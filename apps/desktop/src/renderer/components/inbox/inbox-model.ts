import {
  inboxKinds,
  type ChangeSetRisk,
  type InboxItem,
  type InboxKind,
  type InboxObject,
  type InboxVerb
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { changeSetTitle } from "../activity/change-title";

/**
 * How the Inbox words what the stores hold. Every sentence is a fixed message key chosen from a
 * closed table by the item's kind and variant, with the variable parts (names, counts, amounts) as
 * parameters; a stored key or value that a table does not know reads as the plain sentence of its
 * kind, and a raw ID or stored text never reaches the screen as a key.
 */

export const kindLabels = {
  review: "inbox.kinds.review",
  quarantined: "inbox.kinds.quarantined",
  contradiction: "inbox.kinds.contradiction",
  withdrawn: "inbox.kinds.withdrawn",
  duplicate: "inbox.kinds.duplicate",
  obsidian_conflict: "inbox.kinds.obsidianConflict",
  budget: "inbox.kinds.budget",
  backlog: "inbox.kinds.backlog"
} as const satisfies Record<InboxKind, MessageKey>;

export const riskLabels = {
  high: "inbox.risk.high",
  medium: "inbox.risk.medium",
  low: "inbox.risk.low"
} as const satisfies Record<ChangeSetRisk, MessageKey>;

/** The kinds in the order of the filter bar. */
export const kindOrder: readonly InboxKind[] = inboxKinds;

export const verbLabels = {
  review: { apply: "inbox.verbs.apply", dismiss: "inbox.verbs.dismiss" },
  contradiction: { apply: "inbox.verbs.keep", dismiss: "inbox.verbs.remove" },
  withdrawn: { apply: "inbox.verbs.keep", dismiss: "inbox.verbs.remove" },
  quarantined: { retry: "inbox.verbs.retry", dismiss: "inbox.verbs.dismiss" },
  duplicate: { dismiss: "inbox.verbs.notDuplicate" },
  obsidian_conflict: {},
  budget: { apply: "inbox.verbs.continue", dismiss: "inbox.verbs.dismiss" },
  backlog: { apply: "inbox.verbs.rematch", dismiss: "inbox.verbs.dismiss" }
} as const satisfies Record<InboxKind, Partial<Record<InboxVerb, MessageKey>>>;

/** The label of a verb on an item of a kind. */
export function verbLabel(t: Translator, kind: InboxKind, verb: InboxVerb): string {
  const labels: Partial<Record<InboxVerb, MessageKey>> = verbLabels[kind];
  return t(labels[verb] ?? "inbox.verbs.dismiss");
}

/** The key that carries each verb out, as it is shown. */
export const verbKeys: Readonly<Record<InboxVerb, string>> = {
  apply: "A",
  dismiss: "X",
  retry: "R"
};

export function objectName(t: Translator, object: InboxObject): string {
  if (object.title !== null && object.title.trim() !== "") return object.title;
  return object.kind === "topic" ? t("topics.page.unnamed") : t("inbox.detail.unnamed");
}

function namesOf(t: Translator, item: InboxItem): { first: string; second: string } {
  return {
    first: item.objects[0] ? objectName(t, item.objects[0]) : t("inbox.detail.unnamed"),
    second: item.objects[1] ? objectName(t, item.objects[1]) : t("inbox.detail.unnamed")
  };
}

const text = (value: unknown): string => (typeof value === "string" ? value : "");
const finite = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

// ---------------------------------------------------------------------------
// Sentences

const quarantineTasks = {
  place: "inbox.items.quarantined.task.place",
  rebalance: "inbox.items.quarantined.task.rebalance",
  audit: "inbox.items.quarantined.task.audit",
  match: "inbox.items.quarantined.task.match",
  refresh: "inbox.items.quarantined.task.refresh",
  derived: "inbox.items.quarantined.task.derived",
  other: "inbox.items.quarantined.task.other"
} as const satisfies Record<string, MessageKey>;

const quarantineReasons = {
  invalid_output: "inbox.items.quarantined.reasons.invalidOutput",
  call_failed: "inbox.items.quarantined.reasons.callFailed",
  invalid: "inbox.items.quarantined.reasons.invalid"
} as const satisfies Record<string, MessageKey>;

const known = <T extends Record<string, MessageKey>>(table: T, key: unknown): T[keyof T] | null =>
  typeof key === "string" && Object.hasOwn(table, key) ? (table[key] as T[keyof T]) : null;

/** Why a quarantined task failed, as a clause ("the model's answer could not be used"). */
export function quarantineReason(t: Translator, errorClass: unknown): string {
  return t(known(quarantineReasons, errorClass) ?? "inbox.items.quarantined.reasons.unknown");
}

const reviewVariants = {
  topic: "inbox.items.review.variant.topic",
  relation: "inbox.items.review.variant.relation",
  overview: "inbox.items.review.variant.overview"
} as const satisfies Record<string, MessageKey>;

/** What a review item is about, as a short label ("Topic overview"). */
export function reviewVariantLabel(t: Translator, variant: string): string | null {
  const key = known(reviewVariants, variant);
  return key ? t(key) : null;
}

/** The headline of an item. */
export function itemTitle(t: Translator, item: InboxItem): string {
  switch (item.kind) {
    case "review":
      return item.changeSet
        ? changeSetTitle(t, item.changeSet, "inbox.items.review.title")
        : t("inbox.items.review.title");
    case "quarantined":
      return t("inbox.items.quarantined.title", {
        values: {
          task: t(known(quarantineTasks, item.variant) ?? "inbox.items.quarantined.task.other")
        }
      });
    case "contradiction":
      return t("inbox.items.contradiction.title");
    case "withdrawn":
      return t("inbox.items.withdrawn.title");
    case "duplicate":
      return t("inbox.items.duplicate.title");
    case "obsidian_conflict":
      return t("inbox.items.obsidianConflict.title");
    case "budget":
      return t(
        item.variant === "money_100"
          ? "inbox.items.budget.title.money100"
          : "inbox.items.budget.title.money80"
      );
    case "backlog":
      return t(
        settingsBacklog(item) ? "inbox.items.backlog.titleSettings" : "inbox.items.backlog.title"
      );
  }
}

/** A MATCH backlog offered because the matching values changed (F4 Q4, T98), not the decider. */
const settingsBacklog = (item: InboxItem): boolean =>
  item.variant === "match" && item.params.reason === "settings_changed";

function money(t: Translator, value: unknown): string {
  return new Intl.NumberFormat(t.locale, { style: "currency", currency: "USD" }).format(
    finite(value)
  );
}

/** The sentence under the headline: what it is and what the person can do. */
export function itemBody(t: Translator, item: InboxItem): string {
  const { first, second } = namesOf(t, item);
  switch (item.kind) {
    case "review":
      return t("inbox.items.review.body");
    case "quarantined": {
      const reason = t("inbox.items.quarantined.reason", {
        values: { reason: quarantineReason(t, item.params.errorClass) }
      });
      return `${t("inbox.items.quarantined.body")} ${reason}`;
    }
    case "contradiction":
      return t("inbox.items.contradiction.body", { values: { first, second } });
    case "withdrawn":
      return t(
        item.variant === "explainer"
          ? "inbox.items.withdrawn.body.explainer"
          : item.variant === "typer"
            ? "inbox.items.withdrawn.body.typer"
            : "inbox.items.withdrawn.body.unknown",
        { values: { first, second } }
      );
    case "duplicate":
      return t(
        item.variant === "vector"
          ? "inbox.items.duplicate.body.vector"
          : item.variant === "title"
            ? "inbox.items.duplicate.body.title"
            : "inbox.items.duplicate.body.both",
        { values: { first, second } }
      );
    case "obsidian_conflict":
      return t(
        item.variant === "deleted"
          ? "inbox.items.obsidianConflict.body.deleted"
          : item.variant === "projection"
            ? "inbox.items.obsidianConflict.body.projection"
            : "inbox.items.obsidianConflict.body.editorial",
        { values: { path: text(item.params.path) } }
      );
    case "budget":
      return t("inbox.items.budget.body", {
        values: { spent: money(t, item.params.spentUsd), cap: money(t, item.params.capUsd) }
      });
    case "backlog": {
      const numbers = new Intl.NumberFormat(t.locale);
      if (settingsBacklog(item))
        return t("inbox.items.backlog.bodySettings", {
          values: {
            notes: numbers.format(finite(item.params.notes)),
            pairs: numbers.format(finite(item.params.pairs))
          }
        });
      return item.variant === "match"
        ? t("inbox.items.backlog.body", {
            values: { count: numbers.format(finite(item.params.notes)) }
          })
        : t("inbox.items.backlog.bodyOther");
    }
  }
}

/** A further line some kinds carry (what a dismissal does, where a conflict is solved). */
export function itemHint(t: Translator, item: InboxItem): string | null {
  switch (item.kind) {
    case "duplicate":
      return t("inbox.items.duplicate.hint");
    case "obsidian_conflict":
      return t("inbox.items.obsidianConflict.where");
    case "budget":
      return t(
        item.variant === "money_100"
          ? "inbox.items.budget.hint.money100"
          : "inbox.items.budget.hint.money80"
      );
    default:
      return null;
  }
}

/** A short second line for the list: the objects it names, or what kind of change it is. */
export function itemSubject(t: Translator, item: InboxItem): string {
  if (item.kind === "obsidian_conflict") return text(item.params.path);
  if (item.objects.length > 0)
    return item.objects.map((object) => `“${objectName(t, object)}”`).join(" · ");
  if (item.kind === "review")
    return reviewVariantLabel(t, item.variant) ?? t(kindLabels[item.kind]);
  return t(kindLabels[item.kind]);
}

// ---------------------------------------------------------------------------
// Time

const units: ReadonlyArray<readonly [Intl.RelativeTimeFormatUnit, number]> = [
  ["month", 30 * 24 * 3_600_000],
  ["day", 24 * 3_600_000],
  ["hour", 3_600_000],
  ["minute", 60_000]
];

/** How long ago an item arose ("3 hours ago"); "just now" within the minute. */
export function ageText(t: Translator, at: string, now: number): string {
  const elapsed = Math.max(0, now - Date.parse(at));
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return t("inbox.age.now");
  const [unit, size] = units.find(([, size]) => elapsed >= size) ?? units[units.length - 1]!;
  return new Intl.RelativeTimeFormat(t.locale, { numeric: "auto" }).format(
    -Math.floor(elapsed / size),
    unit
  );
}
