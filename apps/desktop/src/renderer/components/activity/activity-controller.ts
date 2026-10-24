import {
  changeSetErrorKeys,
  type ChangeSetBlockerCode,
  type ChangeSetRef,
  type GardenerStatusAction,
  type GardenerStatusSnapshot
} from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { AppEventHandler, AppEventType } from "../../../shared/app-events";
import type { DesktopApi, LocalEmbeddingLoadStatus } from "../../../shared/ipc";
import { topicErrorMessage } from "../topic-shape/shape-controller";
import {
  actionEffects,
  doneListLimit,
  initialActivitySnapshot,
  jobFactsOf,
  undoKey,
  type ActivityNavigation,
  type ActivitySnapshot,
  type Announcement,
  type RowAction
} from "./activity-model";

/** The part of the preload API the Activity reads and acts through. */
export interface ActivityApi {
  gardener: Pick<DesktopApi["gardener"], "status" | "resume">;
  budget: Pick<DesktopApi["budget"], "snapshot" | "continue">;
  changes: Pick<DesktopApi["changes"], "list" | "undo">;
  /** The Inbox's own count of every kind that waits for the person (`inbox.changed` follows it). */
  inbox: Pick<DesktopApi["inbox"], "counts">;
  onAppEvent: DesktopApi["onAppEvent"];
  /** The local embedder loading into memory (the signal the blocking dialog used to follow). */
  subscribeEmbeddingLoad: (listener: (status: LocalEmbeddingLoadStatus) => void) => () => void;
}

export function activityApiOf(app: DesktopApi): ActivityApi {
  return {
    gardener: app.gardener,
    budget: app.budget,
    changes: app.changes,
    inbox: app.inbox,
    onAppEvent: (type, handler) => app.onAppEvent(type, handler),
    subscribeEmbeddingLoad: (listener) => app.ai.subscribeLocalEmbeddingLoadStatus(listener)
  };
}

export interface ActivityControllerDeps {
  api: () => ActivityApi;
  /** Opens a place in the app for an action (Settings, the AI setup, the local models). */
  navigate: (to: ActivityNavigation) => void;
  /** Quiet time after a pushed change before the drawer's list of changes is read again. */
  refreshDelayMs?: number;
  now?: () => number;
}

const blockerMessages = {
  later_change: "changes.blockers.later_change",
  item_deleted: "changes.blockers.item_deleted",
  changed_since: "changes.blockers.changed_since",
  not_applied: "changes.blockers.not_applied",
  not_undoable: "changes.blockers.not_undoable",
  newer_version: "changes.blockers.newer_version",
  run_open: "changes.blockers.run_open",
  conflict: "changes.blockers.conflict"
} as const satisfies Record<ChangeSetBlockerCode, MessageKey>;

/** The message of a failed undo: a store's own report, else the plain one. */
export function undoFailureMessage(error: unknown): MessageKey {
  const text = String(error);
  const reported = changeSetErrorKeys.find((key) => text.includes(key));
  return reported ?? topicErrorMessage(error) ?? "activity.done.undoFailed";
}

/** The events that mean a change-set may have been added or changed. */
const changeEvents = [
  "changes.changed",
  "tree.changed",
  "relation.created",
  "overview.changed"
] as const satisfies readonly AppEventType[];

/**
 * The state of the Activity pill and drawer, outside React so every rule is tested without a
 * renderer. The pill is always shown, so `start` follows only what it needs: the Gardener's status,
 * the Inbox count and the embedder loading. The drawer's own reads (the spending meters, the
 * changes just made) and its `job.progress` counts exist only while it is open. Everything is
 * pushed; nothing polls. A failed read stays visible and can be retried.
 */
