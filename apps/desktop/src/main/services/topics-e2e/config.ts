// Options of the zero-config end-to-end test (F2 T32, exit criterion E6) and the AI route it
// configures. Pure: the command line is parsed here, the files and the process are the runner's.
//
// Replay (the default) needs nothing but the recorded cassette: the route it was recorded with sits
// next to it (`e2e-route.json`, no secrets), so the harness rebuilds the same profile and every call
// is served from the cassette. Record needs a real route, which is supplied explicitly (flags, or a
// route file kept in a scratch profile under `.cache/profiles/`) and never read from the owner's live
// profile: the credentials of a profile are encrypted for the Electron app and cannot be copied.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { AiCapabilitySchema } from "@app/domain";
import type { AiCapability } from "@app/domain";
import { z } from "zod";

import { goldenPinModes } from "../extraction-pin.js";
import type { GoldenPinMode } from "../extraction-pin.js";

export const defaultSourceKey = "plos-one-murre-dros-2015";
export const defaultCassetteName = "e2e-plos";
export const routeFileName = "e2e-route.json";
export const defaultEmbeddingCatalogId = "gguf-qwen3-embedding-0.6b-q8-0";
export const defaultApiKeyEnv = "MEMORA_E2E_API_KEY";
export const defaultLocale = "pt-BR";
/** E6: the light lane may take at most this long to drain after the import's heavy work. */
export const defaultLaneTimeoutMinutes = 15;
/**
 * E6 runs without a ranker on purpose (spec E6 "no ranker, so the gate fallback is exercised",
 * owner decision 19): the harness's first run keeps the product's first-run ranker install off, no
 * profile routes `class:decide`, and every ambiguous note takes the topic gate's no-decider
 * fallback. The setting is kept with the cassette, so a replay runs the same way.
 */
export const e2eRanker = "none" as const;

/** What the Settings screen gives a model added for generation (`AiSettingsView`). */
export const generationCapabilities: readonly AiCapability[] = [
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "requires-network",
  "requires-api-key"
];

export class UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an environment variable name");

const RemoteWriterSchema = z
  .object({
    kind: z.literal("remote"),
    provider: z.enum(["openai-compatible", "google"]),
    baseUrl: z.string().url().optional(),
    modelId: z.string().trim().min(1),
    capabilities: z
      .array(AiCapabilitySchema)
      .min(1)
      .default([...generationCapabilities]),
    /** The variable the API key is read from (the key itself is never part of a route). */
    apiKeyEnv: envName.default(defaultApiKeyEnv),
    /** Or a file that holds only the key. */
    apiKeyFile: z.string().min(1).optional()
  })
  .strict();

const LocalWriterSchema = z
  .object({
    kind: z.literal("local"),
    /** An entry of the local model catalog (MLX first), installed at `path`. */
    catalogId: z.string().min(1),
    path: z.string().min(1)
  })
  .strict();

/** The AI route a recording uses; `strict` rejects any inline secret such as `apiKey`. */
export const RouteSpecSchema = z
  .object({
    writer: z.discriminatedUnion("kind", [RemoteWriterSchema, LocalWriterSchema]),
    embedding: z
      .object({
        catalogId: z.string().min(1).default(defaultEmbeddingCatalogId),
        /** The installed model file (a GGUF) a recording embeds with. */
        path: z.string().min(1).optional()
      })
      .strict()
      .default({ catalogId: defaultEmbeddingCatalogId })
  })
  .strict();
export type RouteSpec = z.infer<typeof RouteSpecSchema>;
export type WriterSpec = RouteSpec["writer"];

