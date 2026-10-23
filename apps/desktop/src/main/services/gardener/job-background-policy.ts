import type { JobRecord } from "@app/db";
import {
  autonomyRunsProvisionally,
  backgroundBlockerOf,
  gardenerBlockerKey,
  type GardenerBlocker
} from "@app/domain";

/**
 * What the job supervisor asks of the Gardener's background policy (F4 D7, T75): which kinds the
 * global gates hold at claim, the startup re-gate before the workers start, and how a task that met
 * a blocker after its claim is set aside instead of failing.
 */
export interface JobBackgroundPolicy {
  /** The job types among `types` a global gate holds now: the claim leaves them out. */
  heldKinds(types: readonly string[]): ReadonlySet<string>;
  /** Re-gates every blocked row; the supervisor awaits it before its workers start. */
  regate(): Promise<void>;
  /** The blocker a model call of this job met at admission, once (its executor may have swallowed it). */
  takeAdmissionBlock(jobId: string): GardenerBlocker | undefined;
  /** Returns the running job to the queue with the blocker, its attempt given back. */
  blockTask(job: JobRecord, blocker: GardenerBlocker): Promise<boolean>;
}

/**
 * The blocker a job ended with: a background refusal it threw, else one its calls met at admission.
 * A canceled job ends canceled, whatever it met. A kind that runs provisionally under Off (naming)
 * meets the Off refusal as its normal outcome: it wrote its fallback, so that refusal sets nothing
 * aside (a set-aside row would keep its dedupe key and absorb the next requests while Off lasts).
 */
export function jobBlocker(
  policy: JobBackgroundPolicy | undefined,
  job: Pick<JobRecord, "id" | "type">,
  outcome: { error?: unknown; canceled: boolean }
): GardenerBlocker | null {
  if (!policy) return null;
  const taken = policy.takeAdmissionBlock(job.id);
  if (outcome.canceled) return null;
  const remembered =
    taken &&
    gardenerBlockerKey(taken) === "paused.autonomy_off" &&
    autonomyRunsProvisionally(job.type)
      ? undefined
      : taken;
  return backgroundBlockerOf(outcome.error) ?? remembered ?? null;
}

/** The claimable types after the gates: `types` without the kinds they hold now. */
export function claimableTypes(
  policy: JobBackgroundPolicy | undefined,
  types: readonly string[]
): readonly string[] {
  if (!policy || types.length === 0) return types;
  const held = policy.heldKinds(types);
  return held.size === 0 ? types : types.filter((type) => !held.has(type));
}
