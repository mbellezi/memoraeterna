import { z } from "zod";

/**
 * Gardener task state (F4 D5, spec 3.1). The `jobs` table keeps its five statuses; the Gardener
 * state is derived from them and the columns 0060 adds: an outcome on a finished job, a blocker
 * on a job set aside, a quarantine mark on a job that failed again on the same input.
 */

/** How a succeeded job ended: it changed something, found nothing to change, or skipped by fingerprint. */
export const gardenerOutcomeValues = ["done", "no_change", "skipped"] as const;
export const GardenerOutcomeSchema = z.enum(gardenerOutcomeValues);
export type GardenerOutcome = z.infer<typeof GardenerOutcomeSchema>;

/** Blocker classes in precedence order: the first one a task meets is the one it shows (D7). */
export const gardenerBlockerClasses = [
  "paused",
  "no_model",
  "cap",
  "download",
  "waiting",
  "offline"
] as const;
export const GardenerBlockerClassSchema = z.enum(gardenerBlockerClasses);
export type GardenerBlockerClass = z.infer<typeof GardenerBlockerClassSchema>;

/** The reasons of each class (spec 3.1). A reason names one i18n key; variable parts are parameters. */
export const gardenerBlockerReasons = {
  paused: ["user_pause", "autonomy_off", "only_idle_user_active", "only_ac_on_battery"],
  no_model: ["no_route", "model_missing", "no_decider", "signin_required", "space_changed"],
  cap: ["money_80", "money_100", "subscription_daily", "provider_quota", "feature_daily"],
  download: ["model_downloading", "model_verifying", "model_loading"],
  waiting: [
    "queue",
    "same_scope",
    "provider_rate_limit",
    "provider_unavailable",
    "local_memory",
    "waiting_for_embeddings",
    "retry_backoff"
  ],
  offline: ["network_unreachable"]
} as const satisfies Record<GardenerBlockerClass, readonly string[]>;

export type GardenerBlockerReason = (typeof gardenerBlockerReasons)[GardenerBlockerClass][number];

export const GardenerBlockerSchema = z
  .object({ class: GardenerBlockerClassSchema, reason: z.string().min(1).max(64) })
  .strict()
  .superRefine((blocker, context) => {
    if (!(gardenerBlockerReasons[blocker.class] as readonly string[]).includes(blocker.reason))
      context.addIssue({ code: "custom", message: `Unknown ${blocker.class} reason` });
  });
export type GardenerBlocker = { class: GardenerBlockerClass; reason: GardenerBlockerReason };

/** Negative when `a` takes precedence over `b` (paused > no_model > cap > download > waiting > offline). */
export function compareBlockerClasses(a: GardenerBlockerClass, b: GardenerBlockerClass): number {
  return gardenerBlockerClasses.indexOf(a) - gardenerBlockerClasses.indexOf(b);
}

/** The blocker a task shows among those it meets: the class first in precedence. */
export function mostPressingBlocker<T extends { class: GardenerBlockerClass }>(
  blockers: readonly T[]
): T | null {
  return blockers.reduce<T | null>(
    (best, blocker) =>
      best === null || compareBlockerClasses(blocker.class, best.class) < 0 ? blocker : best,
    null
  );
}

/**
 * The derived states (D5). `failed` is a job that ended failed and may be retried; `quarantined`
 * one that failed on an input that failed before (D8); `legacy` a succeeded job finished before
 * 0060, which has no outcome (E3 counts it apart).
 */
export const gardenerStates = [
  "queued",
  "blocked",
  "running",
  "done",
  "no_change",
  "skipped",
  "failed",
  "quarantined",
  "canceled",
  "legacy"
] as const;
export const GardenerStateSchema = z.enum(gardenerStates);
export type GardenerState = z.infer<typeof GardenerStateSchema>;

export interface GardenerStateInput {
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  outcome: GardenerOutcome | null;
  blockedClass: string | null;
  quarantinedAt: Date | string | null;
}

export function gardenerStateOf(job: GardenerStateInput): GardenerState {
  switch (job.status) {
    case "queued":
      return job.blockedClass === null ? "queued" : "blocked";
    case "running":
      return "running";
    case "succeeded":
      return job.outcome ?? "legacy";
    case "failed":
      return job.quarantinedAt === null ? "failed" : "quarantined";
    case "canceled":
      return "canceled";
  }
}

/**
 * Numbers of the task model (D36: typed configuration, not rules). `quarantineAfterFailedJobs`:
 * consecutive failed jobs on one (kind, subject, fingerprint) that quarantine it (D8: the second,
 * six attempts). `jobRetentionDays`: succeeded and canceled jobs older than this are pruned (3.1,
 * calibration). `blockRecheckMs`: a job set aside with no known clear time is looked at again after
 * it, so a missed clearing event never leaves it waiting for good. `releaseDueBlocksEveryMs`: how
 * often a worker releases the set-aside jobs whose clear time passed.
 */
export const GardenerTaskConfigSchema = z
  .object({
    quarantineAfterFailedJobs: z.number().int().min(1).max(10),
    jobRetentionDays: z.number().int().min(1).max(365),
    blockRecheckMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 3_600_000),
    releaseDueBlocksEveryMs: z.number().int().min(1_000).max(600_000)
  })
  .strict();
export type GardenerTaskConfig = z.infer<typeof GardenerTaskConfigSchema>;

export const gardenerTaskConfig: Readonly<GardenerTaskConfig> = Object.freeze(
  GardenerTaskConfigSchema.parse({
    quarantineAfterFailedJobs: 2,
    jobRetentionDays: 30,
    blockRecheckMs: 600_000,
    releaseDueBlocksEveryMs: 30_000
  })
);

/** The next local midnight after `now`: when a per-day cap clears (`cap.feature_daily`). */
export function nextLocalDay(now: Date): Date {
  const next = new Date(now.getTime());
  next.setHours(24, 0, 0, 0);
  return next;
}

/**
 * When a blocker met by a running task clears, if that is known: a daily cap at the next local
 * day; otherwise after the recheck delay, unless an event clears it first (D7).
 */
export function blockerClearAt(
  blocker: GardenerBlocker,
  now: Date,
  config: Pick<GardenerTaskConfig, "blockRecheckMs"> = gardenerTaskConfig
): Date {
  if (blocker.class === "cap" && blocker.reason === "feature_daily") return nextLocalDay(now);
  return new Date(now.getTime() + config.blockRecheckMs);
}