/** What a recording keeps next to its cassette: the route without credentials or paths. */
export const RecordedRouteSchema = z
  .object({
    format: z.literal("memora-topics-e2e-route"),
    version: z.literal(1),
    recordedAt: z.string().datetime(),
    /** The library's content language when it was recorded; a replay uses it again. */
    contentLanguage: z.string().min(1),
    /** The golden manifest key, or `synthetic`. */
    source: z.string().min(1),
    writer: z.discriminatedUnion("kind", [
      RemoteWriterSchema.omit({ apiKeyEnv: true, apiKeyFile: true }),
      LocalWriterSchema.omit({ path: true })
    ]),
    embedding: z.object({ catalogId: z.string().min(1) }).strict(),
    /** E6 runs without a ranker (`e2eRanker`); cassettes recorded before it was kept had none. */
    ranker: z.literal(e2eRanker).default(e2eRanker),
    /**
     * The extraction pin the recording ran under (F3 D5, `MEMORA_GOLDEN_PIN`): `off` is the product
     * path of a recording made under F3 (T55k). A replay runs the same way, so it makes the same
     * requests. A cassette recorded before it was kept is F2-era: pinned.
     */
    pin: z.enum(goldenPinModes).default("extraction"),
    /** What the recorded run produced; a replay must produce the same. */
    result: z
      .object({
        notes: z.number().int().nonnegative(),
        topics: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type RecordedRoute = z.infer<typeof RecordedRouteSchema>;

export type E2eMode = "record" | "replay" | "both";

export interface E2eConfig {
  /** `both` (synthetic only) records and then replays in one invocation. */
  mode: E2eMode;
  /** A tiny built-in library and a synthetic model: no PDF, Docling or real model. */
  synthetic: boolean;
  /** The checkout whose `.cache` holds the golden sources, the cassette and the reports. */
  repositoryRoot: string;
  manifestPath: string;
  sourceKey: string;
  cassetteDir: string | null;
  /** Record: the route to configure, from flags (`spec`) or from a route file (`file`). */
  route: { spec: RouteSpec | null; file: string | null; embeddingGguf: string | null } | null;
  /** Cap on the live remote tokens of a recording. */
  maxTokens: number | null;
  locale: string;
  laneTimeoutMs: number;
  workDir: string | null;
  keep: boolean;
  reportDir: string | null;
  json: boolean;
  /** The ranker of the first run: none, so the gate's no-decider fallback is exercised (E6). */
  ranker: typeof e2eRanker;
  /**
   * Replay only: the installed models a miss on a local runtime runs on when
   * `MEMORA_AI_CASSETTE_LOCAL_MISSES=live` (F3 D41, gate R). Without a path the replay installs placeholder files,
   * which is right while nothing is ever loaded.
   */
  replayModelPaths: { writer: string | null; embedding: string | null };
}

export const usage = `Usage: npm run topics:e2e -- [options]

  Replay (default; needs only the recorded cassette, no model and no network):
    npm run topics:e2e
  Record (once; needs a real AI route and the local embedding model):
    npm run topics:e2e -- --mode record --max-tokens <cap> \\
      --embedding-gguf <Qwen3-Embedding-0.6B-Q8_0.gguf> \\
      (--profile <scratch profile> | --route-file <file> | --writer-provider ... | --writer-local ...)
  Self-test of the harness (records and replays a tiny synthetic library; no models):
    npm run topics:e2e -- --synthetic

  Every run is without a ranker, on purpose: E6 exercises the topic gate's no-decider fallback.

  Non-regression replay after F3 matching merged (gate R): a copy of the cassette without its matching entries
  (npm run golden:cassette-nonreg), the pin (the default here) and local misses run live on the real models:
    MEMORA_AI_CASSETTE_LOCAL_MISSES=live MEMORA_GOLDEN_PIN=extraction npm run topics:e2e -- \
      --cassette-dir .cache/topics/cassettes/e2e-plos-nonreg-R --lane-timeout 45 \
      --writer-path <installed writer model dir> --embedding-gguf <installed embedding .gguf>

  Re-record under F3 (T55k: the local writer, $0, the product path of extraction), then replay it. The
  recording keeps its pin next to the cassette, so a replay runs the same way:
    MEMORA_GOLDEN_PIN=off npm run topics:e2e -- --mode record \
      --cassette-dir .cache/topics/cassettes/e2e-plos-f3 --lane-timeout 45 \
      --writer-local <catalog id> --writer-path <installed writer model dir> \
      --embedding-gguf <installed embedding .gguf>
    npm run topics:e2e -- --cassette-dir .cache/topics/cassettes/e2e-plos-f3 --lane-timeout 45

  --mode record|replay|both  both = record then replay (synthetic only)
  --synthetic                tiny library and synthetic model instead of the PDF and real models
  --cassette-dir <dir>       default <repo>/.cache/topics/cassettes/${defaultCassetteName}
  --source <key>             golden manifest key (default ${defaultSourceKey})
  --manifest <file>          default scripts/golden/manifest.json
  --locale <code>            desktop locale of the fresh profile (default ${defaultLocale})
  --lane-timeout <minutes>   light lane budget (default ${defaultLaneTimeoutMinutes})
  --work-dir <dir>           where the scratch workspace is made (default: system temp)
  --keep                     keep the scratch workspace
  --report <dir>             default <repo>/.cache/topics/e2e/<time>
  --json                     print the report as JSON
  --workspace-root <dir>     the checkout that holds .cache (default: this one)

  Record route (never the owner's live profile; credentials are not copied):
    --profile <name>         read .cache/profiles/<name>/${routeFileName} (no secrets inside)
    --route-file <file>      the same, from any file
    --writer-provider openai-compatible|google --writer-model <id> [--writer-base-url <url>]
      [--writer-key-env <NAME>] [--writer-key-file <file>]   key from $${defaultApiKeyEnv} by default
    --writer-local <catalogId> --writer-path <dir>           a local (MLX) writer
    --embedding-gguf <file>  installed local embedding model     --embedding-catalog <id>
                           (a replay takes --writer-path and --embedding-gguf too, only with
                           MEMORA_AI_CASSETTE_LOCAL_MISSES=live: where its live local misses run)
    --max-tokens <n>         required with a remote writer: cap on live tokens
`;

const profileName = /^[a-z0-9][a-z0-9._-]*$/;

/** The route flags a replay accepts: where the installed models are, never what the route is. */
const replayModelPathFlags: readonly string[] = ["writer-path", "embedding-gguf"];

function insideCache(root: string, directory: string): boolean {
  const inside = relative(resolve(root, ".cache"), directory);
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

export function parseE2eArgs(
  argv: readonly string[],
  context: { repositoryRoot: string }
): E2eConfig | "help" {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        mode: { type: "string" },
        synthetic: { type: "boolean" },
        "cassette-dir": { type: "string" },
        source: { type: "string" },
        manifest: { type: "string" },
        locale: { type: "string" },
        "lane-timeout": { type: "string" },
        "work-dir": { type: "string" },
        keep: { type: "boolean" },
        report: { type: "string" },
        json: { type: "boolean" },
        "workspace-root": { type: "string" },
        profile: { type: "string" },
        "route-file": { type: "string" },
        "writer-provider": { type: "string" },
        "writer-model": { type: "string" },
        "writer-base-url": { type: "string" },
        "writer-key-env": { type: "string" },
        "writer-key-file": { type: "string" },
        "writer-local": { type: "string" },
        "writer-path": { type: "string" },
        "embedding-gguf": { type: "string" },
        "embedding-catalog": { type: "string" },
        "max-tokens": { type: "string" }
      }
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.help) return "help";
  const root = resolve(v["workspace-root"] ?? context.repositoryRoot);
  const synthetic = v.synthetic === true;
  const mode = (v.mode ?? (synthetic ? "both" : "replay")) as E2eMode;
  if (!["record", "replay", "both"].includes(mode))
    throw new UsageError("--mode is record, replay or both");
  if (mode === "both" && !synthetic) throw new UsageError("--mode both needs --synthetic");
  const laneMinutes = positiveNumber(
    "--lane-timeout",
    v["lane-timeout"],
    defaultLaneTimeoutMinutes
  );
  const maxTokens =
    v["max-tokens"] === undefined ? null : positiveInteger("--max-tokens", v["max-tokens"]);

  const routeFlags = [
    "profile",
    "route-file",
    "writer-provider",
    "writer-model",
    "writer-base-url",
    "writer-key-env",
    "writer-key-file",
    "writer-local",
    "writer-path",
    "embedding-gguf",
    "embedding-catalog"
  ] as const;
  const givenRouteFlags = routeFlags.filter((flag) => v[flag] !== undefined);
  // A replay keeps the recorded route, but its live local misses (D41) need to know where the models are.
  const replayPaths = mode === "replay" && !synthetic;
  const refusedRouteFlags = givenRouteFlags.filter(
    (flag) => !replayPaths || !replayModelPathFlags.includes(flag)
  );
  let route: E2eConfig["route"] = null;
  if (mode === "replay" || synthetic) {
    if (refusedRouteFlags.length > 0)
      throw new UsageError(
        `${synthetic ? "--synthetic" : "Replay"} configures its own route; drop --${refusedRouteFlags[0]}`
      );
    if (maxTokens !== null && mode === "replay")
      throw new UsageError("--max-tokens only applies to a recording");
  } else {
    route = routeFromFlags(v, root);
    if (!route) throw new UsageError(`A recording needs a route.\n\n${usage}`);
    if (route.spec?.writer.kind === "remote" && maxTokens === null)
      throw new UsageError(
        "Recording spends a remote route: set --max-tokens (a cap on live tokens)"
      );
    if (!route.embeddingGguf)
      throw new UsageError(
        "A recording needs the installed embedding model: --embedding-gguf <file>"
      );
  }

  const cassetteDir = v["cassette-dir"] ? resolve(v["cassette-dir"]) : null;
  if (cassetteDir && !synthetic && !insideCache(root, cassetteDir))
    throw new UsageError(
      `--cassette-dir must be a folder inside ${join(root, ".cache")}: a cassette holds full prompts and outputs`
    );
  return {
    mode,
    synthetic,
    repositoryRoot: root,
    manifestPath: resolve(v.manifest ?? join(root, "scripts", "golden", "manifest.json")),
    sourceKey: v.source ?? defaultSourceKey,
    cassetteDir,
    route,
    maxTokens,
    locale: v.locale ?? defaultLocale,
    laneTimeoutMs: laneMinutes * 60_000,
    workDir: v["work-dir"] ? resolve(v["work-dir"]) : null,
    keep: v.keep === true,
    reportDir: v.report ? resolve(v.report) : null,
    json: v.json === true,
    ranker: e2eRanker,
    replayModelPaths: {
      writer: replayPaths && v["writer-path"] ? resolve(v["writer-path"]) : null,
      embedding: replayPaths && v["embedding-gguf"] ? resolve(v["embedding-gguf"]) : null
    }
  };
}

function positiveNumber(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new UsageError(`${flag} must be a positive number`);
  return number;
}

function positiveInteger(flag: string, value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new UsageError(`${flag} must be a positive whole number`);
  return number;
}

function routeFromFlags(
  v: Record<string, string | boolean | undefined>,
  root: string
): E2eConfig["route"] {
  const text = (name: string) => (typeof v[name] === "string" ? (v[name] as string) : undefined);
  const inline = ["writer-provider", "writer-model", "writer-local", "writer-path"].some(
    (name) => v[name] !== undefined
  );
  const file = text("route-file");
  const profile = text("profile");
  if ([inline, file !== undefined, profile !== undefined].filter(Boolean).length > 1)
    throw new UsageError("Give one route: --profile, --route-file or --writer-* flags");
  const embeddingGguf = text("embedding-gguf") ? resolve(text("embedding-gguf")!) : null;
  if (profile !== undefined) {
    if (!profileName.test(profile)) throw new UsageError("--profile is a folder name");
    return {
      spec: null,
      file: join(root, ".cache", "profiles", profile, routeFileName),
      embeddingGguf
    };
  }
  if (file !== undefined) return { spec: null, file: resolve(file), embeddingGguf };
  if (!inline) return null;
  const embedding = {
    catalogId: text("embedding-catalog") ?? defaultEmbeddingCatalogId,
    ...(embeddingGguf ? { path: embeddingGguf } : {})
  };
  const local = text("writer-local");
  if (local !== undefined) {
    if (!text("writer-path")) throw new UsageError("--writer-local needs --writer-path <dir>");
    return {
      spec: RouteSpecSchema.parse({
        writer: { kind: "local", catalogId: local, path: resolve(text("writer-path")!) },
        embedding
      }),
      file: null,
      embeddingGguf
    };
  }
  if (!text("writer-provider") || !text("writer-model"))
    throw new UsageError("A remote writer needs --writer-provider and --writer-model");
  const parsed = RouteSpecSchema.safeParse({
    writer: {
      kind: "remote",
      provider: text("writer-provider"),
      modelId: text("writer-model"),
      ...(text("writer-base-url") ? { baseUrl: text("writer-base-url") } : {}),
      ...(text("writer-key-env") ? { apiKeyEnv: text("writer-key-env") } : {}),
      ...(text("writer-key-file") ? { apiKeyFile: resolve(text("writer-key-file")!) } : {})
    },
    embedding
  });
  if (!parsed.success)
    throw new UsageError(
      `Invalid route: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  return { spec: parsed.data, file: null, embeddingGguf };
}

/** The route of a recording, from flags or from a route file (a file holds references, no secrets). */
export function routeFromFile(
  content: string,
  file: string,
  embeddingGguf: string | null
): RouteSpec {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new UsageError(`${file} is not JSON`);
  }
  const parsed = RouteSpecSchema.safeParse(json);
  if (!parsed.success)
    throw new UsageError(
      `${file} is not a valid route (it names where a key is read from, never the key): ` +
        parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")
    );
  const spec = parsed.data;
  const path = embeddingGguf ?? spec.embedding.path;
  if (!path)
    throw new UsageError(
      "A recording needs the installed embedding model: --embedding-gguf <file>"
    );
  return { ...spec, embedding: { ...spec.embedding, path } };
}

/** The route a cassette is kept with: no credentials and no local paths. */
export function recordedRoute(
  spec: RouteSpec,
  facts: {
    contentLanguage: string;
    source: string;
    notes: number;
    topics: number;
    recordedAt: Date;
    pin?: GoldenPinMode;
  }
): RecordedRoute {
  const writer: RecordedRoute["writer"] =
    spec.writer.kind === "remote"
      ? {
          kind: "remote",
          provider: spec.writer.provider,
          ...(spec.writer.baseUrl ? { baseUrl: spec.writer.baseUrl } : {}),
          modelId: spec.writer.modelId,
          capabilities: spec.writer.capabilities
        }
      : { kind: "local", catalogId: spec.writer.catalogId };
  return RecordedRouteSchema.parse({
    format: "memora-topics-e2e-route",
    version: 1,
    recordedAt: facts.recordedAt.toISOString(),
    contentLanguage: facts.contentLanguage,
    source: facts.source,
    writer,
    embedding: { catalogId: spec.embedding.catalogId },
    ranker: e2eRanker,
    pin: facts.pin ?? "extraction",
    result: { notes: facts.notes, topics: facts.topics }
  });
}
