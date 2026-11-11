import {
  gardenerBlockerClasses,
  gardenerStatusActionKeys,
  statusSentence,
  type BudgetSnapshot,
  type ChangeSetRef,
  type ChangeSetSummary,
  type GardenerStatusAction,
  type GardenerStatusSentence,
  type GardenerStatusSnapshot
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { JobProgressEvent } from "../../../shared/app-events";
import type { SettingsScope } from "../SettingsView";

/**
 * What the Activity pill and drawer show (F4 D28, spec 3.8), as plain data and pure functions: the
 * controller keeps the state and the components draw it, so every rule is tested without a
 * renderer. Nothing here carries copy: states and amounts map to `activity.*` and
 * `gardener.status.*` messages at the edge.
 */

/** A read that is loading, failed (and can be retried), or answered. */
export type Load<T> = { status: "loading" } | { status: "error" } | { status: "ready"; value: T };

/** The jobs of both lanes together, from `job.progress`; the copy shows no lane names. */
export interface JobFacts {
  running: number;
  waiting: number;
  onHold: number;
}

/** What happened to the last action on one change-set: asking, or why it did not happen. */
export type RowAction =
  { status: "pending" } | { status: "failed" | "blocked"; messageKey: MessageKey };

/** What the polite live region says next; the host turns it into text in the interface language. */
export type Announcement = { id: number } & (
  { kind: "message"; key: MessageKey } | { kind: "attention" }
);

export interface ActivitySnapshot {
  /** When the snapshot was made: the clock its sentences and times are read against. */
  now: number;
  status: Load<GardenerStatusSnapshot>;
  /** The local embedder is loading into memory (what the blocking dialog used to say). */
  embedderLoading: boolean;
  /** The reviews that wait for the person: the Inbox count. Null until it is known. */
  inboxTotal: number | null;
  open: boolean;
  /** Null until a `job.progress` arrived. */
  jobs: JobFacts | null;
  budget: Load<BudgetSnapshot>;
  done: Load<ChangeSetSummary[]>;
  /** Undo per change-set (`undoKey`). */
  undo: Readonly<Record<string, RowAction>>;
  /** The status action being run (resume, continue), or the last one that failed. */
  statusAction: { action: GardenerStatusAction; status: "pending" | "failed" } | null;
  announcement: Announcement | null;
}

export const initialActivitySnapshot = (now: number): ActivitySnapshot => ({
  now,
  status: { status: "loading" },
  embedderLoading: false,
  inboxTotal: null,
  open: false,
  jobs: null,
  budget: { status: "loading" },
  done: { status: "loading" },
  undo: {},
  statusAction: null,
  announcement: null
});

export const undoKey = (ref: ChangeSetRef): string => `${ref.kind}:${ref.id}`;

/** Recent changes listed in the drawer. */
export const doneListLimit = 8;

// ---------------------------------------------------------------------------
// The status the person sees

const downloadRank = gardenerBlockerClasses.indexOf("download");

/**
 * The embedder loading into memory is a `download` hold. The status service names it while work
 * waits for it; a search that waits for the embedder with nothing else to do has no work to name,
 * so the pill says it itself, unless a higher hold already speaks (paused, no model, a cap).
 */
export function withEmbedderLoading(
  status: GardenerStatusSnapshot,
  loading: boolean
): GardenerStatusSnapshot {
  if (!loading) return status;
  if (status.class !== undefined && gardenerBlockerClasses.indexOf(status.class) <= downloadRank)
    return status;
  return {
    state: "blocked",
    class: "download",
    reason: "model_loading",
    params: {},
    coverage: status.coverage
  };
}

/** Where the status sentence lives in the drawer: running or idle is "now", a hold is waiting. */
export function statusSection(status: GardenerStatusSnapshot): "now" | "waiting" | "needsYou" {
  if (status.state === "attention") return "needsYou";
  return status.state === "blocked" ? "waiting" : "now";
}

/** The status the person is told about: the pill, and the drawer's Now, Waiting or Needs you. */
export function effectiveStatus(snapshot: ActivitySnapshot): GardenerStatusSnapshot | null {
  return snapshot.status.status === "ready"
    ? withEmbedderLoading(snapshot.status.value, snapshot.embedderLoading)
    : null;
}

export function jobFactsOf(event: JobProgressEvent): JobFacts {
  const lanes = Object.values(event.lanes);
  const sum = (field: "running" | "queued" | "blocked") =>
    lanes.reduce((total, lane) => total + lane[field], 0);
  return { running: sum("running"), waiting: sum("queued"), onHold: sum("blocked") };
}

// ---------------------------------------------------------------------------
// Actions

/** A status action the host carries out by opening a place in Settings. */
export interface ActivityNavigation {
  view: "settings";
  scope: SettingsScope;
}

/**
 * What each action does. The Gardener's controls (pause, autonomy, the monthly limit) live in
 * Settings › Knowledge (T98); Resume changes the pause there through the same writer.
 */
export const actionEffects = {
  resume: { kind: "resume" },
  continue_budget: { kind: "continueBudget" },
  open_controls: { kind: "navigate", to: { view: "settings", scope: "knowledge" } },
  raise_budget: { kind: "navigate", to: { view: "settings", scope: "knowledge" } },
  open_ai_settings: { kind: "navigate", to: { view: "settings", scope: "intelligence" } },
  sign_in: { kind: "navigate", to: { view: "settings", scope: "intelligence" } },
  open_local_models: { kind: "navigate", to: { view: "settings", scope: "models" } }
} as const satisfies Record<
  GardenerStatusAction,
  { kind: "resume" | "continueBudget" } | { kind: "navigate"; to: ActivityNavigation }
>;

/**
 * The actions offered beside a status sentence: its own, and for the pause near the spending limit
 * the way out the sentence names too ("continue it, or raise the limit").
 */
export function actionsOf(status: GardenerStatusSnapshot): GardenerStatusAction[] {
  if (status.action === undefined) return [];
  if (status.class === "cap" && status.reason === "money_80")
    return [status.action, "raise_budget"];
  return [status.action];
}

/** An action as a button: what it does and its label in the interface language. */
export interface ActionButton {
  id: GardenerStatusAction;
  label: string;
}

export function actionButtons(t: Translator, status: GardenerStatusSnapshot): ActionButton[] {
  return actionsOf(status).map((id) => ({ id, label: t(gardenerStatusActionKeys[id]) }));
}

// ---------------------------------------------------------------------------
// Needs you

/** One thing only the person can clear, drawn as a sentence with the actions that clear it. */
export interface NeedsYouEntry {
  key: string;
  sentence: GardenerStatusSentence;
  actions: ActionButton[];
}

/**
 * The budget's own hold, for the "needs you" list when a higher hold hides it in the status: the
 * pause near the limit (continue or raise), the limit reached (raise).
 */
export function budgetHold(
  budget: BudgetSnapshot,
  coverage: GardenerStatusSnapshot["coverage"]
): GardenerStatusSnapshot | null {
  const { money } = budget;
  const params = { spentUsd: money.spentUsd, capUsd: money.capUsd };
  if (money.state === "exhausted")
    return {
      state: "attention",
      class: "cap",
      reason: "money_100",
      params,
      coverage,
      action: "raise_budget"
    };
  if (money.state === "paused" && !money.continued)
    return {
      state: "attention",
      class: "cap",
      reason: "money_80",
      params,
      coverage,
      action: "continue_budget"
    };
  return null;
}

const isMoneyCap = (status: GardenerStatusSnapshot): boolean =>
  status.class === "cap" && (status.reason === "money_80" || status.reason === "money_100");

/** The things that wait for the person, the status's own first. */
export function needsYouEntries(input: {
  t: Translator;
  status: GardenerStatusSnapshot;
  budget: BudgetSnapshot | null;
  now: number;
}): NeedsYouEntry[] {
  const { t, status, budget, now } = input;
  const entry = (key: string, source: GardenerStatusSnapshot): NeedsYouEntry => ({
    key,
    sentence: statusSentence(source, t.locale, { now }),
    actions: actionButtons(t, source)
  });
  const entries: NeedsYouEntry[] = [];
  if (statusSection(status) === "needsYou") entries.push(entry("status", status));
  // A higher hold can hide the budget's in the status; the meters still say it.
  if (!isMoneyCap(status) && budget) {
    const hold = budgetHold(budget, status.coverage);
    if (hold) entries.push(entry("budget", hold));
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The pill

export type PillGlyph = "check" | "working" | "waiting" | "attention" | "error" | "loading";

export interface PillView {
  glyph: PillGlyph;
  /** The short phrase the pill draws (no trailing period): it names the work, never the whole story. */
  text: string;
  /** The full sentence and the time left or the time it resumes: the tooltip and accessible name. */
  full: string;
  /** The reviews waiting for the person: the pill says them in words; 0 says nothing. */
  badge: number;
  /** Jobs waiting or on hold, from `job.progress`; 0 says nothing. */
  waiting: number;
}

const glyphOfState = {
  idle: "check",
  running: "working",
  blocked: "waiting",
  attention: "attention"
} as const satisfies Record<GardenerStatusSnapshot["state"], PillGlyph>;

/** The short pill phrase of each hold class; the drawer and the tooltip say the whole reason. */
const holdPhrases = {
  paused: "workspace.status.holdPaused",
  no_model: "workspace.status.holdNoModel",
  cap: "workspace.status.holdCap",
  download: "workspace.status.holdDownload",
  waiting: "workspace.status.holdWaiting",
  offline: "workspace.status.holdOffline"
} as const satisfies Record<(typeof gardenerBlockerClasses)[number], MessageKey>;

/** The pill's own short phrase for a status: the work it names, in a few words. */
export function pillPhrase(t: Translator, status: GardenerStatusSnapshot): string {
  // A running status can carry a class too (the queue, autonomy off); it is still running.
  if (status.class !== undefined && (status.state === "blocked" || status.state === "attention"))
    return t(holdPhrases[status.class]);
  return t(status.state === "running" ? "workspace.status.running" : "workspace.status.idle");
}

export function pillView(t: Translator, snapshot: ActivitySnapshot): PillView {
  const badge = snapshot.inboxTotal ?? 0;
  const waiting = snapshot.jobs ? snapshot.jobs.waiting + snapshot.jobs.onHold : 0;
  if (snapshot.status.status === "loading") {
    const text = t("activity.pill.loading");
    return { glyph: "loading", text, full: text, badge, waiting };
  }
  const status = effectiveStatus(snapshot);
  if (status === null) {
    const text = t("activity.pill.unavailable");
    return { glyph: "error", text, full: text, badge, waiting };
  }
  const sentence = statusSentence(status, t.locale, { now: snapshot.now });
  return {
    glyph: glyphOfState[status.state],
    text: pillPhrase(t, status),
    full: [sentence.headline, sentence.eta].filter((part) => part !== null).join(" "),
    badge,
    waiting
  };
}

// ---------------------------------------------------------------------------
// Numbers and times

/** A whole-percent share; the status already keeps a share below 100% until it is complete. */
export function percentText(locale: string, share: number): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 0 }).format(
    Math.min(1, Math.max(0, share))
  );
}

/** The share of a limit used, rounded down to a whole percent so it never reads full early. */
export function usedShare(used: number, cap: number): number {
  if (!(cap > 0)) return used > 0 ? 1 : 0;
  return Math.min(1, Math.max(0, Math.floor((used / cap) * 100) / 100));
}

export interface BudgetView {
  money: {
    spent: string;
    cap: string;
    share: number;
    state: BudgetSnapshot["money"]["state"];
  };
  /** The subscription's share of today's background allowance, once background calls were made. */
  subscription: { share: number } | null;
}

export function budgetView(locale: string, budget: BudgetSnapshot): BudgetView {
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" });
  const { money, calls } = budget;
  const used = calls.usedCalls + calls.reservedCalls;
  return {
    money: {
      spent: usd.format(money.spentUsd),
      cap: usd.format(money.capUsd),
      share: usedShare(money.spentUsd, money.capUsd),
      state: money.state
    },
    subscription: used > 0 ? { share: usedShare(used, calls.capCalls) } : null
  };
}
