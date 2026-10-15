import { isIP } from "node:net";

import { z } from "zod";
import type { AiTaskType } from "@app/domain";

import type { AiTaskRequest, AiTaskResult, AiWorkloadClass } from "./contracts.js";
import {
  AiProviderError,
  aiErrorRetryAfterMs,
  isTransientAiError,
  toProviderNetworkError
} from "./provider-error.js";

/** The class a task type falls in when its caller states none; it sets the total deadline only. */
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

/** The class a request runs in: the one its caller stated, else its task type's. */
export function requestWorkloadClass(
  request: Pick<AiTaskRequest, "taskType" | "workloadClass">
): AiWorkloadClass {
  return request.workloadClass ?? aiWorkloadClass(request.taskType);
}

/** What a remote call takes from its task request: the task type, parameters and stated class. */
export function remoteCallTask(
  request: AiTaskRequest | undefined
): Pick<RemoteCallOptions, "taskType" | "parameters" | "workloadClass"> {
  return {
    taskType: request?.taskType,
    parameters: request?.parameters,
    workloadClass: request?.workloadClass
  };
}

const milliseconds = z.number().int().positive();

/**
 * Typed configuration of the remote execution deadlines and retries. Deadlines count from the start of
 * the execution (not from admission to the queue); connect, first-byte, no-answer and stall deadlines
 * apply to streamed responses, the total deadline to every call and to its retries together. Bytes alone
 * never extend a stream: only progress does (answer text, and reasoning text before the answer).
 */
