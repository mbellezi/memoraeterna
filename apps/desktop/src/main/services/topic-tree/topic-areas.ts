// The Areas of the topic tree (F2 T24, D12): the `topic-areas` job on the light lane's `model`
// worker. After a build that left at least `areas.minLevel2Topics` level-2 topics, one
// `write-fast` call asks the model for a Clio-style grouping of those topics into Areas (pinned
// Areas fixed); code validates it, applies it to a copy of the tree with the mis-parent pass at the
// Areas level, and accepts it only when the level-2 centroid silhouette and the E2 shape bars hold
// (`@app/domain/topic-tree` areas.ts). The first accepted grouping of a tree (the bootstrap)
// applies on its own as one `areas` change-set; afterwards, and whenever it touches protected
// structure, it is recorded `pending_review` for Shape's Apply and Dismiss (D29). A proposal never
// waits on another one: while one is pending, the job asks the model nothing.
//
// The model call never runs inside the engine's turn or a transaction (D10): the tree is read in
// one turn, the call follows, and the result is checked against the tree in a second turn (a
// regroup of a tree whose level-2 topics changed meanwhile is dropped). The call is background
// work under D34's daily cap, audited with the participating sources, and never made in a
// deterministic golden run (G1).
import { randomUUID } from "node:crypto";

import {
  createJobRepository,
  createTopicNamingRepository,
  createTopicTreeRepository,
  topicStatsWrites
} from "@app/db";
import type { JobRecord, JsonObject, PgPool } from "@app/db";
import {
  areaGroupingInput,
  areaGroupingSignature,
  areasGroupingDue,
  centralItems,
  changeSetRisk,
  clipIdea,
  cloneTopicTreeState,
  isLive,
  level2TopicCount,
  parseItemKey,
  pathOf,
  regroupAreas,
  validateAreaProposal
} from "@app/domain/topic-tree";
import type {
  AreaGroupingInput,
  AreaProposal,
  ItemKey,
  RegroupAreasResult,
  TopicTreeState
} from "@app/domain/topic-tree";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import { localDay } from "./topic-ai.js";
import type { TopicAiBudget, TopicAiMode } from "./topic-ai.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicChangeCoalescer } from "./topic-changes.js";
import { TopicTreePayloadSchema, topicJobTypes } from "./topic-jobs.js";
import {
  buildTopicAreasPrompt,
  parseTopicAreasOutput,
  topicAreasOperation,
  topicAreasPromptVersion
} from "./topic-prompts.js";
import type { TopicTreeService } from "./topic-tree-service.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** What the Areas job needs of the AI service: one structured-output call. */
export type AreasAi = Pick<AiService, "runDefaultTask">;

/** Bounds of the Areas service's own work (engine parameters live in the tree's configuration). */
export const topicAreasLimits = {
  /** The call's output allowance: a base plus this many tokens per regrouped topic, capped. */
  outputTokensBase: 2_000,
  outputTokensPerTopic: 40,
  outputTokensMax: 16_384,
  /** A note title in the prompt is cut here. */
  memberTitleMaxChars: 160
} as const;

/** Job outcomes after which the same build is not asked about again (the model judged it). */
const settledStatuses: ReadonlySet<string> = new Set([
  "applied",
  "pending_review",
  "rejected",
  "invalid",
  "invalid_output",
  "no_change",
  "not_due",
  "nothing_to_group",
  "review_pending"
]);

export interface TopicAreasOptions {
  getPool: () => PgPool | null;
  service: TopicTreeService;
  ai: AreasAi;
  /** The library's content language (`pt-BR`). */
  getContentLanguage: () => Promise<string>;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  triggers: TopicTriggers;
  changes: TopicChangeCoalescer;
  /** Job types with an executor; follow-ups of unregistered types are not requested. */
  isRegistered: (type: string) => boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
  newId?: () => string;
}

/** What the first turn read: the prompt and what the second turn checks the answer against. */
interface Prepared {
  kind: "prompt";
  treeId: string;
  signature: string;
  bootstrap: boolean;
  /** The latest build or rebuild the grouping answers for (null before any). */
  build: string | null;
  prompt: string;
  contentLanguage: string;
  units: number;
  fixed: number;
  sourceItemIds: string[];
}

type PrepareOutcome = Prepared | { kind: "done"; result: JsonObject };

