// Options of the first-run Hybrid end-to-end test (F4 T90, exit criterion E6) and the AI route it
// configures. Pure: the command line is parsed here, the files and the process are the runner's.
//
// A clean install in Hybrid: an empty `userData`, the writer signed in (ChatGPT/Codex), the two
// first-run models (the Qwen3-Embedding-0.6B GGUF and the Qwen3-Reranker-0.6B) installed, two
// sources imported with the default plan. The clock starts at app launch (T0) and stops when a note
// of the first source sits in a named topic with at least one shown relation (T1).
//
// Replay (the default) needs the recorded cassette and the DEV seed folder (`MEMORA_LOCAL_MODEL_SEED_DIR`)
// that holds both models: the install checks and the ranker validation run for real on the seeded
// files, the AI calls are served from the cassette with their recorded timing. Record is the live
// clean-install run: the writer is real (a Codex credential file or an API key), the two models are
// downloaded for real into the scratch profile, and the time the pipeline spent waiting for the
// downloads is kept next to the cassette as the download term D of E6.
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { presetCatalogIds } from "@app/domain";
import { z } from "zod";

import { firstRunRankerCatalogIds } from "../first-run-ranker.js";
import { generationCapabilities } from "../topics-e2e/config.js";
import {
  TopicReleaseSettingsSchema,
  defaultTopicReleaseNotes,
  harnessLinkRuntimes,
  topicReleaseSettings
} from "./topic-release.js";
import type { TopicReleaseSettings } from "./topic-release.js";

export const firstRunCassetteName = "firstrun-hybrid-f4";
export const recordFileName = "firstrun-record.json";
/** The E6 paper and a short, related public text of the golden manifest (spec 5.1, FR2). */
export const defaultFirstSourceKey = "plos-one-murre-dros-2015";
export const defaultSecondSourceKey = "wikibooks-en-memory-and-language";
export const defaultLocale = "pt-BR";
export const defaultApiKeyEnv = "MEMORA_E2E_API_KEY";
/** The model of the owner's Codex subscription (spec 8.2). */
export const defaultCodexModel = "gpt-5.6-luna";
/** The bar of E6: each replay plus the download term D must fit in this. */
export const e6BudgetMinutes = 10;
/** The light lane may take at most this long to drain, at each release of the topic work. */
export const defaultLaneTimeoutMinutes = 15;
/** How long the install of a model may take (a download on a slow line, or a seeded copy). */
export const defaultDownloadTimeoutMinutes = 60;
/** A Codex access token must outlive the run by this much: the harness never refreshes it. */
export const codexMinimumRemainingMinutes = 45;

/** The two models of the first run in Hybrid (decision 12: MLX first where MLX runs). */
export const firstRunModels = {
  embedding: presetCatalogIds.embedding,
  rankerMlx: firstRunRankerCatalogIds.mlx,
  rankerGguf: firstRunRankerCatalogIds.gguf
} as const;

export class UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

const envName = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "an environment variable name");

/** The Codex capabilities Settings gives a generation model (no API key: the sign-in is OAuth). */
export const codexCapabilities = generationCapabilities.filter(
  (capability) => capability !== "requires-api-key"
);

const CodexWriterSchema = z
  .object({
    kind: z.literal("codex"),
    modelId: z.string().trim().min(1),
    /** A Codex-wire server other than ChatGPT's (a loopback fake in a test); the default otherwise. */
    baseUrl: z.string().url().optional(),
    /** A JSON file with the OAuth credential (`access`, `expires`, `accountId`); read, never copied. */
    credentialFile: z.string().min(1)
  })
  .strict();

const RemoteWriterSchema = z
  .object({
    kind: z.literal("remote"),
    provider: z.enum(["openai-compatible", "google"]),
    baseUrl: z.string().url().optional(),
    modelId: z.string().trim().min(1),
    apiKeyEnv: envName.default(defaultApiKeyEnv),
    apiKeyFile: z.string().min(1).optional()
  })
  .strict();

/** The writer a recording signs in to; `strict` rejects any inline secret. */
export const WriterRouteSchema = z.discriminatedUnion("kind", [
  CodexWriterSchema,
  RemoteWriterSchema
]);
export type WriterRoute = z.infer<typeof WriterRouteSchema>;

/** What the record keeps of the writer: no credential, no key, no path. */
export const RecordedWriterSchema = z.discriminatedUnion("kind", [
  CodexWriterSchema.omit({ credentialFile: true }),
  RemoteWriterSchema.omit({ apiKeyEnv: true, apiKeyFile: true })
]);
export type RecordedWriter = z.infer<typeof RecordedWriterSchema>;

