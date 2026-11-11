/**
 * Maps `items` through `fn` with at most `concurrency` calls in flight (F5 D22), so a source's
 * independent batches can reach their lane together while what they produce stays a function of
 * content, never of timing:
 *
 * - calls start in index order, and the outputs come back in index order whatever order the calls
 *   finish in;
 * - each call gets a signal derived from the caller's: aborting the caller's signal aborts the calls
 *   in flight, starts no other, and rejects with the caller's reason once those calls settled;
 * - when a call fails, the calls in flight still finish (their work is kept, for example as a
 *   checkpoint), no other call starts, and the error of the lowest index is thrown, which is the
 *   error a serial run would have met first.
 *
 * A concurrency below 1, or not a finite number, runs the items one at a time.
 */
export async function mapInOrder<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number, signal: AbortSignal) => Promise<R>,
  signal?: AbortSignal
): Promise<R[]> {
  signal?.throwIfAborted();
  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const derived = new AbortController();
  const abort = () => derived.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { index: number; error: unknown } | null = null;
  const fail = (index: number, error: unknown) => {
    if (failure === null || index < failure.index) failure = { index, error };
  };
  const stopped = () => failure !== null || derived.signal.aborted;
  const worker = async () => {
    while (!stopped() && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index]!, index, derived.signal);
      } catch (error) {
        fail(index, error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (signal?.aborted) throw signal.reason;
  const failed = failure as { index: number; error: unknown } | null;
  if (failed) throw failed.error;
  return results;
}
