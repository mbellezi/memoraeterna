/**
 * Minimal JSONL client for the native MLX helper (`native/mlx-helper`), used by the F0 spikes.
 *
 * One helper process, one request in flight at a time (local inference is serialized). A request
 * that times out kills the helper, because the helper cannot abandon a running forward pass.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

import { z } from "zod";

const repositoryRoot = resolve(import.meta.dirname, "..", "..", "..");
export const defaultHelperPath = join(
  repositoryRoot,
  "native",
  "mlx-helper",
  ".build",
  "release",
  "memora-mlx-helper"
);

const requestIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

const batchTimingSchema = z
  .object({
    size: z.number().int().positive(),
    sequenceLength: z.number().int().positive(),
    ms: z.number().nonnegative()
  })
  .strict();

const timingSchema = z
  .object({
    loadMs: z.number().nonnegative(),
    modelCached: z.boolean(),
    tokenizeMs: z.number().nonnegative(),
    inferenceMs: z.number().nonnegative(),
    perItemMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
    batches: z.array(batchTimingSchema)
  })
  .strict();

const progressSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("progress"),
    progress: z.number().min(0).max(1),
    messageKey: z.string().min(1)
  })
  .strict();

const failureSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(false),
    error: z
      .object({ code: z.string().min(1), messageKey: z.string().min(1), recoverable: z.boolean() })
      .strict()
  })
  .strict();

const textResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    output: z.string(),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional()
  })
  .strict();

const embedResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    embeddings: z.array(z.array(z.number())),
    dimensions: z.number().int().positive(),
    normalized: z.boolean(),
    pooling: z.enum(["mean", "cls", "first", "last", "max", "none"]),
    tokenCounts: z.array(z.number().int().positive()),
    truncated: z.array(z.boolean()),
    timing: timingSchema
  })
  .strict();

const scoreResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    scores: z.array(z.number().min(0).max(1)),
    logOdds: z.array(z.number()),
    yesTokenId: z.number().int().nonnegative(),
    noTokenId: z.number().int().nonnegative(),
    tokenCounts: z.array(z.number().int().positive()),
    truncated: z.array(z.boolean()),
    timing: timingSchema
  })
  .strict();

const messageSchema = z.union([
  progressSchema,
  failureSchema,
  embedResultSchema,
  scoreResultSchema,
  textResultSchema
]);

export type MlxHelperMessage = z.infer<typeof messageSchema>;
export type MlxHelperProgress = z.infer<typeof progressSchema>;
export type MlxEmbedResult = z.infer<typeof embedResultSchema>;
export type MlxScoreResult = z.infer<typeof scoreResultSchema>;
export type MlxTextResult = z.infer<typeof textResultSchema>;

export interface MlxEmbedRequest {
  modelPath: string;
  texts: string[];
  normalize?: boolean;
  dimensions?: number;
  maxTokens?: number;
  batchSize?: number;
}

export type MlxScoreRequest = {
  modelPath: string;
  instruction?: string;
  maxTokens?: number;
  batchSize?: number;
} & (
  | { query: string; documents: string[] }
  | { pairs: Array<{ query: string; document: string; instruction?: string }> }
);

export interface MlxHelperClientOptions {
  helperPath?: string;
  /** Default per-request timeout; individual calls may override it. */
  timeoutMs?: number;
  onProgress?: (message: MlxHelperProgress) => void;
}

export class MlxHelperError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "MlxHelperError";
  }
}

