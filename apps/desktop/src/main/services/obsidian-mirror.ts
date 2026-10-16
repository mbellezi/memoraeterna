import { posix } from "node:path";
import { createHash } from "node:crypto";
import {
  createDocumentRepository,
  createObsidianSyncRepository,
  createObsidianWikiRepository,
  createObsidianEditorialRepository,
  type ObsidianSyncFileRecord,
  type PgPool,
  type ProjectionNoteRef
} from "@app/db";
import { translate, type MessageKey } from "@app/i18n";
import {
  markdownHeading,
  wikiLink,
  safeWikiLabel,
  sourceOriginalStart,
  sourceOriginalEnd,
  type ObsidianLayoutConfig,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";
import {
  layoutLabels,
  pathIdentity,
  portableName,
  sourceLayoutPath
} from "./obsidian-layout-paths.js";
import {
  planTopicProjection,
  renderTopicMoc,
  type TopicProjection
} from "./obsidian-topic-projection.js";
import type { ObsidianWikiScope } from "./obsidian-wiki-projection.js";

export interface MirrorTarget {
  id: string;
  type: ObsidianManagedFrontmatter["memoraType"];
  revision: string;
  title: string;
  path: string;
  editorial: string;
  generated: string;
  sourceId?: string;
  documentId?: string;
  layout?: ObsidianLayoutConfig;
  linkMap?: Array<{ rendered: string; canonical: string }>;
  rootSourceId?: string;
  divisionId?: string;
  documentRevisionId?: string;
  /** A topic map's frontmatter `aliases` (redirected and earlier titles). */
  aliases?: string[];
}
/** One file a pass delivers: planned with its path, rendered only when its page comes. */
export interface PlannedTarget {
  /** Delivery order and checkpoint cursor: the kind's rank, then the ID. */
  key: string;
  id: string;
  type: MirrorTarget["type"];
  path: string;
}
/**
 * A rendered target; or why this one file could not be rendered (it fails alone, by name); or
 * neither, when its object was deleted after the pass was planned (the next pass retires it).
 */
export interface RenderedTarget {
  planned: PlannedTarget;
  target?: MirrorTarget;
  error?: string;
}
export interface MirrorPlan {
  /** Every target, in delivery order. */
  targets: PlannedTarget[];
  render(targets: readonly PlannedTarget[]): Promise<RenderedTarget[]>;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const stableId = (key: string) => {
  const h = digest("memora-layout-v2:" + key);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const INDEX = "7cfe90b4-11fb-447d-9673-849b6a3dc000",
  CATALOG = "7cfe90b4-11fb-447d-9673-849b6a3dc001",
  RELATIONS = "7cfe90b4-11fb-447d-9673-849b6a3dc002";
/** Delivery rank of each kind: sources, notes, topic maps, relations, then the indexes. */
export const targetRank: Record<MirrorTarget["type"], number> = {
  source_item: 0,
  source_reference: 0,
  atomic_note: 1,
  topic: 2,
  source_relation: 3,
  wiki_page: 4,
  wiki_index: 4
};
export const targetKey = (type: MirrorTarget["type"], id: string) => `${targetRank[type]}:${id}`;
/** Errors that fail one file of a pass, by name; any other error stops the pass. */
export const fileError = (error: unknown) =>
  /obsidianWiki\.errors\.(limit|binding|format)/.exec(String(error))?.[0] ?? null;
export interface MirrorAsset {
  id: string;
  sourceId: string | null;
  documentId: string | null;
  originalFileName: string;
  sha256: string;
  sizeBytes: number;
  storageBase: string;
  relativePath: string;
  path: string;
  available: boolean;
}

/** Every target of a layout v2 mirror, rendered at once (the explicit layout migration). */
export async function buildObsidianMirror(
  pool: PgPool,
  root: string,
  scope: ObsidianWikiScope,
  config: ObsidianLayoutConfig,
  options: { migrate?: boolean; excluded?: Set<string>; assets?: MirrorAsset[] } = {}
): Promise<MirrorTarget[]> {
  const plan = await planObsidianMirror(pool, root, scope, config, options);
  const rendered = await plan.render(plan.targets);
  const failed = rendered.find((entry) => entry.error);
  if (failed) throw new Error(failed.error);
  return rendered.flatMap((entry) => (entry.target ? [entry.target] : []));
}

/**
 * Plans a layout v2 mirror: every target and its path, with nothing rendered. Paths and links come
 * from light rows (titles, parents, registered paths); a page of targets is rendered on demand. The
 * whole library is planned, never a truncated part of it. Topics take the place of the old wiki
 * pages: each live topic is a folder-note map of content (`obsidian-topic-projection.ts`).
 */
export async function planObsidianMirror(
  pool: PgPool,
  root: string,
  scope: ObsidianWikiScope,
  config: ObsidianLayoutConfig,
  options: { migrate?: boolean; excluded?: Set<string>; assets?: MirrorAsset[] } = {}
): Promise<MirrorPlan> {
  const repo = createObsidianWikiRepository(pool),
    registry = await createObsidianSyncRepository(pool).listAll(),
    registered = new Map<string, ObsidianSyncFileRecord>(registry.map((f) => [f.memoraId, f])),
    wholeLibrary = !scope.sourceIds.length,
    sources = await repo.sources(scope.sourceIds, scope.includeDescendants),
    sourcesById = new Map(sources.map((s) => [String(s.id), s])),
    notes = await repo.noteRefs(
      sources.map((s) => s.id),
      wholeLibrary
    ),
    notesById = new Map(notes.map((n) => [n.id, n]));
  const allowed = new Set(sources.map((s) => String(s.id)));
  const relations = await repo.relationRefs([...allowed]);
  const l = layoutLabels(config.language),
    t = (key: MessageKey) => translate(config.language, key),
    paths = new Map<string, string>(),
    used = new Map<string, string>();
  // A retired file never moves, so its path stays taken even while a layout migration re-places the rest.
  for (const row of registry)
    if (!options.migrate || row.status === "retired" || options.excluded?.has(row.memoraId))
      used.set(pathIdentity(row.relativePath), row.memoraId);
  function reserve(id: string, path: string) {
    const old = registered.get(id);
    if (old && !old.relativePath.startsWith(root + "/"))
      throw new Error("obsidianWiki.errors.binding");
    if (old && (!options.migrate || options.excluded?.has(id))) path = old.relativePath;
    const occupied = used.get(pathIdentity(path));
    if (occupied && occupied !== id) path = path.replace(/\.md$/, ` — ${id.slice(0, 8)}.md`);
    if (used.has(pathIdentity(path)) && used.get(pathIdentity(path)) !== id)
      path = path.replace(/\.md$/, ` — ${id}.md`);
    if (used.has(pathIdentity(path)) && used.get(pathIdentity(path)) !== id)
      throw new Error("obsidianWiki.errors.conflict");
    if (Buffer.byteLength(path) > 900) throw new Error("obsidianWiki.errors.limit");
    used.set(pathIdentity(path), id);
    paths.set(id, path);
    return path;
  }
  const sourceDirectories = new Map<string, string>();
  const parents = new Set(
    sources
      .map((s) => s.parentId)
      .filter(Boolean)
      .map(String)
  );
  const placeSource = (source: (typeof sources)[number], seen = new Set<string>()): string => {
    if (paths.has(source.id)) return paths.get(source.id)!;
    if (seen.has(source.id)) throw new Error("wiki.errors.cycle");
    seen.add(source.id);
    let path = sourceLayoutPath(
      root,
      { ...source, metadata: { ...source.fullMetadata, ...source.metadata } },
      sources,
      config.language
    );
    const parent = source.parentId ? sourcesById.get(String(source.parentId)) : undefined;
    if (parent) {
      const parentPath = placeSource(parent, seen);
      path = posix.join(
        posix.dirname(parentPath),
        parent.type === "Book"
          ? l.chapters
          : parent.type === "PeriodicalIssue"
            ? l.articles
            : l.sections,
        posix.basename(path)
      );
    }
    if (
      ["Book", "AcademicPaper", "PeriodicalIssue"].includes(source.type) ||
      parents.has(String(source.id))
    ) {
      let directory = posix.dirname(path);
      if (!["Book", "AcademicPaper", "PeriodicalIssue"].includes(source.type))
        directory = posix.join(directory, portableName(source.title));
      const owner = sourceDirectories.get(pathIdentity(directory));
      if (owner && owner !== source.id) directory += " — " + source.id.slice(0, 8);
      sourceDirectories.set(pathIdentity(directory), source.id);
      path = posix.join(directory, posix.basename(path));
    }
    return reserve(source.id, path);
  };
  for (const source of sources) placeSource(source);
  for (const note of notes)
    reserve(note.id, posix.join(root, l.notes, portableName(note.title) + ".md"));
  const topicsLabel = portableName(translate(config.language, "topics.navigator.topics"));
  const topics = planTopicProjection(await repo.topicProjection(), {
    folder: posix.join(root, topicsLabel),
    rootFile: topicsLabel,
    language: config.language,
    wholeLibrary,
    projected: (kind, id) => (kind === "note" ? notesById.has(id) : sourcesById.has(id)),
    registered: (id) => registered.has(id),
    reserve
  });
  reserve(INDEX, posix.join(root, "Wiki", l.index + ".md"));
  reserve(CATALOG, posix.join(root, l.sources, l.index + ".md"));
  reserve(RELATIONS, posix.join(root, "Wiki", t("obsidianWiki.connections"), l.index + ".md"));
  for (const r of relations)
    reserve(
      r.id,
      posix.join(
        root,
        "Wiki",
        t("obsidianWiki.connections"),
        portableName(r.sourceTitle + " — " + r.targetTitle) + ".md"
      )
    );
  for (const [key, area] of [
    ["notes", l.notes],
    ["assets", l.assets],
    ["home", ""]
  ] as const)
    reserve(stableId(key), posix.join(root, area, (key === "home" ? l.home : l.index) + ".md"));

  const planned: PlannedTarget[] = [];
  const plan = (id: string, type: MirrorTarget["type"]) =>
    planned.push({ key: targetKey(type, id), id, type, path: paths.get(id)! });
  for (const source of sources)
    plan(source.id, source.catalogOnly ? "source_reference" : "source_item");
  for (const note of notes) plan(note.id, "atomic_note");
  for (const entry of topics?.planned ?? []) plan(entry.topic.id, "topic");
  for (const r of relations) plan(r.id, "source_relation");
  for (const id of [INDEX, CATALOG, RELATIONS, stableId("notes"), stableId("assets")])
    plan(id, "wiki_index");
  plan(stableId("home"), "wiki_index");
  planned.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const missing = new Set(
    registry
      .filter((f) => f.status === "deleted" || f.metadata.editorialTombstone)
      .map((f) => f.memoraId)
  );
  const link = (id: string, title: string, kind = "source") =>
    wikiLink(missing.has(id) ? undefined : paths.get(id), title, id, kind);
  const context: MirrorContext = {
    pool,
    config,
    scope,
    sources,
    sourcesById,
    notes,
    notesById,
    allowed,
    relations,
    topics,
    paths,
    link,
    homeId: stableId("home"),
    assets: options.assets ?? []
  };
  return { targets: planned, render: (targets) => renderMirrorTargets(context, targets) };
}

interface MirrorContext {
  pool: PgPool;
  config: ObsidianLayoutConfig;
  scope: ObsidianWikiScope;
  sources: Awaited<ReturnType<ReturnType<typeof createObsidianWikiRepository>["sources"]>>;
  sourcesById: Map<string, MirrorContext["sources"][number]>;
  notes: ProjectionNoteRef[];
  notesById: Map<string, ProjectionNoteRef>;
  allowed: Set<string>;
  relations: Awaited<ReturnType<ReturnType<typeof createObsidianWikiRepository>["relationRefs"]>>;
  topics: TopicProjection | null;
  paths: Map<string, string>;
  link: (id: string, title: string, kind?: string) => string;
  homeId: string;
  assets: MirrorAsset[];
  /** Built on the first render: notes by source, and the topics that hold each note and source. */
  bySource?: Map<string, ProjectionNoteRef[]>;
  topicsOf?: Map<string, Set<string>>;
}

function indexes(context: MirrorContext) {
  if (!context.bySource) {
    const bySource = new Map<string, ProjectionNoteRef[]>();
    for (const note of context.notes)
      for (const id of new Set([note.sourceId, ...(note.sourceIds ?? [])]))
        if (id) bySource.set(id, [...(bySource.get(id) ?? []), note]);
    const topicsOf = new Map<string, Set<string>>();
    const add = (id: string | null, topicId: string) => {
      if (!id) return;
      const set = topicsOf.get(id) ?? new Set<string>();
      set.add(topicId);
      topicsOf.set(id, set);
    };
    for (const placement of context.topics?.rows.placements ?? []) {
      if (!context.topics?.byId.has(placement.topicId)) continue;
      add(placement.itemId, placement.topicId);
      if (placement.kind === "note") add(`root:${placement.rootSourceId}`, placement.topicId);
    }
    context.bySource = bySource;
    context.topicsOf = topicsOf;
  }
  return { bySource: context.bySource, topicsOf: context.topicsOf! };
}

/** Which of these rows still exist (IDs of one table, read in one statement). */
async function existingIds(
  pool: PgPool,
  table: "source_items" | "source_relations",
  ids: string[]
) {
  if (!ids.length) return [];
  return (await pool.query(`select id from ${table} where id = any($1::uuid[])`, [ids])).rows.map(
    (row) => String(row.id)
  );
}

/** Renders a page of planned targets; a file that cannot be rendered fails alone, by name. */
async function renderMirrorTargets(
  context: MirrorContext,
  targets: readonly PlannedTarget[]
): Promise<RenderedTarget[]> {
  const { pool, config, sources, sourcesById, notes, notesById, allowed, link, paths } = context;
  const repo = createObsidianWikiRepository(pool),
    l = layoutLabels(config.language),
    t = (key: MessageKey) => translate(config.language, key);
  const { bySource, topicsOf } = indexes(context);
  const relationsById = new Map(context.relations.map((r) => [String(r.id), r]));
  const details = new Map(
    (await repo.noteDetails(targets.filter((p) => p.type === "atomic_note").map((p) => p.id))).map(
      (row) => [String(row.id), row]
    )
  );
  // What was deleted since the pass was planned is skipped, never rendered from the old plan.
  const ofType = (...types: Array<MirrorTarget["type"]>) =>
    targets.filter((p) => types.includes(p.type)).map((p) => p.id);
  const existing = new Set([
    ...(await existingIds(pool, "source_items", ofType("source_item", "source_reference"))),
    ...(await existingIds(pool, "source_relations", ofType("source_relation"))),
    ...(await repo.liveTopicIds(ofType("topic")))
  ]);
  const evidenceSourceLink = (id: string, title: string) =>
    allowed.has(id)
      ? link(id, title)
      : safeWikiLabel(title) + " · " + t("obsidianWiki.unavailable");
  const list = (items: Array<{ id: string; title: string }>, kind = "wiki") =>
    items.map((item) => "- " + link(item.id, item.title, kind)).join("\n");
  const topicList = (ids: Iterable<string>) =>
    [...ids]
      .map((id) => context.topics?.byId.get(id))
      .filter((entry) => entry !== undefined)
      .sort((a, b) => a.title.localeCompare(b.title) || a.topic.id.localeCompare(b.topic.id))
      .map((entry) => ({ id: entry.topic.id, title: entry.title }));
  const quote = (text: string) =>
    text
      .split("\n")
      .map((line) => "> " + line.replace(/<!--\s*memora:/g, "&lt;!-- memora:"))
      .join("\n");
  const references = (text: string) =>
    text
      .replace(
        /<source-ref\b[^>]*\bid=["']([^"']+)["'][^>]*\/?>(?:<\/source-ref>)?/g,
        (_match, id: string) => {
          const source = sourcesById.get(id);
          return source ? link(id, source.title) : t("obsidianWiki.unavailable");
        }
      )
      .replace(/<\/?source-ref[^>]*>/g, t("obsidianWiki.unavailable"));
  const out: RenderedTarget[] = [];
  const add = (planned: PlannedTarget, target: Omit<MirrorTarget, "path" | "layout">) =>
    out.push({ planned, target: { ...target, path: planned.path, layout: config } });

  const renderSource = async (planned: PlannedTarget) => {
    const source = sourcesById.get(planned.id)!;
    const children = sources
      .filter((s) => s.parentId === source.id)
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.id.localeCompare(b.id));
    const document = (await createDocumentRepository(pool).listBySourceItem(source.id)).find(
      (d) => d.metadata.processingMode !== "catalog_metadata" && !d.metadata.supersededByDocumentId
    );
    let materialized = false;
    for (const child of children) {
      const doc = (await createDocumentRepository(pool).listBySourceItem(child.id))[0];
      if (document && doc?.metadata.derivedFromDocumentId === document.id) materialized = true;
    }
    const original = document && !materialized ? document.canonicalMarkdown : "";
    let rootSource = source;
    const seen = new Set<string>();
    while (rootSource.parentId && !seen.has(rootSource.id)) {
      seen.add(rootSource.id);
      const parent = sourcesById.get(String(rootSource.parentId));
      if (!parent) break;
      rootSource = parent;
    }
    const documentRevisionId = document
      ? await createObsidianEditorialRepository(pool).documentRevision(pool, document.id)
      : undefined;
    const bibliography = [source.metadata, ...(source.bibliography ?? [])]
      .map((data) =>
        Object.entries(data)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(
            ([key, value]) =>
              `${safeWikiLabel(key)}: ${safeWikiLabel(typeof value === "string" ? value : JSON.stringify(value))}`
          )
          .join("\n\n")
      )
      .filter(Boolean)
      .join("\n\n");
    const assets = context.assets.filter(
      (a) =>
        a.sourceId === source.id || a.sourceId === rootSource.id || a.documentId === document?.id
    );
    const assetLinks = assets
      .map((a) =>
        a.available
          ? `- [${safeWikiLabel(a.originalFileName)}](<${posix.relative(posix.dirname(paths.get(source.id)!), a.path)}>)`
          : `- ${safeWikiLabel(a.originalFileName)} · ${t(config.attachments === "omit" ? "obsidianLayout.assetOmitted" : "obsidianLayout.assetUnavailable")}`
      )
      .join("\n");
    const sourceTopics = new Set([
      ...(topicsOf.get(source.id) ?? []),
      ...(topicsOf.get(`root:${source.id}`) ?? [])
    ]);
    const generated = [
      source.parentId
        ? link(
            source.parentId,
            sourcesById.get(String(source.parentId))?.title ?? t("obsidianWiki.unavailable")
          )
        : "",
      `## ${t("obsidianLayout.bibliography")}`,
      bibliography,
      source.sourceUri ? safeWikiLabel(source.sourceUri) : "",
      document
        ? materialized
          ? t("obsidianLayout.materialized")
          : document.id
        : t("obsidianWiki.catalogOnly"),
      source.summary
        ? `## ${t("obsidianLayout.summary")}\n\n${quote(source.summary.text)}\n\n${safeWikiLabel(source.summary.provider)} · ${safeWikiLabel(source.summary.model)} · ${safeWikiLabel(source.summary.runtime)} · ${source.summary.generatedAt} · ${source.summary.stale ? t("wiki.needsEvidenceReview") : t("obsidianWiki.current")} · ${source.summary.id}`
        : "",
      list(children, "source"),
      `## ${l.sourceNotes}`,
      list(bySource.get(source.id) ?? [], "note"),
      sourceTopics.size ? `## ${t("obsidianLayout.usedBy")}` : "",
      list(topicList(sourceTopics)),
      `## ${l.assets}`,
      assetLinks || t("obsidianLayout.assetUnavailable")
    ]
      .filter(Boolean)
      .join("\n\n");
    add(planned, {
      id: source.id,
      type: document ? "source_item" : "source_reference",
      revision: source.updatedAt.toISOString(),
      title: source.title,
      sourceId: source.id,
      rootSourceId: source.rootId ?? rootSource.id,
      ...(typeof source.fullMetadata?.divisionId === "string"
        ? { divisionId: source.fullMetadata.divisionId }
        : {}),
      ...(documentRevisionId ? { documentRevisionId } : {}),
      ...(document ? { documentId: document.id } : {}),
      editorial: `# ${markdownHeading(source.title)}\n\n${sourceOriginalStart}\n${original}\n${sourceOriginalEnd}\n\n`,
      generated
    });
  };

  const renderNote = async (planned: PlannedTarget) => {
    const note = details.get(planned.id)!;
    const originals = await repo.noteEvidence(note.id, note.evidenceChunkId),
      evidence = originals.find((e) => e.id === note.evidenceChunkId),
      source = sourcesById.get(String(note.sourceId));
    if (originals.length > 100) throw new Error("obsidianWiki.errors.limit");
    if (context.scope.sourceIds.length && originals.some((e) => !allowed.has(e.sourceId)))
      throw new Error("obsidianWiki.errors.binding");
    const noteState = [
      t(("knowledge.notes.status." + note.status) as MessageKey),
      // AI provenance until a person approves, edits or discards the note.
      note.status === "active" ? t("knowledge.notes.aiBadge") : "",
      t(note.current ? "obsidianWiki.current" : "obsidianWiki.historical"),
      note.metadata?.humanProtected === true ? t("obsidianWiki.protected") : ""
    ]
      .filter(Boolean)
      .join(" · ");
    const originalReferences = originals
      .map(
        (e, i) =>
          `[${i + 1}] ${evidenceSourceLink(e.sourceId, e.sourceTitle)} · ${e.documentId} · ${e.id} · ${e.sourceSpanId ?? ""} · ${safeWikiLabel(e.locator ?? "")} · ${t(e.current ? "obsidianWiki.current" : "obsidianWiki.historical")}\n\n${quote(e.content)}`
      )
      .join("\n\n");
    add(planned, {
      id: note.id,
      type: "atomic_note",
      revision: note.updatedAt.toISOString(),
      title: note.title,
      ...(note.ownership === "knowledge"
        ? {}
        : { sourceId: note.sourceId, ...(evidence ? { documentId: evidence.documentId } : {}) }),
      editorial: `# ${markdownHeading(note.title)}\n\n${note.bodyMarkdown}\n\n`,
      generated: [
        noteState,
        source ? link(source.id, source.title) : "",
        originalReferences || t("obsidianWiki.unavailable"),
        note.successorIds
          ?.map((id: string) => link(id, notesById.get(id)?.title ?? id, "note"))
          .join("\n"),
        list(topicList(topicsOf.get(note.id) ?? []))
      ]
        .filter(Boolean)
        .join("\n\n")
    });
  };

  const renderTopic = (planned: PlannedTarget) => {
    const entry = context.topics!.byId.get(planned.id)!;
    const moc = renderTopicMoc(context.topics!, entry, {
      language: config.language,
      link: (id, title, kind) => link(id, title, kind),
      pathOf: (id) => paths.get(id),
      titleOf: (kind, id) =>
        (kind === "note" ? notesById.get(id)?.title : sourcesById.get(id)?.title) ?? id,
      home: { id: context.homeId, title: l.home }
    });
    add(planned, {
      id: planned.id,
      type: "topic",
      revision: moc.revision,
      title: moc.title,
      editorial: moc.editorial,
      generated: moc.generated,
      aliases: moc.aliases
    });
  };

  const renderRelation = async (planned: PlannedTarget) => {
    const r = relationsById.get(planned.id)!;
    const evidence = await repo.relationEvidence(r.id);
    add(planned, {
      id: r.id,
      type: "source_relation",
      revision: digest(JSON.stringify({ ...r, evidence })),
      title: r.sourceTitle + " → " + r.targetTitle,
      editorial: `# ${markdownHeading(r.sourceTitle + " → " + r.targetTitle)}\n\n`,
      generated: [
        t("obsidianWiki.readOnly"),
        t(("sourceRelations." + r.status) as MessageKey),
        link(r.source_item_id, r.sourceTitle) +
          " → " +
          link(r.target_source_item_id, r.targetTitle),
        // Relations decided without prose have none stored: their explanation is written on open.
        ...[r.source_idea, r.target_idea, r.explanation]
          .filter((text): text is string => typeof text === "string")
          .map(references),
        ...evidence.map(
          (e: Record<string, any>) =>
            `${e.id} · ${e.sourceDocumentId ?? ""} · ${e.targetDocumentId ?? ""} · ${e.current ? t("obsidianWiki.current") : t("obsidianWiki.historical")}\n\n${quote(e.snapshot.sourceExcerpt ?? "")}\n\n${quote(e.snapshot.targetExcerpt ?? "")}`
        )
      ].join("\n\n")
    });
  };

  const renderIndex = (planned: PlannedTarget) => {
    const topicRoot = context.topics?.planned[0];
    const areas = context.topics
      ? (context.topics.children.get(context.topics.rows.rootId) ?? [])
          .map((topic) => context.topics!.byId.get(topic.id))
          .filter((entry) => entry !== undefined)
          .map((entry) => ({ id: entry.topic.id, title: entry.title }))
      : [];
    const generated: Record<string, [string, string]> = {
      [INDEX]: [
        t("wiki.title"),
        [topicRoot ? link(topicRoot.topic.id, topicRoot.title, "wiki") : "", list(areas)]
          .filter(Boolean)
          .join("\n\n") || t("topics.page.empty")
      ],
      [CATALOG]: [l.sources, list(sources, "source")],
      [RELATIONS]: [
        t("obsidianWiki.connections"),
        list(
          context.relations.map((r) => ({ id: r.id, title: r.sourceTitle + " → " + r.targetTitle }))
        )
      ],
      [stableId("notes")]: [l.notes, list(notes, "note")],
      [stableId("assets")]: [
        l.assets,
        context.assets
          .map(
            (a) =>
              `${a.originalFileName} · ${a.available ? a.path : t("obsidianLayout.assetOmitted")}`
          )
          .join("\n")
      ],
      [stableId("home")]: [
        l.home,
        [
          link(INDEX, t("wiki.title"), "wiki"),
          link(CATALOG, l.sources, "wiki"),
          link(stableId("notes"), l.notes, "wiki"),
          link(stableId("assets"), l.assets, "wiki")
        ].join("\n\n")
      ]
    };
    const [title, body] = generated[planned.id]!;
    add(planned, {
      id: planned.id,
      type: "wiki_index",
      revision: digest(body),
      title,
      editorial: `# ${markdownHeading(title)}\n\n`,
      generated: body
    });
  };

  for (const planned of targets) {
    try {
      const gone =
        planned.type === "atomic_note"
          ? !details.has(planned.id)
          : planned.type !== "wiki_index" && !existing.has(planned.id);
      if (gone) out.push({ planned });
      else if (planned.type === "source_item" || planned.type === "source_reference")
        await renderSource(planned);
      else if (planned.type === "atomic_note") await renderNote(planned);
      else if (planned.type === "topic") renderTopic(planned);
      else if (planned.type === "source_relation") await renderRelation(planned);
      else renderIndex(planned);
    } catch (error) {
      const failure = fileError(error);
      if (!failure) throw error;
      out.push({ planned, error: failure });
    }
  }
  return out;
}
