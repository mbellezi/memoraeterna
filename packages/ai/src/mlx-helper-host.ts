import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { z } from "zod";

import {
  mlxHelperEmbedResultSchema,
  mlxHelperMessageSchema,
  mlxHelperRequestSchema,
  mlxHelperScoreResultSchema,
  mlxHelperTextResultSchema,
  type MlxEmbedInput,
  type MlxGenerationParameters,
  type MlxHelperEmbedResult,
  type MlxHelperMessage,
  type MlxHelperProgress,
  type MlxHelperScoreResult,
  type MlxHelperTextResult,
  type MlxScoreInput
} from "./local-runtime-protocol.js";
import {
  mlxHelperEnvironment,
  resolveMlxRuntimeConfig,
  type MlxRuntimeConfig,
  type MlxRuntimeConfigInput
} from "./runtime-config.js";

const runtimeFailedKey = "errors.localModels.runtimeFailed";

/**
 * A failed helper request. `message` is a localization key (the helper's own, or the generic
 * runtime failure key), so job failure classification and the UI treat it like every other
 * local-model error. `code` says what happened: `timeout`, `helper_exited`, `spawn_failed`,
 * `protocol`, `disposed`, or the helper's own error code. `stderr` is the tail of the helper's
 * diagnostics and must not be shown to the user.
 */
export class MlxHelperError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly recoverable: boolean,
    public readonly stderr: string
  ) {
    super(message);
    this.name = "MlxHelperError";
  }
}

export interface MlxHelperHostOptions {
  helperPath: string;
  config?: MlxRuntimeConfigInput;
  /** The environment the helper's is derived from; defaults to `process.env`. */
  environment?: NodeJS.ProcessEnv;
}

export interface MlxHelperCallOptions {
  /** Deadline from the start of execution; the wait for earlier requests does not count. */
  timeoutMs?: number;
  /** Aborting kills the helper, because it cannot abandon a running forward pass. */
  signal?: AbortSignal;
  onProgress?: (progress: Pick<MlxHelperProgress, "progress" | "messageKey">) => void;
}

export interface MlxGenerateInput {
  modelPath: string;
  prompt: string;
  parameters?: MlxGenerationParameters;
}

/** One spawned helper process and the single request it may be answering. */
interface HelperProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stderr: string;
  /** Set when the process is gone or is being killed; it is never written to again. */
  exited: boolean;
  /** Set once the helper survived its first answer, so it is not a one-request-per-process helper. */
  persistent: boolean;
  /** Why the process could not start (for example a missing executable). */
  startupError: MlxHelperError | null;
  active: ActiveRequest | null;
  /** Resolves when the process has exited or failed to start. */
  readonly gone: Promise<void>;
  markGone: () => void;
}

interface ActiveRequest {
  readonly requestId: string;
  onMessage: (message: MlxHelperMessage) => void;
  onFailure: (error: Error) => void;
}

/**
 * The one supervised MLX helper process of a runtime. `generate`, `embed` and `score` all go to
 * the same process, which keeps at most one model loaded per command kind. Requests are
 * serialized (local inference runs one call at a time), a timeout or an abort kills the helper,
 * and the next request spawns a fresh one once the old one is gone, so two helpers never overlap.
 */
export class MlxHelperHost {
  public readonly config: MlxRuntimeConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private current: HelperProcess | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private spawned = 0;

  public constructor(private readonly options: MlxHelperHostOptions) {
    this.environment = options.environment ?? process.env;
    this.config = resolveMlxRuntimeConfig(options.config, this.environment);
  }

  /** The process ID of the running helper, if one is running. */
  public get pid(): number | undefined {
    const current = this.current;
    return current && !current.exited ? current.child.pid : undefined;
  }

  /** How many helper processes this host has started. */
  public get spawnCount(): number {
    return this.spawned;
  }

