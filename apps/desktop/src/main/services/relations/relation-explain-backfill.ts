// The explanation backfill (F4 D18, T84). Explanations are written when the owner opens a relation;
// the backfill writes, ahead of the next open, those of the shown relations of notes the owner opened
// lately that have none cached. A pass (`relation-explain-backfill` with `{ pass: true }`) selects
// them, at most `dailyRelations` a local day (a settings counter, so a restart never selects more),
// and queues one job per relation on the `relations` worker. Each job writes its explanation at P3
// as background work: the Gardener's gates hold it (none under autonomy Off) and the RemoteBudget
// meters it. A writer that finds the notes unrelated withdraws the relation exactly as on open; the
// withdrawn relation waits in the Inbox for the owner to keep or remove it. The pass is queued a
// while after the start, then daily.
import { createHash } from "node:crypto";

import {
  createJobRepository,
  createRelationExplanationRepository,
  type JobRecord,
  type JsonObject,
  type PgPool
} from "@app/db";
import {
  gardenerFingerprint,
  relationExplainBackfillConfig,
  relationExplainBackfillJobType,
  relationExplanationOrder,
  type RelationExplainBackfillConfig
} from "@app/domain";
import { z } from "zod";

import { jobTaskPayload } from "../../job-task-payload.js";
import type { LightJobExecutor } from "../job-lanes.js";
import type { RelationBackfillOutcome } from "../relation-explanation-service.js";
import { createRelationCallBudget } from "./relation-call-budget.js";

export { relationExplainBackfillJobType };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
const dayMs = 86_400_000;

/** The pass's own dedupe key: one pass queued at a time. */
export const relationExplainBackfillPassKey = `${relationExplainBackfillJobType}:pass`;

/** `relation-explain-backfill:<relationId>`: one queued backfill per relation. */
export function relationExplainBackfillDedupeKey(relationId: string): string {
  return `${relationExplainBackfillJobType}:${relationId.toLowerCase()}`;
}

/**
 * Backfill jobs queue below the link jobs of the `relations` worker (0 and 1) and the catalog
 * header refresh (-1): maintenance that no import waits for.
 */
export const relationExplainBackfillPriority = -10;

/** One relation to explain, or the daily pass that selects them. */
export const RelationExplainBackfillPayloadSchema = z.union([
  z.object({ relationId: z.string().uuid() }).strict(),
  z.object({ pass: z.literal(true) }).strict()
]);

export interface ExplainBackfillPassReport {
  /** Relations the day's counter allowed before this pass. */
  remaining: number;
  /** Relations queued by this pass. */
  queued: number;
}

/**
 * Queues the next pass `delayMs` from now. A pass already queued keeps its time when it is due or
 * earlier, so a start never pulls the day's pass forward.
 */
export async function scheduleExplainBackfillPass(
  jobs: Pick<ReturnType<typeof createJobRepository>, "enqueueDeduped">,
  delayMs: number
): Promise<JobRecord> {
  const delay = Math.max(0, Math.trunc(delayMs));
  const { job } = await jobs.enqueueDeduped({
    type: relationExplainBackfillJobType,
    lane: "light",
    dedupeKey: relationExplainBackfillPassKey,
    payload: { pass: true },
    priority: relationExplainBackfillPriority,
    debounce: { delayMs: delay, maxDelayMs: delay }
  });
  return job;
}

/**
 * One pass: the candidates of now (shown relations of notes opened within the window, with no
 * explanation cached), each counted against the day's allowance before it is queued.
 */
