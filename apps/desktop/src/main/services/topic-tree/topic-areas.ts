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
//
// An incomplete or malformed answer is repaired before it is judged (`areas.ts`): code first (a
// topic left out joins the Area with the nearest members, a topic named twice stays in the nearest,
// an Area left empty is dropped), then the answer is validated again. Only when more than
// `ai.areasRepairMaxMissingShare` of the topics were missing, or the answer is still invalid or not
// JSON of the required shape, is the model asked once more, with the problems listed (the same
// operation and audit as the first call, attempt 1, under the same cap). Of the answers that
// validate, the one that needed less repair is used. The change-set summary records what was
// repaired and how (`summary.repair`); the acceptance check is the same for a repaired answer.
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
  areaRepairChanged,
  areaRepairVectors,
  areasGroupingDue,
  areaUnreadableAnswerLine,
  centralItems,
  changeSetRisk,
  checkAreaAnswer,
  clipIdea,
  cloneTopicTreeState,
  describeAreaIssues,
  isLive,
  level2TopicCount,
  parseItemKey,
  pathOf,
  regroupAreas,
  repairedTopics,
  validateAreaProposal
} from "@app/domain/topic-tree";
import type {
  AreaAnswerCheck,
  AreaGroupingInput,
  AreaProposal,
  AreaVectors,
  ItemKey,
  RegroupAreasResult,
  TopicTreeConfig,
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
  buildTopicAreasRepairPrompt,
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

/**
 * The revision of the answer repair a job result records. A build whose last grouping was judged
 * `invalid` (or unreadable) before the repair existed is asked about once more by `requestIfNeeded`.
 */
export const topicAreasRepairRevision = 1;

/** Outcomes that the repair can turn into a grouping: a result of an older revision is not final. */
const repairableStatuses: ReadonlySet<string> = new Set(["invalid", "invalid_output"]);

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
  /** What the repair of an answer compares: the input and a copy of the statistics it needs. */
  input: AreaGroupingInput;
  vectors: AreaVectors;
  config: TopicTreeConfig;
}

type PrepareOutcome = Prepared | { kind: "done"; result: JsonObject };

