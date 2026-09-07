/** One inference at a time; cancellation while waiting never releases an active call. */
export class AiExecutionQueue {
  private tail: Promise<void> = Promise.resolve();

  public run<T>(execute: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
      const cancel = () => reject(signal?.reason);
      signal?.addEventListener("abort", cancel, { once: true });
      const result = this.tail.then(() => {
        signal?.removeEventListener("abort", cancel);
        signal?.throwIfAborted();
        return execute();
      });
      this.tail = result.then(() => undefined, () => undefined);
      result.then(resolve, reject);
    });
  }
}
