// The status sentence (F4 D27, spec 3.8): the snapshot of `status.ts` rendered through `@app/i18n`.
// Every reason has its own message, `gardener.status.<class>.<reason>`, listed here as a literal key
// so the compiler checks each against the English catalog; no key is ever built from a variable
// part. What varies (the route class, the amounts, the time left) travels as a parameter of the
// message or of the sentence that follows it. Copy never carries a call or task count.
import { translate, type LanguageCode, type MessageKey } from "@app/i18n";

import type { AiClassId } from "../ai-presets.js";
import type { GardenerBlockerKey } from "./blockers.js";
import {
  gardenerStatusActions,
  type GardenerStatusAction,
  type GardenerStatusSnapshot
} from "./status.js";

/** The message of each reason. */
export const gardenerStatusMessageKeys = {
  "paused.user_pause": "gardener.status.paused.user_pause",
  "paused.autonomy_off": "gardener.status.paused.autonomy_off",
  "paused.only_idle_user_active": "gardener.status.paused.only_idle_user_active",
  "paused.only_ac_on_battery": "gardener.status.paused.only_ac_on_battery",
  "no_model.no_route": "gardener.status.no_model.no_route",
  "no_model.model_missing": "gardener.status.no_model.model_missing",
  "no_model.no_decider": "gardener.status.no_model.no_decider",
  "no_model.signin_required": "gardener.status.no_model.signin_required",
  "no_model.space_changed": "gardener.status.no_model.space_changed",
  "cap.money_80": "gardener.status.cap.money_80",
  "cap.money_100": "gardener.status.cap.money_100",
  "cap.subscription_daily": "gardener.status.cap.subscription_daily",
  "cap.provider_quota": "gardener.status.cap.provider_quota",
  "cap.feature_daily": "gardener.status.cap.feature_daily",
  "download.model_downloading": "gardener.status.download.model_downloading",
  "download.model_verifying": "gardener.status.download.model_verifying",
  "download.model_loading": "gardener.status.download.model_loading",
  "waiting.queue": "gardener.status.waiting.queue",
  "waiting.same_scope": "gardener.status.waiting.same_scope",
  "waiting.provider_rate_limit": "gardener.status.waiting.provider_rate_limit",
  "waiting.provider_unavailable": "gardener.status.waiting.provider_unavailable",
  "waiting.local_memory": "gardener.status.waiting.local_memory",
  "waiting.waiting_for_embeddings": "gardener.status.waiting.waiting_for_embeddings",
  "waiting.retry_backoff": "gardener.status.waiting.retry_backoff",
  "offline.network_unreachable": "gardener.status.offline.network_unreachable"
} as const satisfies Record<GardenerBlockerKey, MessageKey>;

/** The messages of a status with nothing in the way. */
export const gardenerStatusStateKeys = {
  idle: "gardener.status.idle",
  running: "gardener.status.running"
} as const satisfies Record<"idle" | "running", MessageKey>;

/** The route class a `no_route` message names, as a lower-case noun (`{routeClass}`). */
export const gardenerStatusRouteClassKeys = {
  embed: "gardener.status.routeClass.embed",
  decide: "gardener.status.routeClass.decide",
  "write-fast": "gardener.status.routeClass.writeFast",
  "write-quality": "gardener.status.routeClass.writeQuality",
  answer: "gardener.status.routeClass.answer"
} as const satisfies Record<AiClassId, MessageKey>;

/** The label of each action. */
export const gardenerStatusActionKeys = {
  resume: "gardener.status.actions.resume",
  open_controls: "gardener.status.actions.open_controls",
  open_ai_settings: "gardener.status.actions.open_ai_settings",
  open_local_models: "gardener.status.actions.open_local_models",
  sign_in: "gardener.status.actions.sign_in",
  continue_budget: "gardener.status.actions.continue_budget",
  raise_budget: "gardener.status.actions.raise_budget"
} as const satisfies Record<GardenerStatusAction, MessageKey>;

/** The sentences that follow the message: the amounts and the time left. */
export const gardenerStatusDetailKeys = {
  budget: "gardener.status.detail.budget",
  etaDuration: "gardener.status.eta.duration",
  etaLessThanMinute: "gardener.status.eta.lessThanMinute",
  etaAt: "gardener.status.eta.at"
} as const satisfies Record<string, MessageKey>;