type Asked =
  | {
      kind: "answer";
      proposal: AreaProposal;
      aiTaskRunId: string;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { kind: "done"; result: JsonObject };

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** Every live topic on the paths from `ids` to the root. */
function pathsOf(state: TopicTreeState, ids: Iterable<string>): string[] {
  const output = new Set<string>();
  for (const id of ids) {
    const node = state.topics.get(id);
    if (!node || !isLive(node)) continue;
    for (const pathId of pathOf(state, id)) output.add(pathId);
  }
  return [...output].sort();
}

/** The measurements a result and a change-set summary report. */
function measurements(result: RegroupAreasResult): JsonObject {
  const { acceptance, outcome } = result;
  return {
    accepted: acceptance.accepted,
    reasons: acceptance.reasons,
    silhouette: {
      before: round(acceptance.silhouette.before),
      after: round(acceptance.silhouette.after),
      tolerance: acceptance.silhouette.tolerance
    },
    shape: {
      before: { ...acceptance.shape.before, meanDepth: round(acceptance.shape.before.meanDepth) },
      after: { ...acceptance.shape.after, meanDepth: round(acceptance.shape.after.meanDepth) }
    },
    hardViolations: { ...acceptance.hardViolations },
    misParented: { ...result.misParented },
    areas: acceptance.shape.after.areas,
    created: outcome.created.length,
    matched: outcome.matched,
    retired: outcome.retired.length,
    renamed: outcome.renamed.length,
    promoted: outcome.promoted.length,
    movedTopics: outcome.movedTopics.length,
    movedItems: outcome.movedItems,
    clearedTitles: outcome.clearedTitles.length,
    reparented: result.reparented.length,
    churnItems: result.churn.items,
    churnShare: round(result.churn.share),
    protectedTouched: result.protectedTouched
  };
}

export class TopicAreasService {
  public constructor(private readonly options: TopicAreasOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  /**
   * Startup: asks for the grouping again when the tree never had one and the last job for its
   * latest build ended before the model judged anything (the daily cap, no route, a failed call,
   * a tree that changed under it). Builds ask for it themselves (T19). Never throws.
   */
  public async requestIfNeeded(treeId: string | null): Promise<void> {
    if (!treeId || this.options.aiMode !== "full") return;
    if (!this.options.isRegistered(topicJobTypes.areas)) return;
    try {
      const pool = this.options.getPool();
      if (!pool) return;
      const repository = createTopicTreeRepository(pool);
      const counts = await repository.changeSetStatusCounts(treeId, "areas");
      if (counts.applied + counts.undone + counts.pending_review > 0) return;
      const latest = await createJobRepository(pool).latestByType(topicJobTypes.areas);
      if (latest && (latest.status === "queued" || latest.status === "running")) return;
      const build = (await repository.latestStructureBuild(treeId))?.changeSetId ?? null;
      const result = latest?.result ?? null;
      if (
        result &&
        result.treeId === treeId &&
        (result.build ?? null) === build &&
        typeof result.status === "string" &&
        settledStatuses.has(result.status)
      ) {
        return;
      }
      await this.options.triggers.request(topicJobTypes.areas, treeId);
    } catch (error) {
      this.options.logger?.warn("Topic Areas could not be requested", error);
    }
  }

  // -------------------------------------------------------------------------
  // The job

  public async runAreas(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    if (this.options.aiMode !== "full") {
      return { status: "skipped", reason: "deterministic", treeId };
    }
    const started = performance.now();
    const finish = (result: JsonObject): JsonObject => ({
      treeId,
      ...result,
      ms: round(performance.now() - started, 1)
    });
    const prepared = await this.options.service.runOnTree(treeId, (cache) => this.prepare(cache));
    if (prepared === null) return finish({ status: "tree_inactive" });
    if (prepared.kind === "done") return finish(prepared.result);
    if (signal.aborted) throw new Error("topics.errors.canceled");

    const asked = await this.ask(prepared, job, signal);
    const base: JsonObject = {
      build: prepared.build,
      bootstrap: prepared.bootstrap,
      units: prepared.units,
      fixed: prepared.fixed
    };
    if (asked.kind === "done") return finish({ ...base, ...asked.result });
    const usage: JsonObject = {
      calls: 1,
      inputTokens: asked.inputTokens,
      outputTokens: asked.outputTokens
    };
    if (signal.aborted) throw new Error("topics.errors.canceled");

    const applied = await this.options.service.runOnTree(treeId, (cache) =>
      this.apply(cache, prepared, asked, job)
    );
    if (applied === null) return finish({ ...base, ...usage, status: "tree_inactive" });
    this.options.logger?.info(
      `Topic Areas ${job.id}: ${String(applied.status)}` +
        (Array.isArray(applied.reasons) && applied.reasons.length > 0
          ? ` (${applied.reasons.join(", ")})`
          : "")
    );
    return finish({ ...base, ...usage, ...applied });
  }

  /** The first turn: whether a grouping is due, and its prompt. */
  private async prepare(cache: TopicTreeCache): Promise<PrepareOutcome> {
    const { state, config, tree } = cache;
    const pool = this.requirePool();
    const repository = createTopicTreeRepository(pool);
    const build = (await repository.latestStructureBuild(tree.id))?.changeSetId ?? null;
    const done = (result: JsonObject): PrepareOutcome => ({
      kind: "done",
      result: { build, ...result }
    });
    if (!areasGroupingDue(state, config)) {
      return done({
        status: "not_due",
        level2Topics: level2TopicCount(state),
        minLevel2Topics: config.areas.minLevel2Topics
      });
    }
    const counts = await repository.changeSetStatusCounts(tree.id, "areas");
    if (counts.pending_review > 0) return done({ status: "review_pending" });
    const input = areaGroupingInput(state);
    if (input.units.length < 2) return done({ status: "nothing_to_group" });

    // Each unit shows the model a few central note titles (D12, spec 3.6), in content order.
    const central = new Map(
      input.units.map((unit) => [
        unit.topicId,
        centralItems(state, cache.vectors, unit.topicId, config.areas.centralTitles)
      ])
    );
    const keys = [...new Set([...central.values()].flatMap((items) => items.map((i) => i.key)))];
    const texts = await createTopicNamingRepository(pool).memberTexts(
      keys.flatMap((key) => {
        const parsed = parseItemKey(key);
        return parsed ? [parsed] : [];
      })
    );
    const sources = new Set<string>();
    const sourceOf = (key: ItemKey): string | null => {
      const entry = state.items.get(key);
      const root = entry?.kind === "source" ? key : (entry?.rootSource ?? null);
      return root ? (parseItemKey(root)?.id ?? null) : null;
    };
    const topics = input.units.map((unit) => ({
      alias: unit.alias,
      titles: (central.get(unit.topicId) ?? []).flatMap((item) => {
        const text = texts.get(item.key);
        if (!text) return [];
        const source = sourceOf(item.key);
        if (source) sources.add(source);
        return [clipIdea(text.title, topicAreasLimits.memberTitleMaxChars)];
      })
    }));
    const contentLanguage = await this.options.getContentLanguage();
    const prompt = buildTopicAreasPrompt({
      contentLanguage,
      areas: { target: config.areas.target, min: config.areas.min, max: config.areas.max },
      pinned: input.fixed.flatMap((area) =>
        area.title === null
          ? []
          : [{ alias: area.alias, title: area.title, description: area.description }]
      ),
      topics
    });
    return {
      kind: "prompt",
      treeId: tree.id,
      signature: areaGroupingSignature(input),
      bootstrap: counts.applied + counts.undone === 0,
      build,
      prompt,
      contentLanguage,
      units: input.units.length,
      fixed: input.fixed.length,
      sourceItemIds: [...sources].sort()
    };
  }

  /** The model call, outside the engine's turn, within the daily cap (D34). */
  private async ask(prepared: Prepared, job: JobRecord, signal: AbortSignal): Promise<Asked> {
    if (!(await this.options.budget.reserve(1))) {
      return { kind: "done", result: { status: "cap_reached" } };
    }
    const logContext: AiTaskLogContext = {
      jobId: job.id,
      stage: "topic_areas",
      operation: topicAreasOperation,
      origin: "job",
      workloadClass: "write-fast",
      priority: "background",
      contentLanguage: prepared.contentLanguage,
      promptVersion: topicAreasPromptVersion,
      attempt: 0,
      sourceItemIds: prepared.sourceItemIds
    };
    let result;
    try {
      result = await this.options.ai.runDefaultTask(
        "structured-output",
        prepared.prompt,
        logContext,
        signal,
        {
          maxOutputTokens: Math.min(
            topicAreasLimits.outputTokensMax,
            topicAreasLimits.outputTokensBase +
              topicAreasLimits.outputTokensPerTopic * prepared.units
          )
        }
      );
    } catch (error) {
      if (signal.aborted) throw error;
      this.options.logger?.warn("The topic Areas call failed", error);
      return {
        kind: "done",
        result: {
          status: "call_failed",
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }
      };
    }
    // No route can serve structured output: nothing changes until one exists.
    if (!result) return { kind: "done", result: { status: "no_route" } };
    const tokens = {
      calls: 1,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null,
      aiTaskRunId: result.aiTaskRunId
    };
    let proposal: AreaProposal;
    try {
      proposal = parseTopicAreasOutput(result.output);
    } catch {
      return { kind: "done", result: { status: "invalid_output", ...tokens } };
    }
    return {
      kind: "answer",
      proposal,
      aiTaskRunId: result.aiTaskRunId,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens
    };
  }

  /** The second turn: validation, the regroup on a copy, acceptance, and the change-set. */
  private async apply(
    cache: TopicTreeCache,
    prepared: Prepared,
    asked: Extract<Asked, { kind: "answer" }>,
    job: JobRecord
  ): Promise<JsonObject> {
    const { state, config, tree, vectors } = cache;
    const input: AreaGroupingInput = areaGroupingInput(state);
    if (areaGroupingSignature(input) !== prepared.signature) {
      // The level-2 topics changed while the model answered: the answer is for another tree.
      return { status: "stale" };
    }
    const checked = validateAreaProposal(input, asked.proposal, config);
    if (!checked.ok) {
      return {
        status: "invalid",
        issues: checked.issues.slice(0, 50).map((issue) => ({ ...issue }))
      };
    }
    const copy = cloneTopicTreeState(state);
    const now = this.now();
    const changeSetId = (this.options.newId ?? randomUUID)();
    const result = regroupAreas({
      state: copy,
      vectors,
      config,
      input,
      proposal: checked.proposal,
      seed: tree.seed,
      now: now.toISOString(),
      day: localDay(now),
      newTopicId: () => (this.options.newId ?? randomUUID)(),
      changeSetId,
      contentLanguage: prepared.contentLanguage
    });
    const measured: JsonObject = {
      ...measurements(result),
      titleIssues: checked.proposal.titleIssues.slice(0, 20).map((issue) => ({ ...issue }))
    };
    if (!result.acceptance.accepted) return { status: "rejected", ...measured };
    if (result.events.length === 0) return { status: "no_change", ...measured };

    const review = !prepared.bootstrap || result.protectedTouched;
    const repository = createTopicTreeRepository(this.requirePool());
    const paths = pathsOf(copy, result.touchedTopics);
    const outcome = await repository.applyChangeSet({
      id: changeSetId,
      treeId: tree.id,
      expectedGeneration: tree.generation,
      ...(review ? { status: "pending_review" as const } : {}),
      origin: "areas",
      titleKey: "topics.changeSets.areas",
      titleParams: {
        areas: result.acceptance.shape.after.areas,
        topics: result.outcome.movedTopics.length
      },
      risk: review ? "high" : changeSetRisk(result.churn.share, config),
      jobId: job.id,
      aiTaskRunIds: [asked.aiTaskRunId],
      summary: {
        ...measured,
        bootstrap: prepared.bootstrap,
        build: prepared.build,
        language: prepared.contentLanguage,
        calls: 1,
        inputTokens: asked.inputTokens,
        outputTokens: asked.outputTokens
      },
      events: result.events,
      ...(review ? {} : { stats: topicStatsWrites(copy, vectors, paths), clock: copy.clock })
    });
    // The cache holds the stored tree, not the copy: the next turn reloads it.
    this.options.service.invalidate();
    if (outcome.kind === "pending") {
      return { status: "pending_review", changeSetId: outcome.changeSetId, ...measured };
    }
    if (outcome.kind === "no_change") return { status: "no_change", ...measured };
    if (outcome.kind === "conflict") {
      return {
        status: outcome.reason === "treeRetired" ? "tree_inactive" : "stale",
        reason: outcome.reason
      };
    }
    this.options.changes.record({
      treeId: tree.id,
      generation: outcome.generation,
      topicIds: null,
      changeSetId: outcome.changeSetId
    });
    // Naming hears the change (new Areas without a valid title, topics that gave theirs up);
    // renamed Areas need their label vectors again; the audit checks the new shape.
    const follow: Record<string, number> = {};
    for (const type of [topicJobTypes.labelEmbed, topicJobTypes.audit]) {
      if (!this.options.isRegistered(type)) continue;
      follow[type] = (await this.options.triggers.request(type, tree.id)).length;
    }
    return {
      status: "applied",
      changeSetId: outcome.changeSetId,
      generation: outcome.generation,
      followUps: follow,
      ...measured
    };
  }
}
