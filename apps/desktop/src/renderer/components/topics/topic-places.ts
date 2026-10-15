import type { TopicPath, TopicPathInput, TopicTree, TopicTreeInput } from "@app/domain";
import type { ViewHistoryEntry, ViewHistoryListInput } from "../../../shared/view-history";
import { recentOpenTarget } from "../../lib/view-history";
import type { PlaceEntry } from "./topic-navigation";

/**
 * Pinned and Recents (docs spec 3.8): the view history, with each topic entry resolved against the
 * live tree. A retired topic leads to its successor, a topic that no longer exists is dropped, and
 * a topic shows its item count and health. Notes and sources open in the Library as before.
 */

/** Recent (unpinned) entries shown; every pin is shown besides them. */
export const recentsShown = 5;
/** Recent entries asked for, so dropping the ones that cannot be opened still leaves enough. */
export const recentsAsked = 10;

/** The kinds the navigator lists. */
export const placeKinds = ["topic", "note", "source"] as const;

export interface PlacesApi {
  history(input: ViewHistoryListInput): Promise<ViewHistoryEntry[]>;
  path(input: TopicPathInput): Promise<TopicPath | null>;
  tree(input: TopicTreeInput): Promise<TopicTree | null>;
}

export interface ResolvedTopic {
  id: string;
  title: string | null;
  count: number;
  health: PlaceEntry["health"];
  management: PlaceEntry["management"];
}

/** Resolves one topic ID to the live topic it stands for; null when there is none. */
export async function resolveTopic(api: PlacesApi, id: string): Promise<ResolvedTopic | null> {
  const path = await api.path({ id });
  if (!path) return null;
  const tree = await api.tree({
    parentId: path.resolvedId,
    limit: 1,
    includeItems: false,
    itemLimit: 0
  });
  if (!tree) return null;
  const { parent } = tree;
  return {
    id: parent.id,
    title: parent.title,
    count: parent.items,
    health: parent.health,
    management: parent.management
  };
}

export interface Places {
  pinned: PlaceEntry[];
  recents: PlaceEntry[];
}

/**
 * Builds both lists from the history. `resolved` caches topic answers between calls (a null answer
 * is a topic that is gone); a topic that cannot be read right now keeps its stored title and shows
 * no count rather than disappearing.
 */
export async function loadPlaces(
  api: PlacesApi,
  resolved: Map<string, ResolvedTopic | null>
): Promise<Places> {
  const entries = await api.history({ limit: recentsAsked, kinds: [...placeKinds] });
  const topicIds = [
    ...new Set(entries.filter((entry) => entry.kind === "topic").map((entry) => entry.id))
  ].filter((id) => !resolved.has(id));
  const failed = new Set<string>();
  await Promise.all(
    topicIds.map(async (id) => {
      try {
        resolved.set(id, await resolveTopic(api, id));
      } catch {
        failed.add(id);
      }
    })
  );
  return placesFromEntries(entries, resolved, failed);
}

/** Pure part of {@link loadPlaces}: the entries, in order, with their resolved topics. */
export function placesFromEntries(
  entries: readonly ViewHistoryEntry[],
  resolved: ReadonlyMap<string, ResolvedTopic | null>,
  unreadable: ReadonlySet<string> = new Set()
): Places {
  // A pin and a recent entry for the same object, or two retired topics that merged into one,
  // list once, in the place of the first, and pinned if any of them was.
  const byIdentity = new Map<string, PlaceEntry>();
  for (const entry of entries) {
    const place = placeOf(entry, resolved, unreadable);
    if (!place) continue;
    const identity = `${place.kind}:${place.id}`;
    const known = byIdentity.get(identity);
    if (known) known.pinned = known.pinned || place.pinned;
    else byIdentity.set(identity, place);
  }
  const pinned: PlaceEntry[] = [];
  const recents: PlaceEntry[] = [];
  for (const place of byIdentity.values()) (place.pinned ? pinned : recents).push(place);
  return { pinned, recents: recents.slice(0, recentsShown) };
}

function placeOf(
  entry: ViewHistoryEntry,
  resolved: ReadonlyMap<string, ResolvedTopic | null>,
  unreadable: ReadonlySet<string>
): PlaceEntry | null {
  if (entry.kind === "topic") {
    if (unreadable.has(entry.id)) {
      return {
        address: entry.address,
        kind: "topic",
        id: entry.id,
        title: entry.title,
        pinned: entry.pinned,
        count: null,
        health: null,
        management: null,
        source: null
      };
    }
    const topic = resolved.get(entry.id);
    if (!topic) return null;
    return {
      address: `memora://topic/${topic.id}`,
      kind: "topic",
      id: topic.id,
      title: topic.title,
      pinned: entry.pinned,
      count: topic.count,
      health: topic.health,
      management: topic.management,
      source: null
    };
  }
  if (entry.kind !== "note" && entry.kind !== "source") return null;
  const target = recentOpenTarget(entry);
  if (!target) return null;
  return {
    address: entry.address,
    kind: entry.kind,
    id: entry.id,
    title: entry.title,
    pinned: entry.pinned,
    count: null,
    health: null,
    management: null,
    source: target
  };
}
