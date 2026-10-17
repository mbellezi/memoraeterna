const activeDeadlines = new WeakMap<AbortSignal, ActiveDeadline>();

export interface ActiveDeadlineOptions {
  /** The reason the signal aborts with when the active time is used up; a `TimeoutError` by default. */
  reason?: () => unknown;
}

/**
 * A timeout that does not run while its owner waits for an AI lane, so a caller that waited behind
 * other work is not timed out by the wait. Time spent executing, and any other work the owner does,
 * counts. `signal` ends on cancellation of `parent` or when the active time is used up.
 */
export class ActiveDeadline {
  public readonly signal: AbortSignal;
  private readonly expiry = new AbortController();
  private readonly options: ActiveDeadlineOptions;
  private remainingMs: number;
  private waiting = 0;
  private disposed = false;
  private startedAt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(
    private readonly activeMs: number,
    parent?: AbortSignal,
    options: ActiveDeadlineOptions = {}
  ) {
    this.options = options;
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
   * deadline's: the scheduler still finds this deadline on it and stops its clock while it waits.
   */
  public join(...others: AbortSignal[]): AbortSignal {
    const joined = AbortSignal.any([this.signal, ...others]);
    activeDeadlines.set(joined, this);
    return joined;
  }

  /** Active time used so far: the waits are not counted. */
  public get elapsedMs(): number {
    const running = this.timer === undefined ? 0 : Date.now() - this.startedAt;
    return Math.max(0, this.activeMs - this.remainingMs + running);
  }

  /** Whether the owner is waiting for a lane, so the clock stands still. */
  public get paused(): boolean {
    return this.waiting > 0;
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
      () =>
        this.expiry.abort(
          this.options.reason?.() ?? new DOMException("The operation timed out.", "TimeoutError")
        ),
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
