// Topic naming (F2 T18, D11): the `topic-name` job on the light lane's `model` worker. It names the
// topics that have no name or only a provisional one, and the LLM-named topics whose members
// drifted by `naming.renameDrift` or more, in the content language. The work is top-down: one
// level of the tree at a time, so a child is named knowing its parent's name. Per level, topics
// are packed into calls of at most `naming.maxTopicsPerCall` (groups of siblings stay together),
// each call is one `write-fast` request, an invalid answer is asked again once for the rejected
// topics only, and a topic that still has no valid name gets the TF-IDF provisional name built from
// content-language notes (naming-fallback.ts) or stays unnamed with no title stored. A level is
// written as one `naming` change-set with the topics' membership sketches, which is how drift is
// measured later. A model call never runs inside the engine lock or a transaction (D10): the tree
// is read first, the calls follow, and the write re-checks every topic against the stored rows.
//
// Human-named, human-managed and pinned topics are never named (RULES.md). In a deterministic
// golden run (G1) nothing is named at all. Background calls count against D34's daily cap; at the
// cap, topics keep provisional names and the status says why.
import { randomUUID } from "node:crypto";

import { createTopicNamingRepository, createTopicTreeRepository } from "@app/db";
import type { JobRecord, JsonObject, PgPool, TopicNamingRows } from "@app/db";
import { topicLimits } from "@app/domain";
import {
  MembershipSketchSchema,
  centralItems,
  clipIdea,
  compareStrings,
  describeRejections,
  fallbackScope,
  membershipDrift,
  membershipSketch,
  namingCallTopics,
  namingCandidates,
  normalizeTopicTitle,
  packNamingCalls,
  parseItemKey,
  provisionalNames,
  retryCall,
  validateNamingOutput
} from "@app/domain/topic-tree";
import type {
  AcceptedName,
  FallbackText,
  ItemKey,
  MembershipSketch,
  NamingCall,
  NamingCandidate,
  NamingGroup,
  NamingMember,
  NamingValidation,
  RejectedName,
  StructureEvent,
  TopicRecord,
  TopicTreeState,
  UnaliasedTopic
} from "@app/domain/topic-tree";
import { z } from "zod";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import { localDay } from "./topic-ai.js";
import type { TopicAiBudget, TopicAiMode } from "./topic-ai.js";
import { loadTopicTreeCache } from "./topic-cache.js";
import type { TopicTreeCache } from "./topic-cache.js";
import type { TopicChangeCoalescer, TopicsChangedEvent } from "./topic-changes.js";
import { TopicTreePayloadSchema, topicJobTypes } from "./topic-jobs.js";
import {
  buildTopicNamePrompt,
  buildTopicNameRepairPrompt,
  topicNameOperation,
  topicNamePromptVersion
} from "./topic-prompts.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** What naming needs of the AI service: one structured-output call at a time. */
export type NamingAi = Pick<AiService, "runDefaultTask">;

/** Bounds of the naming service's own work (engine parameters live in the tree's configuration). */
export const topicNamingLimits = {
  /** A topic that got no LLM name is not tried again for this long (a restart tries it once). */
  retryMs: 15 * 60_000,
  /** The least time between two checks of LLM-named topics for membership drift. */
  driftCheckMs: 60 * 60_000,
  /** Commit attempts of one level after generation or event conflicts. */
  commitAttempts: 3,
  /** A call's output allowance: a base plus this many tokens per topic named. */
  outputTokensBase: 300,
  outputTokensPerTopic: 220,
  /** The model calls of one job that failed in a row before it stops asking and falls back. */
  consecutiveFailures: 2,
  /** A note title in a prompt is cut here (the idea has `naming.ideaMaxChars`). */
  memberTitleMaxChars: 160
} as const;

const NamingSummarySchema = z
  .object({ sketches: z.record(z.string(), MembershipSketchSchema).optional() })
  .passthrough();

