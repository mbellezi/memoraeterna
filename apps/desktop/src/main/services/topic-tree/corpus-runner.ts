// ENV-C, the corpus measurement profile (F2 T22b, spec section 4): a DEV-only runner that fills an
// empty measurement profile (`.cache/profiles/<name>`, made by `scripts/topics/env-profiles.ts`)
// with the 18,632-note Wikipedia pseudo-note corpus, lets the app's own `note-embedding` jobs embed
// it through the active route, and then lets the Topic Tree Engine build and name the tree once.
//
//   MEMORA_TOPIC_CORPUS=1                      the corpus in <workspace>/.cache/corpus, or a folder
//   MEMORA_TOPIC_CORPUS_STAGE=all              seed, build, arrive (or a comma list of them)
//   MEMORA_TOPIC_CORPUS_HOLDOUT=articles:40    articles held out of the base (share:<x>, file:<path>)
//   MEMORA_TOPIC_CORPUS_ARTICLES=<n>           a seeded n-article subset (smoke runs)
//   MEMORA_TOPIC_CORPUS_SEED=20261014          seed of the subset and of the holdout
//   MEMORA_TOPIC_CORPUS_MAX_TOKENS=<n>         live remote token cap of the topic stages
//   MEMORA_TOPIC_CORPUS_EXIT=1                 quit when the run ends
//
// Stages (D23): `seed` loads the base articles and waits until every note has its vector in the
// route's embedding space (run it with no AI cassette: a cassette in record mode would record
// each of the 18,632 embedding calls); `build` releases the topic barrier and lets the light lane run what the
// sweep enqueues (the cold-start build, then naming and Areas) until it is quiet; `arrive` seeds
// the held-out articles one at a time, each followed by its PLACE and a drained light lane, so the
// items present at every gate call are a function of the arrival order. Topic jobs are held from
// the moment the app starts until the build stage releases them, so the one bootstrap build sees
// every note. The stages can run in separate starts (a marker in the settings records where the
// library stands); a seed-only start leaves the topic jobs held for the rest of the session.
//
// A packaged build ignores the knobs. In DEV it is refused (and the app quits) when the profile is
// not a measurement profile of kind `env-c`, when the library is not empty (the seed stage), when
// an Obsidian vault is synchronizing, beside another DEV knob that changes the library, and, for
// the stages that call topic AI, without an AI cassette in `record` mode with a token cap (or
// `replay`). Only log lines and `.cache/topics/corpus-runs/<time>.json` leave the process; the
// runner itself calls no model (the app's own jobs embed, build and name).
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  createJobRepository,
  createSettingsRepository,
  createStorageSettingsRepository,
  createTopicTreeLoadRepository,
  createTopicTreeRepository
} from "@app/db";
import type { PgPool, TopicLoadSpace } from "@app/db";
import { z } from "zod";

import { isMeasurementProfilePath, profilesDirectory } from "../profile-reset.js";
import { resolveWorkspaceRoot } from "../workspace-paths.js";
import {
  loadCorpus,
  limitArticles,
  parseHoldout,
  planCorpus,
  seedArticle
} from "./corpus-library.js";
import type { Corpus, CorpusArticle, HoldoutSpec } from "./corpus-library.js";
import { sameSpace } from "./topic-space.js";
import type { SpaceResolver } from "./topic-space.js";
import { immediateDebounce } from "./topic-triggers.js";
import type { TopicTriggers } from "./topic-triggers.js";

export const corpusKnobs = {
  corpus: "MEMORA_TOPIC_CORPUS",
  stage: "MEMORA_TOPIC_CORPUS_STAGE",
  holdout: "MEMORA_TOPIC_CORPUS_HOLDOUT",
  articles: "MEMORA_TOPIC_CORPUS_ARTICLES",
  seed: "MEMORA_TOPIC_CORPUS_SEED",
  maxTokens: "MEMORA_TOPIC_CORPUS_MAX_TOKENS",
  exit: "MEMORA_TOPIC_CORPUS_EXIT"
} as const;

/** DEV knobs that import, wipe or reset a library; the corpus runner never runs beside one. */
export const corpusConflictingKnobs = [
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_PROFILE_RESET",
  "MEMORA_LEGACY_WIPE",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK"
] as const;

export const corpusStages = ["seed", "build", "arrive"] as const;
export type CorpusStage = (typeof corpusStages)[number];

/** The pre-registered evaluation seed (`topicTreeSeed`). */
export const defaultCorpusSeed = 20261014;
export const corpusMarkerSettingKey = "topics.corpus.v1";

export type CorpusRefusalCode =
  | "packaged"
  | "invalidValue"
  | "conflictingKnob"
  | "outsideProfiles"
  | "notEnvCProfile"
  | "notDevelopmentDatabase"
  | "libraryNotEmpty"
  | "notSeeded"
  | "vaultSynchronizing"
  | "cassetteRequired"
  | "tokenCapRequired"
  | "noActiveTree";

