import { Fragment, type ReactNode } from "react";
import type { MessageKey, Translator } from "@app/i18n";

import { pluralForm, whenParts } from "./home-model";

/** The count words Home uses: one message pair per noun, `One` and `Other` by the locale's plural rule. */
const countKeys = {
  sources: ["home.counts.sourcesOne", "home.counts.sourcesOther"],
  notes: ["home.counts.notesOne", "home.counts.notesOther"],
  newNotes: ["home.counts.newNotesOne", "home.counts.newNotesOther"],
  changes: ["home.counts.changesOne", "home.counts.changesOther"],
  decisions: ["home.counts.decisionsOne", "home.counts.decisionsOther"],
  items: ["home.counts.itemsOne", "home.counts.itemsOther"],
  topics: ["home.counts.topicsOne", "home.counts.topicsOther"],
  levels: ["home.counts.levelsOne", "home.counts.levelsOther"],
  weekNotes: ["home.counts.weekNotesOne", "home.counts.weekNotesOther"]
} as const satisfies Record<string, readonly [MessageKey, MessageKey]>;

export type CountNoun = keyof typeof countKeys;

/** "3 fontes": the number bound to its noun by a no-break space, formatted for the locale. */
export function countText(t: Translator, noun: CountNoun, count: number): string {
  const [one, other] = countKeys[noun];
  return t(pluralForm(t.locale, count) === "One" ? one : other, {
    values: { count: new Intl.NumberFormat(t.locale).format(count) }
  });
}

/** Picks the `One` or the `Other` message of a pair for `count`. */
export function pluralKey<One extends MessageKey, Other extends MessageKey>(
  locale: string,
  count: number,
  one: One,
  other: Other
): One | Other {
  return pluralForm(locale, count) === "One" ? one : other;
}

/** "09:12" today, "ontem, 22:38" yesterday, "3 nov, 18:20" before. */
export function whenText(t: Translator, at: string | Date, now: number): string {
  const { day, time } = whenParts(t.locale, new Date(at), new Date(now));
  return day === null ? time : `${day}, ${time}`;
}

/** The text of a message with `{name}` slots, the slots filled with nodes (a link, a count in bold). */
export function slotted(text: string, slots: Readonly<Record<string, ReactNode>>): ReactNode[] {
  return text.split(/(\{[A-Za-z]+\})/u).map((part, index) => {
    const name = /^\{([A-Za-z]+)\}$/u.exec(part)?.[1];
    return name !== undefined && name in slots ? (
      <Fragment key={index}>{slots[name]}</Fragment>
    ) : (
      part
    );
  });
}

/** Values that leave their own `{name}` in the text, so `slotted` can find the slot. */
export const slotValues = (...names: string[]): Record<string, string> =>
  Object.fromEntries(names.map((name) => [name, `{${name}}`]));
