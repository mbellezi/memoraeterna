import type { NavigationDirection } from "../../lib/window-navigation";

/**
 * What the Wiki's reading surface shows, as a history that Back and Forward follow while the Wiki
 * is on screen: a topic by ID, or where to start (`null`). It lives in memory beside the Wiki; the
 * Library keeps its own history, so moving in one never moves the other.
 */
export interface WikiTopicHistory {
  readonly entries: readonly (string | null)[];
  readonly index: number;
}

/** Entries kept; the oldest ones go first. */
export const wikiTopicHistoryMax = 50;

/** A Wiki that shows where to start and has nowhere to go back to. */
export const startWikiTopicHistory: WikiTopicHistory = Object.freeze({
  entries: Object.freeze([null]),
  index: 0
});

/** The topic the reading surface shows; `null` shows where to start. */
export function currentWikiTopic(history: WikiTopicHistory): string | null {
  return history.entries[history.index] ?? null;
}

/**
 * Shows a topic (or, for `null`, where to start) after the current entry, dropping the entries
 * Forward would have reached. Showing what is already shown changes nothing, so a second click on
 * the open topic adds no step to go back through.
 */
export function showInWiki(history: WikiTopicHistory, topicId: string | null): WikiTopicHistory {
  if (currentWikiTopic(history) === topicId) return history;
  const entries = [...history.entries.slice(0, history.index + 1), topicId].slice(
    -wikiTopicHistoryMax
  );
  return { entries, index: entries.length - 1 };
}

/** One step back or forward; `null` when there is nothing that way, so the step is left to others. */
export function stepWikiTopicHistory(
  history: WikiTopicHistory,
  direction: NavigationDirection
): WikiTopicHistory | null {
  const index = history.index + (direction === "back" ? -1 : 1);
  if (index < 0 || index >= history.entries.length) return null;
  return { entries: history.entries, index };
}

/**
 * Back or Forward of the window (menu, shortcut or mouse button): the Wiki takes the step only
 * while it is the view on screen and has somewhere to go. `null` leaves the step to the other
 * listeners; a hidden Wiki ignores history events.
 */
export function wikiNavigationStep(
  wikiShown: boolean,
  history: WikiTopicHistory,
  direction: NavigationDirection
): WikiTopicHistory | null {
  return wikiShown ? stepWikiTopicHistory(history, direction) : null;
}
