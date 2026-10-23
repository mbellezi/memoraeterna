/**
 * One bounded step of disposing a local runtime (F4 D23). The quit path stops the runtimes with a
 * bound on the whole step (`application-shutdown.ts`); each step inside is bounded and timed too, so
 * the shutdown log names the one that overran instead of the runtime as a whole.
 */
export interface LocalDisposeStep {
  /** What the step did, for the log: `gguf model`, `mlx helper shutdown`. */
  step: string;
  ms: number;
  /** The longest the step waits; it is abandoned (left running) when the bound passes. */
  boundMs: number;
  outcome: "done" | "timeout" | "failed";
}

/** Receives each step as it ends. It must not throw. */
export type LocalDisposeListener = (step: LocalDisposeStep) => void;

/**
 * Runs one step under its bound. It never rejects and never takes longer than `boundMs`: a step that
 * does not end in time is abandoned (a late failure is ignored) and reported as a `timeout`.
 */
export async function runDisposeStep(
  step: string,
  boundMs: number,
  run: () => Promise<unknown> | unknown,
  listener?: LocalDisposeListener
): Promise<LocalDisposeStep> {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), boundMs);
  });
  const work = (async () => run())().then(
    () => "done" as const,
    () => "failed" as const
  );
  const outcome = await Promise.race([work, bound]);
  clearTimeout(timer);
  const report: LocalDisposeStep = { step, ms: Date.now() - startedAt, boundMs, outcome };
  listener?.(report);
  return report;
}
