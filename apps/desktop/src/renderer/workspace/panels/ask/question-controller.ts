import type { AppEventOf } from "../../../../shared/app-events";
import type { QuestionView, QuestionsApi } from "../../../../shared/ipc-questions";
import {
  applyDelta,
  applyStatus,
  emptyStream,
  isEndStage,
  streamFor,
  type StreamState
} from "./answer-model";
import { rememberRequest, requestOf } from "./ask-session";

/**
 * Reads one Question and keeps its answer current. The state lives here, outside React, so the
 * rules are tested without a renderer:
 *
 * - a hidden panel loads nothing; shown again it reads once more, quietly, unless its last load
 *   failed (a failed load stays visible and retryable);
 * - the bus tells what the Ask is doing: `consultation.delta` and `consultation.status` of this
 *   Question's own events feed the stream, and an event of another Question is never this page's;
 * - when the Ask ends, the stored answer is read (quietly, keeping what is shown) so the page shows
 *   the version that was stored; `object.changed` for the Question reads it again the same way;
 * - a read the bus asks for keeps what is shown until the new one arrives, and a read that fails
 *   keeps it; changes that arrive while a read is under way ask for one more read, not one per change;
 * - Stop cancels the request the page knows (the one it asked for, or the first it heard of), and
 *   Ask again writes a new version of the same Question.
 */

export type QuestionLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; question: QuestionView };

/** What the page's own actions are doing. */
export type QuestionAction = "idle" | "stopping" | "asking" | "failed";

export interface QuestionSnapshot {
  load: QuestionLoad;
  stream: StreamState;
  action: QuestionAction;
}

export interface QuestionControllerDeps {
  api: () => Pick<QuestionsApi, "get" | "cancel" | "askAgain" | "ask"> | undefined;
}

export class QuestionController {
  private readonly listeners = new Set<() => void>();
  private snapshot: QuestionSnapshot = {
    load: { status: "loading" },
    stream: emptyStream,
    action: "idle"
  };
  private id: string | null = null;
  private active = false;
  /** A change arrived while hidden: the next time the panel is shown it reads again. */
  private stale = false;
  private generation = 0;
  private reading = false;
  private again = false;

  constructor(private readonly deps: QuestionControllerDeps) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getSnapshot = (): QuestionSnapshot => this.snapshot;

  /** Shows the Question `id`; `active` is whether the panel is on screen. */
  show(id: string, active: boolean): void {
    const wasActive = this.active;
    this.active = active;
    if (id !== this.id) {
      this.id = id;
      this.stale = false;
      this.generation += 1;
      this.reading = false;
      this.again = false;
      const requestId = requestOf(id);
      this.set({
        load: { status: "loading" },
        stream: requestId ? streamFor(requestId) : emptyStream,
        action: "idle"
      });
      if (active) this.read(false);
      return;
    }
    if (!active || wasActive) return;
    if (this.snapshot.load.status === "loading" && !this.reading) this.read(false);
    else if (this.snapshot.load.status === "ready" || this.snapshot.load.status === "missing")
      this.read(true);
    this.stale = false;
  }

  /** "Tentar de novo" after a failed load: the skeleton again, then the page. */
  retry(): void {
    if (this.id === null) return;
    this.generation += 1;
    this.reading = false;
    this.again = false;
    this.set({ ...this.snapshot, load: { status: "loading" }, action: "idle" });
    this.read(false);
  }

  /** The Question changed (or its Ask ended): read it again in place. */
  reread(): void {
    if (this.id === null) return;
    if (!this.active) {
      this.stale = true;
      return;
    }
    if (this.snapshot.load.status === "error") return;
    if (this.reading) {
      this.again = true;
      return;
    }
    this.read(true);
  }

  /** A `consultation.delta` of the bus. */
  applyDelta(event: AppEventOf<"consultation.delta">): void {
    if (event.questionId !== this.id) return;
    this.followStream(applyDelta(this.snapshot.stream, event));
  }

  /** A `consultation.status` of the bus; an event with no Question is only this page's by its request. */
  applyStatus(event: AppEventOf<"consultation.status">): void {
    const known = this.snapshot.stream.requestId === event.requestId;
    if (event.questionId !== undefined ? event.questionId !== this.id : !known) return;
    const stream = applyStatus(this.snapshot.stream, event);
    this.followStream(stream);
    if (stream.stage !== null && isEndStage(stream.stage)) this.reread();
  }

  private followStream(stream: StreamState): void {
    if (stream === this.snapshot.stream) return;
    if (stream.requestId !== null && this.id !== null) rememberRequest(this.id, stream.requestId);
    this.set({ ...this.snapshot, stream });
  }

  /** Stops the Ask that is writing the answer; its paragraphs so far are stored as a stopped version. */
  stop(): void {
    const api = this.deps.api();
    const requestId = this.snapshot.stream.requestId ?? (this.id ? requestOf(this.id) : undefined);
    if (!api || !requestId || this.snapshot.action === "stopping") return;
    this.set({ ...this.snapshot, action: "stopping" });
    api
      .cancel({ requestId })
      .then(() => this.finishAction("idle"))
      .catch(() => this.finishAction("failed"));
  }

  /** "Refazer": writes a new version of this Question; its words and scope stay. */
  askAgain(): void {
    const api = this.deps.api();
    const id = this.id;
    if (!api || id === null || this.snapshot.action === "asking") return;
    this.set({ ...this.snapshot, action: "asking" });
    api
      .askAgain({ id })
      .then(({ requestId }) => {
        if (this.id !== id) return;
        rememberRequest(id, requestId);
        this.set({ ...this.snapshot, stream: streamFor(requestId), action: "idle" });
        // The Question reads as running now: the stored answer stays until the new one replaces it.
        this.reread();
      })
      .catch(() => this.finishAction("failed"));
  }

  private finishAction(action: QuestionAction): void {
    this.set({ ...this.snapshot, action });
  }

  /** Reads the Question. `quiet` keeps what is shown until the answer arrives or fails. */
  private read(quiet: boolean): void {
    const id = this.id;
    if (id === null) return;
    const api = this.deps.api();
    const generation = ++this.generation;
    this.reading = true;
    const finish = (apply: () => void) => {
      if (generation !== this.generation) return;
      this.reading = false;
      apply();
      if (this.again) {
        this.again = false;
        if (this.active) this.read(true);
        else this.stale = true;
      }
    };
    if (!api) {
      finish(() => {
        if (!quiet) this.set({ ...this.snapshot, load: { status: "error" } });
      });
      return;
    }
    api
      .get({ id })
      .then((question) =>
        finish(() =>
          this.set({
            ...this.snapshot,
            load: question === null ? { status: "missing" } : { status: "ready", question }
          })
        )
      )
      .catch(() =>
        finish(() => {
          // A failed re-read keeps the page that is shown; a first read says it failed.
          if (!quiet || this.snapshot.load.status === "loading")
            this.set({ ...this.snapshot, load: { status: "error" } });
        })
      );
  }

  private set(snapshot: QuestionSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of [...this.listeners]) listener();
  }
}
