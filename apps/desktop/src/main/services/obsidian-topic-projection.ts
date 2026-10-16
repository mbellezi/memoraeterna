import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { TopicProjectionRows, TopicProjectionTopic } from "@app/db";
import { formatObjectAddress } from "@app/domain";
import { translate, type MessageKey } from "@app/i18n";
import { markdownHeading, safeWikiLabel } from "@app/integration-contracts";

import { boundedWikiPath, pathIdentity, portableName } from "./obsidian-layout-paths.js";

/**
 * The topic tree's projection into the vault (F2 T33): every topic is a folder-note map of content,
 * `<Topics>/<Area>/<Topic>/<Topic>.md`, listing its subtopics, its notes by centrality and its
 * sources, with an "Up" link and a `memora://topic/<id>` link. Built from the canonical topic tables
 * without AI. Paths are planned once and then registered: a rename or a move changes the map and
 * its frontmatter `aliases`, never its path (a layout migration re-places files explicitly).
 *
 * Pure planning and rendering: the mirror and the first-generation plan supply where the topic
 * folder lives, which notes and sources the projection holds and how to link them.
 */
export const topicProjectionConfig = {
  /** Aliases written in one map's frontmatter (title, stored aliases, then redirected titles). */
  maxAliases: 20,
  /** Redirects followed from a retired topic to its live successor. */
  redirectHops: 8
} as const;

export interface PlannedTopic {
  topic: TopicProjectionTopic;
  /** The title the map shows: the topic's, or the localized root or unnamed label. */
  title: string;
  path: string;
}

export interface TopicPlanContext {
  /** The topics folder, e.g. `Memora/Topics`. */
  folder: string;
  /** The interface label of that folder's own map (the root topic). */
  rootFile: string;
  language: string;
  /** Whether the projection holds the whole library (every live topic gets a map). */
  wholeLibrary: boolean;
  /** Whether the projection writes this note or source (in scope and planned). */
  projected: (kind: "note" | "source", id: string) => boolean;
  /** Whether the topic has a registered file (an unnamed topic gets one only after its first name). */
  registered: (id: string) => boolean;
  /** Reserves a path for a target: its registered path, unless a migration re-places it. */
  reserve: (id: string, path: string) => string;
}

export interface TopicProjection {
  rows: TopicProjectionRows;
  /** Maps to write, parents first. */
  planned: PlannedTopic[];
  byId: Map<string, PlannedTopic>;
  topics: Map<string, TopicProjectionTopic>;
  children: Map<string, TopicProjectionTopic[]>;
  /** In-scope notes and sources placed directly on each topic, by centrality. */
  direct: Map<string, TopicProjectionRows["placements"]>;
  /** In-scope notes in each topic's subtree. */
  subtreeNotes: Map<string, number>;
  /** Titles of the retired topics whose redirects lead to each live topic. */
  redirectedTitles: Map<string, string[]>;
}

const unnamed = (language: string) => translate(language, "topics.unnamed");

/** The title a map shows. */
export function topicTitle(topic: TopicProjectionTopic, language: string): string {
  if (topic.role === "root") return translate(language, "topics.page.rootTitle");
  return topic.title ?? unnamed(language);
}

