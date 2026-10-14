import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

import type {
  AiModelAdapter,
  AiModelDescriptor,
  AiProgressListener,
  AiTaskRequest,
  AiTaskResult
} from "./contracts.js";

/**
 * DEV-only AI cassettes. A cassette wraps `AiModelAdapter.run`/`runStreaming`, so it sees every AI
 * task execution (remote generation, local generation, embeddings, reranking) after routing and
 * prompt composition. `record` serves calls already in the cassette and calls the provider only for
 * new ones; `replay` serves recorded calls and never reaches the provider: a miss fails the call.
 * Packaged builds refuse cassettes, and a cassette lives under `<repository>/.cache/` (it holds the
 * full prompts and outputs, which are library text).
 */
export const aiCassetteModes = ["off", "record", "replay"] as const;
export type AiCassetteMode = (typeof aiCassetteModes)[number];

export interface AiCassetteConfig {
  mode: "record" | "replay";
  directory: string;
}

export type AiCassetteErrorCode =
  | "invalid_mode"
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
  byTask: Record<string, { served: number; recorded: number; misses: number }>;
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
    responses: z.array(recordedResponseSchema).min(1)
  })
  .strict();
type CassetteEntry = z.infer<typeof entrySchema>;

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
  if (mode === "off") return null;
  if (options.isPackaged)
    throw new AiCassetteError("packaged_build", "AI cassettes are refused in packaged builds");
  const directory = env.MEMORA_AI_CASSETTE_DIR?.trim();
  if (!directory)
    throw new AiCassetteError(
      "missing_directory",
      "MEMORA_AI_CASSETTE_DIR is required when MEMORA_AI_CASSETTE is record or replay"
    );
  const cacheRoot = resolve(options.baseDirectory, ".cache");
  const resolved = resolve(options.baseDirectory, directory);
  const inside = relative(cacheRoot, resolved);
  if (inside === "" || inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside))
    throw new AiCassetteError(
      "directory_outside_cache",
      `MEMORA_AI_CASSETTE_DIR must be a folder inside ${cacheRoot} (git-ignored): cassettes hold full prompts and outputs`
    );
  return { mode: mode as AiCassetteConfig["mode"], directory: resolved };
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

export class AiCassette {
  public readonly mode: AiCassetteConfig["mode"];
  public readonly directory: string;
  private readonly entries = new Map<string, CassetteEntry | null>();
  private readonly occurrences = new Map<string, number>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly wrapped = new WeakSet<AiModelAdapter>();
  private maxLiveTokens: number | null = null;
  private readonly counters: Omit<AiCassetteStats, "mode" | "directory" | "maxLiveTokens"> = {
    served: 0,
    recorded: 0,
    misses: 0,
    byTask: {},
    liveTokens: 0,
    missDetails: []
  };

  public constructor(
    config: AiCassetteConfig,
    private readonly now: () => Date = () => new Date()
  ) {
    this.mode = config.mode;
    this.directory = config.directory;
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
    return this.withLock(key, async () => {
      const entry = await this.readEntry(key);
      const occurrence = this.occurrences.get(key) ?? 0;
      const recorded = entry?.responses[occurrence];
      if (recorded) {
        this.occurrences.set(key, occurrence + 1);
        this.count(request.taskType, "served");
        onProgress?.({ progress: 1 });
        return replayedResult(request, recorded, requestKey.ids, performance.now() - startedAt);
      }
      if (this.mode === "replay") {
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
      await this.writeEntry({
        format: entryFormat,
        version: 1,
        key,
        taskType: request.taskType,
        request: JSON.parse(requestKey.canonical) as unknown,
        responses: [...(entry?.responses ?? []), response]
      });
      this.occurrences.set(key, occurrence + 1);
      this.count(request.taskType, "recorded");
      return result;
    });
  }

  private count(taskType: string, field: "served" | "recorded" | "misses") {
    this.counters[field] += 1;
    const task = (this.counters.byTask[taskType] ??= { served: 0, recorded: 0, misses: 0 });
    task[field] += 1;
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
    // The audit keeps the real (replay) duration; the recorded timing stays in the cassette.
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