export interface TopicNamingOptions {
  getPool: () => PgPool | null;
  ai: NamingAi;
  /** The library's content language (`pt-BR`). */
  getContentLanguage: () => Promise<string>;
  budget: TopicAiBudget;
  aiMode: TopicAiMode;
  triggers: TopicTriggers;
  changes: TopicChangeCoalescer;
  /** Job types with an executor; naming is requested only when its executor exists. */
  isRegistered: (type: string) => boolean;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
  newId?: () => string;
}

/** One name to write: an LLM name with its description and aliases, or a TF-IDF provisional one. */
interface PlannedName {
  topicId: string;
  kind: "llm" | "tfidf";
  title: string;
  description: string | null;
  aliases: string[];
  /** The title and state the snapshot saw: the write is refused when the stored row differs. */
  expectTitle: string | null;
  expectState: TopicRecord["nameState"];
  sketch: MembershipSketch | null;
}

interface RunCounters {
  calls: number;
  repairCalls: number;
  inputTokens: number;
  outputTokens: number;
  aiTaskRunIds: string[];
  /** Topics put to the model, and how many of them a first answer or a repair named. */
  asked: number;
  firstTryAccepted: number;
  repairAccepted: number;
  llmNamed: number;
  provisional: number;
  stillUnnamed: number;
  kept: number;
  dropped: number;
  failedCalls: number;
  capReached: boolean;
  noRoute: boolean;
  changeSets: number;
}

const emptyCounters = (): RunCounters => ({
  calls: 0,
  repairCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  aiTaskRunIds: [],
  asked: 0,
  firstTryAccepted: 0,
  repairAccepted: 0,
  llmNamed: 0,
  provisional: 0,
  stillUnnamed: 0,
  kept: 0,
  dropped: 0,
  failedCalls: 0,
  capReached: false,
  noRoute: false,
  changeSets: 0
});

/** The root source behind a prompt member, for the audit's participating sources. */
function memberSourceId(member: NamingMember): string | null {
  const key = member.kind === "source" ? member.key : member.rootSource;
  return key ? (parseItemKey(key)?.id ?? null) : null;
}

export class TopicNamingService {
  private readonly attempted = new Map<string, number>();
  private readonly driftChecked = new Map<string, number>();
  /** No model route: naming falls back to provisional names until this time. */
  private routeBlockedUntil = 0;