/** Every message of the status, for the exhaustive test of the five locales. */
export const gardenerStatusAllMessageKeys: readonly MessageKey[] = [
  ...Object.values(gardenerStatusMessageKeys),
  ...Object.values(gardenerStatusStateKeys),
  ...Object.values(gardenerStatusRouteClassKeys),
  ...Object.values(gardenerStatusActionKeys),
  ...Object.values(gardenerStatusDetailKeys)
];

export interface GardenerStatusSentence {
  /** What the pill shows: the message, then the amounts and the time left when there are any. */
  text: string;
  /** The message of the reason, or of the idle or running state. */
  headline: string;
  /** The amounts that go with the reason (a spending limit), when the snapshot carries them. */
  detail: string | null;
  /** The time left or the time it resumes, when the snapshot carries one. */
  eta: string | null;
  /** What the person can do about it. */
  action: { id: GardenerStatusAction; label: string } | null;
}

function unit(locale: LanguageCode, name: "minute" | "hour", value: number): string {
  return new Intl.NumberFormat(locale, {
    style: "unit",
    unit: name,
    unitDisplay: "long",
    maximumFractionDigits: 0
  }).format(value);
}

/** A duration for a sentence: minutes up to two hours, then whole hours. */
export function formatStatusDuration(locale: LanguageCode, seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  return minutes < 120
    ? unit(locale, "minute", minutes)
    : unit(locale, "hour", Math.round(minutes / 60));
}

/** A time for a sentence: the hour today, the date and hour on another day. */
export function formatStatusTime(locale: LanguageCode, at: Date, now: Date): string {
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  return new Intl.DateTimeFormat(
    locale,
    sameDay
      ? { hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }
  ).format(at);
}

function formatUsd(locale: LanguageCode, value: number): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(value);
}

const isRouteClass = (value: unknown): value is AiClassId =>
  typeof value === "string" && Object.hasOwn(gardenerStatusRouteClassKeys, value);

const isMessageKeyOfReason = (value: string): value is keyof typeof gardenerStatusMessageKeys =>
  Object.hasOwn(gardenerStatusMessageKeys, value);

/**
 * Renders a status for a locale. Pure: the same snapshot, locale and clock give the same text. The
 * clock only decides whether a time is shown with its date.
 */
export function statusSentence(
  snapshot: GardenerStatusSnapshot,
  locale: LanguageCode,
  options: { now?: number } = {}
): GardenerStatusSentence {
  const now = new Date(options.now ?? Date.now());
  const say = (key: MessageKey, values?: Record<string, string | number>): string =>
    translate(locale, key, values ? { values } : {});

  const reasonKey = snapshot.class !== undefined ? `${snapshot.class}.${snapshot.reason}` : null;
  const known = reasonKey !== null && isMessageKeyOfReason(reasonKey) ? reasonKey : null;
  const headline = known
    ? say(
        gardenerStatusMessageKeys[known],
        known === "no_model.no_route"
          ? {
              routeClass: say(
                gardenerStatusRouteClassKeys[
                  isRouteClass(snapshot.params.routeClass) ? snapshot.params.routeClass : "embed"
                ]
              )
            }
          : undefined
      )
    : say(
        snapshot.state === "idle" ? gardenerStatusStateKeys.idle : gardenerStatusStateKeys.running
      );

  const { spentUsd, capUsd } = snapshot.params;
  const detail =
    known && typeof spentUsd === "number" && typeof capUsd === "number"
      ? say(gardenerStatusDetailKeys.budget, {
          spent: formatUsd(locale, spentUsd),
          cap: formatUsd(locale, capUsd)
        })
      : null;

  let eta: string | null = null;
  if (snapshot.eta?.kind === "duration")
    eta =
      snapshot.eta.seconds < 60
        ? say(gardenerStatusDetailKeys.etaLessThanMinute)
        : say(gardenerStatusDetailKeys.etaDuration, {
            duration: formatStatusDuration(locale, snapshot.eta.seconds)
          });
  else if (snapshot.eta?.kind === "at")
    eta = say(gardenerStatusDetailKeys.etaAt, {
      time: formatStatusTime(locale, new Date(snapshot.eta.at), now)
    });

  const action =
    snapshot.action && gardenerStatusActions.includes(snapshot.action)
      ? { id: snapshot.action, label: say(gardenerStatusActionKeys[snapshot.action]) }
      : null;

  return {
    text: [headline, detail, eta].filter((part): part is string => part !== null).join(" "),
    headline,
    detail,
    eta,
    action
  };
}