export class ActivityController {
  private snapshot: ActivitySnapshot;
  private readonly listeners = new Set<() => void>();
  private started = false;
  private stops: Array<() => void> = [];
  private drawerStops: Array<() => void> = [];
  private statusToken = 0;
  private budgetToken = 0;
  private doneToken = 0;
  private inboxToken = 0;
  /** The Inbox count came from `inbox.changed`, which is newer than any read in flight. */
  private inboxFromEvents = false;
  private loadingModelId: string | null = null;
  private announcementId = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: ActivityControllerDeps) {
    this.snapshot = initialActivitySnapshot(this.clock());
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): ActivitySnapshot => this.snapshot;

  /** Follows the status and reads it once. Safe to call again; `stop` undoes it. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const api = this.deps.api();
    this.stops.push(
      api.onAppEvent("gardener.status", (event) => {
        this.statusToken += 1;
        this.acceptStatus(event.status);
      }),
      api.onAppEvent("inbox.changed", (event) => {
        this.inboxFromEvents = true;
        this.inboxToken += 1;
        this.update({ inboxTotal: event.total });
      }),
      api.subscribeEmbeddingLoad((status) => {
        if (status.state === "loading") {
          this.loadingModelId = status.modelId;
          if (!this.snapshot.embedderLoading) this.update({ embedderLoading: true });
        } else if (this.loadingModelId === status.modelId) {
          this.loadingModelId = null;
          this.update({ embedderLoading: false });
        }
      })
    );
    this.loadStatus();
    this.loadInbox();
  }

  /** Stops every subscription and timer; reads that are still in flight are dropped. */
  stop(): void {
    this.started = false;
    for (const stop of this.stops.splice(0)) stop();
    if (this.snapshot.open) this.setOpen(false);
    this.statusToken += 1;
    this.inboxToken += 1;
  }

  toggle(): void {
    this.setOpen(!this.snapshot.open);
  }

  setOpen(open: boolean): void {
    if (this.snapshot.open === open) return;
    if (!open) {
      this.stopDrawer();
      this.update({ open, jobs: null });
      return;
    }
    this.update({ open });
    this.listenDrawer();
    if (this.snapshot.status.status === "error") this.loadStatus();
    if (!this.inboxFromEvents) this.loadInbox();
    this.loadBudget(this.snapshot.budget.status === "ready");
    this.loadDone(this.snapshot.done.status === "ready");
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (this.snapshot.status.status === "error") this.loadStatus();
    if (this.snapshot.budget.status === "error") this.loadBudget(false);
    if (this.snapshot.done.status === "error") this.loadDone(false);
  }

  /** Carries out what a status sentence offers. */
  async runAction(action: GardenerStatusAction): Promise<void> {
    const effect = actionEffects[action];
    if (effect.kind === "navigate") {
      this.deps.navigate(effect.to);
      this.setOpen(false);
      return;
    }
    if (this.snapshot.statusAction?.status === "pending") return;
    this.update({ statusAction: { action, status: "pending" } });
    const api = this.deps.api();
    try {
      if (effect.kind === "resume") {
        await api.gardener.resume();
        this.announce("activity.actions.resumed");
      } else {
        const budget = await api.budget.continue();
        this.budgetToken += 1;
        this.update({ budget: { status: "ready", value: budget } });
        this.announce("activity.actions.continued");
      }
      this.update({ statusAction: null });
    } catch {
      this.update({ statusAction: { action, status: "failed" } });
      this.announce("activity.actions.failed");
    }
    // The status follows by itself: the change publishes `gardener.status`. Reading it here would
    // answer from before the change.
  }

  /** Undoes one of the changes just made. */
  async undo(ref: ChangeSetRef): Promise<void> {
    const key = undoKey(ref);
    if (this.snapshot.undo[key]?.status === "pending") return;
    this.setUndo(key, { status: "pending" });
    try {
      const result = await this.deps.api().changes.undo(ref);
      if (result.status === "undone") {
        this.setUndo(key, null);
        this.announce("activity.done.undone");
      } else {
        const messageKey = blockerMessages[result.blockers[0]!.code];
        this.setUndo(key, { status: "blocked", messageKey });
        this.announce(messageKey);
      }
    } catch (error) {
      const messageKey = undoFailureMessage(error);
      this.setUndo(key, { status: "failed", messageKey });
      this.announce(messageKey);
    }
    if (this.snapshot.open) this.loadDone(true);
  }

  // -------------------------------------------------------------------------

  private acceptStatus(status: GardenerStatusSnapshot): void {
    const previous = this.snapshot.status.status === "ready" ? this.snapshot.status.value : null;
    this.update({ status: { status: "ready", value: status } });
    const needsYou = status.state === "attention";
    if (needsYou && (previous?.state !== "attention" || previous.reason !== status.reason))
      this.announceAttention();
  }

  private loadStatus(): void {
    const token = ++this.statusToken;
    if (this.snapshot.status.status !== "ready") this.update({ status: { status: "loading" } });
    this.deps
      .api()
      .gardener.status()
      .then((status) => {
        if (token === this.statusToken) this.acceptStatus(status);
      })
      .catch(() => {
        // A push that arrived meanwhile is newer; a status that was shown stays shown.
        if (token === this.statusToken && this.snapshot.status.status !== "ready")
          this.update({ status: { status: "error" } });
      });
  }

  private loadInbox(): void {
    const token = ++this.inboxToken;
    this.deps
      .api()
      .inbox.counts()
      .then((counts) => {
        if (token === this.inboxToken && !this.inboxFromEvents)
          this.update({ inboxTotal: counts.total });
      })
      .catch(() => undefined);
  }

  private loadBudget(silent: boolean): void {
    const token = ++this.budgetToken;
    if (!silent) this.update({ budget: { status: "loading" } });
    this.deps
      .api()
      .budget.snapshot()
      .then((budget) => {
        if (token === this.budgetToken) this.update({ budget: { status: "ready", value: budget } });
      })
      .catch(() => {
        if (token === this.budgetToken && this.snapshot.budget.status !== "ready")
          this.update({ budget: { status: "error" } });
      });
  }

  private loadDone(silent: boolean): void {
    const token = ++this.doneToken;
    if (!silent) this.update({ done: { status: "loading" } });
    this.deps
      .api()
      .changes.list({ status: "applied", limit: doneListLimit })
      .then((list) => {
        if (token === this.doneToken) this.update({ done: { status: "ready", value: list.items } });
      })
      .catch(() => {
        // A list that was shown stays shown when a refresh fails.
        if (token === this.doneToken && this.snapshot.done.status !== "ready")
          this.update({ done: { status: "error" } });
      });
  }

  private listenDrawer(): void {
    const api = this.deps.api();
    const follow = <T extends AppEventType>(type: T, handler: AppEventHandler<T>) =>
      this.drawerStops.push(api.onAppEvent(type, handler));
    follow("job.progress", (event) => {
      const jobs = jobFactsOf(event);
      const { jobs: shown } = this.snapshot;
      // Counts that did not move are not a change: the drawer is not drawn again for them.
      if (
        shown?.running === jobs.running &&
        shown.waiting === jobs.waiting &&
        shown.onHold === jobs.onHold
      )
        return;
      this.update({ jobs });
    });
    follow("budget.changed", (event) => {
      this.budgetToken += 1;
      this.update({ budget: { status: "ready", value: event.budget } });
    });
    for (const type of changeEvents) follow(type, () => this.scheduleDoneRefresh());
  }

  private stopDrawer(): void {
    for (const stop of this.drawerStops.splice(0)) stop();
    if (this.refreshTimer !== null) clearTimeout(this.refreshTimer);
    this.refreshTimer = null;
    // Reads still in flight belong to a drawer that is gone.
    this.budgetToken += 1;
    this.doneToken += 1;
  }

  private scheduleDoneRefresh(): void {
    if (this.refreshTimer !== null) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      if (this.snapshot.open) this.loadDone(true);
    }, this.deps.refreshDelayMs ?? 1_000);
  }

  private setUndo(key: string, action: RowAction | null): void {
    const next = { ...this.snapshot.undo };
    if (action === null) delete next[key];
    else next[key] = action;
    this.update({ undo: next });
  }

  private announce(key: MessageKey): void {
    this.update({ announcement: this.nextAnnouncement({ kind: "message", key }) });
  }

  private announceAttention(): void {
    this.update({ announcement: this.nextAnnouncement({ kind: "attention" }) });
  }

  private nextAnnouncement(
    content: { kind: "message"; key: MessageKey } | { kind: "attention" }
  ): Announcement {
    this.announcementId += 1;
    return { id: this.announcementId, ...content };
  }

  private clock(): number {
    return (this.deps.now ?? Date.now)();
  }

  private update(change: Partial<ActivitySnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change, now: this.clock() };
    for (const listener of this.listeners) listener();
  }
}
