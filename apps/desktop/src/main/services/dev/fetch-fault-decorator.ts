import { seededUnit } from "./fake-remote-core.js";
import { currentSoakCallContext, type SoakCallContext } from "./soak-call-context.js";
import type { FetchFaultKind, FetchFaultPlan } from "./soak-plan-f4.js";
import { injectedTag, type InjectedExchangeKind, type SoakEventSink } from "./soak-records.js";

/**
 * The fault layer in front of the real Codex adapter (F4 T89, spec 5.4), a DEV `fetch` wrapper the
 * adapter takes as its `fetch` option. F3's faults lived in fake providers (`fault-decorator.ts`); the
 * 7-day soak calls the real Codex backend, so the faults are injected at the HTTP layer and cost no
 * token: every injected exchange is answered or failed by this layer and the request is never
 * forwarded, with one exception, the stall, which forwards the request, lets real deltas through and
 * then goes silent (tokens billed, counted). Each exchange is written to the ledger tagged
 * `soak-injected`, with the bytes of the request it forwarded (the report asserts 0 for every
 * injected exchange but the stall) and `synthetic: true` where the body is one this layer built.
 * The bodies are synthetic shapes from our parser's patterns (`provider-error.ts`): no real
 * `usage_limit_reached` body is captured in the repository, and the report labels them so.
 *
 * Two kinds of fault: per request, drawn from the plan's rates and forced bursts by a seed (the same
 * seed gives the same fault on the same request), and windows the driver opens and closes, which
 * answer every request of the lane (a usage limit, a refused connection, an unknown host, a
 * rejected sign-in). Requests to a server on this machine (the soak's own fakes) pass through.
 *
 * A malformed answer is a well-formed stream whose answer text is cut JSON, as F3's fakes answered:
 * the call succeeds and its consumer refuses the text, which is the repair path the spec registers
 * (a stream the adapter cannot read would end the call instead and never reach a repair).
 *
 * The layer also tells the harness token cap, through the call's context, which requests reached
 * the provider and which of them it refused (an HTTP error bills nothing), and asks the cap to admit
 * every request of a call after its first before it is forwarded (a retry is admitted again).
 */

export const codexProviderName = "openai-codex";

/** The windows that change what every request of the lane meets. */
export type FetchWindowKind = "usage_limit" | "refused" | "enotfound" | "unauthorized";

export interface FetchFaultInjectorOptions {
  plan: FetchFaultPlan;
  seed: number;
  sink: SoakEventSink;
  /** The provider the real lane's audit rows name (the report matches ledger and calls by it). */
  provider?: string;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (milliseconds: number, signal: AbortSignal | null | undefined) => Promise<void>;
}

interface RequestFault {
  kind: FetchFaultKind;
  forced: boolean;
  retryAfterSeconds?: number;
}

const rateOrder = [
  ["rateLimit", "rate_limit"],
  ["unavailable", "unavailable"],
  ["lateFirstByte", "late_first_byte"],
  ["stall", "stall"],
  ["malformed", "malformed"],
  ["unauthorized", "unauthorized"],
  ["contextOverflow", "context_overflow"]
] as const satisfies ReadonlyArray<readonly [keyof FetchFaultPlan["rates"], FetchFaultKind]>;

/** The per-request faults of the real lane, drawn from a seed; forced bursts come first. */
export class FetchFaultSchedule {
  private readonly forcedLeft: number[];

  public constructor(
    public readonly plan: FetchFaultPlan,
    private readonly seed: number,
    private readonly provider: string
  ) {
    this.forcedLeft = plan.forced.map((entry) => entry.count);
  }

  /**
   * The fault of the `seq`-th generation request (1-based), `elapsedMs` after the clock started.
   * `call` is the context of the call the request belongs to: a forced fault aimed at structured
   * calls waits for the first request of one and is not spent on any other.
   */
  public requestFault(
    seq: number,
    elapsedMs: number,
    call?: Pick<SoakCallContext, "structured">
  ): RequestFault | null {
    for (const [index, entry] of this.plan.forced.entries()) {
      if (elapsedMs < entry.afterMinute * 60_000 || this.forcedLeft[index]! <= 0) continue;
      if (entry.aim === "structured" && call?.structured !== true) continue;
      this.forcedLeft[index]! -= 1;
      return {
        kind: entry.kind,
        forced: true,
        ...(entry.kind === "rate_limit" ? { retryAfterSeconds: this.retryAfter(seq) } : {})
      };
    }
    const draw = seededUnit(this.seed, this.provider, seq, "fault");
    let threshold = 0;
    for (const [rate, kind] of rateOrder) {
      threshold += this.plan.rates[rate];
      if (draw < threshold)
        return {
          kind,
          forced: false,
          ...(kind === "rate_limit" ? { retryAfterSeconds: this.retryAfter(seq) } : {})
        };
    }
    return null;
  }

