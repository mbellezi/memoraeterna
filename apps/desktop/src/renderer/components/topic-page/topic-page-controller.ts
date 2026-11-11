import { topicReadLimits, type TopicNoteLeaf, type TopicPage } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { DesktopApi } from "../../../shared/ipc";
import type { ViewHistoryRecordInput } from "../../../shared/view-history";
import { onTreeChanged, type TreeChangedListener } from "../../lib/app-events";
import type { LoadOutcome } from "../../lib/hidden-view";
import { viewsToRecord } from "../../lib/view-history";
import {
  eventTouchesPage,
  isStaleCursor,
  mergeNoteLeaves,
  nextAnnouncement,
  samePageContent,
  topicPageLoadDecision,
  topicPageOpenedObject
} from "./topic-page-model";

export type TopicPageLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; page: TopicPage };

/** Undoing the last change: nothing asked, asking, refused because a later change depends on it, or failed. */
export type UndoState =
  { status: "idle" } | { status: "pending" } | { status: "blocked" } | { status: "failed" };

/** The full list of the topic's notes behind "See all"; `null` while the list is not asked for. */
export type NotesListState =
  | null
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      notes: readonly TopicNoteLeaf[];
      nextCursor: string | null;
      more: "idle" | "loading" | "error";
    };

export interface TopicPageSnapshot {
  load: TopicPageLoad;
  undo: UndoState;
  notes: NotesListState;
  /** Polite announcement of the last action's result. */
  announcement: string;
  /** When the page shown was read: "today" in the banner is measured against it. */
  readAt: number;
}

export type TopicPageApi = Pick<DesktopApi["topics"], "page" | "notes" | "undo">;

export interface TopicPageControllerDeps {
  api: () => TopicPageApi;
  /** Where the tree's committed changes arrive (default: `tree.changed` on the bus). */
  onTreeChanged?: (listener: TreeChangedListener) => () => void;
  record: (input: ViewHistoryRecordInput) => void;
  now?: () => number;
  /** Quiet time after a pushed change before the page is read again. */
  refreshDelayMs?: number;
}

const initialSnapshot = (): TopicPageSnapshot => ({
  load: { status: "loading" },
  undo: { status: "idle" },
  notes: null,
  announcement: "",
  readAt: 0
});

/**
 * The state of one Topic page, outside React so every rule is tested without a renderer.
 *
 * Opening a page reads it once (`topics.page`, which carries the path, the map and the last change)
 * and records the open once; nothing else is asked until the person acts. A hidden page loads
 * nothing and listens to nothing; shown again with the same topic and a good last load it
 * refreshes in place. A pushed change reads the page again only when it can alter it, after a
 * quiet period, and a read that finds the same content changes nothing.
 */