/** Plans which topics get a map and where, parents first. */
export function planTopicProjection(
  rows: TopicProjectionRows | null,
  context: TopicPlanContext
): TopicProjection | null {
  if (!rows) return null;
  const topics = new Map(rows.topics.map((topic) => [topic.id, topic]));
  const children = new Map<string, TopicProjectionTopic[]>();
  for (const topic of rows.topics) {
    if (!topic.parentId || !topics.has(topic.parentId)) continue;
    const siblings = children.get(topic.parentId) ?? [];
    siblings.push(topic);
    children.set(topic.parentId, siblings);
  }
  const direct = new Map<string, TopicProjectionRows["placements"]>();
  for (const placement of rows.placements) {
    if (!topics.has(placement.topicId) || !context.projected(placement.kind, placement.itemId))
      continue;
    const list = direct.get(placement.topicId) ?? [];
    list.push(placement);
    direct.set(placement.topicId, list);
  }
  // Parents first (breadth-first from the root), so a child's folder is known when it is placed.
  const order: TopicProjectionTopic[] = [];
  const root = topics.get(rows.rootId);
  if (!root) return null;
  const seen = new Set<string>([root.id]);
  for (let queue = [root]; queue.length;) {
    const next: TopicProjectionTopic[] = [];
    for (const topic of queue) {
      order.push(topic);
      for (const child of children.get(topic.id) ?? [])
        if (!seen.has(child.id)) {
          seen.add(child.id);
          next.push(child);
        }
    }
    queue = next;
  }
  // In-scope notes, and notes plus sources, in each subtree (children before their parents).
  const subtreeNotes = new Map<string, number>();
  const subtreeItems = new Map<string, number>();
  for (const topic of [...order].reverse()) {
    const own = direct.get(topic.id) ?? [];
    let notes = own.filter((p) => p.kind === "note").length;
    let items = own.length;
    for (const child of children.get(topic.id) ?? []) {
      notes += subtreeNotes.get(child.id) ?? 0;
      items += subtreeItems.get(child.id) ?? 0;
    }
    subtreeNotes.set(topic.id, notes);
    subtreeItems.set(topic.id, items);
  }

  const planned: PlannedTopic[] = [];
  const byId = new Map<string, PlannedTopic>();
  const folders = new Map<string, string>();
  const folderOf = (topic: TopicProjectionTopic): string => {
    for (let id = topic.parentId; id; id = topics.get(id)?.parentId ?? null) {
      const parent = byId.get(id);
      if (parent) return posix.dirname(parent.path);
    }
    return context.folder;
  };
  for (const topic of order) {
    const produced =
      topic.role === "root" ||
      context.registered(topic.id) ||
      (topic.nameState !== "unnamed" &&
        (context.wholeLibrary || (subtreeItems.get(topic.id) ?? 0) > 0));
    if (!produced) continue;
    const title = topicTitle(topic, context.language);
    let path: string;
    if (topic.role === "root") {
      path = posix.join(context.folder, context.rootFile + ".md");
    } else {
      const name = portableName(title);
      let directory = posix.join(folderOf(topic), name);
      // A folder belongs to one topic: two titles with the same portable name get two folders.
      const owner = folders.get(pathIdentity(directory));
      if (owner && owner !== topic.id) directory += " — " + topic.id.slice(0, 8);
      path = boundedWikiPath(
        posix.join(directory, name + ".md"),
        posix.join(context.folder, name + " — " + topic.id.slice(0, 8), name + ".md")
      );
    }
    path = context.reserve(topic.id, path);
    folders.set(pathIdentity(posix.dirname(path)), topic.id);
    const entry = { topic, title, path };
    planned.push(entry);
    byId.set(topic.id, entry);
  }

  // A retired topic's title becomes an alias of the live topic its redirects lead to.
  const redirects = new Map(rows.redirects.map((row) => [row.id, row]));
  const redirectedTitles = new Map<string, string[]>();
  for (const row of rows.redirects) {
    let target: string | null = row.redirectTo;
    for (let hop = 0; target && !topics.has(target); hop += 1) {
      if (hop >= topicProjectionConfig.redirectHops) target = null;
      else target = redirects.get(target)?.redirectTo ?? null;
    }
    if (!target) continue;
    const titles = redirectedTitles.get(target) ?? [];
    titles.push(row.title);
    redirectedTitles.set(target, titles);
  }
  return {
    rows,
    planned,
    byId,
    topics,
    children,
    direct,
    subtreeNotes,
    redirectedTitles
  };
}

/**
 * The aliases of a map: its current title when the file kept an older name, its stored aliases and
 * the titles of the topics merged into it. Never the file's own name, never twice, never a line the
 * frontmatter parser would take for a reserved field.
 */