export async function runExplainBackfillPass(
  pool: PgPool,
  options: { now: Date; config?: RelationExplainBackfillConfig }
): Promise<ExplainBackfillPassReport> {
  const config = options.config ?? relationExplainBackfillConfig;
  const budget = createRelationCallBudget({
    db: () => pool,
    cap: () => config.dailyRelations,
    settingKey: config.dailySettingKey,
    now: () => options.now
  });
  const counted = await budget.status();
  const remaining = Math.max(0, config.dailyRelations - counted.calls);
  if (remaining === 0) return { remaining, queued: 0 };
  const candidates = await createRelationExplanationRepository(pool).backfillCandidates({
    openedSince: new Date(options.now.getTime() - config.openedWithinDays * dayMs),
    limit: remaining,
    jobType: relationExplainBackfillJobType
  });
  const jobs = createJobRepository(pool);
  let queued = 0;
  for (const candidate of candidates) {
    // Counted as a remote background call: never more than the day's allowance, local or not.
    if (!(await budget.reserve({ lane: "remote", priority: "P3" }))) break;
    await jobs.enqueueDeduped({
      type: relationExplainBackfillJobType,
      lane: "light",
      dedupeKey: relationExplainBackfillDedupeKey(candidate.relationId),
      payload: { relationId: candidate.relationId },
      priority: relationExplainBackfillPriority,
      debounce: { delayMs: 0, maxDelayMs: 0 }
    });
    queued += 1;
  }
  return { remaining, queued };
}

/** A relation's backfill outcome as its job's `result.status` (spec 3.1b). */
export function explainBackfillStatus(outcome: RelationBackfillOutcome): string {
  switch (outcome) {
    case "written":
    case "unrelated":
      return "completed";
    case "vetoed":
      return "applied";
    case "current":
      return "current";
    case "gone":
      return "stale";
    case "no_writer":
      return "no_route";
  }
}

export interface ExplainBackfillExecutorOptions {
  getPool: () => PgPool | null;
  /** Writes one relation's explanation in the background (`RelationExplanationService.backfill`). */
  backfill: (
    relationId: string,
    options: { jobId: string; signal: AbortSignal }
  ) => Promise<RelationBackfillOutcome>;
  /** Wakes the light lane after a pass queued relations. */
  wake?: () => void;
  now?: () => Date;
  config?: RelationExplainBackfillConfig;
  /**
   * The day's allowance while a DEV override lowers it (the 7-day soak's drop step 3, 20 to 10,
   * F4 T89); the configuration's `dailyRelations` when absent or null.
   */
  dailyRelations?: () => number | null;
}

/** The `relation-explain-backfill` light job, on the `relations` worker. */
export function explainBackfillExecutor(options: ExplainBackfillExecutorOptions): LightJobExecutor {
  const pool = () => {
    const current = options.getPool();
    if (!current) throw new Error("database_unavailable");
    return current;
  };
  return {
    needsModel: true,
    worker: "relations",
    /**
     * The content an explanation is written from (D9): the type, the direction it reads in, both
     * ideas and both passages. The writer, the prompt and the language are provenance.
     */
    async fingerprint(job) {
      // The task's arguments, without the envelope a claim adds (`claimedDedupeKey`, T74).
      const parsed = RelationExplainBackfillPayloadSchema.safeParse(jobTaskPayload(job.payload));
      if (!parsed.success || !("relationId" in parsed.data)) return null;
      const context = await createRelationExplanationRepository(pool()).readContext(
        parsed.data.relationId
      );
      if (!context) return null;
      const order = relationExplanationOrder(context);
      const side = (note: typeof order.first) => ({
        idea: note.ideaStatement,
        passage: note.passage?.contentHash ?? null
      });
      return gardenerFingerprint(
        relationExplainBackfillJobType,
        {
          type: context.type,
          direction: order.direction,
          first: side(order.first),
          second: side(order.second)
        },
        sha256
      );
    },
    async execute(job, signal): Promise<JsonObject> {
      const payload = RelationExplainBackfillPayloadSchema.parse(jobTaskPayload(job.payload));
      if ("pass" in payload) {
        const config = options.config ?? relationExplainBackfillConfig;
        const lowered = options.dailyRelations?.() ?? null;
        const report = await runExplainBackfillPass(pool(), {
          now: options.now?.() ?? new Date(),
          config: lowered === null ? config : { ...config, dailyRelations: lowered }
        });
        await scheduleExplainBackfillPass(createJobRepository(pool()), config.passEveryMs);
        if (report.queued > 0) options.wake?.();
        return { status: "completed", remaining: report.remaining, queued: report.queued };
      }
      const outcome = await options.backfill(payload.relationId, { jobId: job.id, signal });
      return { status: explainBackfillStatus(outcome), outcome };
    }
  };
}
