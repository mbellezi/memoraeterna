import { topicsBlockedReasons, type TopicsBlockedReason } from "../topics.js";
import { gardenerTaskKind } from "./kinds.js";
import type { GardenerBlocker } from "./blockers.js";
import type { GardenerOutcome } from "./state.js";

/**
 * Table 3.1b: what each free-text `result.status` a Gardener executor returns means. The value
 * stays in `result` for the code that reads it (topic Areas, the topic status, the verify scripts);
 * the supervisor adds the outcome or the blocker beside it, or counts a failed attempt. A static
 * test fails on a status literal of a producer that has no row here.
 */
export type ResultStatusState =
  | { state: "outcome"; outcome: GardenerOutcome }
  | { state: "blocked"; blocker: GardenerBlocker | "by_reason" }
  | { state: "failed"; retry: boolean };

const done = { state: "outcome", outcome: "done" } as const;
const noChange = { state: "outcome", outcome: "no_change" } as const;
const failedAttempt = { state: "failed", retry: true } as const;
const failedJob = { state: "failed", retry: false } as const;

export const resultStatusStates: Readonly<Record<string, ResultStatusState>> = Object.freeze({
  // Done: the task changed what it was asked to.
  applied: done,
  named: done,
  embedded: done,
  audited: done,
  completed: done,
  cold_start: done,
  swept: done,
  judged: done,
  synced: done,
  // Done with a change-set that waits for review (E3 counts it completed); REBALANCE names its
  // change-set outcome `pending` (`topic-build.ts`, the kind of `applyChangeSet`'s result).
  pending_review: done,
  pending: done,
  // No change: nothing to do, or nothing to do yet without anything blocking the task.
  no_change: noChange,
  current: noChange,
  nothing_to_name: noChange,
  nothing_waiting: noChange,
  nothing_to_group: noChange,
  too_few_items: noChange,
  not_due: noChange,
  rejected: noChange,
  stale: noChange,
  tree_inactive: noChange,
  waiting_for_items: noChange,
  awaiting_build: noChange,
  // Areas wait for an open review; never blocks other work.
  review_pending: noChange,
  // A build skipped because the owner dismissed that configuration's rebuild (`topic-build.ts`).
  dismissed: noChange,
  // A producer's own skip; `skipped` the outcome is reserved for the fingerprint skip (D9).
  skipped: noChange,
  // The supervisor's skip of an input its quarantine holds back (D8): the job does not run and ends
  // with the outcome `skipped`, which E3 reports apart; never done.
  quarantined: { state: "outcome", outcome: "skipped" },
  // A generation conflict re-requested by the producer, and a space change waiting for its
  // re-embedding: the re-request inherits the clock (E3 measures the chain).
  deferred: noChange,
  space_changed: noChange,
  // Blockers: the job returns to the queue without burning an attempt (D7).
  no_route: { state: "blocked", blocker: { class: "no_model", reason: "no_route" } },
  no_decider: { state: "blocked", blocker: { class: "no_model", reason: "no_decider" } },
  cap_reached: { state: "blocked", blocker: { class: "cap", reason: "feature_daily" } },
  blocked: { state: "blocked", blocker: "by_reason" },
  // A failed call: retried with backoff like a transient failure, then failed (D8).
  call_failed: failedAttempt,
  // An answer still invalid after the producer's own repair is final for its input: only transient
  // errors are retried (rules/architecture.md), so the job fails at once. Both count toward
  // quarantine (D8).
  invalid: failedJob,
  invalid_output: failedJob
});

/** The blockers of the topic engine's `blocked` resolutions (`result.reason`). */
export const topicBlockedReasonBlockers: Readonly<Record<TopicsBlockedReason, GardenerBlocker>> =
  Object.freeze({
    no_embedding_route: { class: "no_model", reason: "no_route" },
    space_changed: { class: "no_model", reason: "space_changed" },
    waiting_for_embeddings: { class: "waiting", reason: "waiting_for_embeddings" },
    no_decider: { class: "no_model", reason: "no_decider" }
  });

export type GardenerResult =
  | { state: "outcome"; outcome: GardenerOutcome; status: string | null }
  | { state: "blocked"; blocker: GardenerBlocker; status: string; routeClass: string | null }
  | { state: "failed"; status: string; retry: boolean };

/**
 * How a finished step of a job of `type` with `result` ends (3.1b). Only Gardener kinds map their
 * status; any other job, a result without a status and a status no row names end done.
 */
export function gardenerResultOf(
  type: string,
  result: Readonly<Record<string, unknown>> | null
): GardenerResult {
  const row = gardenerTaskKind(type);
  const status = typeof result?.status === "string" ? result.status : null;
  if (!row?.gardener || status === null) return { state: "outcome", outcome: "done", status };
  const mapped = resultStatusStates[status];
  if (!mapped) return { state: "outcome", outcome: "done", status };
  if (mapped.state === "outcome") return { state: "outcome", outcome: mapped.outcome, status };
  if (mapped.state === "failed") return { state: "failed", status, retry: mapped.retry };
  const reason = result?.reason;
  const blocker =
    mapped.blocker !== "by_reason"
      ? mapped.blocker
      : typeof reason === "string" && (topicsBlockedReasons as readonly string[]).includes(reason)
        ? topicBlockedReasonBlockers[reason as TopicsBlockedReason]
        : null;
  // A `blocked` resolution with a reason no row names waits like an unexplained queue wait.
  return {
    state: "blocked",
    blocker: blocker ?? { class: "waiting", reason: "queue" },
    status,
    routeClass:
      blocker?.reason === "no_route"
        ? reason === "no_embedding_route"
          ? "embed"
          : row.routeClass
        : null
  };
}
