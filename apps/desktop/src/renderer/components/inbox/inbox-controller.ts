import {
  changeSetErrorKeys,
  inboxErrorKeys,
  inboxReadLimits,
  topicErrorKeys,
  type ChangeSetBlockerCode,
  type ChangeSetRisk,
  type InboxCounts,
  type InboxItem,
  type InboxKind,
  type InboxVerb
} from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { AppEventHandler } from "../../../shared/app-events";
import type { DesktopApi } from "../../../shared/ipc";
import { isSilentRefresh, type LoadOutcome } from "../../lib/hidden-view";
import { verbForKey, type InboxCommand } from "./inbox-keys";
import {
  initialInboxState,
  keyOf,
  mergeItems,
  offers,
  reduceInbox,
  selectedItem,
  type InboxEvent,
  type InboxFilter,
  type InboxState
} from "./inbox-state";

/** What the controller needs of `window.app`. */
export interface InboxApi {
  inbox: Pick<DesktopApi["inbox"], "list" | "counts" | "act">;
  changes: Pick<DesktopApi["changes"], "diff">;
  onAppEvent: DesktopApi["onAppEvent"];
}

export interface InboxControllerDeps {
  api: () => InboxApi;
  /** Items one page asks for. */
  pageSize?: number;
  /** The clock ages are measured with (tests pass a fixed one). */
  now?: () => number;
}

/** Pages a refresh reads again at most to keep what the person loaded (500 items at 50 a page). */
export const refreshPagesMax = 10;

/** The sentence of a verb that was carried out, per kind (a closed table, never a composed key). */
const doneMessages = {
  review: { apply: "inbox.result.applied", dismiss: "inbox.result.dismissed" },
  contradiction: { apply: "inbox.result.kept", dismiss: "inbox.result.removed" },
  suggestion: { apply: "inbox.result.kept", dismiss: "inbox.result.removed" },
  withdrawn: { apply: "inbox.result.kept", dismiss: "inbox.result.removed" },
  quarantined: { retry: "inbox.result.retried", dismiss: "inbox.result.dismissed" },
  duplicate: { dismiss: "inbox.result.dismissed" },
  obsidian_conflict: {},
  budget: { apply: "inbox.result.continued", dismiss: "inbox.result.dismissed" },
  backlog: { apply: "inbox.result.accepted", dismiss: "inbox.result.dismissed" }
} as const satisfies Record<InboxKind, Partial<Record<InboxVerb, MessageKey>>>;

/** A Divergence is kept beside the text or its item dismissed; nothing is removed (D17). */
const divergenceDoneMessages = {
  apply: "inbox.result.kept",
  dismiss: "inbox.result.dismissed"
} as const satisfies Partial<Record<InboxVerb, MessageKey>>;

export function doneMessage(kind: InboxKind, verb: InboxVerb, variant?: string): MessageKey {
  const messages: Partial<Record<InboxVerb, MessageKey>> =
    kind === "contradiction" && variant === "divergence"
      ? divergenceDoneMessages
      : doneMessages[kind];
  return messages[verb] ?? "inbox.result.dismissed";
}

/** Why a change-set could not be applied or undone, per blocker code (`changes.blockers.*`). */
export const blockerMessages = {
  later_change: "changes.blockers.later_change",
  item_deleted: "changes.blockers.item_deleted",
  changed_since: "changes.blockers.changed_since",
  not_applied: "changes.blockers.not_applied",
  not_undoable: "changes.blockers.not_undoable",
  newer_version: "changes.blockers.newer_version",
  run_open: "changes.blockers.run_open",
  conflict: "changes.blockers.conflict"
} as const satisfies Record<ChangeSetBlockerCode, MessageKey>;

const knownErrors: readonly MessageKey[] = [
  ...inboxErrorKeys,
  ...changeSetErrorKeys,
  ...topicErrorKeys
];