export function topicAliases(projection: TopicProjection, planned: PlannedTopic): string[] {
  const stem = posix.basename(planned.path).replace(/\.md$/u, "");
  const key = (text: string) => text.normalize("NFC").toLocaleLowerCase("und");
  const seen = new Set([key(stem), key(stem.replace(/ — [0-9a-f]{8}$/u, ""))]);
  const aliases: string[] = [];
  const candidates = [
    ...(planned.topic.role === "root" ? [] : planned.topic.title ? [planned.topic.title] : []),
    ...planned.topic.aliases,
    ...[...(projection.redirectedTitles.get(planned.topic.id) ?? [])].sort()
  ];
  for (const raw of candidates) {
    const alias = raw.replace(/[\r\n\t]+/gu, " ").trim();
    if (!alias || /memora_[a-z_]+\s*["']?\s*:|<!--/iu.test(alias) || seen.has(key(alias))) continue;
    seen.add(key(alias));
    aliases.push(alias);
    if (aliases.length >= topicProjectionConfig.maxAliases) break;
  }
  return aliases;
}

/**
 * The managed `aliases` line of a map's frontmatter, in place of the one the projection wrote last
 * time; other user frontmatter is kept as it is.
 */
export function withTopicAliases(userFrontmatter: string, aliases: readonly string[]): string {
  const lines = userFrontmatter ? userFrontmatter.split("\n") : [];
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (/^aliases\s*:/u.test(lines[i]!)) {
      while (i + 1 < lines.length && /^(?:\s+|-\s)/u.test(lines[i + 1]!)) i += 1;
      continue;
    }
    kept.push(lines[i]!);
  }
  return [...(aliases.length ? [`aliases: ${JSON.stringify(aliases)}`] : []), ...kept].join("\n");
}

export interface TopicRenderContext {
  language: string;
  /** A link to a projected note, source or topic map (a vault link, or the app when absent). */
  link: (id: string, title: string, kind: "note" | "source") => string;
  /** The vault path of a planned target. */
  pathOf: (id: string) => string | undefined;
  titleOf: (kind: "note" | "source", id: string) => string;
  /** Where the root's "Up" link leads (the vault home or index), when there is one. */
  home?: { id: string; title: string };
}

export interface RenderedTopic {
  title: string;
  editorial: string;
  generated: string;
  revision: string;
  aliases: string[];
}

const topicLink = (context: TopicRenderContext, id: string, title: string) => {
  const path = context.pathOf(id);
  return path
    ? `[[${path.replace(/\.md$/iu, "").replace(/[[\]|#]/gu, (char) => `\\${char}`)}|${safeWikiLabel(title)}]]`
    : `[${safeWikiLabel(title)}](${formatObjectAddress({ kind: "topic", id })})`;
};

/** The map of content of one planned topic: generated navigation only, no AI and no prose. */
export function renderTopicMoc(
  projection: TopicProjection,
  planned: PlannedTopic,
  context: TopicRenderContext
): RenderedTopic {
  const t = (key: MessageKey, values?: Record<string, string | number>) =>
    translate(context.language, key, values ? { values } : {});
  const { topic } = planned;
  const count = (n: number) =>
    n === 1 ? t("topics.page.counts.notesOne") : t("topics.page.counts.notes", { count: n });
  const parent = topic.parentId ? projection.topics.get(topic.parentId) : undefined;
  const up = parent
    ? topicLink(context, parent.id, topicTitle(parent, context.language))
    : context.home && context.pathOf(context.home.id)
      ? topicLink(context, context.home.id, context.home.title)
      : "";
  const open = `[${safeWikiLabel(t("obsidianWiki.openApp"))}](${formatObjectAddress({ kind: "topic", id: topic.id })})`;
  const sections: string[] = [
    [up ? `${t("obsidianWiki.topicUp")}: ${up}` : "", open].filter(Boolean).join(" · ")
  ];
  if (topic.description) sections.push(safeWikiLabel(topic.description));
  const subtopics = (projection.children.get(topic.id) ?? []).map(
    (child) =>
      `- ${topicLink(context, child.id, topicTitle(child, context.language))} · ${count(projection.subtreeNotes.get(child.id) ?? 0)}`
  );
  if (subtopics.length)
    sections.push(`## ${t("topics.page.map.subtopics")}\n\n${subtopics.join("\n")}`);
  const direct = projection.direct.get(topic.id) ?? [];
  const waiting = ` · ${t("topics.navigator.unsorted")}`;
  const notes = direct
    .filter((p) => p.kind === "note")
    .map(
      (p) =>
        `- ${context.link(p.itemId, context.titleOf("note", p.itemId), "note")}${topic.role !== "root" && p.waiting ? waiting : ""}`
    );
  if (notes.length)
    sections.push(
      `## ${t(topic.role === "root" ? "topics.navigator.unsorted" : "topics.page.map.notes")}\n\n${notes.join("\n")}`
    );
  // Sources: those placed here, then the sources of the notes here, by how many they contribute.
  const sourceCounts = new Map<string, number>();
  for (const p of direct) {
    const id = p.kind === "source" ? p.itemId : p.rootSourceId;
    if (!id || !context.pathOf(id)) continue;
    sourceCounts.set(id, (sourceCounts.get(id) ?? 0) + (p.kind === "note" ? 1 : 0));
  }
  const sources = [...sourceCounts]
    .map(([id, n]) => ({ id, n, title: context.titleOf("source", id) }))
    .sort((a, b) => b.n - a.n || a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
    .map((source) => `- ${context.link(source.id, source.title, "source")}`);
  if (sources.length) sections.push(`## ${t("topics.page.map.sources")}\n\n${sources.join("\n")}`);
  if (!subtopics.length && !notes.length && !sources.length) sections.push(t("topics.page.empty"));
  const generated = sections.join("\n\n");
  const aliases = topicAliases(projection, planned);
  return {
    title: planned.title,
    editorial: `# ${markdownHeading(planned.title)}\n\n`,
    generated,
    aliases,
    revision: createHash("sha256")
      .update(JSON.stringify([planned.title, aliases, generated]))
      .digest("hex")
  };
}
