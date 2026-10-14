import { z } from "zod";
import type { AiTaskType } from "@app/domain";

import {
  AiProviderError,
  aiErrorRetryAfterMs,
  isTransientAiError,
  toProviderNetworkError
} from "./provider-error.js";

/** Workload classes of the AI runtime; each has its own total deadline. */
export type AiWorkloadClass = "embed" | "decide" | "write-fast" | "write-quality" | "answer";

export function aiWorkloadClass(taskType: AiTaskType): AiWorkloadClass {
  switch (taskType) {
    case "embedding":
      return "embed";
    case "reranking":
      return "decide";
    case "summarization":
    case "entity-extraction":
    case "claim-extraction":
    case "metadata-lookup":
    case "cataloging":
      return "write-fast";
    case "atomic-note-generation":
    case "knowledge-graph-generation":
      return "write-quality";
    default:
      return "answer";
  }
}

const milliseconds = z.number().int().positive();

/**
 * Typed configuration of the remote execution deadlines and retries. Deadlines count from the start of
 * the execution (not from admission to the queue); connect, first-byte and stall deadlines apply to
 * streamed responses, the total deadline to every call and to its retries together.
 */
export const aiRuntimeConfigSchema = z
  .object({
    deadlines: z
      .object({
        /** Until the response headers arrive. */
        connectMs: milliseconds,
        /** From the headers until the first body chunk. */
        firstByteMs: milliseconds,
        /** Replaces `firstByteMs` for high-reasoning requests, which stay silent while they think. */
        firstByteHighReasoningMs: milliseconds,
        /** Longest silence between body chunks once the stream started. */
        stallMs: milliseconds,
        /** Multiplies the total deadline of servers on this machine, which are slower to answer. */
        localTotalFactor: z.number().min(1),
        totalMs: z
          .object({
            embed: milliseconds,
            decide: milliseconds,
            "write-fast": milliseconds,
            "write-quality": milliseconds,
            answer: milliseconds
          })
          .strict()
      })
      .strict(),
    retry: z
      .object({
        /** Attempts of one call, the first included. */
        maxAttempts: z.number().int().min(1).max(10),
        baseDelayMs: milliseconds,
        maxDelayMs: milliseconds,
        /**
         * Longest `Retry-After` the adapter waits for inside the single execution slot; a longer wait is
         * left to the caller, which re-queues the work.
         */
        maxInlineRetryAfterMs: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type AiRuntimeConfig = z.infer<typeof aiRuntimeConfigSchema>;
export interface AiRuntimeConfigInput {
  deadlines?: Partial<Omit<AiRuntimeConfig["deadlines"], "totalMs">> & {
    totalMs?: Partial<AiRuntimeConfig["deadlines"]["totalMs"]>;
  };
  retry?: Partial<AiRuntimeConfig["retry"]>;
}

export const defaultAiRuntimeConfig: AiRuntimeConfig = {
  deadlines: {
    connectMs: 10_000,
    firstByteMs: 30_000,
    firstByteHighReasoningMs: 120_000,
    stallMs: 20_000,
    localTotalFactor: 3,
    totalMs: {
      embed: 30_000,
      decide: 90_000,
      "write-fast": 120_000,
      "write-quality": 300_000,
      answer: 180_000
    }
  },
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, maxInlineRetryAfterMs: 15_000 }
};

export function resolveAiRuntimeConfig(input: AiRuntimeConfigInput = {}): AiRuntimeConfig {
  const { totalMs, ...deadlines } = input.deadlines ?? {};
  return aiRuntimeConfigSchema.parse({
    deadlines: {
      ...defaultAiRuntimeConfig.deadlines,
      ...deadlines,
      totalMs: { ...defaultAiRuntimeConfig.deadlines.totalMs, ...totalMs }
    },
    retry: { ...defaultAiRuntimeConfig.retry, ...input.retry }
  });
}

/** Exponential backoff with full jitter; a provider-requested delay is a floor. */
export function retryDelayMs(
  retry: number,
  policy: Pick<AiRuntimeConfig["retry"], "baseDelayMs" | "maxDelayMs">,
  retryAfterMs?: number,
  random: () => number = Math.random
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** retry);
  return Math.max(Math.floor(random() * ceiling), retryAfterMs ?? 0);
}

/** Whether an endpoint is served from this machine or its private network. */
export function isLocalEndpoint(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname === "::1" ||
    /^127\./.test(hostname) ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)
  );
}

export function isHighReasoning(parameters: Record<string, unknown>): boolean {
  return (
    parameters.reasoningLevel === "high" ||
    parameters.reasoningLevel === "xhigh" ||
    parameters.reasoningLevel === "max"
  );
}

/** Reports progress that never moves backwards, even when a retried attempt starts over. */
export function monotonicProgress<T extends { progress: number }>(
  listener: (event: T) => void
): (event: T) => void {
  let reported = 0;
  return (event) => {
    reported = Math.max(reported, event.progress);
    listener({ ...event, progress: reported });
  };
}

export interface RemoteExecutionContext {
  config: AiRuntimeConfig;
  /**
   * The server runs on this machine (Ollama, LM Studio, vLLM) and may load a model before it answers,
   * so connect and first-byte deadlines do not apply and the total deadline is longer.
   */
  local?: boolean | undefined;
  /** Source of the backoff jitter; tests inject a fixed one. */
  random?: (() => number) | undefined;
}

