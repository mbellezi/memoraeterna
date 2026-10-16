// How the zero-config end-to-end test (F2 T32) waits: for the import's heavy work, then for the
// light lane. A queue counts as drained after several quiet polls in a row, because a finished job
// enqueues its follow-up a moment later (the change notice that asks for a name is coalesced).
export type WaitStop = "cassette_miss" | "token_limit";
export type WaitOutcome = "settled" | "timeout" | WaitStop;

/** Polls until `count` is 0 for `quietPolls` polls in a row, a stop reason appears or time is up. */
export async function waitQuiet(options: {
  /** Jobs (or runs) still to finish. */
  count: () => Promise<number>;
  /** A reason to give up at once: a replay miss, or the live token cap of a recording. */
  stopReason: () => Promise<WaitStop | null>;
  timeoutMs: number;
  pollIntervalMs: number;
  quietPolls: number;
  sleep: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<WaitOutcome> {
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