export class CorpusRefusal extends Error {
  public constructor(
    public readonly code: CorpusRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "CorpusRefusal";
  }
}

export interface CorpusConfig {
  directory: string;
  stages: readonly CorpusStage[];
  holdout: HoldoutSpec | null;
  articleLimit: number | null;
  seed: number;
  maxTokens: number | null;
  exit: boolean;
  cassette: "record" | "replay" | null;
  workspaceRoot: string;
  userDataPath: string;
}

function positiveInteger(name: string, value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0)
    throw new CorpusRefusal("invalidValue", `${name} must be a positive whole number`);
  return parsed;
}

/**
 * Reads the knobs: null when `MEMORA_TOPIC_CORPUS` is unset (a normal start); a refusal for a
 * packaged build, a conflicting knob, a bad value or an unsafe AI setting. Nothing is touched.
 */
export function readCorpusConfig(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): CorpusConfig | null {
  const raw = env[corpusKnobs.corpus]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new CorpusRefusal("packaged", `${corpusKnobs.corpus} is refused in packaged builds`);
  const others = corpusConflictingKnobs.filter((name) => env[name]?.trim());
  if (others.length > 0)
    throw new CorpusRefusal(
      "conflictingKnob",
      `${corpusKnobs.corpus} cannot run with ${others.join(", ")}`
    );
  const userData = env.MEMORA_USER_DATA_DIR?.trim();
  if (!userData)
    throw new CorpusRefusal(
      "outsideProfiles",
      `${corpusKnobs.corpus} needs MEMORA_USER_DATA_DIR to name a profile under .cache/profiles/`
    );
  const stageValue = env[corpusKnobs.stage]?.trim() || "all";
  const named =
    stageValue === "all" ? [...corpusStages] : stageValue.split(",").map((s) => s.trim());
  const unknown = named.filter((stage) => !(corpusStages as readonly string[]).includes(stage));
  if (unknown.length > 0)
    throw new CorpusRefusal(
      "invalidValue",
      `${corpusKnobs.stage} is all or a list of ${corpusStages.join(", ")} (got ${unknown.join(", ")})`
    );
  const stages = corpusStages.filter((stage) => named.includes(stage));
  let holdout: HoldoutSpec | null = null;
  const holdoutValue = env[corpusKnobs.holdout]?.trim();
  if (holdoutValue) {
    try {
      holdout = parseHoldout(holdoutValue, options.workspaceRoot);
    } catch (error) {
      throw new CorpusRefusal(
        "invalidValue",
        error instanceof Error ? error.message : String(error)
      );
    }
  }
  const seedValue = env[corpusKnobs.seed]?.trim();
  const seed = seedValue === undefined || seedValue === "" ? defaultCorpusSeed : Number(seedValue);
  if (!Number.isSafeInteger(seed) || seed < 0)
    throw new CorpusRefusal("invalidValue", `${corpusKnobs.seed} must be a whole number`);
  const maxTokens = positiveInteger(corpusKnobs.maxTokens, env[corpusKnobs.maxTokens]);
  const cassetteValue = env.MEMORA_AI_CASSETTE?.trim();
  const cassette = cassetteValue === "record" || cassetteValue === "replay" ? cassetteValue : null;
  // The stages that run topic AI (naming, Areas, the gate) never reach a provider unrecorded.
  if (stages.some((stage) => stage !== "seed")) {
    if (cassette === null)
      throw new CorpusRefusal(
        "cassetteRequired",
        "The build and arrive stages call topic AI: set MEMORA_AI_CASSETTE=record (with a token cap) or replay and MEMORA_AI_CASSETTE_DIR"
      );
    if (cassette === "record" && maxTokens === null)
      throw new CorpusRefusal(
        "tokenCapRequired",
        `MEMORA_AI_CASSETTE=record needs ${corpusKnobs.maxTokens} (a cap on the live remote tokens)`
      );
  }
  const workspaceRoot = resolve(options.workspaceRoot);
  return {
    directory: raw === "1" ? join(workspaceRoot, ".cache", "corpus") : resolve(workspaceRoot, raw),
    stages,
    holdout,
    articleLimit: positiveInteger(corpusKnobs.articles, env[corpusKnobs.articles]),
    seed,
    maxTokens,
    exit: env[corpusKnobs.exit]?.trim() === "1",
    cassette,
    workspaceRoot,
    userDataPath: resolve(userData)
  };
}

// ---------------------------------------------------------------------------
// Marker and summary

