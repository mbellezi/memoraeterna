import {
  AiProviderError,
  remoteCallReport,
  type AiAdapterDecorator,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiProgressListener,
  type AiTaskRequest,
  type AiTaskResult
} from "@app/ai";

import { devFakeCodexModelId } from "./fake-codex-provider.js";
import { withSoakCallContext, type SoakCallContext } from "./soak-call-context.js";
import type { SoakEventSink } from "./soak-records.js";

/**
 * The harness token cap of the 7-day soak (F4 T89, spec 5.4, E4(a)): a ceiling on the tokens the
 * real Codex writer may use in a run, enforced by reservation. A call is admitted only if the
 * tokens spent, the tokens reserved by the calls in flight and its own estimate stay within the cap,
 * so the cap is passed by at most one call's estimation error even with two calls in flight (the
 * Codex lane's maximum). A call settles with what the provider reported (a failed attempt's usage
 * included); a call that never reached the provider (every attempt answered by the fault injector)
 * costs nothing; a call that did reach it and reported nothing (a stall) keeps its estimate as spend,
 * never zero. Reaching the cap at its hard value ends the remote leg and the run reads inconclusive;
 * a DEV command lowers the cap in the gate S window and the window restores it.
 *
 * The registry has one decorator slot (`setAiAdapterDecorator`), shared with the GGUF abort decorator
 * of the local faults, so the app installs {@link composeAdapterDecorators} of both.
 */

export const harnessCapMarker = "soak-harness-cap";

/** The refusal of a call that would pass the cap: permanent, tagged so the report sets it aside. */
export class HarnessCapRefusal extends AiProviderError {
  public constructor(
    public readonly capTokens: number,
    public readonly spentTokens: number,
    public readonly reservedTokens: number,
    public readonly estimateTokens: number
  ) {
    super(
      `${harnessCapMarker}: the call would pass the harness token cap (${spentTokens} spent, ${reservedTokens} reserved, ${estimateTokens} estimated, cap ${capTokens}).`,
      { kind: "http", transient: false, status: 402, code: "soak_harness_cap" }
    );
    this.name = "HarnessCapRefusal";
  }
}

/** One call's tokens as a request promises them: its input at three bytes a token plus its output ceiling. */
export function estimateCallTokens(request: AiTaskRequest): number {
  const input = Buffer.byteLength(JSON.stringify(request.input ?? ""), "utf8");
  const maxTokens = request.parameters.maxTokens;
  const output =
    typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0
      ? maxTokens
      : 8_192;
  return Math.ceil(input / 3) + Math.ceil(output);
}

export interface CapSnapshot {
  /** The cap in force (lowered by the DEV command or the gate S window). */
  capTokens: number;
  /** The cap the plan froze. */
  hardCapTokens: number;
  spentTokens: number;
  reservedTokens: number;
  calls: number;
  refusals: number;
  largestCallTokens: number;
}

export interface CapReservation {
  readonly id: number;
  readonly estimateTokens: number;
}

export interface HarnessTokenCapOptions {
  capTokens: number;
  sink: SoakEventSink;
  now?: () => number;
  estimate?: (request: AiTaskRequest) => number;
  /** Which adapters the cap meters: the real Codex writer; the F3 fake Codex wire and every other provider are not. */
  meters?: (descriptor: AiModelDescriptor) => boolean;
  /** Called once when a call is refused at the hard cap: the run is inconclusive from here. */
  onExhausted?: (snapshot: CapSnapshot) => void;
}

/** A refusal is written for the first ones and then now and again, so a refused burst stays readable. */
const loggedRefusal = (count: number) => count <= 20 || count % 25 === 0;

export class HarnessTokenCap {
  private readonly hardCap: number;
  private cap: number;
  private spent = 0;
  private reserved = 0;
  private calls = 0;
  private refusals = 0;
  private largest = 0;
  private admitted = 0;
  private admittedEstimates = 0;
  private nextId = 1;
  private exhausted = false;
  private readonly open = new Map<number, number>();
  private readonly now: () => number;

  public constructor(private readonly options: HarnessTokenCapOptions) {
    if (!(options.capTokens > 0)) throw new Error("The harness token cap must be above zero.");
    this.hardCap = options.capTokens;
    this.cap = options.capTokens;
    this.now = options.now ?? Date.now;
    this.record("set");
  }

  public snapshot(): CapSnapshot {
    return {
      capTokens: this.cap,
      hardCapTokens: this.hardCap,
      spentTokens: this.spent,
      reservedTokens: this.reserved,
      calls: this.calls,
      refusals: this.refusals,
      largestCallTokens: this.largest
    };
  }

  /** The mean estimate of the calls admitted so far: what "a call" weighs for the gate S window. */
  public typicalEstimateTokens(): number {
    return this.admitted === 0 ? 20_000 : Math.round(this.admittedEstimates / this.admitted);
  }

  /** Reserves `estimateTokens` for a call, or throws {@link HarnessCapRefusal}. */
  public reserve(estimateTokens: number): CapReservation {
    const estimate = Math.max(0, Math.ceil(estimateTokens));
    if (this.spent + this.reserved + estimate > this.cap) {
      this.refusals += 1;
      const refusal = new HarnessCapRefusal(this.cap, this.spent, this.reserved, estimate);
      if (loggedRefusal(this.refusals))
        this.record("refused", { estimateTokens: estimate, refusals: this.refusals });
      if (this.cap === this.hardCap && !this.exhausted) {
        this.exhausted = true;
        this.record("exhausted", { estimateTokens: estimate });
        this.options.onExhausted?.(this.snapshot());
      }
      throw refusal;
    }
    const reservation: CapReservation = { id: this.nextId++, estimateTokens: estimate };
    this.open.set(reservation.id, estimate);
    this.reserved += estimate;
    this.admitted += 1;
    this.admittedEstimates += estimate;
    return reservation;
  }

