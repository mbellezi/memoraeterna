import type {
  TopicHealth,
  TopicItemLeaf,
  TopicLastChange,
  TopicNoteLeaf,
  TopicPage,
  TopicPathEntry,
  TopicRelationStances,
  TopicsChangedEvent
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { isSilentRefresh, type LoadOutcome } from "../../lib/hidden-view";
import { relationTypeView, type Stance } from "../../lib/relation-stance";
import type { OpenedObject } from "../../lib/view-history";

/**
 * The decisions of the Topic page that need no renderer: what it calls things, how it counts,
 * when it reads again and what its banner says. The container wraps them in state; the views only
 * show the result.
 */

/** Where a click on the page leads; the host decides how each target opens. */
export interface TopicPageActions {
  openTopic(topicId: string): void;
  /** A note, located first (it opens in its source). */
  openNote(noteId: string): void;
  /** A source, located first (it opens at its place in the Library). */
  openSource(sourceId: string): void;
}

/** A topic as the person reads it: its name, "All topics" for the root, "Unnamed topic" otherwise. */
export function topicTitle(t: Translator, topic: { title: string | null }, root: boolean): string {
  if (topic.title !== null) return topic.title;
  return root ? t("topics.page.rootTitle") : t("topics.page.unnamed");
}

export interface Crumb {
  id: string;
  label: string;
  current: boolean;
}

/** The path from the root; the first entry is the root and the last one is the page itself. */
export function breadcrumb(t: Translator, path: readonly TopicPathEntry[]): Crumb[] {
  return path.map((entry, index) => ({
    id: entry.id,
    label: topicTitle(t, entry, index === 0),
    current: index === path.length - 1
  }));
}

export function isRootPage(page: Pick<TopicPage, "topic">): boolean {
  return page.topic.parentId === null;
}

export type CountNoun = "notes" | "sources" | "subtopics" | "items" | "relations";

const countKeys = {
  notes: ["topics.page.counts.notesOne", "topics.page.counts.notes"],
  sources: ["topics.page.counts.sourcesOne", "topics.page.counts.sources"],
  subtopics: ["topics.page.counts.subtopicsOne", "topics.page.counts.subtopics"],
  items: ["topics.page.counts.itemsOne", "topics.page.counts.items"],
  relations: ["topics.page.counts.relationsOne", "topics.page.counts.relations"]
} as const satisfies Record<CountNoun, readonly [MessageKey, MessageKey]>;

/** "1 note", "23 notes": the singular has its own message, the plural carries the number. */
export function countLabel(t: Translator, noun: CountNoun, count: number): string {
  const [one, other] = countKeys[noun];
  return count === 1
    ? t(one)
    : t(other, { values: { count: new Intl.NumberFormat(t.locale).format(count) } });
}

/** The same message with a count that is not a noun of the page (the number of more subtopics). */
export function moreSubtopicsLabel(t: Translator, count: number): string {
  return count === 1
    ? t("topics.page.map.moreSubtopicsOne")
    : t("topics.page.map.moreSubtopics", {
        values: { count: new Intl.NumberFormat(t.locale).format(count) }
      });
}

export type HealthTone = "success" | "warning" | "danger";

/** Health is a word and a glyph as well as a colour: the view picks the glyph from the tone. */
export const healthViews = {
  good: { key: "topics.page.health.good", tone: "success" },
  attention: { key: "topics.page.health.attention", tone: "warning" },
  violation: { key: "topics.page.health.violation", tone: "danger" }
} as const satisfies Record<TopicHealth, { key: MessageKey; tone: HealthTone }>;

export interface StanceRow {
  type: string;
  stance: Stance;
  wordKey: MessageKey;
  count: number;
}

/**
 * The relations of the topic's notes by type: legend order of the stance first, then the larger
 * count. Types without relations are left out.
 */
export function stanceRows(stances: TopicRelationStances): StanceRow[] {
  return Object.entries(stances)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => ({ type, count, view: relationTypeView(type) }))
    .sort(
      (a, b) => a.view.order - b.view.order || b.count - a.count || a.type.localeCompare(b.type)
    )
    .map(({ type, count, view }) => ({
      type,
      stance: view.stance,
      wordKey: view.wordKey,
      count
    }));
}

/** The line under a central note: its source, or that the person wrote it. */
export function noteSourceLine(
  t: Translator,
  note: { sourceTitle: string | null; provenance: "ai" | "human" }
): string | null {
  if (note.sourceTitle) return note.sourceTitle;
  return note.provenance === "human" ? t("topics.page.map.writtenByYou") : null;
}

export function relationsLabel(t: Translator, count: number): string {
  return count === 0 ? t("topics.page.map.noRelations") : countLabel(t, "relations", count);
}

// ---------------------------------------------------------------------------
// The banner of the last automatic change

const bannerKeys = {
  build: "topics.page.banner.changes.build",
  place: "topics.page.banner.changes.place",
  gate: "topics.page.banner.changes.gate",
  rebalance: "topics.page.banner.changes.rebalance",
  audit: "topics.page.banner.changes.audit",
  naming: "topics.page.banner.changes.naming",
  areas: "topics.page.banner.changes.areas",
  rebuild: "topics.page.banner.changes.rebuild",
  human: "topics.page.banner.changes.human",
  undo: "topics.page.banner.changes.undo",
  other: "topics.page.banner.changes.other"
} as const satisfies Record<string, MessageKey>;
type BannerOrigin = keyof typeof bannerKeys;

