// REFRESH's trigger and job (F4 D17, T84). After a placement change commits (`topicsChanged`, the
// placement hook), every topic on the changed paths whose members moved away from its stored
// overview is requested: a deduped, debounced `topic-overview:<topicId>` job on the light lane's
// model worker, scope `topic:<id>`, only for topics with an overview or opened within the window,
// non-root, with enough placed notes. Its job priority is dirtiness × views × recency, below every
// other model job. The job joins a writing in progress, then patches at P3 (or proposes, under
// Suggest), and records nothing to re-run: its content fingerprint (members and the stored
// citations) skips a request whose input it already handled.
import { createHash } from "node:crypto";

import {
  createJobRepository,
  createTopicOverviewRepository,
  immediateJobDebounce,
  type JobDebounce,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";
import {
  gardenerFingerprint,
  overviewDirtiness,
  topicOverviewJobType,
  topicOverviewLimits,
  topicOverviewRefreshConfig,
  topicOverviewRefreshPriority,
  topicOverviewRefreshScore,
  type GardenerAutonomy,
  type TopicOverviewRefreshConfig,
  type TopicsChangedEvent
} from "@app/domain";
import { z } from "zod";

import type { LightJobExecutor } from "../job-lanes.js";
import type { TopicAiMode } from "./topic-ai.js";
import type { OverviewRefreshResult, TopicOverviewService } from "./topic-overview.js";

export { topicOverviewJobType };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const dayMs = 86_400_000;

/** The work of one REFRESH job: one topic. */
export const TopicOverviewJobPayloadSchema = z.object({ topicId: z.string().uuid() }).strict();

/** `topic-overview:<topicId>`: one queued REFRESH per topic absorbs every request for it. */
export function topicOverviewDedupeKey(topicId: string): string {
  return `${topicOverviewJobType}:${topicId.toLowerCase()}`;
}

export interface TopicOverviewRefreshOptions {
  getPool: () => PgPool | null;
  overview: Pick<TopicOverviewService, "refresh">;
  /** The Knowledge controls' autonomy now (D12, D13): Suggest proposes, Auto applies. */
  autonomy: () => Promise<GardenerAutonomy>;
  /** G1 (D23): a golden run writes no overview, so nothing is requested. */
  aiMode: TopicAiMode;
  /** Wakes the light lane after an enqueue. */
  wake?: () => void;
  config?: TopicOverviewRefreshConfig;
  now?: () => Date;
  logger?: Pick<Console, "warn">;
}

/** REFRESH's trigger, its requests and its job executor. */
export class TopicOverviewRefresh {
  private chain: Promise<unknown> = Promise.resolve();

  public constructor(private readonly options: TopicOverviewRefreshOptions) {}

  /**
   * The `topicsChanged` listener (the placement hook): the requests of one change are queued after
   * those of the change before, and a failure is logged, never thrown at the coalescer.
   */
  public readonly onTopicsChanged = (event: TopicsChangedEvent): void => {
    this.chain = this.chain
      .then(() => this.request(event.treeId, event.topicIds))
      .catch((error: unknown) => {
        this.options.logger?.warn("REFRESH requests could not be queued", error);
      });
  };

  /** Resolves once the requests of every change heard so far are queued (scripts and tests). */
  public async settled(): Promise<void> {
    await this.chain;
  }

  /**
   * Requests REFRESH for the topics among `topicIds` (null: every topic of the tree) that it may
   * keep current and whose overview does not stand for their members of now; answers how many it
   * queued. A topic with no overview is requested only when it was opened within the window.
   */
  public async request(treeId: string, topicIds: readonly string[] | null): Promise<number> {
    if (this.options.aiMode !== "full") return 0;
    const pool = this.options.getPool();
    if (!pool || (topicIds !== null && topicIds.length === 0)) return 0;
    const config = this.config();
    const now = this.now();
    const repository = createTopicOverviewRepository(pool);
    const candidates = await repository.refreshCandidates({
      treeId,
      topicIds,
      openedSince: new Date(now.getTime() - config.openedWithinDays * dayMs),
      limit: config.maxTopicsPerChange
    });
    let queued = 0;
    for (const candidate of candidates) {
      const context = await repository.readContext(candidate.topicId);
      if (!context || context.topic.id !== candidate.topicId || context.topic.role === "root")
        continue;
      if (context.members.notes < config.minPlacedNotes) continue;
      const stored = context.stored;
      if (stored && stored.memberFingerprint === context.members.fingerprint) continue;
      const rows = await repository.readEvidence(context.topic, {
        perTopic: topicOverviewLimits.candidatesPerTopic,
        candidates: topicOverviewLimits.maxCandidates
      });
      const dirtiness = overviewDirtiness(
        rows.map((row) => ({ noteId: row.noteId, passageHash: sha256(row.passage) })),
        stored ? stored.evidence : null
      );
      const score = topicOverviewRefreshScore(
        {
          dirtiness,
          openCount: candidate.openCount,
          openedDaysAgo: candidate.openedAt
            ? (now.getTime() - candidate.openedAt.getTime()) / dayMs
            : null
        },
        config
      );
      await this.enqueue(pool, candidate.topicId, topicOverviewRefreshPriority(score, config), {
        delayMs: config.debounceMs,
        maxDelayMs: config.debounceMaxMs
      });
      queued += 1;
    }
    if (queued > 0) this.options.wake?.();
    return queued;
  }

  /**
   * Requests REFRESH of one topic now, at the top of REFRESH's range: a proposal the owner applied
   * on a version that moved since is proposed again on the version of now (D17).
   */
  public async requestTopic(topicId: string): Promise<boolean> {
    if (this.options.aiMode !== "full") return false;
    const pool = this.options.getPool();
    if (!pool) return false;
    await this.enqueue(pool, topicId, this.config().priorityMax, immediateJobDebounce);
    this.options.wake?.();
    return true;
  }

  /** The light-lane executor of `topic-overview` (the model worker). */
  public executor(held?: () => boolean): LightJobExecutor {
    return {
      needsModel: true,
      ...(held ? { held } : {}),
      fingerprint: (job) => this.fingerprint(job),
      execute: (job, signal) => this.execute(job, signal)
    };
  }

  /**
   * The content the job reads (D9): the topic's members and the citations of its stored overview.
   * Null when the topic is gone (the job then runs and ends as stale).
   */
  private async fingerprint(job: JobRecord): Promise<string | null> {
    const parsed = TopicOverviewJobPayloadSchema.safeParse(job.payload);
    const pool = this.options.getPool();
    if (!parsed.success || !pool) return null;
    const context = await createTopicOverviewRepository(pool).readContext(parsed.data.topicId);
    if (!context) return null;
    return gardenerFingerprint(
      topicOverviewJobType,
      {
        topic: context.topic.id,
        members: context.members.fingerprint,
        cited: context.stored
          ? context.stored.citations.map((citation) => citation.excerptHash)
          : []
      },
      sha256
    );
  }

  private async execute(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const { topicId } = TopicOverviewJobPayloadSchema.parse(job.payload);
    const result = await this.options.overview.refresh({
      topicId,
      jobId: job.id,
      autonomy: await this.options.autonomy(),
      signal
    });
    // A newer version was stored while the patch was written: it is requested again on that one.
    if (result.status === "deferred") await this.requestTopic(topicId);
    return resultOf(result);
  }

  private async enqueue(
    pool: PgPool,
    topicId: string,
    priority: number,
    debounce: JobDebounce
  ): Promise<void> {
    await createJobRepository(pool).enqueueDeduped({
      type: topicOverviewJobType,
      lane: "light",
      dedupeKey: topicOverviewDedupeKey(topicId),
      payload: { topicId },
      priority,
      debounce
    });
  }

  private config(): TopicOverviewRefreshConfig {
    return this.options.config ?? topicOverviewRefreshConfig;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
}

/** The job's result: its status (spec 3.1b) and what changed, without empty fields. */
function resultOf(result: OverviewRefreshResult): JsonObject {
  const entries = Object.entries(result).filter(([, value]) => value !== undefined);
  return Object.fromEntries(entries) as JsonObject;
}