/** The failure a handler reported (`new Error("inbox.errors.…")`), else the plain "could not" sentence. */
export function inboxErrorMessage(error: unknown): MessageKey {
  const text = String(error);
  return knownErrors.find((key) => text.includes(key)) ?? "inbox.result.failed";
}

/**
 * The state of the Inbox, outside React so every rule is tested without a renderer.
 *
 * Showing the view reads the first page and the counts; a hidden view loads nothing and listens to
 * nothing, and shown again with a good last load it refreshes in place. `inbox.changed` reads the
 * first page again, keeping the selection on its item. A verb goes through `inbox.act`, which uses
 * the store's own writer; what it answers decides what the list shows, and a verb that can be taken
 * back leaves an Undo that `u` and the banner reach until the next verb.
 */
export class InboxController {
  private state = initialInboxState();
  private readonly listeners = new Set<() => void>();
  private active = false;
  private wasHidden = false;
  private outcome: LoadOutcome | null = null;
  private loadToken = 0;
  private unsubscribe: (() => void) | null = null;
  private readonly diffTokens = new Map<string, number>();

  constructor(private readonly deps: InboxControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): InboxState => this.state;

  private dispatch(event: InboxEvent): void {
    const before = this.state;
    this.state = reduceInbox(before, event);
    if (this.state === before) return;
    for (const listener of [...this.listeners]) listener();
    if (this.state.selectedKey !== before.selectedKey || event.type === "loaded") this.ensureDiff();
  }

  private key(): string {
    const { kind, risk } = this.state.filter;
    return `${kind ?? ""}|${risk ?? ""}`;
  }

  /** Called whenever the view is shown or hidden. */
  show(active: boolean): void {
    if (!active) {
      this.active = false;
      this.wasHidden = true;
      this.stopListening();
      return;
    }
    const silent = isSilentRefresh(this.wasHidden, this.outcome, this.key());
    this.active = true;
    this.wasHidden = false;
    this.listen();
    // A good load of the same filter is left alone while the view stays shown.
    if (this.outcome?.key === this.key() && this.outcome.ok && !silent) return;
    void this.load(silent);
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (this.active) void this.load(false);
  }

  /** Stops listening; `show` brings the view back. */
  dispose(): void {
    this.active = false;
    this.wasHidden = true;
    this.stopListening();
  }

  private listen(): void {
    if (this.unsubscribe) return;
    const handler: AppEventHandler<"inbox.changed"> = (event) => {
      this.dispatch({
        type: "counts",
        counts: { total: event.total, byKind: event.byKind, byRisk: event.byRisk }
      });
      void this.load(true);
    };
    this.unsubscribe = this.deps.api().onAppEvent("inbox.changed", handler);
  }

  private stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  // -------------------------------------------------------------------------
  // Reading

  private query(cursor?: string) {
    const { kind, risk } = this.state.filter;
    return {
      ...(kind ? { kinds: [kind] } : {}),
      ...(risk ? { risk } : {}),
      ...(cursor ? { cursor } : {}),
      limit: this.deps.pageSize ?? inboxReadLimits.pageDefault
    };
  }

  /**
   * Reads the first page and the counts; `silent` keeps what is on screen while it reads, and reads
   * as many pages as were loaded (up to `refreshPagesMax`), so a refresh after a change elsewhere
   * neither drops the pages the person moved into nor moves the selection off its item.
   */
  private async load(silent: boolean): Promise<void> {
    const token = ++this.loadToken;
    const key = this.key();
    const covered = silent && this.state.load.status === "ready" ? this.state.items.length : 0;
    if (!silent) this.dispatch({ type: "loading" });
    try {
      const { inbox } = this.deps.api();
      const [page, counts] = await Promise.all([inbox.list(this.query()), inbox.counts()]);
      if (token !== this.loadToken) return;
      let items: readonly InboxItem[] = page.items;
      let nextCursor = page.nextCursor;
      let pages = 1;
      while (nextCursor && items.length < covered && pages < refreshPagesMax) {
        const more = await inbox.list(this.query(nextCursor));
        if (token !== this.loadToken) return;
        items = mergeItems(items, more.items);
        nextCursor = more.nextCursor;
        pages += 1;
      }
      this.outcome = { key, ok: true, hasData: items.length > 0 };
      this.dispatch({
        type: "loaded",
        items,
        nextCursor,
        at: (this.deps.now ?? Date.now)()
      });
      this.dispatch({ type: "counts", counts });
    } catch {
      if (token !== this.loadToken) return;
      const keeping = silent && this.state.load.status === "ready";
      this.outcome = { key, ok: keeping, hasData: this.state.items.length > 0 };
      // A silent refresh that failed keeps the list the person is working in.
      if (!keeping) this.dispatch({ type: "loadFailed" });
    }
  }