interface AttemptUsage {
  aiTaskRunId: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

/** One call and what it returned: an answer, an answer in the wrong shape, or no answer at all. */
type Attempt =
  | ({ kind: "answer"; proposal: AreaProposal } & AttemptUsage)
  | ({ kind: "unreadable" } & AttemptUsage)
  | { kind: "stopped"; result: JsonObject };

type Asked =
  | {
      kind: "answer";
      /** The answer to validate and apply: repaired in code when it needed it. */
      proposal: AreaProposal;
      /** What was repaired and how (`summary.repair`). */
      repair: JsonObject;
      aiTaskRunIds: string[];
      calls: number;
      inputTokens: number | null;
      outputTokens: number | null;
    }
  | { kind: "done"; result: JsonObject };

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

/** A sum of token counts; unknown as soon as one of them is (never invented). */
function sumTokens(values: readonly (number | null)[]): number | null {
  return values.every((value) => value !== null)
    ? values.reduce<number>((sum, value) => sum + (value as number), 0)
    : null;
}

/** Issues by code, for the summary. */
function issueCounts(issues: readonly { code: string }[]): JsonObject {
  const counts: Record<string, number> = {};
  for (const issue of issues) counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  return counts;
}

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

/** `summary.repair`: what the repair did to the answer in use, and how (see the file comment). */
function repairSummary(args: {
  /** The check of the answer in use (null when nothing could be read). */
  check: AreaAnswerCheck | null;
  answer: "first" | "second";
  /** The check of the first answer, whose problems the repair call was asked about. */
  first: AreaAnswerCheck | null;
  /** Why the model was asked again (null when it was not). */
  reason: string | null;
  second: Attempt | null;
}): JsonObject {
  const { check, answer, first, reason, second } = args;
  const deterministic = check !== null && areaRepairChanged(check.report);
  const how =
    answer === "second"
      ? deterministic
        ? "call+deterministic"
        : "call"
      : deterministic
        ? "deterministic"
        : "none";
  return {
    repaired: check === null ? 0 : repairedTopics(check.report),
    how,
    answer,
    reason,
    repairCall:
      second === null
        ? "none"
        : second.kind === "stopped"
          ? String(second.result.status)
          : second.kind,
    placed: check?.report.placed ?? 0,
    deduplicated: check?.report.deduplicated ?? 0,
    unknownTopics: check?.report.unknownTopics ?? 0,
    mergedAreas: check?.report.mergedAreas ?? 0,
    droppedAreas: check?.report.droppedAreas ?? 0,
    missingShare: round(first?.missingShare ?? 0),
    issues: issueCounts(first?.issues ?? [])
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
      // An answer judged invalid before the repair existed (no revision, or an older one) is
      // asked about once more; a result of this revision is final for the build.
      const repaired =
        typeof result?.repairRevision === "number" &&
        result.repairRevision >= topicAreasRepairRevision;
      if (
        result &&
        result.treeId === treeId &&
        (result.build ?? null) === build &&
        typeof result.status === "string" &&
        settledStatuses.has(result.status) &&
        (repaired || !repairableStatuses.has(result.status))
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
      repairRevision: topicAreasRepairRevision,
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
      calls: asked.calls,
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
      sourceItemIds: [...sources].sort(),
      input,
      vectors: areaRepairVectors(state, input),
      config
    };
  }

  /**
   * The model call, outside the engine's turn, within the daily cap (D34), and its one repair. The
   * answer is checked and repaired in code (`checkAreaAnswer`); the model is asked once more only
   * when many topics are missing, the answer is still invalid after the repair, or it was not JSON
   * of the required shape. Of the answers that validate, the one that needed less repair is used.
   */
  private async ask(prepared: Prepared, job: JobRecord, signal: AbortSignal): Promise<Asked> {
    const first = await this.call(prepared, prepared.prompt, 0, job, signal);
    if (first.kind === "stopped") return { kind: "done", result: first.result };
    const { input, config, vectors } = prepared;
    const firstCheck =
      first.kind === "answer" ? checkAreaAnswer(input, first.proposal, config, vectors) : null;
    const reason = firstCheck === null ? "unreadable" : firstCheck.callReason;

    let second: Attempt | null = null;
    let secondCheck: AreaAnswerCheck | null = null;
    if (reason !== null) {
      if (signal.aborted) throw new Error("topics.errors.canceled");
      const problems =
        first.kind === "answer" && firstCheck !== null
          ? describeAreaIssues(input, first.proposal, firstCheck.issues, config)
          : areaUnreadableAnswerLine;
      second = await this.call(
        prepared,
        buildTopicAreasRepairPrompt(prepared.prompt, prepared.contentLanguage, problems),
        1,
        job,
        signal
      );
      if (second.kind === "answer") {
        secondCheck = checkAreaAnswer(input, second.proposal, config, vectors);
      }
    }

    const used: AttemptUsage[] = [
      first,
      ...(second !== null && second.kind !== "stopped" ? [second] : [])
    ];
    const tokens = {
      calls: used.length,
      inputTokens: sumTokens(used.map((attempt) => attempt.inputTokens)),
      outputTokens: sumTokens(used.map((attempt) => attempt.outputTokens))
    };
    const aiTaskRunIds = used.map((attempt) => attempt.aiTaskRunId);
    const summary = (check: AreaAnswerCheck | null, answer: "first" | "second"): JsonObject =>
      repairSummary({ check, answer, first: firstCheck, reason, second });

    // The answer that validates after the repair and needed the fewest topics repaired; the repair
    // call's answer wins a tie (it was written knowing the problems).
    let chosen: { answer: "first" | "second"; check: AreaAnswerCheck } | null = null;
    for (const [answer, check] of [
      ["first", firstCheck],
      ["second", secondCheck]
    ] as const) {
      if (check === null || !check.validation.ok) continue;
      if (chosen === null || repairedTopics(check.report) <= repairedTopics(chosen.check.report)) {
        chosen = { answer, check };
      }
    }
    if (chosen !== null) {
      return {
        kind: "answer",
        proposal: chosen.check.proposal,
        repair: summary(chosen.check, chosen.answer),
        aiTaskRunIds,
        ...tokens
      };
    }
    const last = secondCheck ?? firstCheck;
    if (last === null) {
      return {
        kind: "done",
        result: { status: "invalid_output", ...tokens, repair: summary(null, "first") }
      };
    }
    return {
      kind: "done",
      result: {
        status: "invalid",
        issues: (last.validation.ok ? [] : last.validation.issues)
          .slice(0, 50)
          .map((issue) => ({ ...issue })),
        ...tokens,
        repair: summary(last, secondCheck !== null ? "second" : "first")
      }
    };
  }

  /** One structured-output call and its parse; `attempt` 0 is the grouping, 1 its repair. */
  private async call(
    prepared: Prepared,
    prompt: string,
    attempt: number,
    job: JobRecord,
    signal: AbortSignal
  ): Promise<Attempt> {
    if (!(await this.options.budget.reserve(1))) {
      return { kind: "stopped", result: { status: "cap_reached" } };
    }
    const logContext: AiTaskLogContext = {
      jobId: job.id,
      stage: "topic_areas",
      operation: topicAreasOperation,
      origin: "job",
      workloadClass: "write-fast",
      priority: "P3",
      contentLanguage: prepared.contentLanguage,
      promptVersion: topicAreasPromptVersion,
      attempt,
      // Attempt 1 is the repair of the grouping: the audit counts it (D35).
      isRepair: attempt > 0,
      sourceItemIds: prepared.sourceItemIds
    };
    let result;
    try {
      result = await this.options.ai.runDefaultTask(
        "structured-output",
        prompt,
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
        kind: "stopped",
        result: {
          status: "call_failed",
          error: error instanceof Error ? error.message.slice(0, 200) : "unknown"
        }
      };
    }
    // No route can serve structured output: nothing changes until one exists.
    if (!result) return { kind: "stopped", result: { status: "no_route" } };
    const usage: AttemptUsage = {
      aiTaskRunId: result.aiTaskRunId,
      inputTokens: result.inputTokens ?? null,
      outputTokens: result.outputTokens ?? null
    };
    try {
      return { kind: "answer", proposal: parseTopicAreasOutput(result.output), ...usage };
    } catch {
      return { kind: "unreadable", ...usage };
    }
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
        issues: checked.issues.slice(0, 50).map((issue) => ({ ...issue })),
        repair: asked.repair
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
      titleIssues: checked.proposal.titleIssues.slice(0, 20).map((issue) => ({ ...issue })),
      repair: asked.repair
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
      aiTaskRunIds: asked.aiTaskRunIds,
      summary: {
        ...measured,
        bootstrap: prepared.bootstrap,
        build: prepared.build,
        language: prepared.contentLanguage,
        calls: asked.calls,
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
