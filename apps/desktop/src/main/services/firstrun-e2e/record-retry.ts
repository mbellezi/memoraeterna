// How the first-run end-to-end test (F4 T90, E6) records a remote call that fails transiently (card
// FRMISS). A cassette keeps only answers, so a live call that failed in the record has no entry: its
// job ran again later in the record, after other divisions, while a replay is served the eventual
// answer at the first attempt and runs the job in its own order. The prompts built from what other
// jobs left behind (the entity-identity candidates, the note judge's neighbours) then differ and the
// replay misses (FRREC of 11-11: 17 failed graph jobs; one division's graph never got an answer).
//
// So in a recording the harness tries a transient failure of a remote call again itself, below the
// cassette and above the provider's adapter (its own attempts already spent): the product sees one
// slow call, the work keeps the order a replay follows, and the recorded duration covers the failed
// attempts and the waits, so a replay with recorded timing waits as long as the record did. A call
// that still fails reaches the product as before, and the record's `replayable` check fails. The
// product's behaviour is unchanged: only this harness wraps adapters this way.
//
// The tries run under the lane scheduler, and each failed attempt still reports "transient" to its
// lane: under the product's breaker (5 in a row) one retried call opens it, and the entries waiting
// on the lane are refused above this wrapper, so their jobs back off: the same reorder. The harness
// therefore runs its lanes with `firstRunLaneRuntime`. A try also keeps its lane slot through its
// wait, which a replay with recorded timing does too (the entry's duration covers the wait).
import { isTransientAiError } from "@app/ai";
import type {
  AiLaneRuntimeConfigInput,
  AiModelAdapter,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "@app/ai";

/** The waits before each new try of a failed call; their number is the tries a call gets. */
export const recordRetryDelaysMs: readonly number[] = [10_000, 30_000, 60_000, 120_000];

/**
 * The lanes of the harness, record and replays alike: the breaker of a remote lane opens only at the
 * schema's top of 1,000 consecutive transient failures, so the failed attempts of calls the record
 * tries again (at most 3 adapter attempts x 5 tries each) never refuse other entries. A replay has
 * no failures, so the breaker is inert there either way; any call that still fails voids the record
 * (`replayable`). Everything else keeps the product's defaults.
 */
export const firstRunLaneRuntime: AiLaneRuntimeConfigInput = {
  breaker: { failureThreshold: 1_000 }
};

/** What the record's retries did, as the report lists it. */
export interface RecordRetryStats {
  /** Calls that failed transiently at least once. */
  calls: number;
  /** New tries, all calls together. */
  retries: number;
  /** Calls answered after a retry: the product never saw them fail. */
  recovered: number;
  /** Calls that still failed after the last try (or once the token cap was reached). */
  exhausted: number;
  /** New tries by task type. */
  byTask: Record<string, number>;
}

export interface RecordRetryEvent {
  taskType: string;
  /** 1-based number of the try that comes next (2 is the first retry). */
  attempt: number;
  delayMs: number;
  error: string;
}

export interface RecordRetryOptions {
  delaysMs?: readonly number[];
  /** False stops retrying (the run's live-token cap was reached); true by default. */
  allow?: () => boolean;
  /** Waits `ms` or rejects once `signal` aborts (tests pass a fake). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  onRetry?: (event: RecordRetryEvent) => void;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);

/** The record's retry of transient remote failures; `wrap` is applied under the cassette. */
export class RecordRetry {
  private readonly delaysMs: readonly number[];
  private readonly allow: () => boolean;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly now: () => number;
  private readonly counters: RecordRetryStats = {
    calls: 0,
    retries: 0,
    recovered: 0,
    exhausted: 0,
    byTask: {}
  };

  public constructor(private readonly options: RecordRetryOptions = {}) {
    this.delaysMs = options.delaysMs ?? recordRetryDelaysMs;
    this.allow = options.allow ?? (() => true);
    this.sleep = options.sleep ?? abortableSleep;
    this.now = options.now ?? Date.now;
  }

  public stats(): RecordRetryStats {
    return { ...this.counters, byTask: { ...this.counters.byTask } };
  }

  /** A remote adapter whose calls are tried again on a transient failure; any other is returned as is. */
  public wrap(adapter: AiModelAdapter): AiModelAdapter {
    if (adapter.describe().runtime !== "remote") return adapter;
    return {
      describe: () => adapter.describe(),
      canHandle: (request) => adapter.canHandle(request),
      run: (request, signal) =>
        this.execute(
          request,
          signal,
          () => adapter.run(request, signal),
          () => undefined
        ),
      ...(adapter.runStreaming
        ? {
            runStreaming: (
              request: AiTaskRequest,
              signal: AbortSignal | undefined,
              onProgress: AiProgressListener
            ) => {
              // A new try starts the answer again and never moves the progress back.
              let restart = false;
              let progress = 0;
              const listener: AiProgressListener = (event) => {
                if (event.kind === "text") {
                  onProgress(restart ? { ...event, restart: true } : event);
                  restart = false;
                } else if (event.progress >= progress) {
                  progress = event.progress;
                  onProgress(event);
                }
              };
              return this.execute(
                request,
                signal,
                () => adapter.runStreaming!(request, signal, listener),
                () => {
                  restart = true;
                }
              );
            }
          }
        : {}),
      ...(adapter.embedMany ? { embedMany: adapter.embedMany.bind(adapter) } : {}),
      ...(adapter.outputSchemaFor
        ? { outputSchemaFor: (contract) => adapter.outputSchemaFor!(contract) }
        : {}),
      ...(adapter.isLoaded ? { isLoaded: () => adapter.isLoaded!() } : {}),
      ...(adapter.ensureLoaded
        ? { ensureLoaded: (signal?: AbortSignal) => adapter.ensureLoaded!(signal) }
        : {}),
      ...(adapter.listModels
        ? { listModels: (signal?: AbortSignal) => adapter.listModels!(signal) }
        : {}),
      ...(adapter.testConnection
        ? { testConnection: (signal?: AbortSignal) => adapter.testConnection!(signal) }
        : {}),
      ...(adapter.dispose ? { dispose: () => adapter.dispose!() } : {})
    };
  }

  private async execute(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    call: () => Promise<AiTaskResult>,
    beforeRetry: () => void
  ): Promise<AiTaskResult> {
    const startedAt = this.now();
    let retries = 0;
    for (;;) {
      try {
        const result = await call();
        if (retries === 0) return result;
        this.counters.recovered += 1;
        // The recorded duration is the whole call, the failed tries and the waits included.
        return { ...result, durationMs: Math.max(result.durationMs, this.now() - startedAt) };
      } catch (error) {
        const transient = !signal?.aborted && isTransientAiError(error);
        if (!transient) throw error;
        if (retries === 0) this.counters.calls += 1;
        const delayMs = this.delaysMs[retries];
        if (delayMs === undefined || !this.allow()) {
          this.counters.exhausted += 1;
          throw error;
        }
        retries += 1;
        this.counters.retries += 1;
        this.counters.byTask[request.taskType] = (this.counters.byTask[request.taskType] ?? 0) + 1;
        this.options.onRetry?.({
          taskType: request.taskType,
          attempt: retries + 1,
          delayMs,
          error: messageOf(error)
        });
        await this.sleep(delayMs, signal);
        beforeRetry();
      }
    }
  }
}