  public constructor(private readonly options: TopicNamingOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  private cooling(topicId: string): boolean {
    const at = this.attempted.get(topicId);
    return at !== undefined && this.now().getTime() - at < topicNamingLimits.retryMs;
  }

  private driftDue(treeId: string): boolean {
    const at = this.driftChecked.get(treeId);
    return at === undefined || this.now().getTime() - at >= topicNamingLimits.driftCheckMs;
  }

  // -------------------------------------------------------------------------
  // Requesting the job

  /**
   * Enqueues one naming job when topics wait for a name that were not tried lately, or when
   * LLM-named topics are due a drift check. Cheap (two small queries) so it can run after every
   * committed change; never throws. In a deterministic golden run (G1) it does nothing.
   */
  public async requestIfNeeded(treeId: string | null): Promise<void> {
    if (!treeId || this.options.aiMode !== "full") return;
    if (!this.options.isRegistered(topicJobTypes.name)) return;
    try {
      const pool = this.options.getPool();
      if (!pool) return;
      const repository = createTopicNamingRepository(pool);
      const pending = (await repository.pendingNamingTopicIds(treeId)).filter(
        (id) => !this.cooling(id)
      );
      let due = pending.length > 0;
      if (!due && this.driftDue(treeId)) {
        due = (await repository.namingNeeds(treeId)).llmNamed > 0;
      }
      if (due) await this.options.triggers.request(topicJobTypes.name, treeId);
    } catch (error) {
      this.options.logger?.warn("Topic naming could not be requested", error);
    }
  }

  /** The `topicsChanged` listener: any committed change may have created topics. */
  public readonly onTopicsChanged = (event: TopicsChangedEvent): void => {
    void this.requestIfNeeded(event.treeId);
  };

  // -------------------------------------------------------------------------
  // The job

  public async runName(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    if (this.options.aiMode !== "full") return { status: "skipped", reason: "deterministic" };
    const pool = this.requirePool();
    const repository = createTopicNamingRepository(pool);

    // Cheap exit: every waiting topic was tried lately and no drift check is due.
    const waiting = (await repository.pendingNamingTopicIds(treeId)).filter(
      (id) => !this.cooling(id)
    );
    const drifting = this.driftDue(treeId);
    if (waiting.length === 0 && !drifting) return { status: "nothing_to_name", treeId };

    const cache = await loadTopicTreeCache(pool, treeId, this.options.logger);
    if (!cache || cache.tree.status !== "active") return { status: "tree_inactive", treeId };
    if (signal.aborted) throw new Error("topics.errors.canceled");
    const contentLanguage = await this.options.getContentLanguage();

    const drift = drifting ? await this.driftOf(cache, repository) : null;
    if (drifting) this.driftChecked.set(treeId, this.now().getTime());
    const candidates = namingCandidates(cache.state, cache.config, {
      skip: new Set([...cache.state.topics.keys()].filter((id) => this.cooling(id))),
      ...(drift ? { drift: (id: string) => drift.get(id) ?? null } : {})
    });
    if (candidates.length === 0) return { status: "nothing_to_name", treeId };

    const counters = emptyCounters();
    const levels = new Map<number, NamingCandidate[]>();
    for (const candidate of candidates) {
      levels.set(candidate.depth, [...(levels.get(candidate.depth) ?? []), candidate]);
    }
    const run = new NamingRun(
      this.services(pool),
      cache,
      repository,
      job,
      signal,
      contentLanguage,
      counters
    );
    for (const depth of [...levels.keys()].sort((a, b) => a - b)) {
      if (signal.aborted) throw new Error("topics.errors.canceled");
      const outcome = await run.nameLevel(levels.get(depth) as NamingCandidate[]);
      if (outcome === "tree_inactive") return { status: "tree_inactive", treeId };
    }
    if (counters.llmNamed + counters.provisional > 0) {
      await this.options.triggers.request(topicJobTypes.labelEmbed, treeId);
    }
    await this.recordCalls(treeId, counters.calls + counters.repairCalls);
    this.options.logger?.info(
      `Topic naming ${job.id}: ${counters.llmNamed} named, ${counters.provisional} provisional, ` +
        `${counters.stillUnnamed} unnamed, ${counters.calls} calls and ${counters.repairCalls} repairs`
    );
    return {
      status: "named",
      treeId,
      candidates: candidates.length,
      llmNamed: counters.llmNamed,
      provisional: counters.provisional,
      stillUnnamed: counters.stillUnnamed,
      kept: counters.kept,
      dropped: counters.dropped,
      calls: counters.calls,
      repairCalls: counters.repairCalls,
      asked: counters.asked,
      firstTryAccepted: counters.firstTryAccepted,
      repairAccepted: counters.repairAccepted,
      failedCalls: counters.failedCalls,
      inputTokens: counters.inputTokens,
      outputTokens: counters.outputTokens,
      capReached: counters.capReached,
      noRoute: counters.noRoute,
      changeSets: counters.changeSets
    };
  }

  /** Adds the day's model calls to the tree's daily metrics (`naming_calls`); never throws. */
  private async recordCalls(treeId: string, calls: number): Promise<void> {
    if (calls <= 0) return;
    try {
      await createTopicTreeRepository(this.requirePool()).upsertDailyMetrics({
        treeId,
        day: localDay(this.now()),
        increments: { namingCalls: calls }
      });
    } catch (error) {
      this.options.logger?.warn("Topic naming calls could not be counted", error);
    }
  }

  /** The drift of every LLM-named topic with a sketch from the change-set that named it. */
  private async driftOf(
    cache: TopicTreeCache,
    repository: ReturnType<typeof createTopicNamingRepository>
  ): Promise<Map<string, number>> {
    const named = [...cache.state.topics.values()].filter(
      (node) => node.nameState === "named" && node.nameSource === "llm" && node.namedChangeSetId
    );
    const summaries = await repository.changeSetSummaries(
      named.map((node) => node.namedChangeSetId as string)
    );
    const drift = new Map<string, number>();
    for (const node of named) {
      const parsed = NamingSummarySchema.safeParse(summaries.get(node.namedChangeSetId as string));
      const then = parsed.success ? parsed.data.sketches?.[node.id] : undefined;
      if (then) drift.set(node.id, membershipDrift(then, membershipSketch(cache.state, node.id)));
    }
    return drift;
  }

  // -------------------------------------------------------------------------
  // Used by a run

  private services(pool: PgPool): RunServices {
    return {
      ai: this.options.ai,
      budget: this.options.budget,
      changes: this.options.changes,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      newId: this.options.newId ?? randomUUID,
      attempted: this.attempted,
      now: () => this.now(),
      routeBlocked: () => this.now().getTime() < this.routeBlockedUntil,
      blockRoute: () => {
        this.routeBlockedUntil = this.now().getTime() + topicNamingLimits.retryMs;
      },
      pool
    };
  }
}

/** What a run uses of the service that started it. */
interface RunServices {
  ai: NamingAi;
  budget: TopicAiBudget;
  changes: TopicChangeCoalescer;
  logger?: Pick<Console, "info" | "warn" | "error">;
  newId: () => string;
  attempted: Map<string, number>;
  now: () => Date;
  routeBlocked: () => boolean;
  blockRoute: () => void;
  pool: PgPool;
}

// ---------------------------------------------------------------------------
// One run of the job

type LevelOutcome = "done" | "tree_inactive";

/** What one level asked of the model; the level's naming change-set records it. */
interface LevelUsage {
  calls: number;
  repairCalls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
  asked: number;
  firstTryAccepted: number;
  repairAccepted: number;
  aiTaskRunIds: string[];
}

class NamingRun {
  private readonly config: TopicTreeCache["config"];
  private readonly state: TopicTreeState;
  private llm: boolean;
  private consecutiveFailures = 0;
  private fallbackTexts: Map<ItemKey, FallbackText> | null = null;
  public constructor(
    private readonly lib: RunServices,
    private readonly cache: TopicTreeCache,
    private readonly repository: ReturnType<typeof createTopicNamingRepository>,
    private readonly job: JobRecord,
    private readonly signal: AbortSignal,
    private readonly contentLanguage: string,
    private readonly counters: RunCounters
  ) {
    this.config = cache.config;
    this.state = cache.state;
    this.llm = !this.lib.routeBlocked();
  }

