// Topic naming (F2 T18, D11): the `topic-name` job on the light lane's `model` worker. It names the
// topics that have no name or only a provisional one, and the LLM-named topics whose members
// drifted by `naming.renameDrift` or more, in the content language. A name covers the whole topic:
// a leaf shows a covering sample of its members (its most central ones and the ones that span the
// rest), an internal topic its subtopics with their titles, sizes and a few members each. So the
// work is bottom-up: one level of the tree at a time, deepest first, and an internal topic is named
// from its children's names; a name never repeats its parent's or a subtopic's title. Per level,
// topics are packed into calls of at most `naming.maxTopicsPerCall` topics and
// `naming.maxMembersPerCall` members shown (groups of siblings stay together), each call is one
// `write-fast` request, an invalid answer is asked again once for the rejected topics only, and a
// topic that still has no valid name gets the TF-IDF provisional name built from content-language
// notes (naming-fallback.ts) or stays unnamed with no title stored. A level is written as one
// `naming` change-set with the topics' membership sketches and the prompt version, which is how
// drift is measured later and how a rename pass (`renameRevisions`, the DEV knob
// `MEMORA_TOPIC_RENAME_REVISION`) finds the names an earlier prompt version wrote. A model call
// never runs inside the engine lock or a transaction (D10): the tree is read first, the calls
// follow, and the write re-checks every topic against the stored rows.
// The repository writes events one by one under the sibling-title index, so a level's renames are
// ordered for every intermediate state to keep sibling titles unique. A name the write still drops
// is never lost silently: the job says why, re-queues the topic and reports repeated drops.
//
// Human-named, human-managed and pinned topics are never named (RULES.md). In a deterministic
// golden run (G1) nothing is named at all. Background calls count against D34's daily cap; at the
// cap, topics keep provisional names and the status says why.
import { randomUUID } from "node:crypto";

import { createTopicNamingRepository, createTopicTreeRepository } from "@app/db";
import type { JobRecord, JsonObject, PgPool, TopicNamingRows } from "@app/db";
import { backgroundBlockerOf, gardenerBlockerKey, topicLimits } from "@app/domain";
import {
  MembershipSketchSchema,
  clipIdea,
  compareStrings,
  coveringItems,
  describeRejections,
  fallbackScope,
  getTopic,
  internalNamingSample,
  isLive,
  membershipDrift,
  membershipSketch,
  namingCallTopics,
  namingCandidates,
  namingTopicMembers,
  normalizeTopicTitle,
  packNamingCalls,
  parseItemKey,
  provisionalNames,
  retryCall,
  subtreeItems,
  validateNamingOutput
} from "@app/domain/topic-tree";
import type {
  AcceptedName,
  CentralItem,
  FallbackText,
  InternalNamingSample,
  ItemKey,
  MembershipSketch,
  NamingCall,
  NamingCandidate,
  NamingGroup,
  NamingMember,
  NamingSubtopic,
  NamingValidation,
  RejectedName,
  StructureEvent,
  TopicRecord,
  TopicRenamePayload,
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
  topicNamePromptVersion,
  topicNamingOutputContract
} from "./topic-prompts.js";
import type { TopicTriggers } from "./topic-triggers.js";

/** What naming needs of the AI service: one structured-output call at a time. */
export type NamingAi = Pick<AiService, "runDefaultTask">;

/** Bounds of the naming service's own work (engine parameters live in the tree's configuration). */
export const topicNamingLimits = {
  /** A topic that got no LLM name is not tried again for this long (a restart tries it once). */
  retryMs: 15 * 60_000,
  /**
   * The least time between two checks of LLM-named topics for membership drift after the tree
   * changed (a new generation), so a library that grows within one session is named again.
   */
  driftCheckMs: 60_000,
  /** A check also runs this long after the last one (cascaded deletions keep the generation). */
  driftRecheckMs: 60 * 60_000,
  /** Commit attempts of one level after generation or event conflicts. */
  commitAttempts: 3,
  /** A call's output allowance: a base plus this many tokens per topic named. */
  outputTokensBase: 300,
  outputTokensPerTopic: 220,
  /** The model calls of one job that failed in a row before it stops asking and falls back. */
  consecutiveFailures: 2,
  /**
   * A dropped name re-queues its topic at once until it was dropped this many times in a row; the
   * topic then waits `retryMs` like one the model could not name (the job keeps reporting it).
   */
  requeueDrops: 3,
  /** Topics listed in a job result's `repeatedDrops`. */
  repeatedDropsListed: 50,
  /** A note title in a prompt is cut here (the idea has `naming.ideaMaxChars`). */
  memberTitleMaxChars: 160
} as const;