export class TopicPageController {
  private snapshot = initialSnapshot();
  private readonly listeners = new Set<() => void>();
  private topicId: string | null = null;
  private active = false;
  private translator: Translator | null = null;
  private attempt = 0;
  /** The newest read; an older answer arriving later is dropped. */
  private token = 0;
  private notesToken = 0;
  private inFlightKey: string | null = null;
  private outcome: LoadOutcome | null = null;
  private wasHidden = false;
  private recorded: ReadonlySet<string> = new Set();
  private seenGeneration = -1;
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: TopicPageControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): TopicPageSnapshot => this.snapshot;

  /** Called whenever the topic, the visibility or the language changes. */
  show(topicId: string, active: boolean, t: Translator): void {
    this.translator = t;
    const topicChanged = topicId !== this.topicId;
    this.topicId = topicId;
    if (!active) {
      this.active = false;
      this.wasHidden = true;
      this.stopListening();
      return;
    }
    this.active = true;
    this.listen();
    if (topicChanged) this.resetForTopic();
    const key = this.key();
    const decision = topicPageLoadDecision({
      active,
      wasHidden: this.wasHidden,
      outcome: this.outcome,
      key,
      topicChanged,
      showing: this.snapshot.load.status === "ready"
    });
    this.wasHidden = false;
    if (decision === "skip" || this.inFlightKey === key) {
      this.recordOpen();
      return;
    }
    this.load(decision === "silent");
  }

  /** The person asked to try again after a failure. */
  retry(): void {
    if (!this.active || this.topicId === null) return;
    this.attempt += 1;
    this.load(false);
  }

  /**
   * Stops listening; `show` brings the page back. A read that is in flight is kept: React
   * unmounts and mounts a component again while developing, and the answer is still the page.
   */
  dispose(): void {
    this.active = false;
    this.wasHidden = true;
    this.stopListening();
  }

  /** Undoes the change the banner names. */
  async undo(): Promise<void> {
    const load = this.snapshot.load;
    if (load.status !== "ready" || this.snapshot.undo.status === "pending") return;
    const change = load.page.lastChange;
    if (!change || change.undo !== "available") return;
    const topicId = this.topicId;
    this.update({ undo: { status: "pending" } });
    try {
      const result = await this.deps.api().undo({ changeSetId: change.changeSetId });
      if (this.topicId !== topicId) return;
      if (result.status === "undone") {
        this.update({ undo: { status: "idle" } });
        this.announce("topics.page.banner.undone");
      } else {
        this.update({ undo: { status: "blocked" } });
        this.announce("topics.page.banner.blocked");
      }
      // What the change moved, and whether the next one can be undone, is read again.
      this.refresh();
    } catch {
      if (this.topicId !== topicId) return;
      this.update({ undo: { status: "failed" } });
      this.announce("topics.page.banner.failed");
    }
  }

  /** "See all N notes": the topic's whole subtree, a page at a time. */
  showAllNotes(): void {
    if (this.snapshot.notes !== null || this.snapshot.load.status !== "ready") return;
    this.update({ notes: { status: "loading" } });
    void this.fetchNotes(null);
  }

  loadMoreNotes(): void {
    const notes = this.snapshot.notes;
    if (notes?.status !== "ready" || notes.nextCursor === null || notes.more === "loading") return;
    this.update({ notes: { ...notes, more: "loading" } });
    void this.fetchNotes(notes.nextCursor);
  }

  retryNotes(): void {
    const notes = this.snapshot.notes;
    if (notes === null || notes.status === "loading") return;
    if (notes.status === "ready") {
      this.loadMoreNotes();
      return;
    }
    this.update({ notes: { status: "loading" } });
    void this.fetchNotes(null);
  }

  // -------------------------------------------------------------------------

  private key(): string {
    return `${this.topicId}|${this.attempt}`;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private resetForTopic(): void {
    this.token += 1;
    this.notesToken += 1;
    this.inFlightKey = null;
    this.outcome = null;
    this.seenGeneration = -1;
    this.clearTimer();
    this.snapshot = { ...initialSnapshot() };
    this.emit();
    // Another page is another open; the old one is forgotten so coming back counts again.
    this.recorded = viewsToRecord([], this.recorded).recorded;
  }

  private load(silent: boolean): void {
    const topicId = this.topicId;
    if (topicId === null) return;
    const key = this.key();
    const token = ++this.token;
    this.inFlightKey = key;
    if (!silent) this.update({ load: { status: "loading" } });
    this.deps
      .api()
      .page({ id: topicId, noteLimit: topicReadLimits.centralNotesDefault })
      .then((page) => {
        if (token !== this.token) return;
        this.inFlightKey = null;
        this.outcome = { key, ok: true, hasData: page !== null };
        if (page === null) {
          this.update({ load: { status: "missing" } });
          this.recordOpen();
          return;
        }
        this.seenGeneration = Math.max(this.seenGeneration, page.generation);
        const current = this.snapshot.load;
        // The same content is not shown again: no render, no new open.
        if (current.status !== "ready" || !samePageContent(current.page, page)) {
          this.update({ load: { status: "ready", page }, readAt: this.now() });
        }
        this.recordOpen();
      })
      .catch(() => {
        if (token !== this.token) return;
        this.inFlightKey = null;
        this.outcome = { key, ok: false, hasData: false };
        // A failed refresh keeps the page that is shown.
        if (!silent) this.update({ load: { status: "error" } });
      });
  }

  /** A read in place: the same topic, the page on screen stays until the new one arrives. */
  private refresh(): void {
    if (!this.active) return;
    this.attempt += 1;
    this.load(true);
  }

  private listen(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = (this.deps.onTreeChanged ?? onTreeChanged)((event) => {
      const load = this.snapshot.load;
      if (!this.active || load.status !== "ready") return;
      if (!eventTouchesPage(event, load.page, this.seenGeneration)) return;
      if (this.timer !== null) return;
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refresh();
      }, this.deps.refreshDelayMs ?? 1_000);
    });
  }

  private stopListening(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  /** One recorded open per showing of the page; nothing while hidden. */
  private recordOpen(): void {
    const t = this.translator;
    if (!t) return;
    const load = this.snapshot.load;
    const shown = !this.active
      ? null
      : load.status === "ready"
        ? [topicPageOpenedObject(t, load.page)]
        : [];
    const next = viewsToRecord(shown, this.recorded);
    this.recorded = next.recorded;
    for (const object of next.record)
      this.deps.record({ kind: object.kind, id: object.id, title: object.title });
  }

  private async fetchNotes(cursor: string | null): Promise<void> {
    const topicId = this.topicId;
    if (topicId === null) return;
    const token = ++this.notesToken;
    try {
      const answer = await this.deps.api().notes({
        id: topicId,
        scope: "subtree",
        kind: "note",
        limit: topicReadLimits.itemsPageDefault,
        ...(cursor ? { cursor } : {})
      });
      if (token !== this.notesToken) return;
      if (answer === null) {
        this.update({ notes: { status: "error" } });
        return;
      }
      const shown =
        this.snapshot.notes?.status === "ready" && cursor ? this.snapshot.notes.notes : [];
      this.update({
        notes: {
          status: "ready",
          notes: mergeNoteLeaves(shown, answer.items),
          nextCursor: answer.nextCursor,
          more: "idle"
        }
      });
    } catch (error) {
      if (token !== this.notesToken) return;
      if (cursor && isStaleCursor(error)) {
        // The tree moved on under the cursor: the list starts again from its first page.
        this.update({ notes: { status: "loading" } });
        void this.fetchNotes(null);
        return;
      }
      const notes = this.snapshot.notes;
      this.update({
        notes: notes?.status === "ready" ? { ...notes, more: "error" } : { status: "error" }
      });
    }
  }

  private announce(
    key: "topics.page.banner.undone" | "topics.page.banner.blocked" | "topics.page.banner.failed"
  ): void {
    const t = this.translator;
    if (!t) return;
    this.update({ announcement: nextAnnouncement(this.snapshot.announcement, t(key)) });
  }

  private update(change: Partial<TopicPageSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