  // ----- one level -----

  public async nameLevel(level: NamingCandidate[]): Promise<LevelOutcome> {
    const naming = this.config.naming;
    const levelStart = {
      calls: this.counters.calls,
      repairCalls: this.counters.repairCalls,
      failedCalls: this.counters.failedCalls,
      inputTokens: this.counters.inputTokens,
      outputTokens: this.counters.outputTokens,
      asked: this.counters.asked,
      firstTryAccepted: this.counters.firstTryAccepted,
      repairAccepted: this.counters.repairAccepted,
      runIds: this.counters.aiTaskRunIds.length
    };
    const runIds = new Set(level.map((candidate) => candidate.topicId));
    const central = new Map(
      level.map((candidate) => [
        candidate.topicId,
        centralItems(this.state, this.cache.vectors, candidate.topicId, naming.centralMembers)
      ])
    );
    const texts = await this.repository.memberTexts(
      [...new Set([...central.values()].flatMap((items) => items.map((item) => item.key)))].flatMap(
        (key) => {
          const parsed = parseItemKey(key);
          return parsed ? [parsed] : [];
        }
      )
    );

    // Groups of siblings, parents' names known (the levels above are done).
    const groups: Array<Omit<NamingGroup, "topics"> & { topics: UnaliasedTopic[] }> = [];
    const byParent = new Map<string, (typeof groups)[number]>();
    for (const candidate of level) {
      const members = (central.get(candidate.topicId) ?? []).flatMap((item): NamingMember[] => {
        const text = texts.get(item.key);
        if (!text) return [];
        return [
          {
            key: item.key,
            kind: item.kind,
            title: clipIdea(text.title, topicNamingLimits.memberTitleMaxChars),
            idea: text.idea === null ? null : clipIdea(text.idea, naming.ideaMaxChars),
            rootSource: this.state.items.get(item.key)?.rootSource ?? null
          }
        ];
      });
      // A topic with no readable member is left to the fallback, which reads none either.
      if (members.length === 0) continue;
      let group = byParent.get(candidate.parentId);
      if (!group) {
        const parent = this.state.topics.get(candidate.parentId);
        group = {
          parentId: candidate.parentId,
          // A provisional title is a draft, not a name worth showing the model.
          parentTitle:
            parent && parent.title !== null && parent.nameSource !== "tfidf" ? parent.title : null,
          namedSiblings: this.siblingTitles(candidate.parentId, runIds),
          topics: []
        };
        byParent.set(candidate.parentId, group);
        groups.push(group);
      }
      const node = this.state.topics.get(candidate.topicId);
      group.topics.push({
        topicId: candidate.topicId,
        members,
        currentTitle: candidate.reason === "drift" && node?.title ? node.title : null
      });
    }

    const names = new Map<string, AcceptedName>();
    for (const call of packNamingCalls(groups, naming.maxTopicsPerCall)) {
      if (this.signal.aborted) throw new Error("topics.errors.canceled");
      const result = await this.nameCall(call);
      for (const name of result.accepted) names.set(name.topicId, name);
    }

    // Plan: LLM names first, then the fallback for unnamed topics that got none.
    const plan: PlannedName[] = [];
    const sketchFor = (topicId: string): MembershipSketch => membershipSketch(this.state, topicId);
    for (const candidate of level) {
      const name = names.get(candidate.topicId);
      const node = this.state.topics.get(candidate.topicId) as TopicRecord;
      if (!name) continue;
      plan.push({
        topicId: candidate.topicId,
        kind: "llm",
        title: name.title,
        description: name.description,
        aliases: name.aliases,
        expectTitle: node.title,
        expectState: node.nameState,
        sketch: sketchFor(candidate.topicId)
      });
    }
    const needFallback = level
      .filter((candidate) => candidate.reason === "unnamed" && !names.has(candidate.topicId))
      .map((candidate) => candidate.topicId);
    if (needFallback.length > 0) {
      const provisional = await this.fallback(needFallback, plan);
      plan.push(...provisional);
    }
    const planned = new Set(plan.map((item) => item.topicId));
    const attemptedAt = this.lib.now().getTime();
    for (const candidate of level) {
      if (names.has(candidate.topicId)) this.lib.attempted.delete(candidate.topicId);
      else this.lib.attempted.set(candidate.topicId, attemptedAt);
      if (!planned.has(candidate.topicId)) {
        if (candidate.reason === "unnamed") this.counters.stillUnnamed += 1;
        else this.counters.kept += 1;
      }
    }
    if (plan.length === 0) return "done";
    const used = (key: keyof Omit<typeof levelStart, "runIds">): number =>
      this.counters[key] - levelStart[key];
    return this.commit(plan, {
      calls: used("calls"),
      repairCalls: used("repairCalls"),
      failedCalls: used("failedCalls"),
      inputTokens: used("inputTokens"),
      outputTokens: used("outputTokens"),
      asked: used("asked"),
      firstTryAccepted: used("firstTryAccepted"),
      repairAccepted: used("repairAccepted"),
      aiTaskRunIds: this.counters.aiTaskRunIds.slice(levelStart.runIds)
    });
  }