  /** Starts the helper if needed and checks that it answers. */
  public async health(options: MlxHelperCallOptions = {}): Promise<void> {
    await this.call({ command: "health" }, mlxHelperTextResultSchema, {
      timeoutMs: this.config.healthTimeoutMs,
      ...options
    });
  }

  public generate(
    input: MlxGenerateInput,
    options: MlxHelperCallOptions = {}
  ): Promise<MlxHelperTextResult> {
    return this.call(
      {
        command: "generate",
        modelPath: input.modelPath,
        prompt: input.prompt,
        ...(input.parameters ? { parameters: input.parameters } : {})
      },
      mlxHelperTextResultSchema,
      options
    );
  }

  public embed(
    input: MlxEmbedInput,
    options: MlxHelperCallOptions = {}
  ): Promise<MlxHelperEmbedResult> {
    return this.call({ command: "embed", ...input }, mlxHelperEmbedResultSchema, options);
  }

  public score(
    input: MlxScoreInput,
    options: MlxHelperCallOptions = {}
  ): Promise<MlxHelperScoreResult> {
    return this.call({ command: "score", ...input }, mlxHelperScoreResultSchema, options);
  }

  /**
   * Kills the helper and rejects the request it was answering and every queued one. The host
   * stays usable: the next request spawns a fresh helper.
   */
  public async dispose(): Promise<void> {
    this.epoch += 1;
    const current = this.current;
    this.current = null;
    if (!current) return;
    this.fail(current, new MlxHelperError(runtimeFailedKey, "disposed", true, current.stderr));
    this.kill(current);
    await current.gone;
  }

  private call<S extends z.ZodType>(
    body: Record<string, unknown>,
    resultSchema: S,
    options: MlxHelperCallOptions
  ): Promise<z.infer<S>> {
    const requestId = randomUUID();
    // Invalid input fails here, before the request waits for its turn.
    const request = mlxHelperRequestSchema.safeParse({ protocolVersion: 1, requestId, ...body });
    if (!request.success) return Promise.reject(request.error);
    const epoch = this.epoch;
    return this.serialize(options.signal, async () => {
      if (epoch !== this.epoch) throw new MlxHelperError(runtimeFailedKey, "disposed", true, "");
      throwIfAborted(options.signal);
      const helper = await this.acquire();
      return this.execute(helper, request.data, requestId, resultSchema, options);
    });
  }

  /** Runs jobs one at a time; a job whose signal aborts while it waits rejects at once. */
  private serialize<T>(signal: AbortSignal | undefined, job: () => Promise<T>): Promise<T> {
    const result = this.tail.then(job, job);
    this.tail = result.catch(() => undefined);
    if (!signal) return result;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(abortError());
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      result.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }

  /** The running helper, or a new one once any killed predecessor has exited. */
  private async acquire(): Promise<HelperProcess> {
    for (;;) {
      const current = this.current;
      if (current && !current.exited) return current;
      if (current) {
        this.current = null;
        await current.gone;
        continue;
      }
      return this.spawnHelper();
    }
  }