const NamingSummarySchema = z
  .object({
    sketches: z.record(z.string(), MembershipSketchSchema).optional(),
    /** The naming prompt's version (`topicNamePromptVersion`); absent before topic-name-v2. */
    promptVersion: z.string().optional()
  })
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
  /**
   * A rename pass: the LLM names a naming change-set wrote under another prompt version are named
   * again, once each, at the job's drift checks (the DEV knob `MEMORA_TOPIC_RENAME_REVISION`).
   */
  renameRevisions?: boolean;
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

/**
 * Why a planned name was not written: the topic left automation (retired, moved under the root,
 * human-named or protected), its stored row changed since the snapshot, a sibling that keeps its
 * title holds the name, or the write kept conflicting. Only `gone` does not re-queue the topic.
 */
export const namingDropReasons = ["gone", "changed", "titleTaken", "conflict"] as const;
export type NamingDropReason = (typeof namingDropReasons)[number];

/** A topic whose names were dropped by consecutive jobs, while it waits for a written name. */
interface DropRecord {
  treeId: string;
  drops: number;
  reason: NamingDropReason;
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
  /** Unnamed candidates that got no name in this job (except those that left automation). */
  stillUnnamed: number;
  /** Provisional and drifting candidates that keep their current name. */
  kept: number;
  /** Planned names that were not written, and why. */
  dropped: number;
  droppedBy: Record<NamingDropReason, number>;
  /** Topics whose dropped name re-queued them for the next job. */
  requeued: number;
  /** Topics dropped by two or more jobs in a row, with their count and last reason. */
  repeatedDrops: Array<{ topicId: string; drops: number; reason: NamingDropReason }>;
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
  droppedBy: { gone: 0, changed: 0, titleTaken: 0, conflict: 0 },
  requeued: 0,
  repeatedDrops: [],
  failedCalls: 0,
  capReached: false,
  noRoute: false,
  changeSets: 0
});

/** What the naming change-set of an LLM-named topic recorded about it. */
export interface NamingRecord {
  /** The members it had when it was named. */
  sketch: MembershipSketch;
  /** The naming prompt's version, null before topic-name-v2 recorded it. */
  promptVersion: string | null;
}

/**
 * What the naming change-sets recorded of every LLM-named topic: its sketch and the prompt
 * version. Topics no naming change-set named (an Area named by its grouping) are left out.
 */
export async function namingRecords(
  repository: Pick<ReturnType<typeof createTopicNamingRepository>, "changeSetSummaries">,
  state: TopicTreeState
): Promise<Map<string, NamingRecord>> {
  const named = [...state.topics.values()].filter(
    (node) => node.nameState === "named" && node.nameSource === "llm" && node.namedChangeSetId
  );
  const summaries = await repository.changeSetSummaries(
    named.map((node) => node.namedChangeSetId as string)
  );
  const records = new Map<string, NamingRecord>();
  for (const node of named) {
    const parsed = NamingSummarySchema.safeParse(summaries.get(node.namedChangeSetId as string));
    if (!parsed.success) continue;
    const then = parsed.data.sketches?.[node.id];
    if (then)
      records.set(node.id, { sketch: then, promptVersion: parsed.data.promptVersion ?? null });
  }
  return records;
}

/**
 * The members each LLM-named topic had when it was named: the sketch its naming change-set
 * recorded (topics without one are left out). Drift and a rebuild's re-naming are measured from it.
 */
export async function namedMembershipSketches(
  repository: Pick<ReturnType<typeof createTopicNamingRepository>, "changeSetSummaries">,
  state: TopicTreeState
): Promise<Map<string, MembershipSketch>> {
  const sketches = new Map<string, MembershipSketch>();
  for (const [topicId, record] of await namingRecords(repository, state)) {
    sketches.set(topicId, record.sketch);
  }
  return sketches;
}

/** What a topic of a level shows: a leaf's covering sample, or an internal topic's subtopics. */
type TopicSample =
  { kind: "leaf"; items: CentralItem[] } | { kind: "internal"; sample: InternalNamingSample };