export const aiRuntimeConfigSchema = z
  .object({
    deadlines: z
      .object({
        /** Until the response headers arrive. */
        connectMs: milliseconds,
        /** From the headers until the first body chunk. */
        firstByteMs: milliseconds,
        /**
         * Replaces `firstByteMs` for high-reasoning requests, which stay silent while they think. Until
         * their first answer text arrives it is also the longest stretch without progress (when it is
         * longer than `stallMs`), because lifecycle events come early and the thinking that follows is
         * silent.
         */
        firstByteHighReasoningMs: milliseconds,
        /**
         * Longest stretch without progress: answer text once the answer started, reasoning text before it.
         * Lifecycle events, keep-alives and empty data do not count as progress.
         */
        stallMs: milliseconds,
        /**
         * Longest time from the first body chunk to the first answer text of a request that is not
         * high-reasoning and not served from this machine, whatever reasoning text arrives meanwhile. A
         * stream that exceeds it stalls (a transient failure, retried inside the total deadline). A
         * decide call asks for no reasoning summary and so is silent while it thinks: this is also the
         * longest silence it is given before its first answer text, in place of `stallMs`.
         */
        answerStartMs: milliseconds,
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
         * Longest `Retry-After` the adapter waits for while it holds the single execution slot; a longer
         * wait is left to the caller, which re-queues the work.
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
    answerStartMs: 30_000,
    localTotalFactor: 3,
    totalMs: {
      embed: 30_000,
      decide: 45_000,
      "write-fast": 120_000,
      "write-quality": 300_000,
      answer: 180_000
    }
  },
  retry: { maxAttempts: 3, baseDelayMs: 500, maxDelayMs: 8_000, maxInlineRetryAfterMs: 5_000 }
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

/**
 * Whether an endpoint is served from this machine or its private network: `localhost`, mDNS names, and
 * addresses in the loopback, private (10/8, 172.16/12, 192.168/16), IPv6 unique-local (fc00::/7) and IPv6
 * link-local (fe80::/10) ranges. A host name that merely starts like an address (`10.example.com`) is remote.
 */
export function isLocalEndpoint(baseUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase().replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  const version = isIP(hostname);
  if (version === 4) return isPrivateIpv4(hostname);
  if (version === 6) return isPrivateIpv6(hostname);
  return hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local");
}

function isPrivateIpv4(address: string): boolean {
  const [first = 0, second = 0] = address.split(".").map(Number);
  return (
    first === 127 ||
    first === 10 ||
    (first === 192 && second === 168) ||
    (first === 172 && second >= 16 && second <= 31)
  );
}

function isPrivateIpv6(address: string): boolean {
  if (address === "::1") return true;
  // URL normalizes an IPv4-mapped address to hexadecimal groups: ::ffff:7f00:1 is 127.0.0.1.
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (mapped) {
    const high = parseInt(mapped[1]!, 16);
    const low = parseInt(mapped[2]!, 16);
    return isPrivateIpv4(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
  }
  const first = parseInt(address.split(":")[0] || "0", 16);
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
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

/** Tokens a provider reported for one request, when it reported them. */
export interface PartialTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Wire options an adapter chose itself for a request (for example a lean shape), as the provider received them. */
export type RemoteRequestOptions = NonNullable<AiTaskResult["requestOptions"]>;

/** What a remote call cost beyond its answer: how many requests it made and what the failed ones used. */
export interface RemoteCallReport {
  /**
   * Requests started, the first included: a retried attempt counts, and so does every extra request an
   * adapter sends inside one attempt (a fallback to another request shape), because the provider
   * received and may have billed each of them.
   */
  attempts: number;
  /** Tokens the provider reported for requests that failed before the answer (its last report each). */
  failedUsage: PartialTokenUsage;
  /** The wire options of the last request started, when the adapter stated them; they also describe a failed call. */
  requestOptions?: RemoteRequestOptions;
}

export interface RemoteCallOptions {
  /** Caller cancellation; ends the call without a retry. */
  signal?: AbortSignal | undefined;
  /** Absent for probes (model listing, connection tests), which use the shortest total deadline. */
  taskType?: AiTaskType | undefined;
  /** The class the caller stated; it replaces the task type's class for the deadlines. */
  workloadClass?: AiWorkloadClass | undefined;
  parameters?: Record<string, unknown> | undefined;
  /** The response is a stream, so the connect, first-byte and stall deadlines apply. */
  streaming: boolean;
  /** Retry transient failures; false makes the call a single attempt. */
  retry?: boolean;
  /** Receives the report when the call succeeds; a failed call's report is read with {@link remoteCallReport}. */
  report?: ((report: RemoteCallReport) => void) | undefined;
}

const failedCallReports = new WeakMap<object, RemoteCallReport>();

/** The report of a remote call that failed with this error, when it was thrown by {@link runRemoteCall}. */
export function remoteCallReport(error: unknown): RemoteCallReport | undefined {
  return typeof error === "object" && error !== null ? failedCallReports.get(error) : undefined;
}

/**
 * Adds a call's report to its result: the attempt count, and the tokens of failed attempts, which the
 * provider billed too. They join the totals only where the answer's own count is known, so an unknown
 * count stays unknown; `retriedUsage` always shows what was reported for them.
 */
export function withCallReport(
  result: AiTaskResult,
  report: RemoteCallReport | undefined
): AiTaskResult {
  if (!report) return result;
  const { inputTokens: retriedInput, outputTokens: retriedOutput } = report.failedUsage;
  const bump = (value: number | undefined, extra: number | undefined) =>
    value !== undefined && extra !== undefined ? value + extra : value;
  const usage = result.tokenUsage;
  const retriedTotal = (retriedInput ?? 0) + (retriedOutput ?? 0);
  const inputTokens = bump(result.inputTokens, retriedInput);
  const outputTokens = bump(result.outputTokens, retriedOutput);
  const tokenUsage = usage && {
    ...usage,
    ...(usage.inputTokens !== undefined
      ? { inputTokens: bump(usage.inputTokens, retriedInput)! }
      : {}),
    ...(usage.outputTokens !== undefined
      ? { outputTokens: bump(usage.outputTokens, retriedOutput)! }
      : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens + retriedTotal } : {})
  };
  const retried = {
    ...(retriedInput !== undefined ? { inputTokens: retriedInput } : {}),
    ...(retriedOutput !== undefined ? { outputTokens: retriedOutput } : {})
  };
  return {
    ...result,
    attempts: report.attempts,
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(tokenUsage ? { tokenUsage } : {}),
    ...(Object.keys(retried).length > 0 ? { retriedUsage: retried } : {})
  };
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
  const workload =
    options.workloadClass ?? (options.taskType ? aiWorkloadClass(options.taskType) : "embed");
  const totalMs = Math.round(
    config.deadlines.totalMs[workload] * (context.local ? config.deadlines.localTotalFactor : 1)
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
  const highReasoning = options.parameters !== undefined && isHighReasoning(options.parameters);
  const { stallMs, firstByteHighReasoningMs } = config.deadlines;
  const report: RemoteCallReport = { attempts: 0, failedUsage: {} };
  // A decide call asks for no reasoning summary, so it thinks in silence before its answer text.
  const decide = options.taskType !== undefined && workload === "decide";
  // Requests of the attempts that already ended.
  let requestsMade = 0;
  const countRequests = (call: RemoteAttempt) => {
    // An attempt that never reached the network still counts as one.
    report.attempts = requestsMade + Math.max(1, call.requests);
    if (call.wireOptions) report.requestOptions = call.wireOptions;
  };
  try {
    for (let number = 1; ; number++) {
      caller?.throwIfAborted();
      report.attempts = requestsMade + 1;
      const call = new RemoteAttempt({
        streaming: options.streaming,
        local: context.local === true,
        connectMs: config.deadlines.connectMs,
        firstByteMs: highReasoning ? firstByteHighReasoningMs : config.deadlines.firstByteMs,
        // A reasoning model sends early events and then thinks in silence before its first output. A
        // high-reasoning request may do so for its long window. A remote decide call, which has no
        // reasoning text to show, may do so for the answer-start bound and not longer: the same bound
        // that limits every other ordinary request, whatever reasoning text it streams.
        preOutputStallMs: highReasoning
          ? Math.max(stallMs, firstByteHighReasoningMs)
          : decide && !context.local
            ? Math.max(stallMs, config.deadlines.answerStartMs)
            : stallMs,
        stallMs,
        // A server on this machine may take long to load a model and to think, so it has no such bound.
        answerStartMs: highReasoning || context.local ? undefined : config.deadlines.answerStartMs,
        signals: [...(caller ? [caller] : []), total.signal]
      });
      let failure: unknown;
      try {
        const value = await attempt(call);
        countRequests(call);
        options.report?.({
          attempts: report.attempts,
          failedUsage: { ...report.failedUsage },
          ...(report.requestOptions ? { requestOptions: report.requestOptions } : {})
        });
        return value;
      } catch (caught) {
        countRequests(call);
        requestsMade = report.attempts;
        failure = caller?.aborted
          ? caller.reason
          : total.signal.aborted
            ? total.signal.reason
            : (call.expired ?? toProviderNetworkError(caught));
        report.failedUsage = addUsage(report.failedUsage, call.usage);
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
  } catch (error) {
    if (typeof error === "object" && error !== null)
      failedCallReports.set(error, {
        attempts: report.attempts,
        failedUsage: report.failedUsage,
        ...(report.requestOptions ? { requestOptions: report.requestOptions } : {})
      });
    throw error;
  } finally {
    clearTimeout(totalTimer);
  }
}

function addUsage(left: PartialTokenUsage, right: PartialTokenUsage): PartialTokenUsage {
  const sum = (a: number | undefined, b: number | undefined) =>
    a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
  const inputTokens = sum(left.inputTokens, right.inputTokens);
  const outputTokens = sum(left.outputTokens, right.outputTokens);
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {})
  };
}

interface RemoteAttemptOptions {
  streaming: boolean;
  local: boolean;
  connectMs: number;
  firstByteMs: number;
  /** Longest stretch without progress until the first answer text; {@link stallMs} afterwards. */
  preOutputStallMs: number;
  stallMs: number;
  /** Longest time from the first body chunk to the first answer text; absent when no such bound applies. */
  answerStartMs: number | undefined;
  signals: AbortSignal[];
}

/** One request of a remote call. Its signal ends on cancellation, on the total deadline or on a phase deadline. */
export class RemoteAttempt {
  public readonly signal: AbortSignal;
  /** The deadline error that ended this attempt, when one did. */
  public expired: AiProviderError | undefined;
  /** The tokens the provider has reported for this request so far (cumulative, so the last report counts). */
  public usage: PartialTokenUsage = {};
  /** Requests this attempt started; an adapter may send more than one (a fallback to another shape). */
  public requests = 0;
  /** The wire options stated for the last request this attempt started. */
  public wireOptions: RemoteRequestOptions | undefined;
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private firstByteSeen = false;
  private outputBegan = false;

  public constructor(private readonly options: RemoteAttemptOptions) {
    this.signal = AbortSignal.any([...options.signals, this.controller.signal]);
  }

  /**
   * Fetches with the connect deadline, then arms the first-byte deadline of a streamed response.
   * `wireOptions` are the options the adapter chose for this request; they describe it in the audit
   * even when the call fails.
   */
  public async fetch(
    fetchImplementation: typeof fetch,
    input: string,
    init: RequestInit,
    wireOptions?: RemoteRequestOptions
  ): Promise<Response> {
    this.requests += 1;
    if (wireOptions) this.wireOptions = wireOptions;
    const timed = this.options.streaming && !this.options.local;
    if (timed) this.arm("connect", this.options.connectMs);
    const response = await this.guard(fetchImplementation(input, { ...init, signal: this.signal }));
    if (timed) this.arm("firstByte", this.options.firstByteMs);
    else this.disarm();
    return response;
  }

  /**
   * Call for every body chunk of a streamed response. The first one ends the first-byte deadline and
   * starts the progress deadlines; later ones restart nothing, because bytes are not progress.
   */
  public chunkReceived(): void {
    if (!this.options.streaming || this.firstByteSeen) return;
    this.firstByteSeen = true;
    this.arm("stalled", this.progressWindowMs());
    if (this.options.answerStartMs !== undefined) this.armAnswerStart(this.options.answerStartMs);
  }

  /**
   * Call when the stream made progress: answer text, or reasoning text before the answer started. This
   * is the only thing that restarts the stall deadline. Lifecycle events, keep-alives, comments and empty
   * data are not progress, so a stream that sends only those stalls. Once answer text arrives the
   * no-answer deadline ends and a silence of `stallMs` means the stream stalled; reasoning text that comes
   * after the answer started is not progress.
   */
  public progressed(kind: "reasoning" | "answer"): void {
    if (!this.options.streaming) return;
    this.chunkReceived();
    if (kind === "answer") {
      this.outputBegan = true;
      this.disarmAnswerStart();
    } else if (this.outputBegan) {
      return;
    }
    this.arm("stalled", this.progressWindowMs());
  }

  /** Records the usage a provider reports on a streamed response, so a failed attempt's tokens are not lost. */
  public reportUsage(tokenUsage: Readonly<Record<string, number>>): void {
    const { inputTokens, outputTokens } = tokenUsage;
    this.usage = {
      ...this.usage,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {})
    };
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
    this.disarmAnswerStart();
  }

  private progressWindowMs(): number {
    return this.outputBegan ? this.options.stallMs : this.options.preOutputStallMs;
  }

  private arm(phase: "connect" | "firstByte" | "stalled", milliseconds: number): void {
    this.disarm();
    this.timer = setTimeout(() => {
      if (this.expired) return;
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

  private armAnswerStart(milliseconds: number): void {
    this.disarmAnswerStart();
    this.answerTimer = setTimeout(() => {
      if (this.expired) return;
      this.expired = new AiProviderError(
        `AI provider produced no answer text within ${milliseconds} ms.`,
        { kind: "stalled", transient: true }
      );
      this.controller.abort(this.expired);
    }, milliseconds);
  }

  private disarm(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private disarmAnswerStart(): void {
    if (this.answerTimer !== undefined) clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
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