  /** The random faults of the first `count` generation requests: the same on every call. */
  public preview(count: number): Array<RequestFault | null> {
    const copy = new FetchFaultSchedule({ ...this.plan, forced: [] }, this.seed, this.provider);
    return Array.from({ length: count }, (_, index) => copy.requestFault(index + 1, 0));
  }

  private retryAfter(seq: number): number {
    const [low, high] = this.plan.retryAfterSeconds;
    const [from, to] = low <= high ? [low, high] : [high, low];
    return (
      from + Math.floor(seededUnit(this.seed, this.provider, seq, "retry-after") * (to - from + 1))
    );
  }
}

function abortReason(signal: AbortSignal | null | undefined): unknown {
  return signal?.reason ?? new DOMException("This operation was aborted", "AbortError");
}

const realSleep = (milliseconds: number, signal: AbortSignal | null | undefined) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(abortReason(signal));
    const timer = setTimeout(done, Math.max(0, milliseconds));
    function done() {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    function onAbort() {
      clearTimeout(timer);
      reject(abortReason(signal));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });

const jsonHeaders = { "content-type": "application/json" };
const sseHeaders = { "content-type": "text/event-stream", "cache-control": "no-cache" };

/** `fetch failed` with a system error code, as undici reports a transport failure. */
function transportFailure(code: string, message: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(message), { code }) });
}

/** An error body in the shape the providers use, labelled as injected and synthetic. */
function errorBody(message: string, type: string, code: string, extra: object = {}): string {
  return JSON.stringify({
    error: { message: `${message} (${injectedTag}, synthetic shape)`, type, code, ...extra }
  });
}

/** The answer text of a malformed exchange: JSON cut off in the middle, which no contract accepts. */
export const malformedAnswerText = `{"items": [{"text": "cut off here (${injectedTag}, synthetic shape)`;