  /**
   * Titles of the live children of a parent that are not named in this level, in code-unit order:
   * the prompt is a function of content, not of sibling positions or IDs (D22).
   */
  private siblingTitles(parentId: string, exclude: ReadonlySet<string>): string[] {
    const parent = this.state.topics.get(parentId);
    if (!parent) return [];
    return parent.children
      .flatMap((childId) => {
        if (exclude.has(childId)) return [];
        const title = this.state.topics.get(childId)?.title;
        return title ? [title] : [];
      })
      .sort(compareStrings);
  }

  // ----- one call, and its repair -----

  private async nameCall(call: NamingCall): Promise<NamingValidation> {
    const topics = namingCallTopics(call);
    const everyoneRejected = (reason: RejectedName["reason"]): NamingValidation => ({
      accepted: [],
      rejected: topics.map((topic) => ({ topicId: topic.topicId, alias: topic.alias, reason }))
    });
    if (!this.llm) return everyoneRejected("missing");
    const promptInput = { contentLanguage: this.contentLanguage, config: this.config.naming };
    const context = { contentLanguage: this.contentLanguage, config: this.config.naming };

    this.counters.asked += topics.length;
    const first = await this.ask(call, buildTopicNamePrompt(call, promptInput), 0);
    if (first === "unavailable") return everyoneRejected("missing");
    let validation = validateNamingOutput(first.output, call, context);
    this.counters.firstTryAccepted += validation.accepted.length;

    for (
      let attempt = 1;
      attempt <= this.config.naming.repairAttempts && validation.rejected.length > 0 && this.llm;
      attempt += 1
    ) {
      const retry = retryCall(call, validation);
      if (!retry) break;
      const prompt = buildTopicNameRepairPrompt(
        retry,
        promptInput,
        describeRejections(validation.rejected, retry, this.contentLanguage)
      );
      const again = await this.ask(retry, prompt, attempt);
      if (again === "unavailable") break;
      const second = validateNamingOutput(again.output, retry, context);
      this.counters.repairAccepted += second.accepted.length;
      validation = {
        accepted: [...validation.accepted, ...second.accepted],
        rejected: second.rejected
      };
    }
    return validation;
  }

