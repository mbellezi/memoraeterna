/** The batch barrier is shared; execution and outcomes belong to each source run. */
export async function runIndividualStageBatch<T extends { id: string }, R>(options: {
  runs: T[];
  signal: AbortSignal;
  wait: (run: T) => Promise<unknown>;
  start: (run: T) => Promise<unknown>;
  process: (run: T) => Promise<R>;
  complete: (run: T, result: R) => Promise<unknown>;
  fail: (run: T, error: unknown) => Promise<unknown>;
}) {
  const failures = new Map<string, unknown>();
  for (const run of options.runs) {
    options.signal.throwIfAborted();
    await options.wait(run);
  }
  for (const run of options.runs) {
    options.signal.throwIfAborted();
    try {
      await options.start(run);
      const result = await options.process(run);
      await options.complete(run, result);
    } catch (error) {
      await options.fail(run, error);
      options.signal.throwIfAborted();
      failures.set(run.id, error);
    }
  }
  return failures;
}
