import { topicReadLimits, type TopicShapeNode } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { TopicHistorySeries } from "../../../../../shared/ipc-topics-history";

/**
 * The growth column of Map > Shape (F5 D20): the notes that arrived in a topic over the last days.
 * `topics.history` answers per topic with its direct arrivals only (an arrival is an item's first
 * settled primary placement, or a move into the topic), at most 200 topics a request; a parent's
 * growth is the sum over its subtree, which is computed here. Days are the person's local days.
 */

/** The window of the "7 dias" column and of the inspector's line. */
export const growthDays = 7;

/** The topic ids to ask for, in requests of at most `historyTopicsMax`. */
export function growthRequests(nodes: readonly TopicShapeNode[]): string[][] {
  const ids = [...new Set(nodes.map((node) => node.id))];
  const requests: string[][] = [];
  for (let at = 0; at < ids.length; at += topicReadLimits.historyTopicsMax)
    requests.push(ids.slice(at, at + topicReadLimits.historyTopicsMax));
  return requests;
}

/**
 * Notes that arrived in each topic and everything under it. A topic whose series was not read
 * counts as no arrivals of its own; its descendants still add up under it.
 */
export function subtreeGrowth(
  nodes: readonly TopicShapeNode[],
  series: readonly TopicHistorySeries[]
): Map<string, number> {
  const own = new Map<string, number>();
  for (const entry of series)
    own.set(
      entry.topicId,
      entry.daily.reduce((sum, day) => sum + day.arrivals, 0)
    );
  const below = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = below.get(node.parentId);
    if (list) list.push(node.id);
    else below.set(node.parentId, [node.id]);
  }
  const total = new Map<string, number>();
  const visiting = new Set<string>();
  const sum = (id: string): number => {
    const known = total.get(id);
    if (known !== undefined) return known;
    // A topic listed below itself (an inconsistent read) is counted once.
    if (visiting.has(id)) return 0;
    visiting.add(id);
    let value = own.get(id) ?? 0;
    for (const child of below.get(id) ?? []) value += sum(child);
    visiting.delete(id);
    total.set(id, value);
    return value;
  };
  for (const node of nodes) sum(node.id);
  return total;
}

/** "+8" for growth, "0" for none, "—" when the history was not read. */
export function growthText(t: Translator, growth: number | undefined): string {
  if (growth === undefined) return "—";
  const shown = new Intl.NumberFormat(t.locale).format(growth);
  return growth > 0 ? `+${shown}` : shown;
}
