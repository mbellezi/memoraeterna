export interface AiQueueTiming {
  /** Milliseconds between admission (the `run` call) and the start of execution. */
  queueMs: number;
}

/** One inference at a time; cancellation while waiting never releases an active call. */
export class AiExecutionQueue {
  private pending = 0;
  public get busy(): boolean {
    return this.pending > 0;
  }
  private tail: Promise<void> = Promise.resolve();

  public constructor(private readonly now: () => number = () => performance.now()) {}

  public run<T>(execute: (timing: AiQueueTiming) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    const admittedAt = this.now();
    this.pending++;
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      const result = this.tail.then(() => {
        signal?.removeEventListener("abort", cancel);
        signal?.throwIfAborted();
        return execute({ queueMs: Math.max(0, Math.round(this.now() - admittedAt)) });
      });
      this.tail = result.then(
        () => {
          this.pending--;
        },
        () => {
          this.pending--;
        }
      );
      result.then(resolve, reject);
    });
  }
}
