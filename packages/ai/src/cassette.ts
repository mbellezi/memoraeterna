import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod";
import { AiOutputSchemaSchema } from "@app/domain";

import type {
  AiEmbedManyOptions,
  AiEmbedManyResult,
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";
import { embedManyRequest, sumTokenUsage } from "./embed-many.js";

/**
 * DEV-only AI cassettes. A cassette wraps `AiModelAdapter.run`/`runStreaming`, so it sees every AI
 * task execution (remote generation, local generation, embeddings, reranking) after routing and
 * prompt composition. `record` serves calls already in the cassette and calls the provider only for
 * new ones; `replay` serves recorded calls and never reaches the provider: a miss fails the call.
 * Packaged builds refuse cassettes, and a cassette lives under `<repository>/.cache/` (it holds the
 * full prompts and outputs, which are library text).
 *
 * `embedMany` is served and recorded per text, under the key of the single `run` of that text (F3
 * D37): a cassette recorded with single calls serves a batch, and a batch records entries a single
 * call finds. A miss is the only thing the real `embedMany` is asked for.
 */
export const aiCassetteModes = ["off", "record", "replay"] as const;
export type AiCassetteMode = (typeof aiCassetteModes)[number];

/**
 * What a replay does with a request the cassette does not hold (F3 D41). `fail` is the replay's
 * contract. `live` (`MEMORA_AI_CASSETTE_LOCAL_MISSES=live`, DEV, golden and E6 runners) lets a miss on a
 * local runtime (ranker, local writer, local embedder) run live, recorded into the cassette copy and
 * counted by task; a miss on a remote runtime still fails.
 */
export const aiCassetteLocalMissPolicies = ["fail", "live"] as const;
export type AiCassetteLocalMissPolicy = (typeof aiCassetteLocalMissPolicies)[number];

/**
 * How long a served entry takes (F3 D5, 3.17). `off` serves at once. `recorded`
 * (`MEMORA_AI_CASSETTE_TIMING=recorded`) makes a served entry wait its recorded `durationMs` before it
 * answers, inside the lane slot the call already holds, so a throughput rerun of remote work costs
 * nothing and still queues, overlaps and pipelines like the recording did. In record mode a miss
 * goes live and is recorded as usual.
 */
export const aiCassetteTimings = ["off", "recorded"] as const;
export type AiCassetteTiming = (typeof aiCassetteTimings)[number];

export interface AiCassetteConfig {
  mode: "record" | "replay";
  directory: string;
  /** The replay policy for a miss on a local runtime; `fail` when absent. */
  localMisses?: AiCassetteLocalMissPolicy;
  /** How long a served entry takes; `off` when absent. */
  timing?: AiCassetteTiming;
}

export type AiCassetteErrorCode =
  | "invalid_mode"
  | "invalid_local_misses"
  | "invalid_timing"
  | "timing_without_cassette"
  | "missing_directory"
  | "packaged_build"
  | "directory_outside_cache"
  | "not_a_cassette"
  | "corrupt_entry"
  | "token_limit"
  | "unsupported_value";

export class AiCassetteError extends Error {
  public readonly code: AiCassetteErrorCode;

  public constructor(code: AiCassetteErrorCode, message: string) {
    super(message);
    this.name = "AiCassetteError";
    this.code = code;
  }
}

export class AiCassetteMissError extends Error {
  public readonly key: string;
  public readonly taskType: string;
  public readonly occurrence: number;
  public readonly requestPath: string;

  public constructor(input: {
    key: string;
    taskType: string;
    occurrence: number;
    recorded: number;
    requestPath: string;
  }) {
    super(
      `AI cassette miss: no recorded ${input.taskType} response for key ${input.key} ` +
        `(call ${input.occurrence + 1}, ${input.recorded} recorded); request saved to ${input.requestPath}`
    );
    this.name = "AiCassetteMissError";
    this.key = input.key;
    this.taskType = input.taskType;
    this.occurrence = input.occurrence;
    this.requestPath = input.requestPath;
  }
}

export interface AiCassetteMiss {
  key: string;
  taskType: string;
  occurrence: number;
  requestPath: string;
}

export interface AiCassetteStats {
  mode: AiCassetteConfig["mode"];
  directory: string;
  served: number;
  recorded: number;
  misses: number;
  /** Replay misses on a local runtime that ran live under the `live` policy (counted apart from misses). */
  liveLocalMisses?: number;
  byTask: Record<
    string,
    { served: number; recorded: number; misses: number; liveLocalMisses?: number }
  >;
  /** Present with `MEMORA_AI_CASSETTE_TIMING=recorded`: how served entries were timed. */
  timing?: "recorded";
  /** With recorded timing: the milliseconds served entries waited for their recorded duration. */
  waitedMs?: number;
  /** Input plus output tokens of the live remote calls made through this cassette (record mode). */
  liveTokens: number;
  /** The live-token cap enforced before every live call, or null when there is none. */
  maxLiveTokens: number | null;
  /** The first misses, for diagnostics (bounded). */
  missDetails: AiCassetteMiss[];
}

/** Token-usage key that marks a result served from a cassette in the monitoring audit. */
export const aiCassetteReplayedUsageKey = "cassette.replayed";

const cassetteFormat = "memora-ai-cassette";
const entryFormat = "memora-ai-cassette-entry";
const keyVersion = 1;
const maxMissDetails = 20;
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const placeholderPattern = /⟦id:(\d+)⟧/g;
const sha256Pattern = /^[0-9a-f]{64}$/;

const cassetteManifestSchema = z
  .object({
    format: z.literal(cassetteFormat),
    version: z.literal(1),
    createdAt: z.string().datetime()
  })
  .strict();

const recordedResponseSchema = z
  .object({
    output: z.unknown(),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    runtime: z.enum(["remote", "local", "sidecar"]),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    tokenUsage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    costEstimate: z.number().nonnegative().optional(),
    recordedAt: z.string().datetime()
  })
  .strict();
type RecordedResponse = z.infer<typeof recordedResponseSchema>;

const entrySchema = z
  .object({
    format: z.literal(entryFormat),
    version: z.literal(1),
    key: z.string().regex(sha256Pattern),
    taskType: z.string().min(1),
    request: z.unknown(),
    /** The strict schema the request carried, for audit only: it is never part of the key (D35). */
    outputSchema: AiOutputSchemaSchema.optional(),
    responses: z.array(recordedResponseSchema).min(1)
  })
  .strict();
type CassetteEntry = z.infer<typeof entrySchema>;

/** A call that found its recorded response, and the place of that response in the key's order. */
interface ServedEntry {
  served: RecordedResponse;
  occurrence: number;
}

/** A batch of embeddings served whole: each key's place before it, what it took, its recorded time. */
interface ServedBatch {
  before: ReadonlyMap<string, number>;
  taken: ReadonlyMap<string, number>;
  durationMs: number;
}

/** Reads `MEMORA_AI_CASSETTE_LOCAL_MISSES`: `fail` unless it says `live`; anything else is an error. */
export function readAiCassetteLocalMisses(
  env: Readonly<Record<string, string | undefined>>
): AiCassetteLocalMissPolicy {
  const raw = env.MEMORA_AI_CASSETTE_LOCAL_MISSES?.trim() ?? "";
  const policy = (raw === "" ? "fail" : raw) as AiCassetteLocalMissPolicy;
  if (!aiCassetteLocalMissPolicies.includes(policy))
    throw new AiCassetteError(
      "invalid_local_misses",
      `MEMORA_AI_CASSETTE_LOCAL_MISSES must be one of ${aiCassetteLocalMissPolicies.join(", ")}`
    );
  return policy;
}

/** Reads `MEMORA_AI_CASSETTE_TIMING`: `off` unless it says `recorded`; anything else is an error. */
export function readAiCassetteTiming(
  env: Readonly<Record<string, string | undefined>>
): AiCassetteTiming {
  const raw = env.MEMORA_AI_CASSETTE_TIMING?.trim() ?? "";
  const timing = (raw === "" ? "off" : raw) as AiCassetteTiming;
  if (!aiCassetteTimings.includes(timing))
    throw new AiCassetteError(
      "invalid_timing",
      `MEMORA_AI_CASSETTE_TIMING must be one of ${aiCassetteTimings.join(", ")}`
    );
  return timing;
}

/**
 * Reads the cassette configuration from the environment. Returns null when cassettes are off and
 * throws when they are misconfigured or requested in a packaged build.
 */
export function resolveAiCassetteConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; baseDirectory: string }
): AiCassetteConfig | null {
  const rawMode = env.MEMORA_AI_CASSETTE?.trim() ?? "";
  const mode = rawMode === "" ? "off" : rawMode;
  if (!(aiCassetteModes as readonly string[]).includes(mode))
    throw new AiCassetteError(
      "invalid_mode",
      `MEMORA_AI_CASSETTE must be one of ${aiCassetteModes.join(", ")}`
    );
  const timing = readAiCassetteTiming(env);
  if (mode === "off") {
    if (timing !== "off")
      throw new AiCassetteError(
        "timing_without_cassette",
        "MEMORA_AI_CASSETTE_TIMING needs MEMORA_AI_CASSETTE=record or replay"
      );
    return null;
  }
  if (options.isPackaged)
    throw new AiCassetteError("packaged_build", "AI cassettes are refused in packaged builds");
  const directory = env.MEMORA_AI_CASSETTE_DIR?.trim();
  if (!directory)
    throw new AiCassetteError(
      "missing_directory",
      "MEMORA_AI_CASSETTE_DIR is required when MEMORA_AI_CASSETTE is record or replay"
    );
  const localMisses = readAiCassetteLocalMisses(env);
  const cacheRoot = resolve(options.baseDirectory, ".cache");
  const resolved = resolve(options.baseDirectory, directory);
  const inside = relative(cacheRoot, resolved);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new AiCassetteError(
      "directory_outside_cache",
      `MEMORA_AI_CASSETTE_DIR must be a folder inside ${cacheRoot} (git-ignored): cassettes hold full prompts and outputs`
    );
  return {
    mode: mode as AiCassetteConfig["mode"],
    directory: resolved,
    ...(localMisses === "live" ? { localMisses } : {}),
    ...(timing === "recorded" ? { timing } : {})
  };
}