const count = z.number().int().nonnegative();

/** One model of the first run as the record saw it install. */
export const RecordedModelSchema = z
  .object({
    catalogId: z.string().min(1),
    runtime: z.enum(["gguf", "mlx"]),
    /** Bytes the install moved (the catalog's pinned sizes). */
    bytes: count,
    /** Milliseconds from the request to `ready`, null when it did not get there. */
    installMs: count.nullable()
  })
  .strict();

/**
 * What a recording keeps next to its cassette (`firstrun-record.json`): the route without
 * credentials or paths, the two sources, what the run produced (a replay must produce the same), and
 * the live clock, whose download term D a replay adds to its own T1 - T0 (E6).
 */
export const RecordedFirstRunSchema = z
  .object({
    format: z.literal("memora-firstrun-e2e-record"),
    version: z.literal(1),
    recordedAt: z.string().datetime(),
    /** True for the harness's own self-test; a synthetic record never stands for the live one. */
    synthetic: z.boolean(),
    contentLanguage: z.string().min(1),
    sources: z.object({ first: z.string().min(1), second: z.string().min(1) }).strict(),
    writer: RecordedWriterSchema,
    /**
     * When the topic jobs ran (a2, E6A2) and how the link jobs ran: a replay with another policy
     * makes the same calls in another order, so it refuses the cassette. Absent in a record made
     * before E6A2 (the both-imports barrier, the product link runtime), which no replay accepts.
     */
    topicRelease: TopicReleaseSettingsSchema.optional(),
    linkRuntime: z.enum(harnessLinkRuntimes).optional(),
    models: z.object({ embedding: RecordedModelSchema, ranker: RecordedModelSchema }).strict(),
    result: z
      .object({
        notes: count,
        topics: count,
        noteRelations: count,
        /** The topics and relations as content (no IDs, no times): two replays must share it. */
        digest: z.string().regex(/^[0-9a-f]{64}$/)
      })
      .strict(),
    timing: z
      .object({
        /** T1 - T0 of the live run. */
        t1MinusT0Ms: count,
        /** PostgreSQL start, migrations and service start, inside T1 - T0. */
        appLaunchMs: count,
        /**
         * D: the time the live run spent waiting for a download with nothing else to do (the first
         * download's request to the last model ready, minus every moment the pipeline was busy).
         */
        downloadCriticalPathMs: count,
        /** First download request to the last model ready, busy or not. */
        downloadWindowMs: count,
        /**
         * Whether the clock is a live one: false for a take resumed from an earlier cassette, whose
         * served calls answered at once. A replay gate refuses the D of a clock that is not live.
         */
        live: z.boolean()
      })
      .strict()
  })
  .strict();
export type RecordedFirstRun = z.infer<typeof RecordedFirstRunSchema>;

export type FirstRunMode = "record" | "replay" | "both";

export interface FirstRunConfig {
  /** `both` (synthetic only) records and then replays in one invocation. */
  mode: FirstRunMode;
  /** A tiny built-in library, synthetic models and a synthetic writer: no PDF, download or model. */
  synthetic: boolean;
  /** The checkout whose `.cache` holds the golden sources, the models, the cassette and the reports. */
  repositoryRoot: string;
  manifestPath: string;
  sources: { first: string; second: string };
  cassetteDir: string | null;
  /** Record: the writer to sign in to. */
  writer: WriterRoute | null;
  /** Cap on the live remote tokens of a recording. */
  maxTokens: number | null;
  /** Replay: the folder of the seeded models, resolved (null when the run needs none). */
  seedDir: string | null;
  /** Replay: how many passes one invocation makes (the gate wants two). */
  replays: number;
  /** Replay: `recorded` waits each served call its recorded duration (the E6 measurement), `off` serves at once. */
  timing: "recorded" | "off";
  locale: string;
  laneTimeoutMs: number;
  downloadTimeoutMs: number;
  /** E6's bar: each replay plus D must fit. */
  budgetMs: number;
  /** When the held topic jobs run (a2); a replay must use the recording's. */
  topicRelease: TopicReleaseSettings;
  workDir: string | null;
  keep: boolean;
  /** Record: continue a cassette that already holds calls (the clock of that take is not live). */
  resume: boolean;
  /** Record: copy the downloaded models into this seed folder, for the replays (opt-in). */
  copyModelsTo: string | null;
  reportDir: string | null;
  json: boolean;
}