export interface RemoteCallOptions {
  /** Caller cancellation; ends the call without a retry. */
  signal?: AbortSignal | undefined;
  /** Absent for probes (model listing, connection tests), which use the shortest total deadline. */
  taskType?: AiTaskType | undefined;
  parameters?: Record<string, unknown> | undefined;
  /** The response is a stream, so the connect, first-byte and stall deadlines apply. */
  streaming: boolean;
  /** Retry transient failures; false makes the call a single attempt. */
  retry?: boolean;
}

/**
 * Runs one remote call with deadlines counted from now and bounded retries of transient failures.
 * `attempt` performs a single request through the {@link RemoteAttempt} it receives.
 */
export async function runRemoteCall<T>(
  context: RemoteExecutionContext,
  options: RemoteCallOptions,
  attempt: (call: RemoteAttempt) => Promise<T>
): Promise<T> {
  const { config } = context;
  const totalMs = Math.round(
    config.deadlines.totalMs[options.taskType ? aiWorkloadClass(options.taskType) : "embed"] *
      (context.local ? config.deadlines.localTotalFactor : 1)
  );
  const maxAttempts = options.retry === false ? 1 : config.retry.maxAttempts;
  const startedAt = Date.now();
  const total = new AbortController();
  const totalTimer = setTimeout(
    () =>
      total.abort(
        new AiProviderError(`AI provider request exceeded its ${totalMs} ms deadline.`, {
          kind: "timeout",
          transient: true
        })
      ),
    totalMs
  );
  const caller = options.signal;
  const firstByteMs =
    options.parameters && isHighReasoning(options.parameters)
      ? config.deadlines.firstByteHighReasoningMs
      : config.deadlines.firstByteMs;
  try {
    for (let number = 1; ; number++) {
      caller?.throwIfAborted();
      const call = new RemoteAttempt({
        streaming: options.streaming,
        local: context.local === true,
        connectMs: config.deadlines.connectMs,
        firstByteMs,
        stallMs: config.deadlines.stallMs,
        signals: [...(caller ? [caller] : []), total.signal]
      });
      let failure: unknown;
      try {
        return await attempt(call);
      } catch (caught) {
        failure = caller?.aborted
          ? caller.reason
          : total.signal.aborted
            ? total.signal.reason
            : (call.expired ?? toProviderNetworkError(caught));
      } finally {
        call.dispose();
      }
      if (caller?.aborted || total.signal.aborted) throw failure;
      if (!isTransientAiError(failure) || number >= maxAttempts) throw failure;
      const retryAfterMs = aiErrorRetryAfterMs(failure);
      if (retryAfterMs !== undefined && retryAfterMs > config.retry.maxInlineRetryAfterMs)
        throw failure;
      const delay = retryDelayMs(number - 1, config.retry, retryAfterMs, context.random);
      if (Date.now() - startedAt + delay >= totalMs) throw failure;
      await sleep(delay, [...(caller ? [caller] : []), total.signal]);
    }
  } finally {
    clearTimeout(totalTimer);
  }
}

interface RemoteAttemptOptions {
  streaming: boolean;
  local: boolean;
  connectMs: number;
  firstByteMs: number;
  stallMs: number;
  signals: AbortSignal[];
}

/** One request of a remote call. Its signal ends on cancellation, on the total deadline or on a phase deadline. */
export class RemoteAttempt {
  public readonly signal: AbortSignal;
  /** The deadline error that ended this attempt, when one did. */
  public expired: AiProviderError | undefined;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;

  public constructor(private readonly options: RemoteAttemptOptions) {
    this.signal = AbortSignal.any([...options.signals, this.controller.signal]);
  }

  /** Fetches with the connect deadline, then arms the first-byte deadline of a streamed response. */
  public async fetch(
    fetchImplementation: typeof fetch,
    input: string,
    init: RequestInit
  ): Promise<Response> {
    const timed = this.options.streaming && !this.options.local;
    if (timed) this.arm("connect", this.options.connectMs);
    const response = await this.guard(fetchImplementation(input, { ...init, signal: this.signal }));
    if (timed) this.arm("firstByte", this.options.firstByteMs);
    else this.disarm();
    return response;
  }

  /** Call for every body chunk of a streamed response: any bytes restart the stall deadline. */
  public chunkReceived(): void {
    if (this.options.streaming) this.arm("stalled", this.options.stallMs);
  }

  /** Rejects as soon as the attempt ends, even when the guarded operation ignores the signal. */
  public guard<T>(operation: Promise<T>): Promise<T> {
    if (this.signal.aborted) {
      operation.catch(() => undefined);
      return Promise.reject(this.signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener("abort", onAbort, { once: true });
      operation.then(resolve, reject).finally(() => {
        this.signal.removeEventListener("abort", onAbort);
      });
    });
  }

  public dispose(): void {
    this.disarm();
  }

  private arm(phase: "connect" | "firstByte" | "stalled", milliseconds: number): void {
    this.disarm();
    this.timer = setTimeout(() => {
      this.expired =
        phase === "stalled"
          ? new AiProviderError(`AI provider stream stalled for ${milliseconds} ms.`, {
              kind: "stalled",
              transient: true
            })
          : new AiProviderError(
              phase === "connect"
                ? `AI provider did not respond within ${milliseconds} ms.`
                : `AI provider sent no data within ${milliseconds} ms.`,
              { kind: "timeout", transient: true }
            );
      this.controller.abort(this.expired);
    }, milliseconds);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

function sleep(milliseconds: number, signals: AbortSignal[]): Promise<void> {
  const signal = AbortSignal.any(signals);
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