  private spawnHelper(): HelperProcess {
    const child = spawn(this.options.helperPath, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: mlxHelperEnvironment(this.config, this.environment)
    });
    let markGone: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      markGone = resolve;
    });
    const helper: HelperProcess = {
      child,
      stderr: "",
      exited: false,
      persistent: false,
      startupError: null,
      active: null,
      gone,
      markGone
    };
    this.current = helper;
    this.spawned += 1;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      helper.stderr = tail(`${helper.stderr}${chunk}`, this.config.stderrTailChars);
    });
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(helper, line));
    // A write to a helper that just died fails with EPIPE; the exit handlers report it.
    child.stdin.on("error", () => undefined);
    child.once("error", (error) => {
      helper.startupError = new MlxHelperError(
        runtimeFailedKey,
        "spawn_failed",
        false,
        error.message
      );
      this.release(helper);
      this.fail(helper, helper.startupError);
    });
    child.once("exit", () => this.release(helper));
    // `close` follows `exit` once stdout is drained, so an answer written just before exiting still
    // reaches its request.
    child.once("close", () => {
      this.release(helper);
      this.fail(helper, new MlxHelperError(runtimeFailedKey, "helper_exited", true, helper.stderr));
    });
    return helper;
  }

  private release(helper: HelperProcess): void {
    helper.exited = true;
    if (this.current === helper) this.current = null;
    helper.markGone();
  }

  private execute<S extends z.ZodType>(
    helper: HelperProcess,
    request: z.infer<typeof mlxHelperRequestSchema>,
    requestId: string,
    resultSchema: S,
    options: MlxHelperCallOptions
  ): Promise<z.infer<S>> {
    if (helper.exited) {
      return Promise.reject(
        helper.startupError ??
          new MlxHelperError(runtimeFailedKey, "helper_exited", true, helper.stderr)
      );
    }
    const timeoutMs = options.timeoutMs ?? this.config.requestTimeoutMs;
    const answer = new Promise<z.infer<S>>((resolve, reject) => {
      let settled = false;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (helper.active?.requestId === requestId) helper.active = null;
        settle();
      };
      const stop = (error: Error) => {
        finish(() => reject(error));
        this.kill(helper);
      };
      const onAbort = () => stop(abortError());
      const timer = setTimeout(
        () => stop(new MlxHelperError(runtimeFailedKey, "timeout", true, helper.stderr)),
        timeoutMs
      );
      options.signal?.addEventListener("abort", onAbort, { once: true });
      helper.active = {
        requestId,
        onFailure: (error) => finish(() => reject(error)),
        onMessage: (message) => {
          if (message.kind === "progress") {
            options.onProgress?.({ progress: message.progress, messageKey: message.messageKey });
            return;
          }
          if (!message.ok) {
            finish(() =>
              reject(
                new MlxHelperError(
                  message.error.messageKey,
                  message.error.code,
                  message.error.recoverable,
                  helper.stderr
                )
              )
            );
            return;
          }
          const checked = resultSchema.safeParse(message);
          if (checked.success) finish(() => resolve(checked.data));
          else stop(new MlxHelperError(runtimeFailedKey, "protocol", false, helper.stderr));
        }
      };
      helper.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
    return answer.then(async (result) => {
      await this.confirmPersistence(helper);
      return result;
    });
  }

  /**
   * An older helper exits after each request. Watching a fresh helper briefly after its first
   * answer makes the next request spawn a new process instead of writing to a dying one.
   */
  private async confirmPersistence(helper: HelperProcess): Promise<void> {
    if (helper.persistent || helper.exited) return;
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      helper.gone.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), this.config.persistenceProbeMs);
      })
    ]);
    clearTimeout(timer);
    if (!exited) helper.persistent = true;
  }

  private onLine(helper: HelperProcess, line: string): void {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      // Native MLX diagnostics can appear on stdout outside the protocol.
      return;
    }
    const active = helper.active;
    const parsed = mlxHelperMessageSchema.safeParse(value);
    if (!parsed.success) {
      if (active) {
        this.fail(helper, new MlxHelperError(runtimeFailedKey, "protocol", false, helper.stderr));
        this.kill(helper);
      }
      return;
    }
    if (active && parsed.data.requestId === active.requestId) active.onMessage(parsed.data);
  }

  private fail(helper: HelperProcess, error: Error): void {
    helper.active?.onFailure(error);
  }

  /** SIGTERM, then SIGKILL after the grace period. The caller no longer uses this helper. */
  private kill(helper: HelperProcess): void {
    if (helper.exited) return;
    helper.exited = true;
    helper.child.kill("SIGTERM");
    setTimeout(() => {
      if (helper.child.exitCode === null && helper.child.signalCode === null) {
        helper.child.kill("SIGKILL");
      }
    }, this.config.killGraceMs).unref();
  }
}

function tail(text: string, characters: number): string {
  return characters === 0 ? "" : text.slice(-characters);
}

function abortError(): DOMException {
  return new DOMException("Local inference canceled.", "AbortError");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError();
}
