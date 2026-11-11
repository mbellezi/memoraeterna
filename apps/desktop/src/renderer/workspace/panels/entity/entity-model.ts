import { formatObjectAddress, type ObjectRef } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type { EntityMention, EntityPage } from "../../../../shared/ipc-entities";

/**
 * The rules of the Entity panel (design record §6.5), apart from the screen: how the mentions of
 * `entities.page` group under their topics, which sources they name, which names and topics the
 * header lists, and which of the four states the page is in. Pure, so each rule has a test.
 */

/** The stored kinds of entity that have a word of their own (`knowledge.graph.entityTypes`). */
const knownTypes: readonly string[] = [
  "Collection",
  "Concept",
  "Event",
  "FieldOfStudy",
  "Organization",
  "Person",
  "Place",
  "Product",
  "Project",
  "Publication",
  "Publisher",
  "Tag",
  "Work"
];

/** The kind of entity in the person's words; a kind with no word of its own is shown as stored. */
export function entityTypeLabel(t: Translator, type: string): string {
  return knownTypes.includes(type) ? t(`knowledge.graph.entityTypes.${type}` as MessageKey) : type;
}

/** One topic's run of mentions. `topicId` is null for the notes that are not placed anywhere. */
export interface MentionGroup {
  key: string;
  topicId: string | null;
  /** Empty when the topic is not named yet or the notes are not placed: the view writes the label. */
  title: string;
  /** The mentions of this topic that are loaded so far. */
  notes: EntityMention[];
  /** How many of the entity's notes the topic holds (the repository's count; 0 when not placed). */
  total: number;
}

const unplacedKey = "unplaced";

/**
 * The mentions grouped by the topic where each note is primarily placed, in the order the
 * repository lists them (the densest topic first, a topic with no name first among equals, the
 * notes that are not placed last). A page boundary can fall inside a group, so a group is built
 * from every loaded item with its topic id, and it stays one group.
 */
export function groupMentions(items: readonly EntityMention[]): MentionGroup[] {
  const groups = new Map<string, MentionGroup>();
  for (const item of items) {
    const key = item.topicId ?? unplacedKey;
    const group = groups.get(key);
    if (group) group.notes.push(item);
    else
      groups.set(key, {
        key,
        topicId: item.topicId,
        title: item.topicTitle,
        notes: [item],
        total: item.topicId === null ? 0 : item.topicNotes
      });
  }
  return [...groups.values()];
}

/** A source named by a loaded mention. */
export interface MentionSource {
  id: string;
  title: string;
}

/** The distinct sources of the loaded mentions, in the order they first appear. */
export function sourcesOf(items: readonly EntityMention[]): MentionSource[] {
  const sources = new Map<string, MentionSource>();
  for (const item of items)
    if (item.sourceId !== null && item.sourceTitle !== null && !sources.has(item.sourceId))
      sources.set(item.sourceId, { id: item.sourceId, title: item.sourceTitle });
  return [...sources.values()];
}

/**
 * The page with the mentions of the page that follows it added. A cursor read that overlaps what is
 * loaded (a note that moved between two reads) does not list a note twice; the topics and the
 * co-mentioned entities stay those of the first page.
 */
export function appendMentions(page: EntityPage, next: EntityPage): EntityPage {
  const seen = new Set(page.mentions.items.map((item) => item.noteId));
  const items = [
    ...page.mentions.items,
    ...next.mentions.items.filter((item) => !seen.has(item.noteId))
  ];
  const mentions =
    next.mentions.next === undefined ? { items } : { items, next: next.mentions.next };
  return { ...page, counts: next.counts, mentions };
}

/** How many mentions are not loaded yet. */
export function remainingMentions(page: EntityPage): number {
  return Math.max(0, page.counts.notes - page.mentions.items.length);
}

/**
 * Whether the sources list names fewer sources than the entity has: the page carries no list of its
 * own, so Fontes is built from the loaded mentions and says so until they are all loaded.
 */
export function sourcesArePartial(page: EntityPage): boolean {
  return (
    page.mentions.next !== undefined && sourcesOf(page.mentions.items).length < page.counts.sources
  );
}

/** The names of the entity other than its own, each once, in stored order. */
export function otherNames(entity: EntityPage["entity"]): string[] {
  const seen = new Set<string>([entity.canonicalName.trim().toLowerCase()]);
  const names: string[] = [];
  for (const alias of entity.aliases) {
    const name = alias.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

/** A topic the entity appears in. */
export interface TopicChip {
  id: string;
  title: string;
  /** The topic that holds most of the entity's notes. */
  densest: boolean;
}

/**
 * The topics of the entity: the one that holds most of its notes first, then the others. The
 * densest topic is the last of the primary path; a path that is only the tree's untitled root is
 * no topic at all.
 */
export function topicChips(topics: EntityPage["topics"]): TopicChip[] {
  if (!topics) return [];
  const last: ObjectRef | undefined = topics.primary[topics.primary.length - 1];
  const densest =
    last && last.kind === "topic" && !(topics.primary.length === 1 && last.title === "")
      ? last
      : null;
  const chips: TopicChip[] = densest
    ? [{ id: densest.id, title: densest.title, densest: true }]
    : [];
  for (const topic of topics.alsoIn)
    if (!chips.some((chip) => chip.id === topic.id))
      chips.push({ id: topic.id, title: topic.title, densest: false });
  return chips;
}

/** Topics the entity is also in that the chips do not list. */
export function hiddenTopicCount(topics: EntityPage["topics"]): number {
  return topics ? Math.max(0, topics.alsoInCount - topics.alsoIn.length) : 0;
}

/** The load state of the panel's page. */
export type EntityLoad =
  | { status: "loading" }
  | { status: "error" }
  | { status: "missing" }
  | { status: "ready"; page: EntityPage; more: "idle" | "loading" | "error" };

/** What the panel's frame is told: the page's state in the four words of the contract. */
export function reportedState(load: EntityLoad): "loading" | "empty" | "error" | "success" {
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  if (load.status === "missing") return "empty";
  return load.page.counts.notes === 0 && load.page.mentions.items.length === 0
    ? "empty"
    : "success";
}

/** The address of an object a row opens. */
export const addressOf = (kind: "note" | "source" | "topic" | "entity", id: string): string =>
  formatObjectAddress({ kind, id });
