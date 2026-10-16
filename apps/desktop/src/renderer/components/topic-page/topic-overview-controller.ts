import type { TopicOverviewState } from "@app/domain";

import {
  overviewAnswered,
  overviewErrorKey,
  overviewFailed,
  overviewLocal,
  overviewRequested,
  overviewView,
  shouldRequestOverview,
  type OverviewLocal
} from "./topic-overview-model";

/** What the overview section needs of `window.app.topics`. */
export interface TopicOverviewApi {
  overview(input: { id: string; force?: boolean }): Promise<TopicOverviewState>;
  cancelOverview(input: { id: string }): Promise<boolean>;
}

export interface TopicOverviewSnapshot {
  /** The slot's own request for the topic it shows; null until it asked. */
  local: OverviewLocal | null;
  /** When the snapshot was taken: "written on open, 2 days ago" reads from it. */
  now: number;
}

/**
 * The overview section's state outside React (the page's own controller is the precedent): the
 * page tells it what it read and whether it is shown; it asks the main process only to write a
 * missing overview, to join a writing in progress or to wait once for a support verdict, and on
 * Write, Update, Retry and Cancel. An answer for a topic the page no longer shows, or for a
 * request a later one replaced (an Update while a verdict was awaited), is dropped.
 */
export class TopicOverviewController {
  private snapshot: TopicOverviewSnapshot;
  private readonly listeners = new Set<() => void>();
  private topicId: string | null = null;
  private page: TopicOverviewState = { status: "absent", canWrite: false };
  private active = false;
  /** The latest request: an answer to an earlier one for the same topic is dropped. */
  private latest: { topicId: string; seq: number } | null = null;

  constructor(
    private readonly deps: {
      api: () => TopicOverviewApi;
      now?: () => number;
    }
  ) {
    this.snapshot = { local: null, now: this.clock() };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): TopicOverviewSnapshot => this.snapshot;

  /** The page shows `topicId` with the overview state it read; `active` is false while hidden. */
  show(topicId: string, page: TopicOverviewState, active: boolean): void {
    if (topicId !== this.topicId) {
      this.topicId = topicId;
      this.publish(null);
    }
    this.page = page;
    this.active = active;
    this.consider();
  }

  /**
   * Write (or, with `force`, Update) the overview of the topic shown; Retry after a failure. An
   * Update does not wait for the support verdict of the overview it replaces.
   */
  write(force: boolean): void {
    if (this.topicId === null) return;
    const request = this.current()?.request;
    if (request?.status === "requesting" && !(request.verdict && force)) return;
    this.request(this.topicId, force);
  }

  /** Stops the writing in progress; nothing is written again on its own for this topic. */
  cancel(): void {
    const topicId = this.topicId;
    if (topicId === null) return;
    void this.deps
      .api()
      .cancelOverview({ id: topicId })
      .catch(() => false);
  }

  /**
   * Asks nothing more until `show` is called again. A request in flight is kept: React unmounts and
   * mounts a component again while developing, and its answer is still the overview (the writing
   * itself goes on in the main process and is cached either way).
   */
  dispose(): void {
    this.active = false;
  }

  private consider(): void {
    if (!this.active || this.topicId === null) return;
    const local = this.current();
    const view = overviewView(this.page, local);
    if (shouldRequestOverview(view, local, this.active)) {
      // Asking again about a ready overview only waits for its support verdict.
      this.request(this.topicId, false, view.kind === "ready");
    }
  }

  private current(): OverviewLocal | null {
    const local = this.snapshot.local;
    return local && local.topicId === this.topicId ? local : null;
  }

  private request(topicId: string, force: boolean, verdict = false): void {
    const seq = (this.latest?.seq ?? 0) + 1;
    this.latest = { topicId, seq };
    const replaced = () => this.latest?.topicId === topicId && this.latest.seq !== seq;
    this.publish(overviewRequested(this.current() ?? overviewLocal(topicId), force, verdict));
    let answer: Promise<TopicOverviewState>;
    try {
      answer = this.deps.api().overview(force ? { id: topicId, force: true } : { id: topicId });
    } catch (error) {
      answer = Promise.reject(error);
    }
    answer.then(
      (state) => {
        if (topicId !== this.topicId || replaced()) return;
        this.publish(overviewAnswered(this.current() ?? overviewLocal(topicId), state));
        this.consider();
      },
      (error: unknown) => {
        if (topicId !== this.topicId || replaced()) return;
        this.publish(
          overviewFailed(this.current() ?? overviewLocal(topicId), overviewErrorKey(error))
        );
      }
    );
  }

  private publish(local: OverviewLocal | null): void {
    this.snapshot = { local, now: this.clock() };
    for (const listener of [...this.listeners]) listener();
  }

  private clock(): number {
    return this.deps.now?.() ?? Date.now();
  }
}
