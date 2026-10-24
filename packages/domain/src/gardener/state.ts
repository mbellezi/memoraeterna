import { z } from "zod";

import {
  gardenerBlockerClasses,
  type GardenerBlocker,
  type GardenerBlockerClass
} from "./blockers.js";

/**
 * Gardener task state (F4 D5, spec 3.1). The `jobs` table keeps its five statuses; the Gardener
 * state is derived from them and the columns 0060 adds: an outcome on a finished job, a blocker
 * on a job set aside, a quarantine mark on a job that failed again on the same input.
 */

/** How a succeeded job ended: it changed something, found nothing to change, or skipped by fingerprint. */
export const gardenerOutcomeValues = ["done", "no_change", "skipped"] as const;
export const GardenerOutcomeSchema = z.enum(gardenerOutcomeValues);
export type GardenerOutcome = z.infer<typeof GardenerOutcomeSchema>;

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
 * six attempts); the retention window of finished jobs is `changeSetConfig.retention.jobDays`, read
 * by the `gardener-retention` job. `blockRecheckMs`: a job set aside with no known clear time is
 * looked at again after it, so a missed clearing event never leaves it waiting for good.
 * `releaseDueBlocksEveryMs`: how often a worker releases the set-aside jobs whose clear time passed.
 * `providerProbeMs`: a job whose connection to its provider failed (DNS, routing, a refused
 * connection) is set aside this long, about a remote lane's open period, so it comes back as the
 * probe that tells the provider is up again.
 */
export const GardenerTaskConfigSchema = z
  .object({
    quarantineAfterFailedJobs: z.number().int().min(1).max(10),
    blockRecheckMs: z
      .number()
      .int()
      .min(1_000)
      .max(24 * 3_600_000),
    releaseDueBlocksEveryMs: z.number().int().min(1_000).max(600_000),
    providerProbeMs: z.number().int().min(1_000).max(600_000)
  })
  .strict();
export type GardenerTaskConfig = z.infer<typeof GardenerTaskConfigSchema>;

export const gardenerTaskConfig: Readonly<GardenerTaskConfig> = Object.freeze(
  GardenerTaskConfigSchema.parse({
    quarantineAfterFailedJobs: 2,
    blockRecheckMs: 600_000,
    releaseDueBlocksEveryMs: 30_000,
    providerProbeMs: 30_000
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