/** Builds the cassette from the environment, or returns null when cassettes are off. */
export function createAiCassetteFromEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; baseDirectory: string }
): AiCassette | null {
  const config = resolveAiCassetteConfig(env, options);
  return config ? new AiCassette(config) : null;
}

export interface AiCassetteRequestKey {
  /** SHA-256 of the canonical request identity. */
  key: string;
  /** The canonical identity with UUIDs replaced by positional placeholders. */
  canonical: string;
  /** UUIDs of the request in placeholder order (lower case). */
  ids: string[];
}

/**
 * The cassette key: SHA-256 of a canonical JSON (sorted keys) of the provider-agnostic task type,
 * the effective model identity, the effective parameters, the fully composed input and
 * instruction, and the output schema when the request carries one. UUIDs (database IDs such as
 * chunk IDs) are replaced by positional placeholders, so a replay into a fresh library with new
 * IDs produces the same key; the recorded output is mapped back to the new IDs.
 */
export function aiCassetteRequestKey(
  descriptor: AiModelDescriptor,
  request: AiTaskRequest
): AiCassetteRequestKey {
  const requirements = descriptor.requirements;
  const metadata = request.metadata ?? {};
  const text = (value: unknown) =>
    typeof value === "string" && value.length > 0 ? value : undefined;
  const identity = {
    version: keyVersion,
    taskType: request.taskType,
    model: {
      providerId: descriptor.providerId,
      modelId: request.modelId ?? descriptor.modelId,
      runtime: descriptor.runtime,
      adapter: text(requirements.adapter),
      repository: text(requirements.repository),
      revision: text(requirements.revision),
      quantization: text(requirements.quantization)
    },
    parameters: request.parameters ?? {},
    input: request.input,
    instruction: text(metadata.applicationInstruction) ?? null,
    schema: metadata.outputSchema ?? null
  };
  const ids: string[] = [];
  const canonical = canonicalJson(identity, (value) =>
    value.replace(uuidPattern, (match) => {
      const id = match.toLowerCase();
      let index = ids.indexOf(id);
      if (index < 0) index = ids.push(id) - 1;
      return `⟦id:${index + 1}⟧`;
    })
  );
  return { key: createHash("sha256").update(canonical).digest("hex"), canonical, ids };
}

