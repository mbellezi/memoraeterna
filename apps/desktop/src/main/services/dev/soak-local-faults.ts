import {
  AiProviderError,
  type AiAdapterDecorator,
  type AiEmbedManyOptions,
  type AiModelAdapter
} from "@app/ai";

import type { AiService } from "../ai-service.js";
import { relationTypingOperation, relationTypingRepairOperation } from "../ai-task-parameters.js";
import type { SoakEventSink } from "./soak-records.js";

/**
 * The local-side faults of the soak (F3 T62, spec 5.9): a source whose typing fails
 * deterministically, and a forced abort of the GGUF embedder during an embedding batch. (The MLX
 * helper SIGKILL needs only the helper's process ID and lives in the ports.) Both are DEV-only
 * decorators, installed by `index.ts` under `MEMORA_SOAK`, and each writes a `local` record when it
 * takes effect, so the report can tell an injected failure from a real one.
 */

/** The marker every injected error carries, so an audit row or a log line shows its origin. */
export const injectedMarker = "soak-injected";

export interface LocalFaultOptions {
  /** How long into an embedding batch the forced abort comes. */
  ggufAbortAfterMs?: number;
  /** How long an armed abort waits for an embedding batch before it expires. */
  armedForMs?: number;
  now?: () => number;
}

export class LocalFaultController {
  private readonly poisoned = new Set<string>();
  private armedAt: number | null = null;
  private readonly now: () => number;
  private readonly abortAfterMs: number;
  private readonly armedForMs: number;

  public constructor(
    private readonly sink: SoakEventSink,
    options: LocalFaultOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.abortAfterMs = options.ggufAbortAfterMs ?? 25;
    this.armedForMs = options.armedForMs ?? 30 * 60_000;
  }

  /** From now on the typing of every pair that involves this source fails. */
  public poison(sourceItemId: string): void {
    this.poisoned.add(sourceItemId);
  }

  public get poisonedSources(): readonly string[] {
    return [...this.poisoned];
  }

  /** The next GGUF embedding batch is aborted shortly after it starts. */
  public armGgufAbort(): void {
    this.armedAt = this.now();
  }

  public get ggufAbortArmed(): boolean {
    return this.armedAt !== null && this.now() - this.armedAt <= this.armedForMs;
  }

  private record(
    kind: "typing_failure" | "gguf_abort",
    detail: Record<string, string | number | boolean | null>
  ) {
    this.sink.append({
      type: "local",
      kind,
      at: new Date(this.now()).toISOString(),
      detail: { stage: "fired", ...detail }
    });
  }

  /**
   * The AI service's `runDefaultTask` with the typing fault: a typing call (or its re-ask) whose
   * sources include a poisoned one fails with a permanent, injected error. The job layer then types
   * the pair as unrelated-by-default, as it does for any typing failure (D20).
   */
  public withTypingFaults(run: AiService["runDefaultTask"]): AiService["runDefaultTask"] {
    return (taskType, input, logContext = {}, signal, limits) => {
      const operation = logContext.operation;
      if (
        (operation === relationTypingOperation || operation === relationTypingRepairOperation) &&
        this.poisoned.size > 0
      ) {
        const ids = [logContext.sourceItemId, ...(logContext.sourceItemIds ?? [])];
        const hit = ids.find((id) => id !== undefined && this.poisoned.has(id));
        if (hit !== undefined) {
          this.record("typing_failure", { operation, sourceItemId: hit });
          return Promise.reject(
            new AiProviderError(`${injectedMarker}: typing fails for this source.`, {
              kind: "http",
              transient: false,
              status: 422,
              code: "soak_injected"
            })
          );
        }
      }
      return run(taskType, input, logContext, signal, limits);
    };
  }

  /** True once for an armed abort that has not expired; an expired one is recorded and cleared. */
  private takeArmed(): boolean {
    if (this.armedAt === null) return false;
    const fresh = this.now() - this.armedAt <= this.armedForMs;
    this.armedAt = null;
    if (!fresh) this.record("gguf_abort", { stage: "expired" });
    return fresh;
  }

  private async abortable<T>(
    outer: AbortSignal | undefined,
    texts: number,
    call: (signal: AbortSignal | undefined) => Promise<T>
  ): Promise<T> {
    if (!this.takeArmed()) return call(outer);
    const own = new AbortController();
    const signal = outer ? AbortSignal.any([outer, own.signal]) : own.signal;
    let fired = false;
    const timer = setTimeout(() => {
      fired = true;
      own.abort(new DOMException("This operation was aborted", "AbortError"));
    }, this.abortAfterMs);
    try {
      return await call(signal);
    } finally {
      clearTimeout(timer);
      this.record("gguf_abort", { stage: fired ? "fired" : "finished_first", texts });
    }
  }

  /**
   * Wraps the GGUF embedder (a local `node-llama-cpp` embedding model): while an abort is armed, the
   * next batch gets an abort signal that fires `ggufAbortAfterMs` into it, so the runtime is
   * cancelled in the middle of a batch the way a real cancel would. Other adapters pass through.
   */
  public readonly adapterDecorator: AiAdapterDecorator = (adapter) => {
    const descriptor = adapter.describe();
    if (descriptor.providerId !== "local-gguf" || !descriptor.capabilities.includes("embedding"))
      return adapter;
    const wrapped: AiModelAdapter = {
      describe: () => adapter.describe(),
      canHandle: (request) => adapter.canHandle(request),
      run: (request, signal) =>
        request.taskType === "embedding"
          ? this.abortable(signal, 1, (derived) => adapter.run(request, derived))
          : adapter.run(request, signal),
      ...(adapter.embedMany
        ? {
            embedMany: (texts: readonly string[], options: AiEmbedManyOptions = {}) =>
              this.abortable(options.signal, texts.length, (derived) =>
                adapter.embedMany!(texts, { ...options, ...(derived ? { signal: derived } : {}) })
              )
          }
        : {}),
      ...(adapter.runStreaming ? { runStreaming: adapter.runStreaming.bind(adapter) } : {}),
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
    return wrapped;
  };
}
