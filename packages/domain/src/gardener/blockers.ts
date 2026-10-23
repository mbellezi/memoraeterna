// Gardener blockers (F4 D7, spec 3.1): why queued background work does not run, in one closed set of
// classes and reasons. A blocker sets work aside without burning an attempt; the status sentence
// (D27) names the highest class with an affected task. Copy goes through i18n keys built from the
// class and reason, with every variable part (route class, times, names) as a parameter.
import { z } from "zod";

import { remoteBudgetRefusalOf } from "../remote-budget.js";

/** Blocker classes in precedence order: paused > no_model > cap > download > waiting > offline. */
export const gardenerBlockerClasses = [
  "paused",
  "no_model",
  "cap",
  "download",
  "waiting",
  "offline"
] as const;
export type GardenerBlockerClass = (typeof gardenerBlockerClasses)[number];

/** The reasons of each class, in precedence order inside the class. */
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

type Reasons = typeof gardenerBlockerReasons;
export type GardenerBlockerReason<C extends GardenerBlockerClass = GardenerBlockerClass> =
  Reasons[C][number];

/** `class.reason`: the stable name of a reason (status key segment, clearing table, logs). */
export type GardenerBlockerKey = {
  [C in GardenerBlockerClass]: `${C}.${Reasons[C][number]}`;
}[GardenerBlockerClass];

/** Parameters of a blocker's copy: names, times and route classes, never ids in a key. */
export type GardenerBlockerParams = Readonly<Record<string, string | number>>;

/** One blocker: its class and reason, the copy's parameters and the time it clears, when known. */
export type GardenerBlocker = {
  [C in GardenerBlockerClass]: {
    readonly class: C;
    readonly reason: Reasons[C][number];
    readonly params?: GardenerBlockerParams | undefined;
    /** Epoch milliseconds when the condition clears by itself (a reset time), if known. */
    readonly clearsAt?: number | null | undefined;
  };
}[GardenerBlockerClass];

export const gardenerBlockerKeys: readonly GardenerBlockerKey[] = gardenerBlockerClasses.flatMap(
  (blockerClass) =>
    gardenerBlockerReasons[blockerClass].map(
      (reason) => `${blockerClass}.${reason}` as GardenerBlockerKey
    )
);

const keySet = new Set<string>(gardenerBlockerKeys);

export const GardenerBlockerClassSchema = z.enum(gardenerBlockerClasses);

export const GardenerBlockerSchema = z
  .object({
    class: GardenerBlockerClassSchema,
    reason: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number().finite()])).optional(),
    clearsAt: z.number().finite().nullable().optional()
  })
  .strict()
  .refine((value) => keySet.has(`${value.class}.${value.reason}`), {
    message: "gardener.blocker.unknownReason",
    path: ["reason"]
  })
  .transform((value) => value as GardenerBlocker);

/** Builds a blocker, checking at compile time that the reason belongs to the class. */
export function gardenerBlocker<C extends GardenerBlockerClass>(
  blockerClass: C,
  reason: Reasons[C][number],
  extra: { params?: GardenerBlockerParams; clearsAt?: number | null } = {}
): GardenerBlocker {
  return {
    class: blockerClass,
    reason,
    ...(extra.params ? { params: extra.params } : {}),
    ...(extra.clearsAt !== undefined ? { clearsAt: extra.clearsAt } : {})
  } as GardenerBlocker;
}

export function gardenerBlockerKey(blocker: Pick<GardenerBlocker, "class" | "reason">) {
  return `${blocker.class}.${blocker.reason}` as GardenerBlockerKey;
}

export function isGardenerBlockerKey(value: unknown): value is GardenerBlockerKey {
  return typeof value === "string" && keySet.has(value);
}

/** The class and reason of a stored pair (`blocked_class`, `blocked_reason`), or null when unknown. */
export function parseGardenerBlockerKey(
  blockerClass: string | null | undefined,
  reason: string | null | undefined
): GardenerBlocker | null {
  if (!blockerClass || !reason) return null;
  const key = `${blockerClass}.${reason}`;
  return keySet.has(key) ? ({ class: blockerClass, reason } as GardenerBlocker) : null;
}

/**
 * The precedence rank of a reason: lower runs first in the sentence. Classes order first, then the
 * reasons inside a class as listed.
 */
export function gardenerBlockerRank(blocker: Pick<GardenerBlocker, "class" | "reason">): number {
  const classIndex = gardenerBlockerClasses.indexOf(blocker.class);
  const reasons = gardenerBlockerReasons[blocker.class] as readonly string[];
  return classIndex * 100 + reasons.indexOf(blocker.reason);
}

export function compareGardenerBlockers(
  left: Pick<GardenerBlocker, "class" | "reason">,
  right: Pick<GardenerBlocker, "class" | "reason">
): number {
  return gardenerBlockerRank(left) - gardenerBlockerRank(right);
}

/** The blocker that explains a task (or a set of tasks): the highest in precedence, or null. */
export function highestGardenerBlocker<T extends Pick<GardenerBlocker, "class" | "reason">>(
  blockers: Iterable<T | null | undefined>
): T | null {
  let best: T | null = null;
  for (const blocker of blockers)
    if (blocker && (!best || compareGardenerBlockers(blocker, best) < 0)) best = blocker;
  return best;
}

/**
 * Events that clear blocked rows (D7): each clears exactly the rows of the reasons listed for it
 * in {@link gardenerBlockerClearing}.
 */