/** Deterministic JSON: sorted object keys, no whitespace, undefined object members dropped. */
export function canonicalJson(
  value: unknown,
  mapString: (value: string) => string = (text) => text
): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") return JSON.stringify(mapString(value));
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new AiCassetteError("unsupported_value", "Cassette keys need finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, mapString)).join(",")}]`;
  if (typeof value === "object") {
    const members = Object.keys(value)
      .sort()
      .flatMap((key) => {
        const member = (value as Record<string, unknown>)[key];
        return member === undefined
          ? []
          : [`${JSON.stringify(key)}:${canonicalJson(member, mapString)}`];
      });
    return `{${members.join(",")}}`;
  }
  throw new AiCassetteError("unsupported_value", `Cassette keys cannot hold a ${typeof value}`);
}

/** Waits `ms`, or rejects with the signal's reason as soon as the signal aborts. */
async function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<void> {
  try {
    await delay(ms, undefined, signal ? { signal } : undefined);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    throw error;
  }
}

export class AiCassette {
  public readonly mode: AiCassetteConfig["mode"];
  public readonly directory: string;
  public readonly timing: AiCassetteTiming;
  private readonly localMisses: AiCassetteLocalMissPolicy;
  private readonly entries = new Map<string, CassetteEntry | null>();
  private readonly occurrences = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly wrapped = new WeakSet<AiModelAdapter>();
  private maxLiveTokens: number | null = null;
  private readonly counters: Omit<AiCassetteStats, "mode" | "directory" | "maxLiveTokens"> = {
    served: 0,
    recorded: 0,
    misses: 0,
    liveLocalMisses: 0,
    byTask: {},
    liveTokens: 0,
    missDetails: []
  };
  private waitedMs = 0;

