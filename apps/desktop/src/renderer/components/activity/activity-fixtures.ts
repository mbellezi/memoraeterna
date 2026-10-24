import {
  fullGardenerCoverage,
  GardenerStatusSnapshotSchema,
  type BudgetSnapshot,
  type ChangeSetSummary,
  type GardenerStatusSnapshot,
  type InboxCounts
} from "@app/domain";

import type { AppEventOf } from "../../../shared/app-events";
import { initialActivitySnapshot, type ActivitySnapshot } from "./activity-model";

/** A moment the fixtures agree on: 2026-10-24 12:00 UTC. */
export const fixtureNow = Date.UTC(2026, 9, 24, 12, 0, 0);

const status = (snapshot: GardenerStatusSnapshot): GardenerStatusSnapshot =>
  GardenerStatusSnapshotSchema.parse(snapshot);

export const partialCoverage = { placed: 0.92, matched: 0.8, overviewsFresh: 1 } as const;

export const idleStatus = status({ state: "idle", params: {}, coverage: fullGardenerCoverage });

export const runningStatus = status({
  state: "running",
  params: {},
  coverage: partialCoverage,
  eta: { kind: "duration", seconds: 600 }
});

export const queueStatus = status({
  state: "running",
  class: "waiting",
  reason: "queue",
  params: {},
  coverage: partialCoverage
});

export const pausedStatus = status({
  state: "blocked",
  class: "paused",
  reason: "user_pause",
  params: {},
  coverage: partialCoverage,
  action: "resume"
});

export const downloadingStatus = status({
  state: "blocked",
  class: "download",
  reason: "model_downloading",
  params: {},
  coverage: partialCoverage,
  eta: { kind: "duration", seconds: 300 },
  action: "open_local_models"
});

export const rateLimitedStatus = status({
  state: "blocked",
  class: "waiting",
  reason: "provider_rate_limit",
  params: {},
  coverage: partialCoverage,
  eta: { kind: "at", at: "2026-10-24T15:40:00.000Z" }
});

export const signInStatus = status({
  state: "attention",
  class: "no_model",
  reason: "signin_required",
  params: {},
  coverage: partialCoverage,
  action: "sign_in"
});

export const noRouteStatus = status({
  state: "attention",
  class: "no_model",
  reason: "no_route",
  params: { routeClass: "write-fast" },
  coverage: partialCoverage,
  action: "open_ai_settings"
});

export const money80Status = status({
  state: "attention",
  class: "cap",
  reason: "money_80",
  params: { spentUsd: 4.1, capUsd: 5 },
  coverage: partialCoverage,
  action: "continue_budget"
});

export const budgetSnapshot = (
  money: Partial<BudgetSnapshot["money"]> = {},
  calls: Partial<BudgetSnapshot["calls"]> = {}
): BudgetSnapshot => ({
  month: "2026-10",
  day: "2026-10-24",
  money: {
    spentUsd: 1.2,
    reservedUsd: 0,
    capUsd: 5,
    pauseShare: 0.8,
    continued: false,
    state: "open",
    priceTableVersion: "2026-10",
    ...money
  },
  calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: "open", ...calls }
});

const idOf = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const changeSet = (n: number, change: Partial<ChangeSetSummary> = {}): ChangeSetSummary => ({
  kind: "topic",
  id: idOf(n),
  titleKey: "topics.changeSets.place",
  titleParams: { items: 12 },
  risk: "low",
  status: "applied",
  origin: "place",
  subjectId: null,
  jobId: null,
  at: "2026-10-24T11:30:00.000Z",
  undoneAt: null,
  undo: "available",
  ...change
});

export const jobProgress = (
  heavy: Partial<AppEventOf<"job.progress">["lanes"]["heavy"]> = {},
  light: Partial<AppEventOf<"job.progress">["lanes"]["light"]> = {}
): AppEventOf<"job.progress"> => {
  const zero = { queued: 0, blocked: 0, running: 0, succeeded: 0, failed: 0, canceled: 0 };
  return {
    type: "job.progress",
    lanes: { heavy: { ...zero, ...heavy }, light: { ...zero, ...light } },
    changedIds: [],
    changedIdsTruncated: false
  };
};

/** The Inbox's counts (`inbox.counts`) with `total` reviews, all low risk. */
export const inboxCounts = (total: number): InboxCounts => ({
  total,
  byKind: {
    review: total,
    quarantined: 0,
    contradiction: 0,
    withdrawn: 0,
    duplicate: 0,
    obsidian_conflict: 0,
    budget: 0,
    backlog: 0
  },
  byRisk: { low: total, medium: 0, high: 0 }
});

/** An `inbox.changed` event with `total` reviews, all low risk. */
export const inboxChanged = (total: number): AppEventOf<"inbox.changed"> => ({
  type: "inbox.changed",
  ...inboxCounts(total)
});

/** A snapshot with the given parts, the clock fixed. */
export const activitySnapshot = (parts: Partial<ActivitySnapshot> = {}): ActivitySnapshot => ({
  ...initialActivitySnapshot(fixtureNow),
  ...parts
});