export const gardenerClearingEvents = [
  /** A Knowledge control other than the monthly cap changed: pause, autonomy, idle, power, shape. */
  "controls_changed",
  /** The monthly remote spend cap changed (a money-capped task may fit under the new cap). */
  "cap_changed",
  /** The user's activity or the power source changed. */
  "power_changed",
  /** The AI configuration changed: a route, a provider, a sign-in, a validated model. */
  "routes_changed",
  /** A local model download or verification settled. */
  "download_settled",
  /** The local day rolled over (daily caps). */
  "day_rollover",
  /** The local month rolled over (the money cap). */
  "month_rollover",
  /** The user chose to continue past 80% of the monthly cap. */
  "budget_continued",
  /** A remote request succeeded again after network failures. */
  "network_back"
] as const;
export type GardenerClearingEvent = (typeof gardenerClearingEvents)[number];

export interface GardenerBlockerClearing {
  /** Events whose arrival clears the rows of the reason. */
  readonly events: readonly GardenerClearingEvent[];
  /**
   * Rows also clear once their `run_after` (the reset time, the next probe) has passed, so a
   * time-bound wait never needs an event and never outlives its clock.
   */
  readonly atRunAfter: boolean;
}

const clearing = (
  events: readonly GardenerClearingEvent[],
  atRunAfter = false
): GardenerBlockerClearing => ({ events, atRunAfter });

/** How every reason clears. A reason the background gate evaluates also clears when it stops holding. */
export const gardenerBlockerClearing: Readonly<
  Record<GardenerBlockerKey, GardenerBlockerClearing>
> = {
  "paused.user_pause": clearing(["controls_changed"]),
  "paused.autonomy_off": clearing(["controls_changed"]),
  "paused.only_idle_user_active": clearing(["controls_changed", "power_changed"]),
  "paused.only_ac_on_battery": clearing(["controls_changed", "power_changed"]),
  "no_model.no_route": clearing(["routes_changed"]),
  "no_model.model_missing": clearing(["routes_changed", "download_settled"]),
  "no_model.no_decider": clearing(["routes_changed", "download_settled"]),
  "no_model.signin_required": clearing(["routes_changed"], true),
  "no_model.space_changed": clearing(["routes_changed"], true),
  "cap.money_80": clearing(["cap_changed", "budget_continued", "month_rollover"]),
  "cap.money_100": clearing(["cap_changed", "month_rollover"]),
  "cap.subscription_daily": clearing(["day_rollover"]),
  "cap.provider_quota": clearing([], true),
  "cap.feature_daily": clearing(["day_rollover"]),
  "download.model_downloading": clearing(["download_settled"]),
  "download.model_verifying": clearing(["download_settled"]),
  "download.model_loading": clearing(["download_settled"], true),
  "waiting.queue": clearing([], true),
  "waiting.same_scope": clearing([], true),
  "waiting.provider_rate_limit": clearing([], true),
  "waiting.provider_unavailable": clearing(["network_back"], true),
  "waiting.local_memory": clearing([], true),
  "waiting.waiting_for_embeddings": clearing(["routes_changed"], true),
  "waiting.retry_backoff": clearing([], true),
  "offline.network_unreachable": clearing(["network_back"], true)
};

/** The reasons an event clears. */
export function gardenerReasonsClearedBy(event: GardenerClearingEvent): GardenerBlockerKey[] {
  return gardenerBlockerKeys.filter((key) => gardenerBlockerClearing[key].events.includes(event));
}

/** The reasons whose rows clear once their `run_after` has passed. */
export const gardenerTimeClearedReasons: readonly GardenerBlockerKey[] = gardenerBlockerKeys.filter(
  (key) => gardenerBlockerClearing[key].atRunAfter
);

const backgroundBlockedCode = "gardener.blocked";

/**
 * What an admission (a gate, a budget reservation) throws when background work must wait (D7): the
 * job supervisor returns the task to the queue with this blocker, its attempt not burned, instead of
 * failing it. Callers that catch errors of a model call rethrow it ({@link isBackgroundBlocked}).
 */
export class BackgroundBlockedError extends Error {
  public readonly code = backgroundBlockedCode;

  public constructor(public readonly blocker: GardenerBlocker) {
    super(`Background work is held: ${gardenerBlockerKey(blocker)}`);
    this.name = "BackgroundBlockedError";
  }
}

/**
 * The blocker an error carries, when it is a background refusal: a gate's (this module's class)
 * or the RemoteBudget's (`RemoteBudgetRefusal`, D14: a `cap` reason that clears when its day or
 * month rolls over, or when the person continues or raises the cap), also when another error wraps
 * it. Read by shape, not by class, so a refusal made by another module's copy of the class (a
 * bundle, a worker) still maps.
 */
export function backgroundBlockerOf(error: unknown): GardenerBlocker | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as { code?: unknown; blocker?: unknown };
  if (candidate.code === backgroundBlockedCode) {
    const parsed = GardenerBlockerSchema.safeParse(candidate.blocker);
    return parsed.success ? parsed.data : null;
  }
  const refusal = remoteBudgetRefusalOf(error);
  return refusal
    ? gardenerBlocker("cap", refusal.blockedReason, {
        clearsAt: refusal.clearsAt ? refusal.clearsAt.getTime() : null
      })
    : null;
}

export function isBackgroundBlocked(error: unknown): boolean {
  return backgroundBlockerOf(error) !== null;
}