  /** `wait` replaces the real delay of recorded timing (tests); it receives the abort signal. */
  public constructor(
    config: AiCassetteConfig,
    private readonly now: () => Date = () => new Date(),
    private readonly wait: (ms: number, signal?: AbortSignal) => Promise<void> = waitUnlessAborted
  ) {
    this.mode = config.mode;
    this.directory = config.directory;
    this.timing = config.timing ?? "off";
    this.localMisses = config.localMisses ?? "fail";
    this.prepareDirectory();
  }

  /** Wraps an adapter so that its task executions are recorded or replayed. */
  public wrap(adapter: AiModelAdapter): AiModelAdapter {
    if (this.wrapped.has(adapter)) return adapter;
    const replaying = () => this.mode === "replay";
    const wrapper: AiModelAdapter = {
      describe: () => adapter.describe(),
      canHandle: (request) => adapter.canHandle(request),
      run: (request, signal) =>
        this.execute(adapter, request, signal, () => adapter.run(request, signal)),
      ...(adapter.embedMany
        ? {
            embedMany: (texts: readonly string[], options: AiEmbedManyOptions = {}) =>
              this.executeMany(adapter, texts, options)
          }
        : {}),
      ...(adapter.runStreaming
        ? {
            runStreaming: (
              request: AiTaskRequest,
              signal: AbortSignal | undefined,
              onProgress: AiProgressListener
            ) =>
              this.execute(
                adapter,
                request,
                signal,
                () => adapter.runStreaming!(request, signal, onProgress),
                onProgress
              )
          }
        : {}),
      // Replay never loads a local model: nothing will run on it.
      ...(adapter.isLoaded ? { isLoaded: () => replaying() || adapter.isLoaded!() } : {}),
      ...(adapter.ensureLoaded
        ? {
            ensureLoaded: async (signal?: AbortSignal) => {
              if (!replaying()) await adapter.ensureLoaded!(signal);
            }
          }
        : {}),
      ...(adapter.listModels
        ? { listModels: (signal?: AbortSignal) => adapter.listModels!(signal) }
        : {}),
      ...(adapter.testConnection
        ? { testConnection: (signal?: AbortSignal) => adapter.testConnection!(signal) }
        : {}),
      ...(adapter.dispose ? { dispose: () => adapter.dispose!() } : {})
    };
    this.wrapped.add(wrapper);
    return wrapper;
  }

  /**
   * Caps the tokens of live remote calls: once the live calls made through this cassette reached the
   * cap, every further live call fails before it reaches the provider. Calls already running finish,
   * so the total can exceed the cap by what the in-flight calls consume. Null removes the cap.
   */
  public limitLiveTokens(max: number | null): void {
    if (max !== null && (!Number.isSafeInteger(max) || max <= 0))
      throw new AiCassetteError(
        "unsupported_value",
        "The live token cap must be a positive integer"
      );
    this.maxLiveTokens = max;
  }

  public stats(): AiCassetteStats {
    return structuredClone({
      mode: this.mode,
      directory: this.directory,
      maxLiveTokens: this.maxLiveTokens,
      ...(this.timing === "recorded"
        ? { timing: "recorded" as const, waitedMs: this.waitedMs }
        : {}),
      ...this.counters
    });
  }