  /** One model call within the daily cap; "unavailable" when no call could be made. */
  private async ask(
    call: NamingCall,
    prompt: string,
    attempt: number
  ): Promise<{ output: unknown } | "unavailable"> {
    if (!(await this.lib.budget.reserve(1))) {
      this.counters.capReached = true;
      this.llm = false;
      return "unavailable";
    }
    const topics = namingCallTopics(call);
    const sourceItemIds = [
      ...new Set(topics.flatMap((topic) => topic.members.map(memberSourceId)).filter((id) => id))
    ].sort() as string[];
    const logContext: AiTaskLogContext = {
      jobId: this.job.id,
      stage: "topic_naming",
      operation: topicNameOperation,
      origin: "job",
      workloadClass: "write-fast",
      priority: "background",
      contentLanguage: this.contentLanguage,
      promptVersion: topicNamePromptVersion,
      attempt,
      sourceItemIds
    };
    if (attempt === 0) this.counters.calls += 1;
    else this.counters.repairCalls += 1;
    let result;
    try {
      result = await this.lib.ai.runDefaultTask(
        "structured-output",
        prompt,
        logContext,
        this.signal,
        {
          maxOutputTokens:
            topicNamingLimits.outputTokensBase +
            topicNamingLimits.outputTokensPerTopic * topics.length
        }
      );
    } catch (error) {
      if (this.signal.aborted) throw error;
      this.counters.failedCalls += 1;
      this.consecutiveFailures += 1;
      if (this.consecutiveFailures >= topicNamingLimits.consecutiveFailures) this.llm = false;
      this.lib.logger?.warn("A topic naming call failed", error);
      return "unavailable";
    }
    if (!result) {
      // No route can serve structured output: name provisionally until a route exists.
      this.counters.noRoute = true;
      this.llm = false;
      this.lib.blockRoute();
      return "unavailable";
    }
    this.consecutiveFailures = 0;
    this.counters.inputTokens += result.inputTokens ?? 0;
    this.counters.outputTokens += result.outputTokens ?? 0;
    this.counters.aiTaskRunIds.push(result.aiTaskRunId);
    return { output: result.output };
  }

  // ----- the provisional fallback -----

