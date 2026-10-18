import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import type { z } from "zod";

import {
  mlxHelperEmbedResultSchema,
  mlxHelperHealthResultSchema,
  mlxHelperMessageSchema,
  mlxHelperRequestSchema,
  mlxHelperScoreResultSchema,
  mlxHelperTextResultSchema,
  type MlxEmbedInput,
  type MlxGenerationParameters,
  type MlxHelperCapability,
  type MlxHelperEmbedResult,
  type MlxHelperMessage,
  type MlxHelperProgress,
  type MlxHelperScoreResult,
  type MlxHelperSlot,
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
 * local-model error. `code` says what happened: `timeout`, `stalled`, `helper_exited`,
 * `spawn_failed`, `protocol`, `disposed`, or the helper's own error code. `stderr` is the tail of
 * the helper's diagnostics and must not be shown to the user.
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
  /**
   * Aborting stops the request. A helper that announced `cancel` is sent one and stays up with its
   * models loaded; an older helper, or one that has not answered `cancelGraceMs` later, is killed.
   */
  signal?: AbortSignal;
  onProgress?: (progress: Pick<MlxHelperProgress, "progress" | "messageKey">) => void;
  /** The pieces of text a streamed `generate` writes, in order. */
  onDelta?: (text: string) => void;
  /**
   * Longest silence between two `delta` lines once the first one came. A longer one stops the
   * request like its deadline does, with code `stalled`.
   */
  stallMs?: number;
}

export interface MlxGenerateInput {
  modelPath: string;
  prompt: string;
  parameters?: MlxGenerationParameters;
  /** Ask for `delta` lines (`onDelta`); a helper without `stream` answers with the whole text only. */
  stream?: boolean;
}

/**
 * What `unload` did: the slot's model was dropped (`unloaded`), no helper runs so nothing is loaded
 * (`not_running`), or the helper is an older build without `unload` (`unsupported`): only stopping
 * it frees the slot.
 */
export type MlxUnloadOutcome = "unloaded" | "not_running" | "unsupported";

/** One spawned helper process and the single request it may be answering. */
interface HelperProcess {
  readonly child: ChildProcessWithoutNullStreams;
  stderr: string;
  /** Set when the process is gone or is being killed; it is never written to again. */
  exited: boolean;
  /** Set once the helper survived its first answer, so it is not a one-request-per-process helper. */
  persistent: boolean;
  /** Requests it answered. */
  answers: number;
  /** Why the process could not start (for example a missing executable). */
  startupError: MlxHelperError | null;
  active: ActiveRequest | null;
  /** What the process announced in `health`; null until it answered one. */
  capabilities: ReadonlySet<string> | null;
  /** The model each slot holds as far as the host knows: answered requests and unloads. */
  readonly loaded: Map<MlxHelperSlot, string>;
  /** Resolves when the process has exited or failed to start. */
  readonly gone: Promise<void>;
  markGone: () => void;
}

interface ActiveRequest {
  readonly requestId: string;
  onMessage: (message: MlxHelperMessage) => void;
  onFailure: (error: Error) => void;
}

type HelperRequest = z.infer<typeof mlxHelperRequestSchema>;

/**
 * The one supervised MLX helper process of a runtime. `generate`, `embed` and `score` all go to
 * the same process, which keeps at most one model loaded per command kind. Requests are
 * serialized (local inference runs one call at a time) and the next request spawns a fresh helper
 * once a killed one is gone, so two helpers never overlap.
 *
 * A fresh process is asked for its capabilities (`health`) before its first request (F3 D39). At a
 * deadline or an abort a helper that can is sent `cancel` and keeps its PID and its loaded models;
 * one that cannot, or that has not answered the cancel within `cancelGraceMs`, is killed.
 */
export class MlxHelperHost {
  public readonly config: MlxRuntimeConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private current: HelperProcess | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private spawned = 0;
  /** Cleared once the executable proved to exit after each answer: it has no capabilities to ask. */
  private probeCapabilities = true;

  public constructor(private readonly options: MlxHelperHostOptions) {
    this.environment = options.environment ?? process.env;
    this.config = resolveMlxRuntimeConfig(options.config, this.environment);
  }

  /** The process ID of the running helper, if one is running. */
  public get pid(): number | undefined {
    const current = this.running();
    return current?.child.pid;
  }