function sampleKeys(sample: TopicSample): ItemKey[] {
  return sample.kind === "leaf"
    ? sample.items.map((item) => item.key)
    : [
        ...sample.sample.direct.map((item) => item.key),
        ...sample.sample.subtopics.flatMap((subtopic) => subtopic.items.map((item) => item.key))
      ];
}

/** The name fields of a topic without a name (a cycle of renames passes through it). */
function unnamedName(): TopicRenamePayload {
  return {
    title: null,
    nameState: "unnamed",
    nameSource: null,
    nameLanguage: null,
    namedChangeSetId: null,
    aliases: []
  };
}

/** The root source behind a prompt member, for the audit's participating sources. */
function memberSourceId(member: NamingMember): string | null {
  const key = member.kind === "source" ? member.key : member.rootSource;
  return key ? (parseItemKey(key)?.id ?? null) : null;
}

export class TopicNamingService {
  private readonly attempted = new Map<string, number>();
  /** Topics whose last names were dropped, until a name is written (in this process). */
  private readonly drops = new Map<string, DropRecord>();
  /** The last drift check per tree: when, and the tree generation it saw. */
  private readonly driftChecked = new Map<string, { at: number; generation: number | null }>();
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

  /**
   * Whether LLM-named topics are due a drift check: never checked in this process, `driftCheckMs`
   * after the last check when the tree changed since (`generation`, null when not known yet), or
   * `driftRecheckMs` after it in any case.
   */
  private driftDue(treeId: string, generation: number | null = null): boolean {
    const last = this.driftChecked.get(treeId);
    if (last === undefined) return true;
    const elapsed = this.now().getTime() - last.at;
    if (elapsed >= topicNamingLimits.driftRecheckMs) return true;
    const changed = generation === null || last.generation !== generation;
    return changed && elapsed >= topicNamingLimits.driftCheckMs;
  }

