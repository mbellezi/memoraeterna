import type { ChangeSetSummary } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

/**
 * The titles a change-set can carry, as the stores write them (`titleKey` is stored text, so it is
 * looked up in this closed table and never used as a key itself). Every entry is a typed message
 * key: a key the table does not know reads as the plain "a change was made" sentence.
 */
const titleMessages = {
  "topics.changeSets.place": "topics.changeSets.place",
  "topics.changeSets.build": "topics.changeSets.build",
  "topics.changeSets.rebuild": "topics.changeSets.rebuild",
  "topics.changeSets.space": "topics.changeSets.space",
  "topics.changeSets.rebalance": "topics.changeSets.rebalance",
  "topics.changeSets.proposal": "topics.changeSets.proposal",
  "topics.changeSets.redirects": "topics.changeSets.redirects",
  "topics.changeSets.naming": "topics.changeSets.naming",
  "topics.changeSets.humanRename": "topics.changeSets.humanRename",
  "topics.changeSets.humanMove": "topics.changeSets.humanMove",
  "topics.changeSets.humanCreate": "topics.changeSets.humanCreate",
  "topics.changeSets.humanPin": "topics.changeSets.humanPin",
  "topics.changeSets.humanUnpin": "topics.changeSets.humanUnpin",
  "topics.changeSets.humanPlace": "topics.changeSets.humanPlace",
  "topics.changeSets.gate": "topics.changeSets.gate",
  "changes.titles.relation.match": "changes.titles.relation.match",
  "changes.titles.relation.link": "changes.titles.relation.link",
  "changes.titles.relation.type": "changes.titles.relation.type",
  "changes.titles.relation.promote": "changes.titles.relation.promote",
  "changes.titles.relation.discover": "changes.titles.relation.discover",
  "changes.titles.relation.reconcile": "changes.titles.relation.reconcile",
  "changes.titles.relation.retype": "changes.titles.relation.retype",
  "changes.titles.relationMatched": "changes.titles.relationMatched",
  "changes.titles.relationSuggested": "changes.titles.relationSuggested",
  "changes.titles.overview.write": "changes.titles.overview.write",
  "changes.titles.overview.patch": "changes.titles.overview.patch",
  "changes.titles.overview.rewrite": "changes.titles.overview.rewrite",
  "changes.titles.overview.undo": "changes.titles.overview.undo"
} as const satisfies Record<string, MessageKey>;

type TitleKey = keyof typeof titleMessages;

const isTitleKey = (value: string): value is TitleKey => Object.hasOwn(titleMessages, value);

/** The parameters a message names, as `{name}` tokens. */
const parameterTokens = /\{([A-Za-z0-9_.-]+)\}/gu;

/**
 * The sentence of one change-set ("Placed 12 items in topics"): its stored key looked up in the
 * closed table, its parameters formatted for the locale (numbers) or kept as stored (names). A key
 * the table does not know, or a title with a parameter missing, reads as a plain change.
 */
export function changeSetTitle(
  t: Translator,
  change: Pick<ChangeSetSummary, "titleKey" | "titleParams">
): string {
  if (!isTitleKey(change.titleKey)) return t("activity.done.unknownChange");
  const numbers = new Intl.NumberFormat(t.locale);
  const values: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(change.titleParams)) {
    if (typeof value === "number") values[name] = numbers.format(value);
    else if (typeof value === "string") values[name] = value;
  }
  const key = titleMessages[change.titleKey];
  // A title whose parameters were not all stored would show a bare `{name}`: it reads as a plain change.
  const needed = [...t(key).matchAll(parameterTokens)].map((match) => match[1]!);
  if (needed.some((name) => !Object.hasOwn(values, name))) return t("activity.done.unknownChange");
  return t(key, { values });
}
