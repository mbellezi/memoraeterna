// How the first-run end-to-end test (F4 T90) waits: for a queue to drain. It is the zero-config
// test's wait (a queue counts as drained after several quiet polls in a row, because a finished job
// enqueues its follow-up a moment later) with one more reason to give up at once: a model whose
// install failed. The reasons are the caller's.
export type WaitOutcome<Stop extends string> = "settled" | "timeout" | Stop;

/** Polls until `count` is 0 for `quietPolls` polls in a row, a stop reason appears or time is up. */
export async function waitQuiet<Stop extends string>(options: {
  /** Jobs (or runs) still to finish; the caller may observe other things on each poll. */
  count: () => Promise<number>;
  /** A reason to give up at once: a replay miss, the live token cap, a model that failed. */
  stopReason: () => Promise<Stop | null>;
  timeoutMs: number;
  pollIntervalMs: number;
  quietPolls: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<WaitOutcome<Stop>> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let quiet = 0;
  for (;;) {
    const stopped = await options.stopReason();
    if (stopped) return stopped;
    quiet = (await options.count()) === 0 ? quiet + 1 : 0;
    if (quiet >= options.quietPolls) return "settled";
    if (now() >= deadline) return "timeout";
    await options.sleep(options.pollIntervalMs);
  }
}