  private async execute(
    adapter: AiModelAdapter,
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    live: () => Promise<AiTaskResult>,
    onProgress?: AiProgressListener
  ): Promise<AiTaskResult> {
    signal?.throwIfAborted();
    const startedAt = performance.now();
    const requestKey = aiCassetteRequestKey(adapter.describe(), request);
    const { key } = requestKey;
    const outcome = await this.withLock<AiTaskResult | ServedEntry>(key, async () => {
      const entry = await this.readEntry(key);
      const occurrence = this.occurrences.get(key) ?? 0;
      const recorded = entry?.responses[occurrence];
      if (recorded) {
        this.occurrences.set(key, occurrence + 1);
        this.count(request.taskType, "served");
        return { served: recorded, occurrence };
      }
      // A local miss may run live under the `live` policy; any other replay miss fails its call.
      const liveLocalMiss =
        this.mode === "replay" &&
        this.localMisses === "live" &&
        adapter.describe().runtime === "local";
      if (liveLocalMiss) this.count(request.taskType, "liveLocalMisses");
      if (this.mode === "replay" && !liveLocalMiss) {
        const requestPath = await this.saveMiss(requestKey, request.taskType, occurrence, entry);
        this.count(request.taskType, "misses");
        if (this.counters.missDetails.length < maxMissDetails)
          this.counters.missDetails.push({
            key,
            taskType: request.taskType,
            occurrence,
            requestPath
          });
        throw new AiCassetteMissError({
          key,
          taskType: request.taskType,
          occurrence,
          recorded: entry?.responses.length ?? 0,
          requestPath
        });
      }
      if (this.maxLiveTokens !== null && this.counters.liveTokens >= this.maxLiveTokens)
        throw new AiCassetteError(
          "token_limit",
          `AI cassette live token cap reached (${this.counters.liveTokens} of ${this.maxLiveTokens}); the provider was not called`
        );
      const result = await live();
      if (result.runtime === "remote")
        this.counters.liveTokens += (result.inputTokens ?? 0) + (result.outputTokens ?? 0);
      const response = recordedResponse(result, requestKey.ids, this.now());
      const outputSchema = entry?.outputSchema ?? request.outputSchema;
      await this.writeEntry({
        format: entryFormat,
        version: 1,
        key,
        taskType: request.taskType,
        request: JSON.parse(requestKey.canonical) as unknown,
        ...(outputSchema ? { outputSchema } : {}),
        responses: [...(entry?.responses ?? []), response]
      });
      this.occurrences.set(key, occurrence + 1);
      if (!liveLocalMiss) this.count(request.taskType, "recorded");
      return result;
    });
    if (!("served" in outcome)) return outcome;
    // A served entry takes the time it took when it was recorded, off the key's lock and inside the
    // lane slot the caller holds. A call canceled while it waits did not use the entry.
    if (this.timing === "recorded") {
      const remaining = Math.round(outcome.served.durationMs - (performance.now() - startedAt));
      if (remaining > 0) {
        try {
          await this.wait(remaining, signal);
        } catch (error) {
          if (this.occurrences.get(key) === outcome.occurrence + 1)
            this.occurrences.set(key, outcome.occurrence);
          this.count(request.taskType, "served", -1);
          throw error;
        }
        this.waitedMs += remaining;
      }
    }
    onProgress?.({ progress: 1 });
    return replayedResult(request, outcome.served, requestKey.ids, performance.now() - startedAt);
  }