  private async fallback(
    targets: string[],
    llmPlan: readonly PlannedName[]
  ): Promise<PlannedName[]> {
    const naming = this.config.naming;
    if (this.fallbackTexts === null) this.fallbackTexts = new Map();
    const texts = this.fallbackTexts;
    const missing = fallbackScope(this.state, targets).filter((key) => !texts.has(key));
    const found = await this.repository.memberTexts(
      missing.flatMap((key) => {
        const parsed = parseItemKey(key);
        return parsed ? [parsed] : [];
      })
    );
    for (const [key, text] of found) {
      texts.set(key, {
        text: text.idea ? `${text.title}. ${text.idea}` : text.title,
        language: text.language
      });
    }
    // The LLM names of this level are in place while the fallback avoids their titles.
    const restore = llmPlan.map((item) => {
      const node = this.state.topics.get(item.topicId) as TopicRecord & { title: string | null };
      const before = { topicId: item.topicId, title: node.title };
      node.title = item.title;
      return before;
    });
    try {
      const { names } = provisionalNames(this.state, targets, texts, {
        contentLanguage: this.contentLanguage,
        minItems: naming.fallbackMinItems,
        maxTerms: naming.fallbackMaxTerms
      });
      return targets.flatMap((topicId): PlannedName[] => {
        const name = names.get(topicId);
        if (!name) return [];
        const node = this.state.topics.get(topicId) as TopicRecord;
        return [
          {
            topicId,
            kind: "tfidf",
            title: name.title,
            description: null,
            aliases: [],
            expectTitle: node.title,
            expectState: node.nameState,
            sketch: null
          }
        ];
      });
    } finally {
      for (const before of restore) {
        (this.state.topics.get(before.topicId) as TopicRecord).title = before.title;
      }
    }
  }

  // ----- writing a level -----

  private async commit(plan: PlannedName[], level: LevelUsage): Promise<LevelOutcome> {
    const treeId = this.cache.tree.id;
    const naming = createTopicNamingRepository(this.lib.pool);
    const repository = createTopicTreeRepository(this.lib.pool);
    for (let attempt = 0; attempt < topicNamingLimits.commitAttempts; attempt += 1) {
      const rows = await naming.topicRows(
        treeId,
        plan.map((item) => item.topicId)
      );
      if (rows.status !== "active") return "tree_inactive";
      const changeSetId = this.lib.newId();
      const { events, applied, dropped } = this.eventsFor(plan, rows, changeSetId);
      if (events.length === 0) {
        this.counters.dropped += dropped;
        return "done";
      }
      const sketches: Record<string, MembershipSketch> = {};
      for (const item of applied) if (item.sketch) sketches[item.topicId] = item.sketch;
      const llmCount = applied.filter((item) => item.kind === "llm").length;
      const aiTaskRunIds = [...new Set(level.aiTaskRunIds)].slice(0, 1_000);
      let result;
      try {
        result = await repository.applyChangeSet({
          id: changeSetId,
          treeId,
          expectedGeneration: rows.generation,
          origin: "naming",
          titleKey: "topics.changeSets.naming",
          titleParams: { topics: applied.length },
          risk: "low",
          jobId: this.job.id,
          aiTaskRunIds,
          summary: {
            llm: llmCount,
            provisional: applied.length - llmCount,
            language: this.contentLanguage,
            // What this level asked of the model, for the naming measurements (first-try validity,
            // repair rate, calls and tokens per topic).
            calls: level.calls,
            repairCalls: level.repairCalls,
            failedCalls: level.failedCalls,
            inputTokens: level.inputTokens,
            outputTokens: level.outputTokens,
            asked: level.asked,
            firstTryAccepted: level.firstTryAccepted,
            repairAccepted: level.repairAccepted,
            sketches
          },
          events
        });
      } catch (error) {
        // The sibling-title index refused a name a person just took: read the rows again.
        if ((error as { code?: string }).code === "23505") continue;
        throw error;
      }
      if (result.kind === "applied") {
        this.counters.dropped += dropped;
        this.counters.changeSets += 1;
        this.counters.llmNamed += llmCount;
        this.counters.provisional += applied.length - llmCount;
        this.adoptNames(applied, changeSetId);
        const ids = applied.map((item) => item.topicId);
        this.lib.changes.record({
          treeId,
          generation: result.generation,
          topicIds: ids.length > topicLimits.changedTopicIdsMax ? null : ids,
          changeSetId
        });
        return "done";
      }
      if (result.kind === "no_change") {
        this.counters.dropped += dropped;
        return "done";
      }
      if (result.kind === "conflict" && result.reason === "treeRetired") return "tree_inactive";
      // Another writer moved the tree or a row: read the rows again and rebuild the events.
    }
    // The stored tree kept moving: these names are not written, and the topics are tried again
    // when their cooldown ends.
    this.counters.dropped += plan.length;
    return "done";
  }

