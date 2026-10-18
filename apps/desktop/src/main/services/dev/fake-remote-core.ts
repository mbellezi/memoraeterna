import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import type { AddressInfo, Socket } from "node:net";

import type { FaultWindowKind, SoakEventSink } from "./soak-records.js";

/**
 * The engine of the DEV fake remote providers (F3 R6, T62): an HTTP server on loopback that plays a
 * scripted reply, writes one record per generation request and can be stopped and started again on
 * the same port (an outage: the connection is refused, not answered). What a provider says is a
 * `FakeProviderKind` (the OpenAI-compatible fake, the Codex-wire fake, later perhaps a third remote
 * kind); what goes wrong is added around a kind by `withFaults` (fault-decorator.ts), so a new kind
 * is covered by the same faults, ledger and report with no redesign.
 */

export interface FakeHttpRequest {
  method: string;
  /** The path without its query string. */
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** One piece of a reply body. */
export interface ReplyPart {
  /** Wait before this piece is written, counted from the previous piece (or from the headers). */
  delayMs: number;
  data: string;
  /** The piece carries answer text: a stall is injected after the first of these. */
  text?: boolean;
}

/** What a request is answered with, as a plan the server plays. */
export interface ReplyScript {
  status: number;
  headers: Record<string, string>;
  /** The headers are sent at once; the body follows piece by piece. */
  parts: ReplyPart[];
  /** What the exchange record says about the reply. */
  tag?: ReplyTag;
}

export interface ReplyTag {
  kind: "none" | "rate_limit" | "unavailable" | "stall" | "late_first_byte" | "malformed" | "slow";
  injected: boolean;
  retryAfterSeconds?: number;
}

/** The identity of a generation request, for the answer and for the fault schedule. */
export interface FakeCallContext {
  /** Generation requests this provider served so far, this one included; 0 for other routes. */
  seq: number;
  /** Milliseconds since the provider started. */
  elapsedMs: number;
}

/** A wire protocol the fake speaks. */
export interface FakeProviderKind {
  /** The provider name in records and in the report (`openai-compatible`, `codex-wire`). */
  readonly provider: string;
  /** Whether the request carries the credentials of the DEV stub. */
  authorize(headers: IncomingHttpHeaders): boolean;
  /** Whether the request is a generation call: the only requests faults apply to. */
  isGeneration(request: FakeHttpRequest): boolean;
  /** The normal reply to a request. */
  reply(request: FakeHttpRequest, context: FakeCallContext): ReplyScript;
  /** The same reply with the answer text another one, for a malformed answer. */
  replyWithText(request: FakeHttpRequest, context: FakeCallContext, text: string): ReplyScript;
  /** An answer the consumer cannot validate. */
  malformedText(request: FakeHttpRequest, context: FakeCallContext): string;
  rateLimited(retryAfterSeconds: number): ReplyScript;
  unavailable(): ReplyScript;
}

/** A moment of unusual behaviour, in minutes from the start of the fake. */
export interface FakeWindow {
  kind: FaultWindowKind;
  startMs: number;
  durationMs: number;
  /** Latency multiplier of a `slow` window. */
  factor?: number | undefined;
}

/** Latency of a generation call: the time from request to the end of its answer. */
export interface LatencyModel {
  /** The duration for a draw `u` in [0, 1). */
  sample(u: number): number;
}

export function fixedLatency(milliseconds: number): LatencyModel {
  return { sample: () => milliseconds };
}

/**
 * Draws from a recorded distribution: `quantilesMs` are the sorted durations at evenly spaced
 * quantiles from the minimum to the maximum, and a draw interpolates between them. Clamped to
 * `[minMs, maxMs]`.
 */
export function quantileLatency(
  quantilesMs: readonly number[],
  clamp: { minMs?: number; maxMs?: number } = {}
): LatencyModel {
  if (quantilesMs.length < 2)
    throw new Error("A latency distribution needs at least two quantiles.");
  const sorted = [...quantilesMs].sort((a, b) => a - b);
  const { minMs = 0, maxMs = Number.POSITIVE_INFINITY } = clamp;
  return {
    sample(u) {
      const position = Math.min(Math.max(u, 0), 0.999999) * (sorted.length - 1);
      const lower = Math.floor(position);
      const fraction = position - lower;
      const value = sorted[lower]! + (sorted[lower + 1]! - sorted[lower]!) * fraction;
      return Math.round(Math.min(Math.max(value, minMs), maxMs));
    }
  };
}

/** A repeatable number in [0, 1) for a seed, a label and a sequence number (no shared state). */
export function seededUnit(seed: number, label: string, sequence: number, salt = ""): number {
  const digest = createHash("sha256").update(`${seed}:${label}:${sequence}:${salt}`).digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/** A server-sent event line: `data: <json>` and a blank line. */
export function sseData(value: unknown): string {
  return `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`;
}

/** Splits an answer into at least `minimum` pieces of about `size` characters, on spaces. */
export function splitAnswer(text: string, size = 28, minimum = 4): string[] {
  const target = Math.max(1, Math.min(size, Math.ceil(text.length / minimum)));
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= target) {
      pieces.push(rest);
      break;
    }
    const space = rest.lastIndexOf(" ", target);
    const cut = space > 0 ? space + 1 : target;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  return pieces;
}

/**
 * Spreads a call of `totalMs` over its pieces: the first answer text comes after `firstFraction` of
 * the time (the time to first token), the rest evenly after it. Lifecycle pieces with no text
 * (`lead`) come at once.
 */
export function timedParts(
  lead: readonly string[],
  answer: readonly string[],
  tail: readonly string[],
  totalMs: number,
  firstFraction: number
): ReplyPart[] {
  const first = Math.round(totalMs * firstFraction);
  const step = answer.length > 1 ? Math.round((totalMs - first) / (answer.length - 1)) : 0;
  return [
    ...lead.map((data) => ({ delayMs: 0, data })),
    ...answer.map((data, index) => ({
      delayMs: index === 0 ? first : step,
      data,
      text: true as const
    })),
    ...tail.map((data) => ({ delayMs: 0, data }))
  ];
}

/** A reply with one JSON body, written after `delayMs`. */
export function jsonReply(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
  delayMs = 0
): ReplyScript {
  return {
    status,
    headers: { "content-type": "application/json", ...headers },
    parts: [{ delayMs, data: JSON.stringify(body) }]
  };
}

/** The JSON a request carries, or null when it is not a JSON object. */
export function jsonBody(request: FakeHttpRequest): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(request.body);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Tokens a fake reports for a text: a quarter of its characters, as a rough stand-in. */
export function fakeTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** The sum of a script's waits: how long the fake plans to take. */
export function plannedMs(script: ReplyScript): number {
  return script.parts.reduce((total, part) => total + part.delayMs, 0);
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface FakeProviderServerOptions {
  kind: FakeProviderKind;
  sink: SoakEventSink;
  /** Outages and slow windows, from the start of the fake. */
  windows?: readonly FakeWindow[];
  /** Listen address; loopback only. */
  host?: "127.0.0.1";
  now?: () => number;
}

/**
 * One fake provider: listens on loopback, plays the scripts of its kind, and records every
 * generation request. An outage window stops the listener (so a connection is refused) and starts it
 * again on the same port when the window ends.
 */
export class FakeProviderServer {
  private server: Server | null = null;
  private port: number | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private readonly now: () => number;
  private startedAt = 0;
  private sequence = 0;
  private finished = false;

  public constructor(private readonly options: FakeProviderServerOptions) {
    this.now = options.now ?? Date.now;
  }

  public get provider(): string {
    return this.options.kind.provider;
  }

  /** `http://127.0.0.1:<port>`, once started. */
  public get origin(): string {
    if (this.port === null) throw new Error("The fake provider is not started.");
    return `http://${this.options.host ?? "127.0.0.1"}:${this.port}`;
  }

  /** Requests of generation kind served so far. */
  public get served(): number {
    return this.sequence;
  }

  public async start(): Promise<void> {
    this.startedAt = this.now();
    await this.listen();
    for (const window of this.options.windows ?? []) this.arm(window);
  }

  /**
   * Counts the elapsed time (the planned windows and forced faults) from now on. The soak driver
   * calls it as it starts, so the plan's hours are the driver's hours, however long the models took
   * to come up after the fakes did.
   */
  public restartClock(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.startedAt = this.now();
    for (const window of this.options.windows ?? []) this.arm(window);
  }

  /** Stops for good: the listener, the open exchanges and the pending windows. */
  public async stop(): Promise<void> {
    this.finished = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    await this.close();
  }

  private arm(window: FakeWindow): void {
    const schedule = (action: () => void, delay: number) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        action();
      }, delay);
      timer.unref?.();
      this.timers.add(timer);
    };
    const record = (startedAt: number, endedAt: number) =>
      this.options.sink.append({
        type: "window",
        provider: this.provider,
        kind: window.kind,
        startedAt: new Date(startedAt).toISOString(),
        endedAt: new Date(endedAt).toISOString(),
        factor: window.kind === "slow" ? (window.factor ?? 10) : null
      });
    if (window.kind === "slow") {
      // Slow answers need no action: the fault decorator reads the window from the elapsed time.
      // Its record is written when it ends, like the others.
      schedule(
        () =>
          record(
            this.startedAt + window.startMs,
            this.startedAt + window.startMs + window.durationMs
          ),
        window.startMs + window.durationMs
      );
      return;
    }
    schedule(() => {
      if (this.finished) return;
      const begin = this.now();
      void this.close().then(() => {
        schedule(
          () => {
            if (this.finished) return;
            void this.listen().then(() => record(begin, this.now()));
          },
          Math.max(0, begin + window.durationMs - this.now())
        );
      });
    }, window.startMs);
  }

  private listen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handle(request, response).catch(() => {
          if (!response.headersSent) response.writeHead(500).end();
          else response.destroy();
        });
      });
      server.on("connection", (socket) => {
        this.sockets.add(socket);
        socket.on("close", () => this.sockets.delete(socket));
      });
      server.once("error", reject);
      server.listen(this.port ?? 0, this.options.host ?? "127.0.0.1", () => {
        this.port = (server.address() as AddressInfo).port;
        this.server = server;
        server.off("error", reject);
        resolve();
      });
    });
  }

  private async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handle(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const startedAt = this.now();
    const url = new URL(incoming.url ?? "/", "http://fake.invalid");
    const request: FakeHttpRequest = {
      method: incoming.method ?? "GET",
      path: url.pathname,
      headers: incoming.headers,
      body: await readBody(incoming)
    };
    const { kind } = this.options;
    if (!kind.authorize(request.headers)) {
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(
          JSON.stringify({ error: { message: "invalid DEV credentials", code: "invalid_api_key" } })
        );
      return;
    }
    const generation = kind.isGeneration(request);
    const context: FakeCallContext = {
      seq: generation ? ++this.sequence : 0,
      elapsedMs: startedAt - this.startedAt
    };
    const script = kind.reply(request, context);
    await this.play(response, script, generation ? context.seq : null, startedAt);
  }

  private async play(
    response: ServerResponse,
    script: ReplyScript,
    seq: number | null,
    startedAt: number
  ): Promise<void> {
    let lastWriteAt = this.now();
    const gone = new AbortController();
    let outcome: "completed" | "client_closed" | "server_stopped" | null = null;
    response.on("close", () => {
      if (outcome === "completed") return;
      const stopped = this.server === null;
      outcome = stopped ? "server_stopped" : "client_closed";
      gone.abort();
    });
    response.writeHead(script.status, script.headers);
    response.flushHeaders();
    for (const part of script.parts) {
      if (part.delayMs > 0) await wait(part.delayMs, gone.signal);
      if (gone.signal.aborted) break;
      response.write(part.data);
      lastWriteAt = this.now();
    }
    if (!gone.signal.aborted) {
      outcome = "completed";
      response.end();
    }
    if (seq === null) return;
    const endedAt = this.now();
    const left = outcome !== "completed";
    const tag = script.tag ?? { kind: "none" as const, injected: false };
    this.options.sink.append({
      type: "exchange",
      provider: this.provider,
      seq,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      kind: tag.kind,
      injected: tag.injected,
      status: script.status,
      outcome: outcome ?? "client_closed",
      closedAfterMs: left ? endedAt - startedAt : null,
      closedAfterLastWriteMs: left ? endedAt - lastWriteAt : null,
      retryAfterSeconds: tag.retryAfterSeconds ?? null,
      plannedMs: plannedMs(script)
    });
  }
}

/** Waits, or returns early when `signal` aborts (the client left). */
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", done);
      clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