/** A Codex Responses stream that answers {@link malformedAnswerText} and completes with no usage. */
function malformedStream(): string {
  const events = [
    { type: "response.output_text.delta", delta: malformedAnswerText },
    { type: "response.completed", response: {} }
  ];
  return `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
}

const isLoopback = (url: URL) =>
  url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";

const bodyBytes = (body: BodyInit | null | undefined): number =>
  typeof body === "string" ? Buffer.byteLength(body, "utf8") : 0;

/** What an exchange record is told about how the exchange went. */
interface ExchangeNote {
  status: number;
  injected: boolean;
  outcome?: "completed" | "client_closed" | "server_stopped";
  /** Bytes of the request body forwarded to the provider. */
  forwarded?: number;
  synthetic?: boolean;
  retryAfterSeconds?: number;
  /** When the client left (epoch ms), and when the last piece of the body was written. */
  closedAt?: number;
  lastWriteAt?: number;
  plannedMs?: number;
}
type RecordExchange = (kind: InjectedExchangeKind, note: ExchangeNote) => void;

/** One open window: it ends at `endsAtMs` on the injector's clock. */
interface ActiveWindow {
  id: string;
  kind: FetchWindowKind;
  endsAtMs: number;
}

export class FetchFaultInjector {
  private readonly schedule: FetchFaultSchedule;
  private readonly real: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: NonNullable<FetchFaultInjectorOptions["sleep"]>;
  private readonly provider: string;
  private origin: number;
  private sequence = 0;
  private generations = 0;
  private window: ActiveWindow | null = null;
  /** When a request first met each window (the status can name the fault only from then). */
  private readonly windowMet = new Map<string, number>();
  private readonly injected = new Map<string, number>();
  private readonly forwarded = new Map<string, number>();

  public constructor(private readonly options: FetchFaultInjectorOptions) {
    this.provider = options.provider ?? codexProviderName;
    this.schedule = new FetchFaultSchedule(options.plan, options.seed, this.provider);
    this.real = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? realSleep;
    this.origin = this.now();
  }

  /** Counts the plan's minutes from now (the driver starts its timeline at this moment). */
  public restartClock(): void {
    this.origin = this.now();
  }

  /** Opens a window: every request of the lane meets it until {@link endWindow} or its end. */
  public startWindow(id: string, kind: FetchWindowKind, durationMs: number): void {
    this.window = { id, kind, endsAtMs: this.now() + durationMs };
  }

  public endWindow(id: string): void {
    if (this.window?.id === id) this.window = null;
  }

  /** When a request of the lane first met the window, on the injector's clock; null before. */
  public windowMetAt(id: string): number | null {
    return this.windowMet.get(id) ?? null;
  }

  /** Exchanges the layer injected, by kind. */
  public injectedCounts(): Record<string, number> {
    return Object.fromEntries(this.injected);
  }

  /** Injected exchanges that forwarded their request, by kind (only a stall may). */
  public forwardedCounts(): Record<string, number> {
    return Object.fromEntries(this.forwarded);
  }

  /** The wrapper the adapter takes as its `fetch` option. */
  public readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (isLoopback(url)) return this.real(input, init);
    const started = this.now();
    const seq = ++this.sequence;
    const generation =
      (init?.method ?? "GET").toUpperCase() === "POST" && url.pathname.endsWith("/responses");
    const requestBytes = bodyBytes(init?.body);
    const signal = init?.signal;
    const call = currentSoakCallContext();
    const window = this.window && started < this.window.endsAtMs ? this.window : null;
    if (window && !this.windowMet.has(window.id)) this.windowMet.set(window.id, started);
    const fault =
      window || !generation
        ? null
        : this.schedule.requestFault(++this.generations, started - this.origin, call);

    const record: RecordExchange = (kind, note) => {
      const ended = this.now();
      if (note.injected) {
        this.injected.set(kind, (this.injected.get(kind) ?? 0) + 1);
        if (note.forwarded) this.forwarded.set(kind, (this.forwarded.get(kind) ?? 0) + 1);
      }
      this.options.sink.append({
        type: "exchange",
        provider: this.provider,
        seq,
        startedAt: new Date(started).toISOString(),
        endedAt: new Date(ended).toISOString(),
        kind,
        injected: note.injected,
        status: note.status,
        outcome: note.outcome ?? "completed",
        closedAfterMs: note.closedAt === undefined ? null : Math.max(0, note.closedAt - started),
        closedAfterLastWriteMs:
          note.closedAt === undefined
            ? null
            : Math.max(0, note.closedAt - (note.lastWriteAt ?? started)),
        retryAfterSeconds: note.retryAfterSeconds ?? null,
        plannedMs: note.plannedMs ?? null,
        forwardedBytes: note.forwarded ?? 0,
        ...(note.synthetic ? { synthetic: true } : {}),
        ...(note.injected ? { tag: injectedTag } : {}),
        ...(window ? { window: window.id } : {})
      });
    };
    const answer = (
      kind: InjectedExchangeKind,
      status: number,
      body: string,
      headers: Record<string, string> = {},
      retryAfterSeconds?: number
    ): Response => {
      if (call) call.injectedRequests += 1;
      record(kind, {
        status,
        injected: true,
        synthetic: true,
        ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds })
      });
      return new Response(body, { status, headers: { ...jsonHeaders, ...headers } });
    };
    const unauthorized = () =>
      answer(
        "unauthorized",
        401,
        errorBody("Your authentication token is invalid", "invalid_request_error", "token_expired")
      );

    if (window) {
      switch (window.kind) {
        case "refused":
          if (call) call.injectedRequests += 1;
          record("refused", { status: 0, injected: true, synthetic: true });
          throw transportFailure("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:443");
        case "enotfound":
          if (call) call.injectedRequests += 1;
          record("enotfound", { status: 0, injected: true, synthetic: true });
          throw transportFailure("ENOTFOUND", "getaddrinfo ENOTFOUND chatgpt.com");
        case "usage_limit": {
          // The parser clamps a stated reset at 60 minutes: the window's remaining seconds, capped.
          const resets = Math.max(
            1,
            Math.min(3_600, Math.ceil((window.endsAtMs - started) / 1_000))
          );
          return answer(
            "usage_limit",
            429,
            errorBody(
              "The usage limit has been reached",
              "usage_limit_reached",
              "usage_limit_reached",
              { plan_type: "plus", resets_in_seconds: resets }
            )
          );
        }
        case "unauthorized":
          return unauthorized();
      }
    }

    switch (fault?.kind) {
      case "rate_limit": {
        const retryAfterSeconds = fault.retryAfterSeconds ?? 1;
        return answer(
          "rate_limit",
          429,
          errorBody("Rate limit reached", "rate_limit_error", "rate_limit_exceeded"),
          { "retry-after": String(retryAfterSeconds) },
          retryAfterSeconds
        );
      }
      case "unavailable":
        return answer(
          "unavailable",
          503,
          errorBody("The server is overloaded", "server_error", "overloaded")
        );
      case "unauthorized":
        return unauthorized();
      case "context_overflow":
        return answer(
          "context_overflow",
          400,
          errorBody(
            "Your input exceeds the context window of this model",
            "invalid_request_error",
            "context_length_exceeded"
          )
        );
      case "malformed": {
        if (call) call.injectedRequests += 1;
        record("malformed", { status: 200, injected: true, synthetic: true });
        // A well-formed stream whose answer is cut JSON: the consumer refuses it and repairs.
        return new Response(malformedStream(), { status: 200, headers: sseHeaders });
      }
      case "late_first_byte":
        return this.lateFirstByte(signal, call, record);
      case "stall":
      case undefined:
        break;
    }

    // The request goes to the provider (once the cap admitted it); a planned stall wraps the answer.
    call?.beforeForward?.();
    if (call) call.forwardedRequests += 1;
    const response = await this.real(input, init);
    // A refusal by the provider (an HTTP error) bills nothing.
    if (call && !response.ok) call.refusedRequests += 1;
    if (fault?.kind !== "stall" || !response.body || !response.ok) {
      record("none", { status: response.status, injected: false, forwarded: requestBytes });
      return response;
    }
    return this.stalled(response, signal, requestBytes, record);
  };

  /**
   * The first byte comes late: the headers arrive at once and the body stays silent for the plan's
   * `lateFirstByteMs`. The client aborts at its first-byte bound; nothing is ever forwarded. A client
   * that waits the whole time gets a failed-response event.
   */
  private lateFirstByte(
    signal: AbortSignal | null | undefined,
    call: SoakCallContext | undefined,
    record: RecordExchange
  ): Response {
    if (call) call.injectedRequests += 1;
    const { lateFirstByteMs } = this.options.plan;
    const encoder = new TextEncoder();
    let finished = false;
    const finish = (outcome: "completed" | "client_closed", closedAt?: number) => {
      if (finished) return;
      finished = true;
      record("late_first_byte", {
        status: 200,
        injected: true,
        synthetic: true,
        outcome,
        plannedMs: lateFirstByteMs,
        ...(closedAt === undefined ? {} : { closedAt })
      });
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        try {
          await this.sleep(lateFirstByteMs, signal);
        } catch (error) {
          finish("client_closed", this.now());
          controller.error(error);
          return;
        }
        const event = {
          type: "response.failed",
          response: {
            error: {
              code: "server_error",
              message: `The first byte came late (${injectedTag}, synthetic shape)`
            }
          }
        };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        controller.close();
        finish("completed");
      },
      cancel: () => finish("client_closed", this.now())
    });
    return new Response(body, { status: 200, headers: sseHeaders });
  }

  /** The real answer with a silence of `stallMs` after its second piece of text. */
  private stalled(
    response: Response,
    signal: AbortSignal | null | undefined,
    requestBytes: number,
    record: RecordExchange
  ): Response {
    const reader = response.body!.getReader();
    const { stallMs } = this.options.plan;
    const decoder = new TextDecoder();
    let texts = 0;
    let stalledOnce = false;
    let lastWriteAt = this.now();
    let finished = false;
    const finish = (outcome: "completed" | "client_closed", closedAt?: number) => {
      if (finished) return;
      finished = true;
      // An answer that ended before it had two pieces of text was never stalled: it is a plain exchange.
      record(stalledOnce ? "stall" : "none", {
        status: response.status,
        injected: stalledOnce,
        forwarded: requestBytes,
        outcome,
        lastWriteAt,
        ...(stalledOnce ? { plannedMs: stallMs } : {}),
        ...(closedAt === undefined ? {} : { closedAt })
      });
    };
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          finish("client_closed", this.now());
          controller.error(error);
          return;
        }
        if (chunk.done) {
          finish("completed");
          controller.close();
          return;
        }
        controller.enqueue(chunk.value);
        lastWriteAt = this.now();
        texts += (
          decoder.decode(chunk.value, { stream: true }).match(/response\.output_text\.delta/gu) ??
          []
        ).length;
        if (!stalledOnce && texts >= 2) {
          stalledOnce = true;
          try {
            await this.sleep(stallMs, signal);
          } catch (error) {
            await reader.cancel(error).catch(() => undefined);
            finish("client_closed", this.now());
            controller.error(error);
          }
        }
      },
      cancel: async (reason) => {
        await reader.cancel(reason).catch(() => undefined);
        finish("client_closed", this.now());
      }
    });
    return new Response(body, { status: response.status, headers: response.headers });
  }
}