  /** The next page, when there is one. */
  async loadMore(): Promise<void> {
    const { nextCursor, loadingMore } = this.state;
    if (!nextCursor || loadingMore) return;
    const token = this.loadToken;
    this.dispatch({ type: "moreLoading" });
    try {
      const page = await this.deps.api().inbox.list(this.query(nextCursor));
      if (token !== this.loadToken) return;
      this.dispatch({ type: "moreLoaded", items: page.items, nextCursor: page.nextCursor });
    } catch {
      if (token === this.loadToken) this.dispatch({ type: "moreFailed" });
    }
  }

  /** Narrows the list to a kind or a risk; null clears one. */
  setFilter(filter: { kind?: InboxKind | null; risk?: ChangeSetRisk | null }): void {
    const next: Partial<InboxFilter> = {};
    if (filter.kind !== undefined) next.kind = filter.kind;
    if (filter.risk !== undefined) next.risk = filter.risk;
    this.dispatch({ type: "filter", filter: next });
    if (this.active) void this.load(false);
  }

  select(key: string): void {
    this.dispatch({ type: "select", key });
  }

  /** The counts alone, for a badge that is shown while the list is not. */
  counts(): InboxCounts | null {
    return this.state.counts;
  }

  // -------------------------------------------------------------------------
  // The change-set's before and after

  private ensureDiff(): void {
    const item = selectedItem(this.state);
    const changeSet = item?.changeSet;
    if (!changeSet) return;
    const existing = this.state.diffs[changeSet.id];
    if (existing && existing.status !== "error") return;
    void this.loadDiff(changeSet.kind, changeSet.id);
  }

  /** Reads a change-set's diff again, after it failed. */
  retryDiff(): void {
    const changeSet = selectedItem(this.state)?.changeSet;
    if (changeSet) void this.loadDiff(changeSet.kind, changeSet.id);
  }

  private async loadDiff(kind: "topic" | "relation" | "overview", id: string): Promise<void> {
    const token = (this.diffTokens.get(id) ?? 0) + 1;
    this.diffTokens.set(id, token);
    this.dispatch({ type: "diff", changeSetId: id, load: { status: "loading" } });
    try {
      const diff = await this.deps.api().changes.diff({ kind, id });
      if (this.diffTokens.get(id) !== token) return;
      this.dispatch({
        type: "diff",
        changeSetId: id,
        load: diff ? { status: "ready", diff } : { status: "missing" }
      });
    } catch {
      if (this.diffTokens.get(id) === token)
        this.dispatch({ type: "diff", changeSetId: id, load: { status: "error" } });
    }
  }

  // -------------------------------------------------------------------------
  // Keys and verbs