export const usage = `Usage: npm run firstrun:e2e -- [options]

  Replay (default; the cassette, the seeded models and the golden sources; no network, no key):
    MEMORA_LOCAL_MODEL_SEED_DIR=<repository>/.cache/models npm run firstrun:e2e -- --replays 2
  Record (once, the live clean install; downloads the two first-run models for real, calls the writer):
    npm run firstrun:e2e -- --mode record --max-tokens <cap> \\
      --codex-credential-file <file> --copy-models-to <repository>/.cache/models \\
      [--writer-model ${defaultCodexModel}]
    npm run firstrun:e2e -- --mode record --max-tokens <cap> \\
      --writer-provider openai-compatible --writer-model <id> --writer-base-url <url>
  Self-test of the harness (records and replays a tiny synthetic library; no models, no network):
    npm run firstrun:e2e -- --synthetic

  The clock (E6): T0 is the app launch on an empty userData (the database starts and migrates, the
  services start); T1 is a note of the first source in a named topic with a shown relation. A replay
  passes when its T1 - T0 plus D, the download time the live record spent on the critical path, is at
  most ${e6BudgetMinutes} minutes. The topic jobs are held while the sources import and released by
  policy a2 (at the first division boundary with ${defaultTopicReleaseNotes} first-source notes, then per source); the
  link jobs run in drain mode, so two replays make the same calls in the same order.

  --mode record|replay|both   both = record then replay (synthetic only)
  --synthetic                 synthetic library, models and writer
  --cassette-dir <dir>        default <repo>/.cache/topics/cassettes/${firstRunCassetteName}
  --first-source <key>        golden manifest key (default ${defaultFirstSourceKey})
  --second-source <key>       golden manifest key (default ${defaultSecondSourceKey})
  --manifest <file>           default scripts/golden/manifest.json
  --locale <code>             desktop locale of the fresh profile (default ${defaultLocale})
  --replays <n>               replay passes in this invocation (default 1)
  --timing recorded|off       replay: served calls wait their recorded time (default recorded)
  --seed-dir <dir>            replay: the seeded models (default $MEMORA_LOCAL_MODEL_SEED_DIR, else <repo>/.cache/models)
  --lane-timeout <minutes>    light lane budget of each release (default ${defaultLaneTimeoutMinutes})
  --download-timeout <min>    one model's install budget (default ${defaultDownloadTimeoutMinutes})
  --budget-minutes <n>        E6's bar (default ${e6BudgetMinutes})
  --topic-release-notes <n>   a2: release the topic work at the first division boundary where the
                              first source has n notes (default ${defaultTopicReleaseNotes}), then per source
  --topic-release-repeat      a2 hardening: release again at every division boundary until T1
                              (a replay takes the recording's two release options)
  --work-dir <dir>            where the scratch workspace is made (default: system temp)
  --keep                      keep the scratch workspace
  --resume                    record: continue a cassette that holds calls (its clock is not live, so it cannot gate)
  --copy-models-to <dir>      record: copy the downloaded models into this seed folder (inside .cache) for the replays
  --report <dir>              default <repo>/.cache/topics/firstrun-e2e/<time>
  --json                      print the report as JSON
  --workspace-root <dir>      the checkout that holds .cache (default: this one)

  Record route (the owner's profile is never touched; no credential is copied into a report):
    --writer-provider openai-codex|openai-compatible|google   default openai-codex
    --writer-model <id>         default ${defaultCodexModel} for Codex
    --codex-credential-file <f> JSON {access, expires, accountId, refresh}; the access token must
                                outlive the run by ${codexMinimumRemainingMinutes} minutes (the refresh token is dropped:
                                the harness never refreshes, so it cannot rotate the real one)
    --writer-base-url <url>     an OpenAI-compatible server, or a Codex-wire one for a test
    --writer-key-env <NAME> --writer-key-file <file>   key from $${defaultApiKeyEnv} by default
    --max-tokens <n>            required: cap on live remote tokens
`;

function insideCache(root: string, directory: string): boolean {
  const inside = relative(resolve(root, ".cache"), directory);
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

function positiveNumber(flag: string, value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0)
    throw new UsageError(`${flag} must be a positive number`);
  return number;
}

function positiveInteger(flag: string, value: string | undefined, fallback: number | null) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0)
    throw new UsageError(`${flag} must be a positive whole number`);
  return number;
}

const writerFlags = [
  "writer-provider",
  "writer-model",
  "writer-base-url",
  "writer-key-env",
  "writer-key-file",
  "codex-credential-file"
] as const;