  /** Whether a topic of the tree was re-queued by a dropped name and may be asked again now. */
  private requeuedIn(treeId: string): boolean {
    for (const [topicId, record] of this.drops) {
      if (record.treeId === treeId && !this.cooling(topicId)) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Requesting the job

  /**
   * Enqueues one naming job when topics wait for a name that were not tried lately, or when
   * LLM-named topics are due a drift check. Cheap (two small queries) so it can run after every
   * committed change; never throws. In a deterministic golden run (G1) it does nothing.
   */
  public async requestIfNeeded(
    treeId: string | null,
    generation: number | null = null
  ): Promise<void> {
    if (!treeId || this.options.aiMode !== "full") return;
    if (!this.options.isRegistered(topicJobTypes.name)) return;
    try {
      const pool = this.options.getPool();
      if (!pool) return;
      const repository = createTopicNamingRepository(pool);
      const pending = (await repository.pendingNamingTopicIds(treeId)).filter(
        (id) => !this.cooling(id)
      );
      let due = pending.length > 0 || this.requeuedIn(treeId);
      if (!due && this.driftDue(treeId, generation)) {
        due = (await repository.namingNeeds(treeId)).llmNamed > 0;
      }
      if (due) await this.options.triggers.request(topicJobTypes.name, treeId);
    } catch (error) {
      this.options.logger?.warn("Topic naming could not be requested", error);
    }
  }

  /** The `topicsChanged` listener: any committed change may have created topics. */
  public readonly onTopicsChanged = (event: TopicsChangedEvent): void => {
    void this.requestIfNeeded(event.treeId, event.generation);
  };

  // -------------------------------------------------------------------------
  // The job

  public async runName(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { treeId } = TopicTreePayloadSchema.parse(jobTaskPayload(job.payload));
    if (this.options.aiMode !== "full") return { status: "skipped", reason: "deterministic" };
    const pool = this.requirePool();
    const repository = createTopicNamingRepository(pool);

    // Cheap exit: every waiting topic was tried lately, no dropped name re-queued one and no
    // drift check is due.
    const waiting = (await repository.pendingNamingTopicIds(treeId)).filter(
      (id) => !this.cooling(id)
    );
    const requeued = this.requeuedIn(treeId);
    if (waiting.length === 0 && !requeued && !this.driftDue(treeId)) {
      return { status: "nothing_to_name", treeId };
    }

    const cache = await loadTopicTreeCache(pool, treeId, this.options.logger);
    if (!cache || cache.tree.status !== "active") return { status: "tree_inactive", treeId };
    if (signal.aborted) throw new Error("topics.errors.canceled");
    const contentLanguage = await this.options.getContentLanguage();

    // Members drift when items arrive, leave or are replaced (REBALANCE, rebuilds, PLACE). A
    // re-queued drift rename is a candidate again only through a drift check.
    const drifting = requeued || this.driftDue(treeId, cache.tree.generation);
    const history = drifting ? await this.namingHistory(cache, repository) : null;
    if (drifting) {
      this.driftChecked.set(treeId, {
        at: this.now().getTime(),
        generation: cache.tree.generation
      });
    }
    const candidates = namingCandidates(cache.state, cache.config, {
      skip: new Set([...cache.state.topics.keys()].filter((id) => this.cooling(id))),
      ...(history
        ? {
            drift: (id: string) => history.drift.get(id) ?? null,
            staleRevision: (id: string) => history.stale.has(id)
          }
        : {})
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
      counters,
      new Set(candidates.map((candidate) => candidate.topicId))
    );
    // Bottom-up: an internal topic is named after its children, from their names.
    for (const depth of [...levels.keys()].sort((a, b) => b - a)) {
      if (signal.aborted) throw new Error("topics.errors.canceled");
      const outcome = await run.nameLevel(levels.get(depth) as NamingCandidate[]);
      if (outcome === "tree_inactive") return { status: "tree_inactive", treeId };
    }
    if (counters.llmNamed + counters.provisional > 0) {
      await this.options.triggers.request(topicJobTypes.labelEmbed, treeId);
    }
    await this.recordCalls(treeId, counters.calls + counters.repairCalls);
    // A dropped name asks again (debounced), even when this job wrote nothing another change
    // would answer to.
    if (counters.requeued > 0) await this.requeue(treeId);
    this.options.logger?.info(
      `Topic naming ${job.id}: ${counters.llmNamed} named, ${counters.provisional} provisional, ` +
        `${counters.stillUnnamed} unnamed, ${counters.dropped} dropped ` +
        `(${namingDropReasons.map((reason) => `${reason} ${counters.droppedBy[reason]}`).join(", ")}), ` +
        `${counters.requeued} re-queued, ${counters.calls} calls and ${counters.repairCalls} repairs`
    );
    counters.repeatedDrops.sort(
      (a, b) => b.drops - a.drops || compareStrings(a.topicId, b.topicId)
    );
    if (counters.repeatedDrops.length > 0) {
      this.options.logger?.warn(
        `Topic naming ${job.id}: names of ${counters.repeatedDrops.length} topics were dropped ` +
          `by consecutive jobs: ${JSON.stringify(counters.repeatedDrops)}`
      );
    }
    return {
      status: "named",
      treeId,
      candidates: candidates.length,
      revisionCandidates: candidates.filter((candidate) => candidate.reason === "revision").length,
      llmNamed: counters.llmNamed,
      provisional: counters.provisional,
      stillUnnamed: counters.stillUnnamed,
      kept: counters.kept,
      dropped: counters.dropped,
      droppedBy: { ...counters.droppedBy },
      requeued: counters.requeued,
      repeatedDrops: counters.repeatedDrops.slice(0, topicNamingLimits.repeatedDropsListed),
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

  /** Requests the naming job again for re-queued topics; never throws. */
  private async requeue(treeId: string): Promise<void> {
    try {
      await this.options.triggers.request(topicJobTypes.name, treeId);
    } catch (error) {
      this.options.logger?.warn("Topic naming could not be requested again", error);
    }
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

  /**
   * The drift of every LLM-named topic with a sketch from the change-set that named it and, in a
   * rename pass, the topics a naming change-set of another prompt version named.
   */
  private async namingHistory(
    cache: TopicTreeCache,
    repository: ReturnType<typeof createTopicNamingRepository>
  ): Promise<{ drift: Map<string, number>; stale: Set<string> }> {
    const drift = new Map<string, number>();
    const stale = new Set<string>();
    for (const [topicId, record] of await namingRecords(repository, cache.state)) {
      drift.set(topicId, membershipDrift(record.sketch, membershipSketch(cache.state, topicId)));
      if (this.options.renameRevisions && record.promptVersion !== topicNamePromptVersion) {
        stale.add(topicId);
      }
    }
    return { drift, stale };
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
      drops: this.drops,
      now: () => this.now(),
      routeBlocked: () => this.now().getTime() < this.routeBlockedUntil,
      blockRoute: () => {
        this.routeBlockedUntil = this.now().getTime() + topicNamingLimits.retryMs;
      },
      // A naming commit right after the drift check changes no membership: the check stays valid.
      committed: (treeId, before, after) => {
        const last = this.driftChecked.get(treeId);
        if (last && last.generation === before) last.generation = after;
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
  drops: Map<string, DropRecord>;
  now: () => Date;
  routeBlocked: () => boolean;
  blockRoute: () => void;
  /** A naming change-set moved the tree from generation `before` to `after`. */
  committed: (treeId: string, before: number, after: number) => void;
  pool: PgPool;
}

// ---------------------------------------------------------------------------
// One run of the job

type LevelOutcome = "done" | "tree_inactive";

/** What the write of a level did: the topics whose names were written and the dropped ones. */
interface LevelWrite {
  outcome: LevelOutcome;
  written: ReadonlySet<string>;
  dropped: ReadonlyMap<string, NamingDropReason>;
}

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
    private readonly counters: RunCounters,
    /** Every topic this job names; a parent among them is named after its children. */
    private readonly candidateIds: ReadonlySet<string>
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
    const samples = new Map(
      level.map((candidate) => [candidate.topicId, this.sampleOf(candidate.topicId)])
    );
    const texts = await this.repository.memberTexts(
      [...new Set([...samples.values()].flatMap(sampleKeys))].flatMap((key) => {
        const parsed = parseItemKey(key);
        return parsed ? [parsed] : [];
      })
    );
    const memberOf = (item: CentralItem): NamingMember[] => {
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
    };

    // Groups of siblings; the levels below are done, so subtopics show their new names.
    const groups: Array<Omit<NamingGroup, "topics"> & { topics: UnaliasedTopic[] }> = [];
    const byParent = new Map<string, (typeof groups)[number]>();
    for (const candidate of level) {
      const sample = samples.get(candidate.topicId) as TopicSample;
      const members = (sample.kind === "leaf" ? sample.items : sample.sample.direct).flatMap(
        memberOf
      );
      const subtopics: NamingSubtopic[] =
        sample.kind === "leaf"
          ? []
          : sample.sample.subtopics.map((subtopic) => ({
              title: subtopic.title,
              size: subtopic.size,
              members: subtopic.items.flatMap(memberOf)
            }));
      // A topic with nothing readable to show is left to the fallback, which reads none either.
      if (
        members.length === 0 &&
        subtopics.every((subtopic) => subtopic.title === null && subtopic.members.length === 0)
      ) {
        continue;
      }
      let group = byParent.get(candidate.parentId);
      if (!group) {
        const parent = this.state.topics.get(candidate.parentId);
        // A provisional title (a TF-IDF draft, or a merged topic's old name waiting to be
        // replaced) is not a name worth showing the model, nor the title of a parent this job
        // names later; a name never repeats the parent's title either way.
        const parentName =
          parent && parent.title !== null && parent.nameState === "named" ? parent.title : null;
        const parentLater = this.candidateIds.has(candidate.parentId);
        group = {
          parentId: candidate.parentId,
          parentTitle: parentLater ? null : parentName,
          ...(parentLater && parentName !== null ? { parentHeldTitle: parentName } : {}),
          namedSiblings: this.siblingTitles(candidate.parentId, runIds),
          topics: []
        };
        byParent.set(candidate.parentId, group);
        groups.push(group);
      }
      const node = this.state.topics.get(candidate.topicId);
      group.topics.push({
        topicId: candidate.topicId,
        size: subtreeItems(this.state, candidate.topicId).length,
        members,
        subtopics,
        childTitles: this.childTitles(candidate.topicId),
        currentTitle: candidate.reason === "drift" && node?.title ? node.title : null
      });
    }

    const names = new Map<string, AcceptedName>();
    const limit = { maxTopics: naming.maxTopicsPerCall, maxMembers: naming.maxMembersPerCall };
    for (const call of packNamingCalls(groups, limit)) {
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
    const used = (key: keyof Omit<typeof levelStart, "runIds">): number =>
      this.counters[key] - levelStart[key];
    const written =
      plan.length === 0
        ? ({ outcome: "done", written: new Set(), dropped: new Map() } satisfies LevelWrite)
        : await this.commit(plan, {
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
    if (written.outcome === "tree_inactive") return "tree_inactive";
    this.settle(level, names, written);
    return "done";
  }

  /**
   * What a level's candidates wait for after the write. A topic the model named is not cooling;
   * one it could not name waits `retryMs`. A dropped name re-queues its topic with the reason
   * (unless the topic left automation) until `requeueDrops` jobs in a row dropped it; it then
   * waits `retryMs` too, and every job that drops it again lists it in `repeatedDrops`.
   */
  private settle(
    level: readonly NamingCandidate[],
    names: ReadonlyMap<string, AcceptedName>,
    write: LevelWrite
  ): void {
    const now = this.lib.now().getTime();
    const treeId = this.cache.tree.id;
    for (const candidate of level) {
      const id = candidate.topicId;
      const reason = write.dropped.get(id);
      if (reason !== undefined) {
        this.counters.dropped += 1;
        this.counters.droppedBy[reason] += 1;
      }
      if (write.written.has(id)) {
        this.lib.drops.delete(id);
        if (names.has(id)) this.lib.attempted.delete(id);
        else this.lib.attempted.set(id, now);
        continue;
      }
      // Not written: the topic keeps the name it had (none, a provisional one or an old one).
      if (reason !== "gone") {
        if (candidate.reason === "unnamed") this.counters.stillUnnamed += 1;
        else this.counters.kept += 1;
      }
      if (reason === undefined) {
        this.lib.attempted.set(id, now);
        continue;
      }
      if (reason === "gone") {
        this.lib.drops.delete(id);
        this.lib.attempted.set(id, now);
        continue;
      }
      const drops = (this.lib.drops.get(id)?.drops ?? 0) + 1;
      this.lib.drops.set(id, { treeId, drops, reason });
      if (drops >= 2) this.counters.repeatedDrops.push({ topicId: id, drops, reason });
      if (drops < topicNamingLimits.requeueDrops) {
        this.lib.attempted.delete(id);
        this.counters.requeued += 1;
      } else {
        this.lib.attempted.set(id, now);
      }
    }
  }

  /**
   * What a topic shows the model: a leaf its covering sample (`centralMembers` of
   * `sampleMembers`), an internal topic its live subtopics with a few members each.
   */
  private sampleOf(topicId: string): TopicSample {
    const naming = this.config.naming;
    const node = getTopic(this.state, topicId);
    const internal = node.children.some((childId) => isLive(getTopic(this.state, childId)));
    return internal
      ? {
          kind: "internal",
          sample: internalNamingSample(this.state, this.cache.vectors, topicId, {
            total: naming.sampleMembers,
            perChild: naming.childMembers
          })
        }
      : {
          kind: "leaf",
          items: coveringItems(this.state, this.cache.vectors, topicId, {
            central: naming.centralMembers,
            total: naming.sampleMembers
          })
        };
  }

  /** The titles a topic's live children hold now, which its own name must not repeat (D11). */
  private childTitles(topicId: string): string[] {
    return getTopic(this.state, topicId)
      .children.flatMap((childId) => {
        const child = getTopic(this.state, childId);
        return isLive(child) && child.title !== null ? [child.title] : [];
      })
      .sort(compareStrings);
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
    // A remote call counts against the daily cap; one on a local model does not (F4 D14).
    if (
      !(await this.lib.budget.reserve(1, {
        operation: topicNameOperation,
        workloadClass: "write-fast"
      }))
    ) {
      this.counters.capReached = true;
      this.llm = false;
      return "unavailable";
    }
    const topics = namingCallTopics(call);
    const sourceItemIds = [
      ...new Set(
        topics.flatMap((topic) => namingTopicMembers(topic).map(memberSourceId)).filter((id) => id)
      )
    ].sort() as string[];
    const logContext: AiTaskLogContext = {
      jobId: this.job.id,
      stage: "topic_naming",
      operation: topicNameOperation,
      origin: "job",
      workloadClass: "write-fast",
      priority: "P3",
      // The Gardener's work (F4 D12, D15): its gates and the local duty cycle hold this call.
      budgetClass: "background",
      contentLanguage: this.contentLanguage,
      promptVersion: topicNamePromptVersion,
      outputContract: topicNamingOutputContract,
      attempt,
      // Attempts after the first re-ask the topics the validation refused: the audit counts them
      // as repairs (D35), like the `*_repair` operations.
      isRepair: attempt > 0,
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
      const blocker = backgroundBlockerOf(error);
      // Autonomy Off (F4 D12, table 3.2): no generative call; topics get provisional TF-IDF names.
      // The refused call sent nothing, so it is no call of the job.
      if (blocker && gardenerBlockerKey(blocker) === "paused.autonomy_off") {
        if (attempt === 0) this.counters.calls -= 1;
        else this.counters.repairCalls -= 1;
        this.llm = false;
        return "unavailable";
      }
      // Any other background refusal (F4 D7) ends the job; the supervisor sets it aside.
      if (this.signal.aborted || blocker) throw error;
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

  /**
   * Writes a level's names as one change-set. Every attempt reads the stored rows again and
   * rebuilds the events: a name that no longer fits is dropped with its reason and the others are
   * written. An event the repository refuses drops that topic's name only; a tree that keeps
   * moving (`commitAttempts` generation conflicts) drops what is left.
   */
  private async commit(plan: PlannedName[], level: LevelUsage): Promise<LevelWrite> {
    const treeId = this.cache.tree.id;
    const naming = createTopicNamingRepository(this.lib.pool);
    const repository = createTopicTreeRepository(this.lib.pool);
    const dropped = new Map<string, NamingDropReason>();
    const done = (written: ReadonlySet<string> = new Set()): LevelWrite => ({
      outcome: "done",
      written,
      dropped
    });
    let pending = plan;
    let moved = 0;
    while (pending.length > 0) {
      const rows = await naming.topicRows(
        treeId,
        pending.map((item) => item.topicId)
      );
      if (rows.status !== "active")
        return { outcome: "tree_inactive", written: new Set(), dropped };
      const changeSetId = this.lib.newId();
      const built = this.eventsFor(pending, rows, changeSetId);
      for (const [topicId, reason] of built.dropped) dropped.set(topicId, reason);
      const { events, applied } = built;
      if (events.length === 0) return done();
      const sketches: Record<string, MembershipSketch> = {};
      for (const item of applied) if (item.sketch) sketches[item.topicId] = item.sketch;
      const llmCount = applied.filter((item) => item.kind === "llm").length;
      const aiTaskRunIds = [...new Set(level.aiTaskRunIds)].slice(0, 1_000);
      const result = await repository.applyChangeSet({
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
          // The prompt the LLM names were asked with: a rename pass finds older ones by it.
          promptVersion: topicNamePromptVersion,
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
      if (result.kind === "applied") {
        this.counters.changeSets += 1;
        this.counters.llmNamed += llmCount;
        this.counters.provisional += applied.length - llmCount;
        this.adoptNames(applied, changeSetId);
        this.lib.committed(treeId, rows.generation, result.generation);
        const ids = applied.map((item) => item.topicId);
        this.lib.changes.record({
          treeId,
          generation: result.generation,
          topicIds: ids.length > topicLimits.changedTopicIdsMax ? null : ids,
          changeSetId
        });
        return done(new Set(ids));
      }
      // Nothing to change: the stored names already are these.
      if (result.kind === "no_change") return done();
      if (result.kind === "conflict" && result.reason === "treeRetired") {
        return { outcome: "tree_inactive", written: new Set(), dropped };
      }
      // No event of a plan is a no-op, so the repository's event index is the plan's.
      const refused =
        result.kind === "conflict" && result.reason === "event" && result.code !== "busy"
          ? events[result.eventIndex]?.topicId
          : undefined;
      if (refused !== undefined && applied.some((item) => item.topicId === refused)) {
        // The stored tree refused this topic's rename (a title a sibling holds, a changed row):
        // the others are written without it.
        this.lib.logger?.warn(
          `Topic naming ${this.job.id}: the name of topic ${refused} was refused (${
            result.kind === "conflict" && result.reason === "event" ? result.code : "conflict"
          })`
        );
        dropped.set(refused, "conflict");
        pending = applied.filter((item) => item.topicId !== refused);
        continue;
      }
      // Another writer moved the tree: read the rows again and rebuild the events.
      moved += 1;
      if (moved >= topicNamingLimits.commitAttempts) {
        // The stored tree kept moving: these names are not written, and their topics re-queue.
        for (const item of applied) dropped.set(item.topicId, "conflict");
        return done();
      }
      pending = applied;
    }
    return done();
  }

  /**
   * The events of a plan against the stored rows, in an order that keeps sibling titles unique in
   * every intermediate state (the repository writes them one by one under the sibling-title index).
   * A name that no longer fits is dropped: its topic left automation (`gone`), its row changed
   * since the snapshot (`changed`), or a sibling that keeps its title holds it (`titleTaken`; a
   * dropped name keeps its topic's title, which may take a title back from another name).
   *
   * A topic gives its title up before the sibling that takes it is renamed; titles that go round a
   * cycle of siblings (a swap) are freed by clearing one topic first, as Areas do: it passes
   * through `unnamed` and takes its name last. Undo writes the inverse backwards, through the same
   * states.
   */
  private eventsFor(
    plan: readonly PlannedName[],
    rows: TopicNamingRows,
    changeSetId: string
  ): {
    events: StructureEvent[];
    applied: PlannedName[];
    dropped: Map<string, NamingDropReason>;
  } {
    const dropped = new Map<string, NamingDropReason>();
    let fitting: Array<{ item: PlannedName; current: TopicRecord; parentId: string }> = [];
    for (const item of plan) {
      const current = rows.topics.get(item.topicId);
      if (
        !current ||
        current.retiredAt !== null ||
        current.parentId === null ||
        current.management !== "ai" ||
        current.nameSource === "human"
      ) {
        dropped.set(item.topicId, "gone");
        continue;
      }
      if (current.title !== item.expectTitle || current.nameState !== item.expectState) {
        dropped.set(item.topicId, "changed");
        continue;
      }
      fitting.push({ item, current, parentId: current.parentId });
    }

    // Final titles: unique under each parent with the stored siblings that keep theirs (the
    // first name in plan order keeps a title two names claim). Each drop can free or take one
    // title, so the check runs again until no name clashes.
    for (;;) {
      const renamed = new Set(fitting.map((entry) => entry.item.topicId));
      const taken = new Map<string, Set<string>>();
      let clash: (typeof fitting)[number] | null = null;
      for (const entry of fitting) {
        let used = taken.get(entry.parentId);
        if (!used) {
          used = new Set(
            (rows.siblings.get(entry.parentId) ?? []).flatMap((sibling) =>
              sibling.title !== null && !renamed.has(sibling.id)
                ? [normalizeTopicTitle(sibling.title)]
                : []
            )
          );
          taken.set(entry.parentId, used);
        }
        const normal = normalizeTopicTitle(entry.item.title);
        if (used.has(normal)) {
          clash = entry;
          break;
        }
        used.add(normal);
      }
      if (clash === null) break;
      dropped.set(clash.item.topicId, "titleTaken");
      fitting = fitting.filter((entry) => entry !== clash);
    }

    // Write order. `holder` maps a parent and a current title to the renamed topic holding it.
    const titleKey = (parentId: string, title: string) =>
      `${parentId}\u0000${normalizeTopicTitle(title)}`;
    const holder = new Map<string, (typeof fitting)[number]>();
    for (const entry of fitting) {
      if (entry.current.title !== null) {
        holder.set(titleKey(entry.parentId, entry.current.title), entry);
      }
    }
    const nameOf = (current: TopicRecord) => ({
      title: current.title,
      nameState: current.nameState,
      nameSource: current.nameSource,
      nameLanguage: current.nameLanguage,
      namedChangeSetId: current.namedChangeSetId,
      aliases: [...current.aliases]
    });
    const events: StructureEvent[] = [];
    const pending = new Set(fitting);
    const cleared = new Set<(typeof fitting)[number]>();
    const language = this.contentLanguage;
    while (pending.size > 0) {
      let progressed = false;
      for (const entry of fitting) {
        if (!pending.has(entry)) continue;
        const holding = holder.get(titleKey(entry.parentId, entry.item.title));
        if (holding && holding !== entry && pending.has(holding) && !cleared.has(holding)) {
          continue;
        }
        const { item, current } = entry;
        const llm = item.kind === "llm";
        events.push({
          op: "topic.rename",
          topicId: item.topicId,
          before: cleared.has(entry) ? unnamedName() : nameOf(current),
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
        pending.delete(entry);
        progressed = true;
      }
      if (progressed) continue;
      // Every waiting name waits for a sibling that waits too: a cycle. Its first topic in plan
      // order gives its title up first.
      const first = fitting.find((entry) => pending.has(entry) && !cleared.has(entry));
      if (!first) throw new Error("Topic naming could not order the renames of a level");
      events.push({
        op: "topic.rename",
        topicId: first.item.topicId,
        before: nameOf(first.current),
        after: unnamedName()
      });
      cleared.add(first);
    }
    return { events, applied: fitting.map((entry) => entry.item), dropped };
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