const markerSchema = z
  .object({
    format: z.literal("memora-topic-corpus-marker"),
    version: z.literal(1),
    corpus: z.string().min(1),
    seededAt: z.string(),
    seed: z.number().int(),
    articles: z.number().int().min(0),
    notes: z.number().int().min(0),
    /** Held-out article keys in arrival order, and the ones that arrived. */
    held: z.array(z.string()),
    arrived: z.array(z.string()),
    embeddedAt: z.string().nullable(),
    builtAt: z.string().nullable()
  })
  .strict();
export type CorpusMarker = z.infer<typeof markerSchema>;

export type CorpusOutcome = "completed" | "token_limit" | "failed" | "refused";

export interface SeedSummary {
  articles: number;
  notes: number;
  chunks: number;
  ms: number;
  held: number;
}

export interface EmbeddingSummary {
  notes: number;
  ms: number;
  notesPerSecond: number;
  failedJobs: number;
  /** Notes whose embedding job was lost or failed and was queued again (at most two rounds). */
  requeued: number;
  /** The one embedding space of the notes' vectors. */
  space: TopicLoadSpace | null;
  /** `same`: the route's space is the stored one; `route_unresolved`: the route named none. */
  spaceCheck: "same" | "route_unresolved" | "mismatch" | "mixed" | "none";
  /**
   * The embedding calls this run made, from the AI audit: which route embedded the notes
   * (`node-llama-cpp` is the GGUF runtime, `mlx-swift-lm` MLX, `cassette-replay` a recorded call).
   */
  routes: EmbeddingRoute[];
}

export interface EmbeddingRoute {
  provider: string;
  model: string;
  runtime: string;
  adapter: string;
  quantization: string | null;
  calls: number;
}

export interface BuildSummary {
  ms: number;
  polls: number;
  topics: number;
  primaryPlacements: number;
  needsGate: number;
  changeSets: Record<string, number>;
  jobs: Array<{ type: string; status: string; count: number }>;
}

export interface ArrivalSummary {
  article: string;
  notes: number;
  seedMs: number;
  embedMs: number;
  drainMs: number;
}

export interface CorpusRunSummary {
  format: "memora-topic-corpus-run";
  version: 1;
  outcome: CorpusOutcome;
  /** Why the run did not complete: a refusal code or a short message, never a secret. */
  reason: string | null;
  startedAt: string;
  finishedAt: string;
  stages: readonly CorpusStage[];
  corpus: { name: string; articles: number; notes: number } | null;
  seed: SeedSummary | null;
  embedding: EmbeddingSummary | null;
  build: BuildSummary | null;
  arrivals: ArrivalSummary[];
  /** Live remote calls and tokens of the topic stages (cassette replays excluded). */
  ai: {
    cassette: "record" | "replay" | null;
    maxTokens: number | null;
    remoteCalls: number;
    liveTokens: number;
  };
  topicJobsLeftHeld: boolean;
  /** Things that are legal but worth a look (for example a build that left no topics). */
  warnings: string[];
}

// ---------------------------------------------------------------------------
// The runner

export interface CorpusTopicService {
  holdTopicJobs(): void;
  releaseTopicJobs(): Promise<void>;
}

export interface CorpusRunnerOptions {
  config: CorpusConfig;
  getPool: () => PgPool | null;
  service: CorpusTopicService;
  triggers: Pick<TopicTriggers, "place" | "sweep">;
  spaceResolver: SpaceResolver;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
  /** Polling pause; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  /** An embedding wait that makes no progress for this long fails. */
  embedStallMs?: number;
  /** A topic lane that has not gone quiet after this long fails (default 3 h). */
  drainTimeoutMs?: number;
  /** Quits the app after the run (`MEMORA_TOPIC_CORPUS_EXIT=1`). */
  quit?: () => void | Promise<void>;
  /** Folder of the run summaries (default `<cache>/topics/corpus-runs`). */
  summaryDirectory?: string;
}

interface EmbeddingProgress {
  notes: number;
  missing: number;
  queued: number;
  running: number;
  failed: number;
}

const topicJobPrefix = "topic-";
const currentNote =
  "a.status not in ('rejected', 'archived') and a.supersession_status = 'current'";
const embeddingTables = [256, 768, 1024] as const;
/** A subquery per embedding table: the note `a` has a vector that names its space. */
const noteHasVector = embeddingTables
  .map(
    (dimensions) =>
      `select 1 from embeddings_${dimensions} e where e.target_type = 'atomic_note' and e.target_id = a.id and starts_with(e.strategy, 'native-v2:')`
  )
  .join(" union all ");

class CorpusStop extends Error {
  public constructor(public readonly outcome: "token_limit") {
    super(outcome);
  }
}

export class CorpusRunner {
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private held = true;
  private runStartedAt: Date;
  private readonly summary: CorpusRunSummary;