  /**
   * Carries out a command of the keyboard. True when the Inbox used the key (the caller then stops
   * the event); the commands that only move focus (`open`, `escape`) are the view's.
   */
  command(command: InboxCommand): boolean {
    switch (command.type) {
      case "move":
        this.dispatch({ type: "move", delta: command.delta });
        // Reaching the last loaded item reads the next page ahead of the person.
        if (
          command.delta > 0 &&
          this.state.items.at(-1) &&
          keyOf(this.state.items.at(-1)!) === this.state.selectedKey
        )
          void this.loadMore();
        return true;
      case "edge":
        this.dispatch({ type: "edge", to: command.to });
        return true;
      case "help":
        this.dispatch({ type: "help" });
        return true;
      case "undo":
        if (!this.state.undo || this.state.undo.status === "pending") return false;
        void this.undo();
        return true;
      case "verb": {
        const item = selectedItem(this.state);
        // A key carries a verb only where it is offered: `x` never removes a connection and Backspace
        // never dismisses anything else (D34).
        const verb = item ? verbForKey(item, command.verb) : null;
        if (!item || verb === null) return false;
        void this.act(verb);
        return true;
      }
      case "open":
      case "escape":
        return false;
    }
  }

  setHelp(open: boolean): void {
    this.dispatch({ type: "help", open });
  }

  /** Carries a verb out on the selected item through the store's own writer. */
  async act(verb: InboxVerb): Promise<void> {
    const item = selectedItem(this.state);
    if (!item || !offers(item, verb)) return;
    const key = keyOf(item);
    if (this.state.actions[key]?.status === "pending") return;
    this.dispatch({ type: "actionPending", key, verb });
    try {
      const result = await this.deps
        .api()
        .inbox.act({ kind: item.kind, id: item.id, action: verb });
      switch (result.status) {
        case "done": {
          const message = doneMessage(item.kind, verb, item.variant);
          const params = result.queued === undefined ? {} : { count: result.queued };
          this.dispatch({ type: "actionDone", key, announcement: message, params });
          if (result.undoable)
            this.dispatch({
              type: "undoable",
              undo: { key, kind: item.kind, id: item.id, verb, message, params, status: "ready" }
            });
          else this.dispatch({ type: "clearUndo" });
          return;
        }
        case "blocked": {
          const code = result.blockers[0]?.code;
          this.dispatch({
            type: "actionRefused",
            key,
            message: code ? blockerMessages[code] : "inbox.result.blocked"
          });
          return;
        }
        case "stale":
          this.dispatch({ type: "actionRefused", key, message: "inbox.result.stale" });
          void this.load(true);
          return;
        case "waiting":
          this.dispatch({ type: "actionRefused", key, message: "inbox.result.waiting" });
          return;
        case "gone":
          this.dispatch({ type: "itemGone", key });
          this.dispatch({ type: "announce", announcement: "inbox.result.gone" });
          void this.load(true);
          return;
        case "unsupported":
          this.dispatch({ type: "actionRefused", key, message: "inbox.result.unsupported" });
          return;
      }
    } catch (error) {
      this.dispatch({ type: "actionRefused", key, message: inboxErrorMessage(error) });
    }
  }

  /** Takes the last verb back (`u`, or the banner's Undo). */
  async undo(): Promise<void> {
    const undo = this.state.undo;
    if (!undo || undo.status === "pending") return;
    this.dispatch({ type: "undoPending" });
    try {
      const result = await this.deps
        .api()
        .inbox.act({ kind: undo.kind, id: undo.id, action: "undo" });
      if (result.status === "done") {
        this.dispatch({ type: "undoFinished", announcement: "inbox.result.undone" });
        void this.load(true);
      } else if (result.status === "blocked") {
        const code = result.blockers[0]?.code;
        this.dispatch({
          type: "undoRefused",
          message: code ? blockerMessages[code] : "inbox.result.undoUnavailable"
        });
      } else {
        this.dispatch({ type: "undoFinished", announcement: "inbox.result.undoUnavailable" });
      }
    } catch (error) {
      this.dispatch({ type: "undoRefused", message: inboxErrorMessage(error) });
    }
  }

  /** The person left the banner alone: it goes. */
  dismissUndo(): void {
    this.dispatch({ type: "clearUndo" });
  }

  /** The selected item, for the view. */
  selected(): InboxItem | null {
    return selectedItem(this.state);
  }
}