  /** Releases a reservation and adds the tokens the call really used to the spend. */
  public settle(reservation: CapReservation, usedTokens: number): void {
    if (!this.open.delete(reservation.id)) return;
    this.reserved -= reservation.estimateTokens;
    const used = Math.max(0, Math.round(usedTokens));
    this.spent += used;
    this.calls += 1;
    this.largest = Math.max(this.largest, used);
  }

  /** Lowers the cap in force (never raises it); true when it moved. */
  public lowerTo(capTokens: number, detail: Record<string, string | number | boolean | null> = {}) {
    const next = Math.max(1, Math.floor(capTokens));
    if (next >= this.cap) return false;
    this.cap = next;
    this.record("lower", detail);
    return true;
  }

  /** The gate S window: spent plus `calls` times a typical call's estimate. */
  public lowerToSpentPlus(calls: number): number {
    const target = this.spent + Math.round(calls * this.typicalEstimateTokens());
    this.lowerTo(target, { calls, typicalEstimateTokens: this.typicalEstimateTokens() });
    return target;
  }

  /** Back to the frozen cap, when the window that lowered it ends. */
  public restore(): void {
    if (this.cap === this.hardCap) return;
    this.cap = this.hardCap;
    this.record("set", { restored: true });
  }

  /** Whether a refusal reached the hard cap. */
  public get isExhausted(): boolean {
    return this.exhausted;
  }

  private record(
    action: "set" | "lower" | "refused" | "exhausted",
    detail: Record<string, string | number | boolean | null> = {}
  ): void {
    this.options.sink.append({
      type: "cap",
      at: new Date(this.now()).toISOString(),
      action,
      capTokens: this.cap,
      spentTokens: this.spent,
      reservedTokens: this.reserved,
      detail
    });
  }

  /** The decorator for the registry's slot: wraps the metered adapters, passes the others through. */
  public readonly adapterDecorator: AiAdapterDecorator = (adapter) => {
    const meters =
      this.options.meters ??
      ((descriptor: AiModelDescriptor) =>
        descriptor.providerId === "openai-codex" && descriptor.modelId !== devFakeCodexModelId);
    if (!meters(adapter.describe())) return adapter;
    const estimate = this.options.estimate ?? estimateCallTokens;
    const metered = async <T extends AiTaskResult>(
      request: AiTaskRequest,
      call: () => Promise<T>
    ): Promise<T> => {
      const reservation = this.reserve(estimate(request));
      const { context, outcome } = await withSoakCallContext(call);
      if ("error" in outcome) {
        this.settle(reservation, tokensOfFailure(outcome.error, context, reservation));
        throw outcome.error;
      }
      this.settle(reservation, tokensOfResult(outcome.value, context, reservation));
      return outcome.value;
    };
    const wrapped: AiModelAdapter = {
      describe: () => adapter.describe(),
      canHandle: (request) => adapter.canHandle(request),
      run: (request, signal) => metered(request, () => adapter.run(request, signal)),
      ...(adapter.runStreaming
        ? {
            runStreaming: (
              request: AiTaskRequest,
              signal: AbortSignal | undefined,
              onProgress: AiProgressListener
            ) => metered(request, () => adapter.runStreaming!(request, signal, onProgress))
          }
        : {}),
      ...(adapter.outputSchemaFor
        ? { outputSchemaFor: adapter.outputSchemaFor.bind(adapter) }
        : {}),
      ...(adapter.embedMany ? { embedMany: adapter.embedMany.bind(adapter) } : {}),
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

/** What a finished call used: the provider's count, else nothing when nothing was forwarded, else its estimate. */
export function tokensOfResult(
  result: AiTaskResult,
  context: SoakCallContext,
  reservation: CapReservation
): number {
  const reported = (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
  if (result.inputTokens !== undefined || result.outputTokens !== undefined) return reported;
  const total = result.tokenUsage?.totalTokens;
  if (typeof total === "number") return total;
  return context.forwardedRequests === 0 ? 0 : reservation.estimateTokens;
}

/**
 * What a failed call used: the usage its failed attempts reported; nothing when no attempt reached
 * the provider, or when it answered with an HTTP error, a refused connection or a context overflow
 * (it bills no token); the estimate for a stall, a timeout, a broken stream or any other failure
 * after the request went out, since the provider may have billed what it had written.
 */
export function tokensOfFailure(
  error: unknown,
  context: SoakCallContext,
  reservation: CapReservation
): number {
  const failed = remoteCallReport(error)?.failedUsage;
  const reported = (failed?.inputTokens ?? 0) + (failed?.outputTokens ?? 0);
  if (reported > 0) return reported;
  if (context.forwardedRequests === 0) return 0;
  if (
    error instanceof AiProviderError &&
    ["http", "network", "context_overflow"].includes(error.kind)
  )
    return 0;
  return reservation.estimateTokens;
}

/** The decorators in one: each adapter goes through every decorator in order (the registry has one slot). */
export function composeAdapterDecorators(
  ...decorators: ReadonlyArray<AiAdapterDecorator | null | undefined>
): AiAdapterDecorator {
  return (adapter) =>
    decorators.reduce<AiModelAdapter>(
      (current, decorator) => (decorator ? decorator(current) : current),
      adapter
    );
}