  public constructor(private readonly options: CorpusRunnerOptions) {
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => delay(ms));
    this.runStartedAt = this.now();
    this.summary = {
      format: "memora-topic-corpus-run",
      version: 1,
      outcome: "failed",
      reason: null,
      startedAt: this.runStartedAt.toISOString(),
      finishedAt: this.runStartedAt.toISOString(),
      stages: options.config.stages,
      corpus: null,
      seed: null,
      embedding: null,
      build: null,
      arrivals: [],
      ai: {
        cassette: options.config.cassette,
        maxTokens: options.config.maxTokens,
        remoteCalls: 0,
        liveTokens: 0
      },
      topicJobsLeftHeld: true,
      warnings: []
    };
  }

  private log(message: string, details?: Record<string, unknown>): void {
    this.options.logger?.info(
      `CORPUS_RUN ${message}${details ? ` ${JSON.stringify(details)}` : ""}`
    );
  }

  private pool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  private hold(): void {
    this.options.service.holdTopicJobs();
    this.held = true;
  }

  private async release(): Promise<void> {
    await this.options.service.releaseTopicJobs();
    this.held = false;
  }

  /** Runs the stages; never throws. The summary is written and the app quits when asked. */
  public async run(): Promise<CorpusRunSummary> {
    const { config } = this.options;
    const stages = new Set(config.stages);
    try {
      this.log("started", { stages: config.stages, corpus: config.directory });
      await this.preflight(stages);
      const corpus = await loadCorpus(config.directory);
      const articles =
        config.articleLimit === null
          ? corpus.articles
          : limitArticles(corpus.articles, config.articleLimit, config.seed);
      this.summary.corpus = {
        name: corpus.name,
        articles: articles.length,
        notes: articles.reduce((total, article) => total + article.notes.length, 0)
      };
      if (stages.has("seed")) await this.seedStage(corpus, articles);
      if (stages.has("build")) await this.buildStage();
      if (stages.has("arrive")) await this.arriveStage(corpus);
      this.summary.outcome = "completed";
    } catch (error) {
      if (error instanceof CorpusStop) {
        this.summary.outcome = error.outcome;
        this.summary.reason = "the live token cap was reached; the topic jobs stay held";
      } else if (error instanceof CorpusRefusal) {
        this.summary.outcome = "refused";
        this.summary.reason = `${error.code}: ${error.message}`;
      } else {
        this.summary.outcome = "failed";
        this.summary.reason = describeError(error);
      }
      this.options.logger?.error(`CORPUS_RUN ${this.summary.outcome}: ${this.summary.reason}`);
    }
    await this.finish();
    return this.summary;
  }

  private async finish(): Promise<void> {
    const { config } = this.options;
    // The build stage hands the topic lane back to the app, unless something stopped the run:
    // a stopped run must not let queued topic work reach a provider.
    if (this.summary.outcome === "completed" && this.held && config.stages.includes("build")) {
      try {
        await this.release();
      } catch (error) {
        this.options.logger?.error(
          `CORPUS_RUN could not release the topic jobs: ${describeError(error)}`
        );
      }
    }
    this.summary.topicJobsLeftHeld = this.held;
    if (this.held) this.log("topics_left_held");
    await this.readLiveUsage().catch(() => undefined);
    this.summary.finishedAt = this.now().toISOString();
    try {
      await this.writeSummary();
    } catch (error) {
      this.options.logger?.error(`CORPUS_RUN could not write the summary: ${describeError(error)}`);
    }
    this.log("finished", { outcome: this.summary.outcome, liveTokens: this.summary.ai.liveTokens });
    if (config.exit || this.summary.outcome === "refused") {
      try {
        await this.options.quit?.();
      } catch (error) {
        this.options.logger?.error(`CORPUS_RUN could not quit: ${describeError(error)}`);
      }
    }
  }

  private async writeSummary(): Promise<void> {
    const directory =
      this.options.summaryDirectory ??
      join(this.options.config.workspaceRoot, ".cache", "topics", "corpus-runs");
    await mkdir(directory, { recursive: true });
    const stamp = this.runStartedAt
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d+Z$/u, "Z");
    const target = join(directory, `${stamp}.json`);
    await writeFile(`${target}.tmp`, `${JSON.stringify(this.summary, null, 2)}\n`);
    await rename(`${target}.tmp`, target);
    this.log("summary", { path: target });
  }

  // -------------------------------------------------------------------------
  // Safety checks

  private async preflight(stages: ReadonlySet<CorpusStage>): Promise<void> {
    const { config } = this.options;
    if (!(await isMeasurementProfilePath(config.userDataPath, config.workspaceRoot)))
      throw new CorpusRefusal(
        "outsideProfiles",
        `${corpusKnobs.corpus} only fills a profile inside ${profilesDirectory.join("/")}/ (set MEMORA_USER_DATA_DIR)`
      );
    const descriptor = z
      .object({ developmentOnly: z.literal(true) })
      .safeParse(await readJson(join(config.userDataPath, "database", "dev-connection.json")));
    if (!descriptor.success)
      throw new CorpusRefusal(
        "notDevelopmentDatabase",
        "The profile has no DEV PostgreSQL sidecar"
      );
    const record = z
      .looseObject({ format: z.literal("memora-measurement-profile"), kind: z.literal("env-c") })
      .safeParse(await readJson(join(config.userDataPath, "profile.json")));
    if (!record.success)
      throw new CorpusRefusal(
        "notEnvCProfile",
        "The profile was not made by `env-profiles.ts create env-c` (profile.json is missing or another kind)"
      );
    const pool = this.pool();
    const storage = await createStorageSettingsRepository(pool).get();
    if (storage?.obsidianVaultPath && storage.obsidianSyncEnabled)
      throw new CorpusRefusal(
        "vaultSynchronizing",
        "An Obsidian vault is configured and synchronizing: 18,632 notes would be written into it"
      );
    const marker = await this.readMarker();
    if (stages.has("seed")) {
      const counts = await pool.query<{ sources: number; notes: number }>(
        "select (select count(*)::int from source_items) as sources, (select count(*)::int from atomic_notes) as notes"
      );
      const sources = Number(counts.rows[0]?.sources ?? 0);
      const notes = Number(counts.rows[0]?.notes ?? 0);
      if (marker !== null || sources > 0 || notes > 0)
        throw new CorpusRefusal(
          "libraryNotEmpty",
          `The library is not empty (${sources} sources, ${notes} notes${marker ? ", already seeded" : ""}); reset the profile first`
        );
    } else if (marker === null) {
      throw new CorpusRefusal(
        "notSeeded",
        "The profile holds no seeded corpus: run the seed stage first"
      );
    }
  }

  private async readMarker(): Promise<CorpusMarker | null> {
    const stored = await createSettingsRepository(this.pool()).get(corpusMarkerSettingKey);
    if (stored === null) return null;
    return markerSchema.parse(stored);
  }

  private async writeMarker(marker: CorpusMarker): Promise<void> {
    await createSettingsRepository(this.pool()).set(
      corpusMarkerSettingKey,
      markerSchema.parse(marker)
    );
  }

  // -------------------------------------------------------------------------
  // Seed

  private async seedStage(corpus: Corpus, articles: readonly CorpusArticle[]): Promise<void> {
    const { config } = this.options;
    const plan = await planCorpus(articles, config.holdout, config.seed);
    const pool = this.pool();
    const began = Date.now();
    let notes = 0;
    let chunks = 0;
    for (const [index, article] of plan.base.entries()) {
      const seeded = await seedArticle(pool, corpus, article);
      notes += seeded.noteIds.length;
      chunks += seeded.chunks;
      if ((index + 1) % 50 === 0 || index + 1 === plan.base.length)
        this.log("seeding", { articles: index + 1, of: plan.base.length, notes });
    }
    this.summary.seed = {
      articles: plan.base.length,
      notes,
      chunks,
      ms: Date.now() - began,
      held: plan.held.length
    };
    await this.writeMarker({
      format: "memora-topic-corpus-marker",
      version: 1,
      corpus: corpus.name,
      seededAt: this.now().toISOString(),
      seed: config.seed,
      articles: plan.base.length,
      notes,
      held: plan.held.map((article) => article.key),
      arrived: [],
      embeddedAt: null,
      builtAt: null
    });
    this.log("seeded", { ...this.summary.seed });
    await this.waitForEmbeddings(notes);
    const marker = (await this.readMarker())!;
    await this.writeMarker({ ...marker, embeddedAt: this.now().toISOString() });
  }

  // -------------------------------------------------------------------------
  // Embeddings (the app's own note-embedding jobs)

  private async embeddingProgress(): Promise<EmbeddingProgress> {
    const result = await this.pool().query<Record<string, number>>(
      `select (select count(*)::int from atomic_notes a where ${currentNote}) as notes,
              (select count(*)::int from atomic_notes a where ${currentNote} and not exists (${noteHasVector})) as missing,
              (select count(*)::int from jobs where type::text = 'note-embedding' and status::text = 'queued') as queued,
              (select count(*)::int from jobs where type::text = 'note-embedding' and status::text = 'running') as running,
              (select count(*)::int from jobs where type::text = 'note-embedding' and status::text = 'failed') as failed`
    );
    const row = result.rows[0] ?? {};
    return {
      notes: Number(row.notes ?? 0),
      missing: Number(row.missing ?? 0),
      queued: Number(row.queued ?? 0),
      running: Number(row.running ?? 0),
      failed: Number(row.failed ?? 0)
    };
  }

  /**
   * Waits until every current note has a vector in a named space. The app embeds them (one
   * `note-embedding` job per note); a wait that makes no progress for `embedStallMs`, or one with
   * jobs gone and notes still missing, fails with the numbers.
   */
  private async waitForEmbeddings(expectedNotes: number, record = true): Promise<EmbeddingSummary> {
    const began = Date.now();
    const interval = this.options.pollIntervalMs ?? 2000;
    const stallMs = this.options.embedStallMs ?? 20 * 60_000;
    let lastMissing = Number.POSITIVE_INFINITY;
    let lastProgressAt = Date.now();
    let nextLog = 0;
    let rounds = 0;
    let requeued = 0;
    for (;;) {
      const progress = await this.embeddingProgress();
      if (progress.missing === 0) {
        if (progress.notes < expectedNotes)
          throw new Error(`Only ${progress.notes} of ${expectedNotes} notes are in the library`);
        break;
      }
      if (progress.missing < lastMissing) {
        lastMissing = progress.missing;
        lastProgressAt = Date.now();
      }
      if (progress.queued + progress.running === 0) {
        // A job that failed its attempts, or was lost, leaves its note without a vector: queue the
        // missing ones again, twice at most, then say what is wrong.
        if (rounds >= 2)
          throw new Error(
            `${progress.missing} notes have no vector and no note-embedding job is left (${progress.failed} failed): ` +
              "the embedding route is unavailable or rejects the notes"
          );
        rounds += 1;
        const again = await this.requeueMissing();
        requeued += again;
        this.log("requeued", { notes: again, round: rounds });
        lastProgressAt = Date.now();
        continue;
      }
      if (Date.now() - lastProgressAt > stallMs)
        throw new Error(
          `The embedding made no progress for ${Math.round(stallMs / 60_000)} min (${progress.missing} notes missing)`
        );
      if (progress.notes - progress.missing >= nextLog) {
        this.log("embedding", { embedded: progress.notes - progress.missing, of: progress.notes });
        nextLog = progress.notes - progress.missing + 1000;
      }
      await this.sleep(interval);
    }
    const ms = Date.now() - began;
    const final = await this.embeddingProgress();
    const check = await this.checkSpace();
    const embedding: EmbeddingSummary = {
      notes: final.notes,
      ms,
      notesPerSecond: ms > 0 ? Math.round((final.notes / ms) * 100_000) / 100 : 0,
      failedJobs: final.failed,
      requeued,
      space: check.space,
      spaceCheck: check.result,
      routes: await this.embeddingRoutes()
    };
    if (record) this.summary.embedding = embedding;
    this.log("embedded", { ...embedding });
    if (check.result === "mismatch" || check.result === "mixed" || check.result === "none")
      throw new Error(`Embedding space check failed: ${check.result}`);
    return embedding;
  }

  /** Queues a `note-embedding` job again for every current note without a vector. */
  private async requeueMissing(): Promise<number> {
    const pool = this.pool();
    const missing = await pool.query<{ id: string; source: string }>(
      `select a.id::text as id, a.created_from_source_item_id::text as source from atomic_notes a
       where ${currentNote} and not exists (${noteHasVector}) order by a.id`
    );
    const jobs = createJobRepository(pool);
    let queued = 0;
    for (const row of missing.rows)
      if (await jobs.enqueueNoteEmbedding({ atomicNoteId: row.id, sourceItemId: row.source }))
        queued += 1;
    return queued;
  }

  /** The embedding routes this run's calls went through, from the AI audit (`ai_task_runs`). */
  private async embeddingRoutes(): Promise<EmbeddingRoute[]> {
    const rows = await this.pool().query<EmbeddingRoute>(
      `select provider, model_id as model, runtime, coalesce(adapter, '') as adapter, quantization,
              count(*)::int as calls
       from ai_task_runs
       where task_type = 'embedding' and status = 'succeeded' and started_at >= $1
       group by provider, model_id, runtime, adapter, quantization order by calls desc, model_id`,
      [this.runStartedAt]
    );
    return rows.rows.map((row) => ({ ...row, calls: Number(row.calls) }));
  }

  /** The vectors are in one named space, and it is the space the active route embeds in. */
  private async checkSpace(): Promise<{
    result: EmbeddingSummary["spaceCheck"];
    space: TopicLoadSpace | null;
  }> {
    const pool = this.pool();
    const spaces = new Set<string>();
    for (const dimensions of embeddingTables) {
      const rows = await pool.query<{ strategy: string }>(
        `select distinct strategy from embeddings_${dimensions}
         where target_type = 'atomic_note' and starts_with(strategy, 'native-v2:')`
      );
      for (const row of rows.rows) spaces.add(`${dimensions}:${row.strategy}`);
    }
    if (spaces.size === 0) return { result: "none", space: null };
    if (spaces.size > 1) return { result: "mixed", space: null };
    const stored = await createTopicTreeLoadRepository(pool).newestNoteVectorSpace();
    if (!stored) return { result: "none", space: null };
    const route = await this.options.spaceResolver.resolve();
    if (route.kind === "blocked") return { result: "route_unresolved", space: stored };
    // The route's space has no note vector at all: the stored vectors are of another space.
    if (route.kind === "unembedded") return { result: "mismatch", space: stored };
    return { result: sameSpace(route.space, stored) ? "same" : "mismatch", space: stored };
  }

  // -------------------------------------------------------------------------
  // Build

  private async buildStage(): Promise<void> {
    const marker = (await this.readMarker())!;
    // A start that only builds still waits for the notes' vectors (the seed stage may have been
    // interrupted before they were all there).
    if (this.summary.embedding === null) await this.waitForEmbeddings(marker.notes);
    const began = Date.now();
    await this.release();
    await this.options.triggers.sweep("requested", { debounce: immediateDebounce });
    const polls = await this.waitForTopicLane();
    const build = await this.readBuild(polls, Date.now() - began);
    this.summary.build = build;
    if (build.topics === 0)
      this.summary.warnings.push("the topic tree has no topics after the build stage");
    this.log("built", { ...build });
    await this.writeMarker({ ...marker, builtAt: this.now().toISOString() });
    if (this.options.config.stages.includes("arrive")) this.hold();
  }

  private async readBuild(polls: number, ms: number): Promise<BuildSummary> {
    const pool = this.pool();
    const tree = await createTopicTreeRepository(pool).activeTree();
    const jobs = await pool.query<{ type: string; status: string; count: number }>(
      `select type::text as type, status::text as status, count(*)::int as count from jobs
       where type::text like $1 group by 1, 2 order by 1, 2`,
      [`${topicJobPrefix}%`]
    );
    const base = {
      ms,
      polls,
      jobs: jobs.rows.map((row) => ({
        type: row.type,
        status: row.status,
        count: Number(row.count)
      }))
    };
    if (!tree) return { ...base, topics: 0, primaryPlacements: 0, needsGate: 0, changeSets: {} };
    const counts = await pool.query<{ topics: number; placed: number; gate: number }>(
      `select (select count(*)::int from topics where tree_id = $1 and retired_at is null and role <> 'root') as topics,
              (select count(*)::int from topic_placements where tree_id = $1 and rank = 0) as placed,
              (select count(*)::int from topic_placements where tree_id = $1 and rank = 0 and needs_gate) as gate`,
      [tree.id]
    );
    const changeSets = await pool.query<{ origin: string; count: number }>(
      "select origin, count(*)::int as count from topic_change_sets where tree_id = $1 group by origin order by origin",
      [tree.id]
    );
    return {
      ...base,
      topics: Number(counts.rows[0]?.topics ?? 0),
      primaryPlacements: Number(counts.rows[0]?.placed ?? 0),
      needsGate: Number(counts.rows[0]?.gate ?? 0),
      changeSets: Object.fromEntries(changeSets.rows.map((row) => [row.origin, Number(row.count)]))
    };
  }

  /**
   * Waits until no topic job is queued or running, two quiet polls in a row (a queued job counts
   * before its debounce has elapsed, because it will run). The live token cap is checked on every
   * poll: past it, the topic jobs are held again and the run stops.
   */
  private async waitForTopicLane(): Promise<number> {
    const interval = this.options.pollIntervalMs ?? 2000;
    const timeoutMs = this.options.drainTimeoutMs ?? 3 * 60 * 60_000;
    const deadline = Date.now() + timeoutMs;
    let quiet = 0;
    for (let polls = 1; ; polls += 1) {
      await this.checkTokenCap();
      const active = await this.pool().query<{ active: number }>(
        `select count(*)::int as active from jobs
         where type::text like $1 and status::text in ('queued', 'running')`,
        [`${topicJobPrefix}%`]
      );
      quiet = Number(active.rows[0]?.active ?? 0) === 0 ? quiet + 1 : 0;
      if (quiet >= 2) return polls;
      if (Date.now() > deadline) {
        this.hold();
        throw new Error(
          `The topic lane still had queued or running jobs after ${Math.round(timeoutMs / 60_000)} min; the topic jobs are held again`
        );
      }
      await this.sleep(interval);
    }
  }

  /** Live remote tokens and calls of the run so far; cassette replays are not live. */
  private async readLiveUsage(): Promise<void> {
    const usage = await this.pool().query<{ tokens: string; calls: number }>(
      `select coalesce(sum(coalesce(input_tokens, 0) + coalesce(output_tokens, 0)), 0)::text as tokens,
              count(*)::int as calls
       from ai_task_runs
       where runtime = 'remote' and adapter is distinct from 'cassette-replay' and started_at >= $1`,
      [this.runStartedAt]
    );
    this.summary.ai.liveTokens = Number(usage.rows[0]?.tokens ?? 0);
    this.summary.ai.remoteCalls = Number(usage.rows[0]?.calls ?? 0);
  }

  /** The live token cap: past it the topic jobs are held again and the run stops. */
  private async checkTokenCap(): Promise<void> {
    await this.readLiveUsage();
    const { maxTokens } = this.options.config;
    if (maxTokens !== null && this.summary.ai.liveTokens >= maxTokens) {
      this.hold();
      throw new CorpusStop("token_limit");
    }
  }

  // -------------------------------------------------------------------------
  // Arrivals

  private async arriveStage(corpus: Corpus): Promise<void> {
    const pool = this.pool();
    const marker = (await this.readMarker())!;
    const byKey = new Map(corpus.articles.map((article) => [article.key, article]));
    const waiting = marker.held.filter((key) => !marker.arrived.includes(key));
    const tree = await createTopicTreeRepository(pool).activeTree();
    if (waiting.length > 0 && !tree)
      throw new CorpusRefusal(
        "noActiveTree",
        "There is no active topic tree: run the build stage before the arrivals"
      );
    this.log("arrivals", { waiting: waiting.length });
    // The tree the arrivals meet is settled: what the sweep or an earlier start left queued has run.
    await this.release();
    await this.waitForTopicLane();
    this.hold();
    for (const key of waiting) {
      const article = byKey.get(key);
      if (!article) throw new Error(`The held-out article ${key} is not in the corpus`);
      const seedBegan = Date.now();
      const seeded = await seedArticle(pool, corpus, article);
      const seedMs = Date.now() - seedBegan;
      const embedBegan = Date.now();
      await this.waitForEmbeddings(0, false);
      const embedMs = Date.now() - embedBegan;
      const drainBegan = Date.now();
      await this.options.triggers.place(tree!.id, [{ rootSourceId: seeded.rootSourceId }], {
        debounce: immediateDebounce
      });
      await this.release();
      await this.waitForTopicLane();
      this.hold();
      const current = (await this.readMarker())!;
      await this.writeMarker({ ...current, arrived: [...current.arrived, key] });
      this.summary.arrivals.push({
        article: key,
        notes: seeded.noteIds.length,
        seedMs,
        embedMs,
        drainMs: Date.now() - drainBegan
      });
      this.log("arrived", {
        article: key,
        notes: seeded.noteIds.length,
        arrivals: this.summary.arrivals.length,
        of: waiting.length
      });
    }
    if (this.summary.build !== null || marker.builtAt !== null) await this.release();
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** A one-line reason; connection strings are redacted. */
export function describeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/postgres(?:ql)?:\/\/\S+/giu, "[redacted]")
    .slice(0, 400);
}

