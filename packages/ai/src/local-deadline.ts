import { AiProviderError } from "./provider-error.js";

/**
 * Why a local call failed on its deadline (F3 D31):
 * - `deadline`: the deadline cancelled the call and the runtime stopped in time;
 * - `stalled`: a streamed generation produced no token for the stall bound;
 * - `aborted_deadline`: the runtime ignored the cancellation and was still running its grace period
 *   after the deadline, so the call was abandoned and the runtime is wedged until it is disposed;
 * - `wedged`: the call was refused because its runtime is wedged;
 * - `deadline_repeated`: a second consecutive deadline on the same input, which retrying cannot fix.
 */
export type LocalDeadlineCode =
  "deadline" | "stalled" | "aborted_deadline" | "wedged" | "deadline_repeated";

/**
 * A local call ended by its deadline. Transient (a job retries it) except `deadline_repeated`.
 * `recovery` is set on an abandoned call: it settles once the native call ended and its runtime was
 * disposed, and the local lane stays held until then (`LanePermit.holdUntil`).
 */
export class LocalDeadlineError extends AiProviderError {
  public readonly deadlineMs: number;
  public readonly recovery: Promise<void> | undefined;

  public constructor(
    message: string,
    details: {
      code: LocalDeadlineCode;
      deadlineMs: number;
      transient?: boolean;
      recovery?: Promise<void>;
    }
  ) {
    super(message, {
      kind: details.code === "stalled" ? "stalled" : "timeout",
      transient: details.transient ?? details.code !== "deadline_repeated",
      code: details.code
    });
    this.name = "LocalDeadlineError";
    this.deadlineMs = details.deadlineMs;
    this.recovery = details.recovery;
  }
}

export interface LocalDeadlineRun<T> {
  /** Total deadline from now, the start of the execution. */
  deadlineMs: number;
  /** How long the runtime may take to stop after the deadline cancelled it. */
  graceMs: number;
  /** The caller's cancellation; the deadline is added to it. */
  signal?: AbortSignal | undefined;
  /** Longest silence between `touch` calls once the first one came; no bound when absent. */
  stallMs?: number | undefined;
  /** The call: it receives the signal that ends at the deadline and `touch` for each token. */
  run: (signal: AbortSignal, touch: () => void) => Promise<T>;
  /**
   * The call is still running `graceMs` after its deadline: marks the runtime wedged and returns
   * its recovery, given the call's own settlement.
   */
  wedged: (settled: Promise<unknown>) => Promise<void>;
}

/**
 * Runs a local call under its deadline: at the deadline (or a token stall) the call's signal aborts
 * cooperatively; a call that has not settled `graceMs` later is abandoned with `aborted_deadline`
 * and its runtime's recovery. A deadline wins over the error the stopped runtime reports; caller
 * cancellation keeps its own error.
 */
export function runWithLocalDeadline<T>(options: LocalDeadlineRun<T>): Promise<T> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  return new Promise<T>((resolve, reject) => {
    let expired: LocalDeadlineError | undefined;
    let done = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = () => {
      clearTimeout(totalTimer);
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      if (graceTimer !== undefined) clearTimeout(graceTimer);
    };
    const expire = (error: LocalDeadlineError) => {
      if (expired || done) return;
      expired = error;
      controller.abort(error);
      graceTimer = setTimeout(() => {
        if (done) return;
        done = true;
        clearTimers();
        const recovery = options.wedged(settled);
        reject(
          new LocalDeadlineError(
            `Local model call did not stop within ${options.graceMs} ms of its ${options.deadlineMs} ms deadline.`,
            { code: "aborted_deadline", deadlineMs: options.deadlineMs, recovery }
          )
        );
      }, options.graceMs);
    };
    const totalTimer = setTimeout(
      () =>
        expire(
          new LocalDeadlineError(
            `Local model call exceeded its ${options.deadlineMs} ms deadline.`,
            { code: "deadline", deadlineMs: options.deadlineMs }
          )
        ),
      options.deadlineMs
    );
    const touch = () => {
      const stallMs = options.stallMs;
      if (stallMs === undefined || expired || done) return;
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(
        () =>
          expire(
            new LocalDeadlineError(`Local model generation stalled for ${stallMs} ms.`, {
              code: "stalled",
              deadlineMs: options.deadlineMs
            })
          ),
        stallMs
      );
    };
    const settled: Promise<T> = (async () => options.run(signal, touch))();
    settled.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimers();
        if (expired) reject(expired);
        else resolve(value);
      },
      (error: unknown) => {
        if (done) return;
        done = true;
        clearTimers();
        reject(expired ?? error);
      }
    );
  });
}

/** Whether a failure is a deadline ending a call (local or remote): the audit's `aborted` outcome. */
export function isDeadlineFailure(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof AiProviderError)
      return current.kind === "timeout" || current.kind === "stalled";
    const { name, code } = current as { name?: unknown; code?: unknown };
    if (name === "TimeoutError") return true;
    // The MLX helper host reports its own deadline as code `timeout` (it kills the helper).
    if (name === "MlxHelperError" && code === "timeout") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