  /** How many helper processes this host has started. */
  public get spawnCount(): number {
    return this.spawned;
  }

  /** What the running helper announced; undefined while none runs or before it was asked. */
  public get capabilities(): ReadonlySet<string> | undefined {
    return this.running()?.capabilities ?? undefined;
  }

  /** Whether the running helper announced a capability. */
  public supports(capability: MlxHelperCapability): boolean {
    return this.running()?.capabilities?.has(capability) === true;
  }

  /** The model the running helper holds in a slot, as far as the host knows. */
  public loadedModel(slot: MlxHelperSlot): string | undefined {
    return this.running()?.loaded.get(slot);
  }

  /** Starts the helper if needed and checks that it answers. */
  public async health(options: MlxHelperCallOptions = {}): Promise<void> {
    await this.call({ command: "health" }, mlxHelperHealthResultSchema, {
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
        ...(input.parameters ? { parameters: input.parameters } : {}),
        ...(input.stream ? { stream: true } : {})
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
   * Drops one slot's model from the running helper, after the request it may be answering; the
   * other slots keep theirs and the process keeps its PID. It never starts a helper.
   */
  public unload(slot: MlxHelperSlot): Promise<MlxUnloadOutcome> {
    const epoch = this.epoch;
    return this.serialize(undefined, async (): Promise<MlxUnloadOutcome> => {
      const helper = this.running();
      if (epoch !== this.epoch || !helper) return "not_running";
      if (!helper.capabilities && this.probeCapabilities) await this.probe(helper, undefined);
      if (helper.exited) return "not_running";
      if (!helper.capabilities?.has("unload")) return "unsupported";
      const requestId = randomUUID();
      await this.execute(
        helper,
        mlxHelperRequestSchema.parse({ protocolVersion: 1, requestId, command: "unload", slot }),
        requestId,
        mlxHelperTextResultSchema,
        { timeoutMs: this.config.healthTimeoutMs }
      );
      return "unloaded";
    });
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

  private running(): HelperProcess | undefined {
    const current = this.current;
    return current && !current.exited ? current : undefined;
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
      for (let attempt = 0; ; attempt += 1) {
        if (epoch !== this.epoch) throw new MlxHelperError(runtimeFailedKey, "disposed", true, "");
        throwIfAborted(options.signal);
        const helper = await this.ready(options.signal, request.data.command !== "health");
        try {
          return await this.execute(helper, request.data, requestId, resultSchema, options);
        } catch (error) {
          if (attempt > 0 || !exitedAfterAnswering(helper, error)) throw error;
          // An older helper that serves one request per process exited after its last answer,
          // slower than the persistence probe saw: this request never ran; a fresh process takes it.
          this.probeCapabilities = false;
        }
      }
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

  /** The running helper, asked for its capabilities first when it is fresh. */
  private async ready(
    signal: AbortSignal | undefined,
    needsCapabilities: boolean
  ): Promise<HelperProcess> {
    for (;;) {
      const helper = await this.acquire();
      if (!needsCapabilities || helper.capabilities || !this.probeCapabilities) return helper;
      await this.probe(helper, signal);
      if (!helper.exited) return helper;
      // It answered and exited: an older helper that serves one request per process.
      this.probeCapabilities = false;
    }
  }

  private async probe(helper: HelperProcess, signal: AbortSignal | undefined): Promise<void> {
    const requestId = randomUUID();
    await this.execute(
      helper,
      mlxHelperRequestSchema.parse({ protocolVersion: 1, requestId, command: "health" }),
      requestId,
      mlxHelperHealthResultSchema,
      { timeoutMs: this.config.healthTimeoutMs, ...(signal ? { signal } : {}) }
    );
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
      answers: 0,
      startupError: null,
      active: null,
      capabilities: null,
      loaded: new Map(),
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
    helper.loaded.clear();
    if (this.current === helper) this.current = null;
    helper.markGone();
  }

  private execute<S extends z.ZodType>(
    helper: HelperProcess,
    request: HelperRequest,
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
    const slot = requestSlot(request);
    const modelPath = "modelPath" in request ? request.modelPath : undefined;
    const before = slot ? helper.loaded.get(slot) : undefined;
    // Only inference can be cancelled; a `health` or `unload` that does not answer is a stuck helper.
    const cancellable = slot !== null && helper.capabilities?.has("cancel") === true;
    const answer = new Promise<z.infer<S>>((resolve, reject) => {
      let settled = false;
      let interruption: Error | null = null;
      let graceTimer: NodeJS.Timeout | undefined;
      let stallTimer: NodeJS.Timeout | undefined;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(graceTimer);
        clearTimeout(stallTimer);
        options.signal?.removeEventListener("abort", onAbort);
        if (helper.active?.requestId === requestId) helper.active = null;
        settle();
      };
      const killWith = (error: Error) => {
        finish(() => reject(error));
        this.kill(helper);
      };
      // What a slot holds after a request that did not succeed: a failed generation drops its
      // model, and a request that was loading another model may have dropped the old one.
      const forgetSlot = (failedGeneration: boolean) => {
        if (slot && (failedGeneration || before !== modelPath)) helper.loaded.delete(slot);
      };
      /** Stops the request: `cancel` and a grace period on a helper that can, else the kill. */
      const interrupt = (error: Error) => {
        if (settled || interruption) return;
        interruption = error;
        clearTimeout(timer);
        clearTimeout(stallTimer);
        forgetSlot(false);
        if (!cancellable || helper.exited) {
          killWith(error);
          return;
        }
        helper.child.stdin.write(
          `${JSON.stringify({ protocolVersion: 1, requestId, command: "cancel" })}\n`
        );
        graceTimer = setTimeout(() => killWith(error), this.config.cancelGraceMs);
      };
      const onAbort = () => interrupt(abortError());
      const timer = setTimeout(
        () => interrupt(new MlxHelperError(runtimeFailedKey, "timeout", true, helper.stderr)),
        timeoutMs
      );
      const armStall = () => {
        if (options.stallMs === undefined) return;
        clearTimeout(stallTimer);
        stallTimer = setTimeout(
          () => interrupt(new MlxHelperError(runtimeFailedKey, "stalled", true, helper.stderr)),
          options.stallMs
        );
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      helper.active = {
        requestId,
        onFailure: (error) => finish(() => reject(interruption ?? error)),
        onMessage: (message) => {
          if (message.kind === "result") helper.answers += 1;
          if (interruption) {
            // The stopped request answered (cancelled, or done just before the cancel arrived):
            // the helper is free for the next request and keeps its models.
            if (message.kind === "result") finish(() => reject(interruption));
            return;
          }
          if (message.kind === "progress") {
            options.onProgress?.({ progress: message.progress, messageKey: message.messageKey });
            return;
          }
          if (message.kind === "delta") {
            armStall();
            options.onDelta?.(message.delta);
            return;
          }
          if (!message.ok) {
            forgetSlot(request.command === "generate");
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
          if (!checked.success) {
            killWith(new MlxHelperError(runtimeFailedKey, "protocol", false, helper.stderr));
            return;
          }
          if (request.command === "health") {
            helper.capabilities = new Set(
              (checked.data as { capabilities?: string[] }).capabilities ?? []
            );
          } else if (request.command === "unload") {
            helper.loaded.delete(request.slot);
          } else if (slot && modelPath) {
            helper.loaded.set(slot, modelPath);
          }
          finish(() => resolve(checked.data));
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
    helper.loaded.clear();
    helper.child.kill("SIGTERM");
    setTimeout(() => {
      if (helper.child.exitCode === null && helper.child.signalCode === null) {
        helper.child.kill("SIGKILL");
      }
    }, this.config.killGraceMs).unref();
  }
}

/**
 * The helper ended cleanly (exit code 0) without answering this request, after it had answered
 * an earlier one: an older one-request-per-process helper, not a crash.
 */
function exitedAfterAnswering(helper: HelperProcess, error: unknown): boolean {
  return (
    error instanceof MlxHelperError &&
    error.code === "helper_exited" &&
    helper.child.exitCode === 0 &&
    helper.answers > 0
  );
}

/** The model slot an inference request uses; null for the other commands. */
function requestSlot(request: HelperRequest): MlxHelperSlot | null {
  return request.command === "generate" ||
    request.command === "embed" ||
    request.command === "score"
    ? request.command
    : null;
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