  /**
   * A batch of embeddings: every text is looked up under the key of its single request. The texts
   * the cassette holds are served, and only the others reach the adapter's `embedMany` (record mode,
   * or a local runtime under the `live` policy); each of those is recorded as a single entry. A text
   * that repeats within the batch takes the next recorded response of its key, as a second single
   * call would. A miss in replay fails the whole batch and consumes nothing. Under recorded timing
   * a batch served whole waits the sum of its entries' recorded durations, as their single calls
   * would; a batch canceled while it waits did not use its entries.
   */
  private async executeMany(
    adapter: AiModelAdapter,
    texts: readonly string[],
    options: AiEmbedManyOptions
  ): Promise<AiEmbedManyResult> {
    options.signal?.throwIfAborted();
    const startedAt = performance.now();
    const descriptor = adapter.describe();
    if (texts.length === 0)
      return {
        embeddings: [],
        providerId: descriptor.providerId,
        modelId: options.modelId ?? descriptor.modelId,
        runtime: descriptor.runtime,
        durationMs: 0
      };
    const requests = texts.map((text) => embedManyRequest(text, options));
    const requestKeys = requests.map((request) => aiCassetteRequestKey(descriptor, request));
    const keys = [...new Set(requestKeys.map((requestKey) => requestKey.key))].sort();
    // A batch served whole, for recorded timing.
    let servedWhole: ServedBatch | null = null;
    const result = await this.withLocks(keys, async () => {
      const entries = new Map<string, CassetteEntry | null>();
      for (const key of keys) entries.set(key, await this.readEntry(key));
      const taken = new Map<string, number>();
      const plan = requestKeys.map((requestKey) => {
        const key = requestKey.key;
        const occurrence = (this.occurrences.get(key) ?? 0) + (taken.get(key) ?? 0);
        taken.set(key, (taken.get(key) ?? 0) + 1);
        return { requestKey, occurrence, recorded: entries.get(key)?.responses[occurrence] };
      });
      const missing = plan.flatMap((item, index) => (item.recorded ? [] : [index]));
      const liveLocalMiss =
        this.mode === "replay" && this.localMisses === "live" && descriptor.runtime === "local";
      if (missing.length > 0 && this.mode === "replay" && !liveLocalMiss) {
        let first: AiCassetteMissError | undefined;
        for (const index of missing) {
          const { requestKey, occurrence } = plan[index]!;
          const entry = entries.get(requestKey.key) ?? null;
          const requestPath = await this.saveMiss(requestKey, "embedding", occurrence, entry);
          this.count("embedding", "misses");
          if (this.counters.missDetails.length < maxMissDetails)
            this.counters.missDetails.push({
              key: requestKey.key,
              taskType: "embedding",
              occurrence,
              requestPath
            });
          first ??= new AiCassetteMissError({
            key: requestKey.key,
            taskType: "embedding",
            occurrence,
            recorded: entry?.responses.length ?? 0,
            requestPath
          });
        }
        throw first!;
      }
      if (missing.length > 0 && liveLocalMiss)
        for (let miss = 0; miss < missing.length; miss += 1)
          this.count("embedding", "liveLocalMisses");
      let live: AiEmbedManyResult | undefined;
      if (missing.length > 0) {
        if (this.maxLiveTokens !== null && this.counters.liveTokens >= this.maxLiveTokens)
          throw new AiCassetteError(
            "token_limit",
            `AI cassette live token cap reached (${this.counters.liveTokens} of ${this.maxLiveTokens}); the provider was not called`
          );
        live = await adapter.embedMany!(
          missing.map((index) => texts[index]!),
          options
        );
        if (live.embeddings.length !== missing.length)
          throw new AiCassetteError(
            "unsupported_value",
            "An embedMany call returned a different number of vectors than texts"
          );
        if (live.runtime === "remote") this.counters.liveTokens += live.inputTokens ?? 0;
      }
      const now = this.now();
      const written = new Map(entries);
      for (const [position, index] of missing.entries()) {
        const { requestKey } = plan[index]!;
        const entry = written.get(requestKey.key) ?? null;
        const itemTokens = live!.itemInputTokens?.[position];
        const response = recordedResponse(
          {
            taskType: "embedding",
            output: live!.embeddings[position],
            providerId: live!.providerId,
            modelId: live!.modelId,
            runtime: live!.runtime,
            durationMs: live!.durationMs / missing.length,
            ...(itemTokens !== undefined ? { inputTokens: itemTokens } : {})
          },
          requestKey.ids,
          now
        );
        const next: CassetteEntry = {
          format: entryFormat,
          version: 1,
          key: requestKey.key,
          taskType: "embedding",
          request: JSON.parse(requestKey.canonical) as unknown,
          responses: [...(entry?.responses ?? []), response]
        };
        await this.writeEntry(next);
        written.set(requestKey.key, next);
        if (!liveLocalMiss) this.count("embedding", "recorded");
      }
      const before = new Map(keys.map((key) => [key, this.occurrences.get(key) ?? 0]));
      for (const [key, count] of taken)
        this.occurrences.set(key, (this.occurrences.get(key) ?? 0) + count);
      const served = plan.flatMap((item) => (item.recorded ? [item.recorded] : []));
      for (let index = 0; index < served.length; index += 1) this.count("embedding", "served");
      if (missing.length === 0)
        servedWhole = {
          before,
          taken,
          durationMs: served.reduce((total, response) => total + response.durationMs, 0)
        };
      const vectors = plan.map((item, index) => {
        if (item.recorded) return item.recorded.output as number[];
        return live!.embeddings[missing.indexOf(index)]!;
      });
      const first = served[0];
      const identity = live ?? first!;
      const itemTokens = plan.map((item, index) =>
        item.recorded ? item.recorded.inputTokens : live!.itemInputTokens?.[missing.indexOf(index)]
      );
      const tokensKnown = itemTokens.every((count) => count !== undefined);
      const usage = sumTokenUsage([
        ...served.map((response) => response.tokenUsage),
        live?.tokenUsage
      ]);
      const inputTokens = tokensKnown
        ? itemTokens.reduce<number>((total, count) => total + count!, 0)
        : live?.inputTokens !== undefined && served.every((r) => r.inputTokens !== undefined)
          ? live.inputTokens + served.reduce((total, r) => total + r.inputTokens!, 0)
          : undefined;
      const replayedOnly = missing.length === 0;
      return {
        embeddings: vectors,
        providerId: identity.providerId,
        modelId: identity.modelId,
        runtime: identity.runtime,
        // The audit keeps the real duration of the batch; the recorded timings stay in the cassette.
        durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(tokensKnown ? { itemInputTokens: itemTokens as number[] } : {}),
        // Nothing was spent for a replayed text, so the recorded cost is not replayed (as for a single call).
        ...(live?.costEstimate !== undefined ? { costEstimate: live.costEstimate } : {}),
        ...(live?.attempts !== undefined ? { attempts: live.attempts } : {}),
        ...(live?.retriedUsage ? { retriedUsage: live.retriedUsage } : {}),
        tokenUsage: { ...usage, ...(replayedOnly ? { [aiCassetteReplayedUsageKey]: 1 } : {}) },
        replayedItems: served.length
      };
    });
    // Recorded timing (T52b): a batch served whole takes the time its entries took when they were
    // recorded, off the keys' locks and inside the lane slot the caller holds, as their single calls
    // would. A batch canceled while it waits did not use its entries.
    const timed = servedWhole as ServedBatch | null;
    if (this.timing !== "recorded" || !timed) return result;
    const remaining = Math.round(timed.durationMs - (performance.now() - startedAt));
    if (remaining <= 0) return result;
    try {
      await this.wait(remaining, options.signal);
    } catch (error) {
      for (const [key, count] of timed.taken) {
        const before = timed.before.get(key) ?? 0;
        if (this.occurrences.get(key) === before + count) this.occurrences.set(key, before);
        this.count("embedding", "served", -count);
      }
      throw error;
    }
    this.waitedMs += remaining;
    // The audit keeps the real duration, which includes the wait of recorded timing.
    return { ...result, durationMs: Math.max(0, Math.round(performance.now() - startedAt)) };
  }