// ---------------------------------------------------------------------------
// Start

export interface StartCorpusRunnerOptions extends Omit<CorpusRunnerOptions, "config"> {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
}

async function electronQuit(): Promise<void> {
  try {
    const electron = await import("electron");
    (electron as { app?: { quit?: () => void } }).app?.quit?.();
  } catch {
    // Not running inside Electron (a script or a test): there is no app to quit.
  }
}

/**
 * Called by the topic factory's `start()` before anything else: reads the knobs and, when
 * `MEMORA_TOPIC_CORPUS` is set, holds the topic jobs at once (the job supervisor starts after the
 * factory's `start()` returns, so nothing topic-related runs before the barrier is up) and starts
 * the run in the background. Returns null for a normal start. A packaged build ignores the knob
 * (a stray variable must not stop an installed app); a refusal in DEV is logged and quits the app,
 * like a refused golden run.
 */
export function startCorpusRunner(
  options: StartCorpusRunnerOptions
): Promise<CorpusRunSummary> | null {
  if (options.isPackaged) {
    if (options.env[corpusKnobs.corpus]?.trim())
      options.logger?.warn(`${corpusKnobs.corpus} is ignored in packaged builds`);
    return null;
  }
  let config: CorpusConfig | null;
  try {
    config = readCorpusConfig(options.env, {
      isPackaged: options.isPackaged,
      workspaceRoot: resolveWorkspaceRoot(process.cwd(), options.env as NodeJS.ProcessEnv)
    });
  } catch (error) {
    options.logger?.error(`CORPUS_RUN refused: ${describeError(error)}`);
    void Promise.resolve((options.quit ?? electronQuit)()).catch(() => undefined);
    return null;
  }
  if (config === null) return null;
  options.service.holdTopicJobs();
  const { env, isPackaged, ...runner } = options;
  void env;
  void isPackaged;
  return new CorpusRunner({ ...runner, config, quit: runner.quit ?? electronQuit }).run();
}