interface Pending {
  requestId: string;
  schema: z.ZodType;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class MlxHelperClient {
  private stderrTail = "";
  private pending: Pending | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private exited = false;
  private readonly exitPromise: Promise<void>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly options: MlxHelperClientOptions
  ) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-4_000);
    });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.onLine(line));
    this.exitPromise = new Promise((resolveExit) => {
      child.once("exit", (code, signal) => {
        this.exited = true;
        this.failPending(
          new MlxHelperError(
            `MLX helper exited (${code ?? signal ?? "unknown"})`,
            "helper_exited",
            this.stderrTail
          )
        );
        resolveExit();
      });
    });
    child.once("error", (error) => {
      this.failPending(new MlxHelperError(error.message, "spawn_failed", this.stderrTail));
    });
    // A write after the helper died fails with EPIPE; the exit handler reports it.
    child.stdin.on("error", () => undefined);
  }

  public static async start(options: MlxHelperClientOptions = {}): Promise<MlxHelperClient> {
    const helperPath = options.helperPath ?? defaultHelperPath;
    await access(helperPath);
    await access(join(resolve(helperPath, ".."), "mlx.metallib"));
    const child = spawn(helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        LANG: process.env.LANG ?? "en_US.UTF-8"
      }
    });
    const client = new MlxHelperClient(child, options);
    await client.health();
    return client;
  }

  public async health(): Promise<void> {
    await this.request({ command: "health" }, textResultSchema, 30_000);
  }

  public embed(input: MlxEmbedRequest, timeoutMs?: number): Promise<MlxEmbedResult> {
    return this.request({ command: "embed", ...input }, embedResultSchema, timeoutMs);
  }

  public score(input: MlxScoreRequest, timeoutMs?: number): Promise<MlxScoreResult> {
    return this.request({ command: "score", ...input }, scoreResultSchema, timeoutMs);
  }

  /** Sends `shutdown`, waits for a clean exit, and kills the process if it does not exit. */
  public async shutdown(timeoutMs = 5_000): Promise<void> {
    if (this.exited) return;
    try {
      await this.request({ command: "shutdown" }, textResultSchema, timeoutMs);
    } catch {
      // The process is killed below if it did not exit.
    }
    await Promise.race([this.exitPromise, delay(timeoutMs)]);
    this.kill();
  }

  public kill(): void {
    if (this.exited) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 1_000).unref();
  }

  private request<T extends z.ZodType>(
    body: Record<string, unknown>,
    schema: T,
    timeoutMs = this.options.timeoutMs ?? 10 * 60_000
  ): Promise<z.infer<T>> {
    const run = async (): Promise<z.infer<T>> => {
      if (this.exited) {
        throw new MlxHelperError("MLX helper is not running", "helper_exited", this.stderrTail);
      }
      const requestId = randomUUID();
      const result = new Promise<unknown>((resolvePending, rejectPending) => {
        const timer = setTimeout(() => {
          this.failPending(
            new MlxHelperError(`MLX helper timed out after ${timeoutMs} ms`, "timeout", "")
          );
          this.kill();
        }, timeoutMs);
        this.pending = { requestId, schema, resolve: resolvePending, reject: rejectPending, timer };
      });
      this.child.stdin.write(`${JSON.stringify({ protocolVersion: 1, requestId, ...body })}\n`);
      return (await result) as z.infer<T>;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return;
    }
    const parsed = messageSchema.safeParse(value);
    const pending = this.pending;
    if (!parsed.success) {
      if (pending) {
        this.failPending(
          new MlxHelperError(
            `Invalid helper message: ${parsed.error.message}`,
            "protocol",
            this.stderrTail
          )
        );
      }
      return;
    }
    const message = parsed.data;
    if (!pending || message.requestId !== pending.requestId) return;
    if (message.kind === "progress") {
      this.options.onProgress?.(message);
      return;
    }
    if (!message.ok) {
      this.failPending(
        new MlxHelperError(message.error.messageKey, message.error.code, this.stderrTail)
      );
      return;
    }
    const checked = pending.schema.safeParse(message);
    clearTimeout(pending.timer);
    this.pending = null;
    if (checked.success) pending.resolve(checked.data);
    else pending.reject(new MlxHelperError("Unexpected result shape", "protocol", this.stderrTail));
  }

  private failPending(error: Error): void {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    pending.reject(error);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms).unref());
}