  private count(
    taskType: string,
    field: "served" | "recorded" | "misses" | "liveLocalMisses",
    amount = 1
  ) {
    this.counters[field] += amount;
    const task = (this.counters.byTask[taskType] ??= {
      served: 0,
      recorded: 0,
      misses: 0,
      liveLocalMisses: 0
    });
    task[field] += amount;
  }

  private prepareDirectory() {
    const manifestPath = join(this.directory, "cassette.json");
    if (existsSync(manifestPath)) {
      const parsed = cassetteManifestSchema.safeParse(
        JSON.parse(readFileSync(manifestPath, "utf8"))
      );
      if (!parsed.success)
        throw new AiCassetteError("not_a_cassette", `${manifestPath} is not an AI cassette`);
      return;
    }
    if (this.mode === "replay")
      throw new AiCassetteError(
        "not_a_cassette",
        `Replay needs a recorded cassette; ${manifestPath} does not exist`
      );
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ format: cassetteFormat, version: 1, createdAt: this.now().toISOString() }, null, 2)}\n`,
      { flag: "wx" }
    );
  }

  private entryPath(key: string) {
    return join(this.directory, "entries", key.slice(0, 2), `${key}.json`);
  }

  private async readEntry(key: string): Promise<CassetteEntry | null> {
    if (this.entries.has(key)) return this.entries.get(key) ?? null;
    let entry: CassetteEntry | null = null;
    try {
      const parsed = entrySchema.safeParse(JSON.parse(await readFile(this.entryPath(key), "utf8")));
      if (!parsed.success || parsed.data.key !== key)
        throw new AiCassetteError("corrupt_entry", `Corrupt cassette entry ${this.entryPath(key)}`);
      entry = parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    this.entries.set(key, entry);
    return entry;
  }

  private async writeEntry(entry: CassetteEntry) {
    const path = this.entryPath(entry.key);
    await writeAtomically(path, `${JSON.stringify(entry)}\n`);
    this.entries.set(entry.key, entry);
  }

  private async saveMiss(
    requestKey: AiCassetteRequestKey,
    taskType: string,
    occurrence: number,
    entry: CassetteEntry | null
  ): Promise<string> {
    const path = join(this.directory, "misses", `${requestKey.key}.json`);
    await writeAtomically(
      path,
      `${JSON.stringify(
        {
          key: requestKey.key,
          taskType,
          occurrence,
          recorded: entry?.responses.length ?? 0,
          request: JSON.parse(requestKey.canonical) as unknown
        },
        null,
        2
      )}\n`
    );
    return path;
  }

  /** Holds the locks of several keys, always taken in ascending order, so two batches cannot deadlock. */
  private async withLocks<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
    const [first, ...rest] = keys;
    return first === undefined ? run() : this.withLock(first, () => this.withLocks(rest, run));
  }

  private async withLock<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(run);
    this.locks.set(key, current);
    try {
      return await current;
    } finally {
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}

function recordedResponse(result: AiTaskResult, ids: string[], now: Date): RecordedResponse {
  return recordedResponseSchema.parse({
    output: mapIdsToPlaceholders(result.output, ids),
    providerId: result.providerId,
    modelId: result.modelId,
    runtime: result.runtime,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    ...(result.inputTokens !== undefined ? { inputTokens: result.inputTokens } : {}),
    ...(result.outputTokens !== undefined ? { outputTokens: result.outputTokens } : {}),
    ...(result.tokenUsage !== undefined
      ? {
          tokenUsage: Object.fromEntries(
            Object.entries(result.tokenUsage).filter(
              ([, value]) => Number.isFinite(value) && value >= 0
            )
          )
        }
      : {}),
    ...(result.costEstimate !== undefined ? { costEstimate: result.costEstimate } : {}),
    recordedAt: now.toISOString()
  });
}

function replayedResult(
  request: AiTaskRequest,
  recorded: RecordedResponse,
  ids: string[],
  elapsedMs: number
): AiTaskResult {
  return {
    taskType: request.taskType,
    output: mapPlaceholdersToIds(recorded.output, ids),
    providerId: recorded.providerId,
    modelId: recorded.modelId,
    runtime: recorded.runtime,
    // The audit keeps the real (replay) duration, which includes the wait of recorded timing; the
    // recorded duration itself stays in the cassette.
    durationMs: Math.max(0, Math.round(elapsedMs)),
    // The recorded token counts describe the call, so runs stay comparable. The recorded cost is
    // deliberately not replayed: nothing was spent, so the audit must not report it as spent.
    ...(recorded.inputTokens !== undefined ? { inputTokens: recorded.inputTokens } : {}),
    ...(recorded.outputTokens !== undefined ? { outputTokens: recorded.outputTokens } : {}),
    tokenUsage: { ...recorded.tokenUsage, [aiCassetteReplayedUsageKey]: 1 }
  };
}

function mapIdsToPlaceholders(value: unknown, ids: string[]): unknown {
  if (ids.length === 0) return value;
  return mapStrings(value, (text) =>
    text.replace(uuidPattern, (match) => {
      const index = ids.indexOf(match.toLowerCase());
      return index < 0 ? match : `⟦id:${index + 1}⟧`;
    })
  );
}

function mapPlaceholdersToIds(value: unknown, ids: string[]): unknown {
  return mapStrings(value, (text) =>
    text.replace(placeholderPattern, (_match, position: string) => {
      const id = ids[Number(position) - 1];
      if (!id)
        throw new AiCassetteError(
          "corrupt_entry",
          "A recorded response refers to an ID the request does not have"
        );
      return id;
    })
  );
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)])
    );
  return value;
}

async function writeAtomically(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}
