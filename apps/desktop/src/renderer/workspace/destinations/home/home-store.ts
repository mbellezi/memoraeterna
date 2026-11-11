import type { ChangeSetRef } from "@app/domain";
import type { MessageKey } from "@app/i18n";

import type { DesktopApi } from "../../../../shared/ipc";
import { readOnEvents, type ReadOnEvents, type ReadSource } from "../../../lib/status-followers";
import type { HomeData } from "./home-model";

/**
 * Home's data outside React, so every rule is tested without a renderer: one read of the digest
 * (with the sources still generating, which the digest does not carry), kept current by the bus and
 * never by a timer, with a failure that stays visible and retryable (design record §5.12) and the
 * Desfazer of the Jardineiro's rows. `since` is fixed when the first read starts: Home opened is
 * recorded after the first read, and what arrived "since your last visit" must not vanish because
 * of it.
 */

/** The part of `window.app` Home calls. */
export interface HomeStoreApi {
  home: Pick<DesktopApi["home"], "digest">;
  library: Pick<DesktopApi["library"], "rows" | "sourceProgress">;
  changes: Pick<DesktopApi["changes"], "undo">;
  onAppEvent: DesktopApi["onAppEvent"];
}

export type HomeRead =
  | { status: "loading" }
  | { status: "error"; unavailable: boolean }
  | { status: "ready"; data: HomeData };

/** What came of a Desfazer: under way, taken back, refused with the reason, or failed. */
export type HomeUndo =
  | { status: "pending" }
  | { status: "undone" }
  | { status: "blocked" | "failed"; messageKey: MessageKey };

export interface HomeSnapshot {
  read: HomeRead;
  /** Per change-set (`kind:id`). */
  undo: Readonly<Record<string, HomeUndo>>;
}

/** The bus events that mean something Home shows may have changed. */
export const homeSources: readonly ReadSource[] = [
  { type: "object.changed" },
  { type: "inbox.changed" },
  { type: "changes.changed" },
  { type: "view.changed" },
  { type: "tree.changed" }
];

/** How many generating arrivals get their own progress read. */
export const progressReads = 3;
/** The processing sources listed: enough to tell which arrivals are among them. */
const processingLimit = 50;

export const undoKey = (ref: ChangeSetRef): string => `${ref.kind}:${ref.id}`;

const blockerMessages = {
  later_change: "changes.blockers.later_change",
  item_deleted: "changes.blockers.item_deleted",
  changed_since: "changes.blockers.changed_since",
  not_applied: "changes.blockers.not_applied",
  not_undoable: "changes.blockers.not_undoable",
  newer_version: "changes.blockers.newer_version",
  run_open: "changes.blockers.run_open",
  conflict: "changes.blockers.conflict"
} as const satisfies Record<string, MessageKey>;

export class HomeStore {
  private snapshot: HomeSnapshot = { read: { status: "loading" }, undo: {} };
  private readonly listeners = new Set<() => void>();
  private follower: ReadOnEvents | null = null;
  private reported = false;
  private since: string | null | undefined = undefined;

  constructor(
    private readonly options: {
      api: () => HomeStoreApi;
      /**
       * `lastHomeOpenAt`, asked once when the first read starts (Home first on screen) and kept for
       * the store's life; null: never opened, the digest then looks back a week.
       */
      since: () => string | null;
      now?: () => number;
      /** Told once, after the first answer: Home was opened. */
      onFirstRead?: () => void;
    }
  ) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): HomeSnapshot => this.snapshot;

  /** Follows the bus and reads, until `stop`. The last answer stays on screen meanwhile. */
  start(): void {
    if (this.follower) return;
    this.follower = readOnEvents<HomeData>({
      api: () => this.options.api(),
      sources: homeSources,
      read: () => this.load(),
      onValue: (data) => {
        this.set({ ...this.snapshot, read: { status: "ready", data } });
        if (!this.reported) {
          this.reported = true;
          this.options.onFirstRead?.();
        }
      },
      onError: (error) => {
        // An answer that was shown stays shown; only a first read can fail visibly.
        if (this.snapshot.read.status === "ready") return;
        this.set({
          ...this.snapshot,
          read: { status: "error", unavailable: String(error).includes("home.errors.unavailable") }
        });
      }
    });
  }

  stop(): void {
    this.follower?.stop();
    this.follower = null;
  }

  /** "Tentar de novo": the failure gives way to the loading state and the digest is read again. */
  retry(): void {
    if (!this.follower) return;
    this.set({ ...this.snapshot, read: { status: "loading" } });
    this.follower.refresh();
  }

  /** Takes one of the Jardineiro's changes back, exactly, or names what stands in the way. */
  async undo(ref: ChangeSetRef): Promise<void> {
    const key = undoKey(ref);
    if (this.snapshot.undo[key]?.status === "pending") return;
    this.setUndo(key, { status: "pending" });
    try {
      const result = await this.options.api().changes.undo(ref);
      if (result.status === "undone") this.setUndo(key, { status: "undone" });
      else
        this.setUndo(key, {
          status: "blocked",
          messageKey: blockerMessages[result.blockers[0]!.code]
        });
    } catch {
      this.setUndo(key, { status: "failed", messageKey: "activity.done.undoFailed" });
    }
  }

  private async load(): Promise<HomeData> {
    const api = this.options.api();
    if (this.since === undefined) this.since = this.options.since();
    const [digest, generating] = await Promise.all([
      api.home.digest({ since: this.since }),
      api.library
        .rows({ filter: { status: "processing" }, limit: processingLimit })
        .then((result) => ({ total: result.total, ids: result.rows.map((row) => row.id) }))
        // The briefing says nothing about generating when this read fails; Home still opens.
        .catch(() => null)
    ]);
    const arrived = digest.new.sources.items
      .map((item) => /([0-9a-f-]{36})$/iu.exec(item.object.address)?.[1] ?? null)
      .filter((id): id is string => id !== null && (generating?.ids.includes(id) ?? false))
      .slice(0, progressReads);
    const progress: Record<string, { done: number; estimate: number | null }> = {};
    await Promise.all(
      arrived.map(async (sourceId) => {
        try {
          const result = await api.library.sourceProgress({ sourceId });
          if (result)
            progress[sourceId] = {
              done: result.steps.notes.soFar,
              estimate: result.steps.notes.estimate
            };
        } catch {
          // The row then says "generating notes" without the count.
        }
      })
    );
    return {
      digest,
      generating,
      progress,
      lastVisit: this.since,
      readAt: (this.options.now ?? Date.now)()
    };
  }

  private setUndo(key: string, value: HomeUndo): void {
    this.set({ ...this.snapshot, undo: { ...this.snapshot.undo, [key]: value } });
  }

  private set(next: HomeSnapshot): void {
    this.snapshot = next;
    for (const listener of [...this.listeners]) listener();
  }
}
