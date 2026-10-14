export interface AiQueueTiming {
  /** Milliseconds between admission (the `run` call) and the start of execution. */
  queueMs: number;
}

/**
 * Interactive work (Ask, query embeddings, actions the user triggered) is admitted before background
 * work; within a class, admission order decides.
 */
export type AiQueuePriority = "interactive" | "background";

interface Waiting {
  admittedAt: number;
  start: () => void;
}

/**
 * One inference at a time. A waiting interactive call goes before every waiting background call, but a
 * running call is never preempted, so interactive work waits for at most the call in flight.
 * Cancellation while waiting never releases an active call.
 */
export class AiExecutionQueue {
  private readonly waiting: Record<AiQueuePriority, Waiting[]> = {
    interactive: [],
    background: []
  };
  private running = false;
  private dispatching = false;

  public get busy(): boolean {
    return (
      this.running ||
      this.dispatching ||
      this.waiting.interactive.length > 0 ||
      this.waiting.background.length > 0
    );
  }

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public run<T>(
    execute: (timing: AiQueueTiming) => Promise<T>,
    signal?: AbortSignal,
    options: { priority?: AiQueuePriority } = {}
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const queue = this.waiting[options.priority ?? "background"];
    return new Promise<T>((resolve, reject) => {
      const entry: Waiting = {
        admittedAt: this.now(),
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) {
            reject(signal.reason);
            this.release();
            return;
          }
          let result: Promise<T>;
          try {
            result = Promise.resolve(
              execute({ queueMs: Math.max(0, Math.round(this.now() - entry.admittedAt)) })
            );
          } catch (error) {
            result = Promise.reject(error);
          }
          result.then(resolve, reject).finally(() => this.release());
        }
      };
      const onAbort = () => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(signal?.reason);
      };
      queue.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.schedule();
    });
  }

  private release(): void {
    this.running = false;
    this.schedule();
  }

  /** Starts the next call in a microtask, so admissions of the same tick compete by priority. */
  private schedule(): void {
    if (this.running || this.dispatching) return;
    this.dispatching = true;
    queueMicrotask(() => {
      this.dispatching = false;
      if (this.running) return;
      const next = this.waiting.interactive.shift() ?? this.waiting.background.shift();
      if (!next) return;
      this.running = true;
      next.start();
    });
  }
}

const activeDeadlines = new WeakMap<AbortSignal, ActiveDeadline>();

/**
 * A timeout that does not run while its owner waits in the AI queue, so a caller that waited behind
 * other work is not timed out by the wait. Time spent executing, and any other work the owner does,
 * counts. `signal` ends on cancellation of `parent` or when the active time is used up.
 */
export class ActiveDeadline {
  public readonly signal: AbortSignal;
  private readonly expiry = new AbortController();
  private remainingMs: number;
  private waiting = 0;
  private disposed = false;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(activeMs: number, parent?: AbortSignal) {
    this.remainingMs = activeMs;
    this.signal = parent ? AbortSignal.any([parent, this.expiry.signal]) : this.expiry.signal;
    activeDeadlines.set(this.signal, this);
    this.startTimer();
  }

  /** The deadline attached to a signal created by {@link ActiveDeadline}, if any. */
  public static of(signal: AbortSignal | undefined): ActiveDeadline | undefined {
    return signal ? activeDeadlines.get(signal) : undefined;
  }

  /**
   * A signal that also ends with `others`, for work that adds its own cancellation to the
   * deadline's: the queue still finds this deadline on it and stops its clock while it waits.
   */
  public join(...others: AbortSignal[]): AbortSignal {
    const joined = AbortSignal.any([this.signal, ...others]);
    activeDeadlines.set(joined, this);
    return joined;
  }

  /** The owner starts waiting for an execution slot: the clock stops. */
  public pause(): void {
    this.waiting++;
    if (this.waiting === 1) this.stopTimer();
  }

  /** The wait is over (the call started, or was abandoned): the clock runs again. */
  public resume(): void {
    if (this.waiting === 0) return;
    this.waiting--;
    if (this.waiting === 0) this.startTimer();
  }

  public dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  private startTimer(): void {
    if (this.disposed || this.signal.aborted) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(
      () => this.expiry.abort(new DOMException("The operation timed out.", "TimeoutError")),
      Math.max(0, this.remainingMs)
    );
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.remainingMs -= Date.now() - this.startedAt;
  }
}