  /** The events of a plan against the stored rows; a name that no longer fits is dropped. */
  private eventsFor(
    plan: readonly PlannedName[],
    rows: TopicNamingRows,
    changeSetId: string
  ): { events: StructureEvent[]; applied: PlannedName[]; dropped: number } {
    const events: StructureEvent[] = [];
    const applied: PlannedName[] = [];
    let dropped = 0;
    const renamed = new Set(plan.map((item) => item.topicId));
    // Titles taken under each parent: the stored siblings that keep theirs, then the accepted ones.
    const taken = new Map<string, Set<string>>();
    const takenUnder = (parentId: string): Set<string> => {
      let set = taken.get(parentId);
      if (!set) {
        set = new Set(
          (rows.siblings.get(parentId) ?? []).flatMap((sibling) =>
            sibling.title !== null && !renamed.has(sibling.id)
              ? [normalizeTopicTitle(sibling.title)]
              : []
          )
        );
        taken.set(parentId, set);
      }
      return set;
    };
    for (const item of plan) {
      const current = rows.topics.get(item.topicId);
      if (
        !current ||
        current.retiredAt !== null ||
        current.parentId === null ||
        current.management !== "ai" ||
        current.nameSource === "human" ||
        current.title !== item.expectTitle ||
        current.nameState !== item.expectState
      ) {
        dropped += 1;
        continue;
      }
      const used = takenUnder(current.parentId);
      const normal = normalizeTopicTitle(item.title);
      if (used.has(normal)) {
        dropped += 1;
        continue;
      }
      used.add(normal);
      const llm = item.kind === "llm";
      const language = this.contentLanguage;
      events.push({
        op: "topic.rename",
        topicId: item.topicId,
        before: {
          title: current.title,
          nameState: current.nameState,
          nameSource: current.nameSource,
          nameLanguage: current.nameLanguage,
          namedChangeSetId: current.namedChangeSetId,
          aliases: [...current.aliases]
        },
        after: {
          title: item.title,
          nameState: llm ? "named" : "provisional",
          nameSource: llm ? "llm" : "tfidf",
          nameLanguage: language,
          namedChangeSetId: changeSetId,
          aliases: llm ? item.aliases : []
        }
      });
      if (llm && item.description !== null && item.description !== current.description) {
        events.push({
          op: "topic.describe",
          topicId: item.topicId,
          before: { description: current.description },
          after: { description: item.description }
        });
      }
      applied.push(item);
    }
    return { events, applied, dropped };
  }

  /** Mirrors the written names in the snapshot, so the next level sees its parents' names. */
  private adoptNames(applied: readonly PlannedName[], changeSetId: string): void {
    for (const item of applied) {
      const node = this.state.topics.get(item.topicId);
      if (!node) continue;
      const llm = item.kind === "llm";
      node.title = item.title;
      node.nameState = llm ? "named" : "provisional";
      node.nameSource = llm ? "llm" : "tfidf";
      node.nameLanguage = this.contentLanguage;
      node.namedChangeSetId = changeSetId;
      node.aliases = llm ? [...item.aliases] : [];
      if (llm && item.description !== null) node.description = item.description;
    }
  }
}