export function parseFirstRunArgs(
  argv: readonly string[],
  context: { repositoryRoot: string; env?: Readonly<Record<string, string | undefined>> }
): FirstRunConfig | "help" {
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
        "first-source": { type: "string" },
        "second-source": { type: "string" },
        manifest: { type: "string" },
        locale: { type: "string" },
        replays: { type: "string" },
        timing: { type: "string" },
        "seed-dir": { type: "string" },
        "lane-timeout": { type: "string" },
        "download-timeout": { type: "string" },
        "budget-minutes": { type: "string" },
        "topic-release-notes": { type: "string" },
        "topic-release-repeat": { type: "boolean" },
        "work-dir": { type: "string" },
        keep: { type: "boolean" },
        report: { type: "string" },
        json: { type: "boolean" },
        "workspace-root": { type: "string" },
        "writer-provider": { type: "string" },
        "writer-model": { type: "string" },
        "writer-base-url": { type: "string" },
        "writer-key-env": { type: "string" },
        "writer-key-file": { type: "string" },
        "codex-credential-file": { type: "string" },
        "max-tokens": { type: "string" },
        resume: { type: "boolean" },
        "copy-models-to": { type: "string" }
      }
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const v = parsed.values;
  if (v.help) return "help";
  const root = resolve(v["workspace-root"] ?? context.repositoryRoot);
  const synthetic = v.synthetic === true;
  const mode = (v.mode ?? (synthetic ? "both" : "replay")) as FirstRunMode;
  if (!["record", "replay", "both"].includes(mode))
    throw new UsageError("--mode is record, replay or both");
  if (mode === "both" && !synthetic) throw new UsageError("--mode both needs --synthetic");
  const recording = mode === "record" || mode === "both";
  const replaying = mode === "replay" || mode === "both";

  const replays = positiveInteger("--replays", v.replays, 1)!;
  if (replays > 1 && !replaying) throw new UsageError("--replays only applies to a replay");
  const maxTokens = positiveInteger("--max-tokens", v["max-tokens"], null);
  const timing = v.timing ?? "recorded";
  if (timing !== "recorded" && timing !== "off")
    throw new UsageError("--timing is recorded or off");
  if (v.timing !== undefined && !replaying)
    throw new UsageError("--timing only applies to a replay");

  const givenWriterFlags = writerFlags.filter((flag) => v[flag] !== undefined);
  let writer: WriterRoute | null = null;
  if (synthetic) {
    if (givenWriterFlags.length > 0 || maxTokens !== null)
      throw new UsageError("--synthetic configures its own writer; drop the writer flags");
  } else if (mode === "replay") {
    if (givenWriterFlags.length > 0)
      throw new UsageError(`Replay rebuilds the recorded route; drop --${givenWriterFlags[0]}`);
    if (maxTokens !== null) throw new UsageError("--max-tokens only applies to a recording");
  } else {
    writer = writerFromFlags(v, root);
    if (maxTokens === null)
      throw new UsageError(
        "Recording spends a remote writer: set --max-tokens (a cap on live tokens)"
      );
  }

  const cassetteDir = v["cassette-dir"] ? resolve(v["cassette-dir"]) : null;
  if (cassetteDir && !synthetic && !insideCache(root, cassetteDir))
    throw new UsageError(
      `--cassette-dir must be a folder inside ${join(root, ".cache")}: a cassette holds full prompts and outputs`
    );
  if (v.resume === true && !recording) throw new UsageError("--resume only applies to a recording");
  const copyModelsTo = v["copy-models-to"] ? resolve(v["copy-models-to"]) : null;
  if (copyModelsTo !== null) {
    if (mode !== "record" || synthetic)
      throw new UsageError("--copy-models-to only applies to a live recording");
    if (!insideCache(root, copyModelsTo))
      throw new UsageError(`--copy-models-to must be a folder inside ${join(root, ".cache")}`);
  }
  const environmentSeed = context.env?.MEMORA_LOCAL_MODEL_SEED_DIR?.trim();
  const configuredSeed = v["seed-dir"] ?? (environmentSeed ? environmentSeed : undefined);
  if (v["seed-dir"] !== undefined && !replaying)
    throw new UsageError("--seed-dir only applies to a replay: a recording downloads for real");
  const seedDir =
    replaying && !synthetic ? resolve(root, configuredSeed ?? join(".cache", "models")) : null;

  return {
    mode,
    synthetic,
    repositoryRoot: root,
    manifestPath: resolve(v.manifest ?? join(root, "scripts", "golden", "manifest.json")),
    sources: {
      first: v["first-source"] ?? defaultFirstSourceKey,
      second: v["second-source"] ?? defaultSecondSourceKey
    },
    cassetteDir,
    writer: recording && !synthetic ? writer : null,
    maxTokens,
    seedDir,
    replays,
    timing,
    locale: v.locale ?? defaultLocale,
    laneTimeoutMs:
      positiveNumber("--lane-timeout", v["lane-timeout"], defaultLaneTimeoutMinutes) * 60_000,
    downloadTimeoutMs:
      positiveNumber("--download-timeout", v["download-timeout"], defaultDownloadTimeoutMinutes) *
      60_000,
    budgetMs: positiveNumber("--budget-minutes", v["budget-minutes"], e6BudgetMinutes) * 60_000,
    topicRelease: topicReleaseSettings({
      firstSourceNotes: positiveInteger(
        "--topic-release-notes",
        v["topic-release-notes"],
        defaultTopicReleaseNotes
      )!,
      repeatUntilT1: v["topic-release-repeat"] === true
    }),
    workDir: v["work-dir"] ? resolve(v["work-dir"]) : null,
    keep: v.keep === true,
    resume: v.resume === true,
    copyModelsTo,
    reportDir: v.report ? resolve(v.report) : null,
    json: v.json === true
  };
}