const changeTitlePrefix = "topics.changeSets.";

/** The origin a change-set title key names (`topics.changeSets.<origin>`); other keys read as `other`. */
export function bannerOrigin(titleKey: string): BannerOrigin {
  if (!titleKey.startsWith(changeTitlePrefix)) return "other";
  const origin = titleKey.slice(changeTitlePrefix.length);
  // `humanRename`, `humanMove`, ... are the person's own changes (T26).
  if (origin.startsWith("human")) return "human";
  return Object.hasOwn(bannerKeys, origin) ? (origin as BannerOrigin) : "other";
}

const dayMs = 86_400_000;
const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/** "Today, 13:41", "Yesterday, 18:02" or the full date and time. */
export function formatWhen(iso: string, now: Date, t: Translator): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const time = new Intl.DateTimeFormat(t.locale, { timeStyle: "short" }).format(at);
  const days = Math.round((startOfDay(now) - startOfDay(at)) / dayMs);
  if (days === 0) return t("topics.page.when.today", { values: { time } });
  if (days === 1) return t("topics.page.when.yesterday", { values: { time } });
  return new Intl.DateTimeFormat(t.locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}

/**
 * The sentence of the banner: a change that was not made by the person reads "Organized
 * automatically", with what it did when the change-set says so. A title this page does not know
 * still reads as an automatic change, never as the raw key.
 */
export function changeBannerText(change: TopicLastChange, now: Date, t: Translator): string {
  const when = formatWhen(change.at, now, t);
  const origin = bannerOrigin(change.titleKey);
  if (origin === "place") {
    const items = change.titleParams.items;
    if (typeof items === "number" && Number.isInteger(items) && items > 0)
      return items === 1
        ? t("topics.page.banner.changes.placeOne", { values: { when } })
        : t("topics.page.banner.changes.placeMany", {
            values: { when, count: new Intl.NumberFormat(t.locale).format(items) }
          });
  }
  return t(bannerKeys[origin], { values: { when } });
}

// ---------------------------------------------------------------------------
// Loading

export type TopicPageLoadDecision = "skip" | "silent" | "load";

/**
 * What a render does about loading: nothing while hidden or when the key already finished, a
 * refresh in place when the page is shown again after a successful load or reloads the topic it
 * already shows, otherwise a load with a loading state. Another topic always loads.
 */
export function topicPageLoadDecision(input: {
  active: boolean;
  wasHidden: boolean;
  outcome: LoadOutcome | null;
  key: string;
  topicChanged: boolean;
  showing: boolean;
}): TopicPageLoadDecision {
  if (!input.active) return "skip";
  if (input.topicChanged) return "load";
  if (isSilentRefresh(input.wasHidden, input.outcome, input.key)) return "silent";
  if (input.outcome?.key === input.key) return "skip";
  return input.showing ? "silent" : "load";
}

/** A refresh that found the same page changes nothing; the tree generation alone is not content. */
export function samePageContent(a: TopicPage, b: TopicPage): boolean {
  return JSON.stringify({ ...a, generation: 0 }) === JSON.stringify({ ...b, generation: 0 });
}

/**
 * Whether a pushed change can alter the page: a newer generation that lists a topic the page
 * shows (its path, its subtopics, its neighbours) or does not list its topics at all.
 */
export function eventTouchesPage(
  event: TopicsChangedEvent,
  page: TopicPage,
  seenGeneration: number
): boolean {
  if (event.generation <= seenGeneration) return false;
  if (event.topicIds === null) return true;
  const shown = new Set<string>([
    page.topic.id,
    ...page.path.map((entry) => entry.id),
    ...page.subtopics.map((subtopic) => subtopic.id),
    ...page.relatedTopics.map((topic) => topic.id)
  ]);
  return event.topicIds.some((id) => shown.has(id));
}

/** The topic as an entry of the view history (recents and the freeze of recently opened topics). */
export function topicPageOpenedObject(t: Translator, page: TopicPage): OpenedObject {
  return {
    kind: "topic",
    id: page.topic.id,
    title: topicTitle(t, page.topic, isRootPage(page))
  };
}

/** Appends a page of leaves to the list shown: notes only, and never the same note twice. */
export function mergeNoteLeaves(
  shown: readonly TopicNoteLeaf[],
  incoming: readonly TopicItemLeaf[]
): TopicNoteLeaf[] {
  const known = new Set(shown.map((note) => note.id));
  const added: TopicNoteLeaf[] = [];
  for (const leaf of incoming) {
    if (leaf.kind !== "note" || known.has(leaf.id)) continue;
    known.add(leaf.id);
    added.push(leaf);
  }
  return [...shown, ...added];
}

/** A cursor the read side no longer accepts: the list starts again from its first page. */
export function isStaleCursor(error: unknown): boolean {
  return String(error).includes("topics.errors.stale");
}

/**
 * The next text of the polite live region. It speaks only when its text changes, so the same
 * outcome twice in a row alternates a trailing no-break space and is announced again.
 */
export function nextAnnouncement(previous: string, text: string): string {
  return previous === text ? `${text}\u00a0` : text;
}