function writerFromFlags(
  v: Record<string, string | boolean | undefined>,
  root: string
): WriterRoute {
  const text = (name: string) => (typeof v[name] === "string" ? (v[name] as string) : undefined);
  const provider = text("writer-provider") ?? "openai-codex";
  if (provider === "openai-codex") {
    for (const flag of ["writer-key-env", "writer-key-file"])
      if (text(flag) !== undefined)
        throw new UsageError(
          `--${flag} is for an API key route; Codex signs in with --codex-credential-file`
        );
    const credentialFile = text("codex-credential-file");
    if (!credentialFile)
      throw new UsageError(
        "A Codex recording needs --codex-credential-file <file> (the OAuth credential, kept outside the repository)"
      );
    const path = resolve(credentialFile);
    // A credential never sits in the working tree: a repository path other than the ignored cache is refused.
    const inside = relative(root, path);
    const inRepository = inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
    if (inRepository && !insideCache(root, path))
      throw new UsageError(
        "--codex-credential-file must be outside the repository (or inside its ignored .cache)"
      );
    return CodexWriterSchema.parse({
      kind: "codex",
      modelId: text("writer-model") ?? defaultCodexModel,
      ...(text("writer-base-url") ? { baseUrl: text("writer-base-url") } : {}),
      credentialFile: path
    });
  }
  if (text("codex-credential-file") !== undefined)
    throw new UsageError("--codex-credential-file is for --writer-provider openai-codex");
  if (provider !== "openai-compatible" && provider !== "google")
    throw new UsageError("--writer-provider is openai-codex, openai-compatible or google");
  if (!text("writer-model")) throw new UsageError("A remote writer needs --writer-model");
  const parsed = RemoteWriterSchema.safeParse({
    kind: "remote",
    provider,
    modelId: text("writer-model"),
    ...(text("writer-base-url") ? { baseUrl: text("writer-base-url") } : {}),
    ...(text("writer-key-env") ? { apiKeyEnv: text("writer-key-env") } : {}),
    ...(text("writer-key-file") ? { apiKeyFile: resolve(text("writer-key-file")!) } : {})
  });
  if (!parsed.success)
    throw new UsageError(
      `Invalid route: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`
    );
  return parsed.data;
}

/** The writer a record keeps: the route without credentials, keys or paths. */
export function recordedWriter(writer: WriterRoute): RecordedWriter {
  if (writer.kind === "codex")
    return {
      kind: "codex",
      modelId: writer.modelId,
      ...(writer.baseUrl ? { baseUrl: writer.baseUrl } : {})
    };
  return {
    kind: "remote",
    provider: writer.provider,
    ...(writer.baseUrl ? { baseUrl: writer.baseUrl } : {}),
    modelId: writer.modelId
  };
}

/** The writer a replay signs in to: the recorded one, with placeholders where a secret was. */
export function replayWriter(recorded: RecordedWriter): WriterRoute {
  return recorded.kind === "codex"
    ? {
        kind: "codex",
        modelId: recorded.modelId,
        ...(recorded.baseUrl ? { baseUrl: recorded.baseUrl } : {}),
        credentialFile: "replay-placeholder"
      }
    : { ...recorded, apiKeyEnv: defaultApiKeyEnv };
}
