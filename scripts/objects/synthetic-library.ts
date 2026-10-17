import { randomUUID } from "node:crypto";

import { createTopicTreeRepository } from "@app/db";
import type { PgPool, TopicStatsWrite } from "@app/db";
import {
  createRng,
  deriveSeed,
  itemKey,
  placementRecord,
  topicRecord
} from "@app/domain/topic-tree";
import type { ItemKey, PlacementRecord, StructureEvent } from "@app/domain/topic-tree";

/**
 * Synthetic libraries at scale for the latency benchmarks of the objects layer
 * (`locate-benchmark.ts`, `note-page-benchmark.ts`) and of the topic reads
 * (`scripts/topics/read-benchmark.ts`). Each SQL step is one statement for a single session on a
 * throwaway database migrated from scratch; temporary tables carry IDs between steps.
 * `seedTopicTree` then places the notes of such a library in a topic tree through
 * `topicTreeRepository` (D9: no raw SQL on the topic tables).
 */

/**
 * Books > chapters > sections with eight chunks each, notes (10% knowledge-owned and linked to a
 * second source) and legacy wiki pages with memberships, dependencies and evidence.
 */
export const librarySeedSteps = (
  booksCount: number,
  notesCount: number,
  pagesCount: number
): string[] => [
  // Library: books > chapters > sections.
  `create temp table t_book as select i, gen_random_uuid() as id from generate_series(1, ${booksCount}) i`,
  `create temp table t_chapter as select b.i, c, gen_random_uuid() as id, b.id as parent from t_book b, generate_series(1, 3) c`,
  `create temp table t_section as select c.i, c.c, s, gen_random_uuid() as id, c.id as parent,
          row_number() over (order by c.i, c.c, s) as rn from t_chapter c, generate_series(1, 2) s`,
  `insert into source_items (id, type, title, parent_source_item_id)
   select id, 'Book'::source_item_type, 'Book ' || i, null::uuid from t_book
   union all select id, 'BookChapter', 'Book ' || i || ' chapter ' || c, parent from t_chapter
   union all select id, 'DocumentSection', 'Book ' || i || ' chapter ' || c || ' section ' || s, parent from t_section`,
  `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
   select gen_random_uuid(), id, 'Document', 'seed', md5(id::text) from t_section`,
  `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
   select gen_random_uuid(), d.id, d.source_item_id, g, 'Passage ' || g, md5(d.id::text || g)
     from documents d, generate_series(0, 7) g`,
  `create temp table t_chunk as select row_number() over (order by source_item_id, chunk_index) as rn,
          id, source_item_id, chunk_index from chunks`,
  // Notes: 10% knowledge-owned and linked to a second source.
  `create temp table t_note as
     select gen_random_uuid() as id, g, s.id as source_id, k.id as chunk_id
       from generate_series(1, ${notesCount}) g
       join t_section s on s.rn = 1 + (g % (select count(*) from t_section))
       join t_chunk k on k.source_item_id = s.id and k.chunk_index = g % 8`,
  `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
      ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
      generation_runtime, generation_prompt_version, generation_key)
   select id, 'Note ' || g, 'Body ' || g, 'Idea ' || g, 'active', 'current',
          case when g % 10 = 0 then 'knowledge' else 'source' end,
          source_id, chunk_id, 'seed', 'seed', 'local', 'seed', id::text from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select id, source_id, chunk_id from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select n.id, k.source_item_id, k.id from t_note n
     join t_chunk k on k.rn = 1 + ((n.g * 31) % (select count(*) from t_chunk))
    where n.g % 10 = 0 on conflict do nothing`,
  `create temp table t_note_rank as select row_number() over (order by g) as rn, id from t_note`,
  `create temp table t_source_rank as
     select row_number() over (order by id) as rn, id from source_items`,
  // Legacy wiki: pages with a revision, a TOC group, memberships, dependencies and evidence.
  // Migration 0052 fences new legacy content (D40); this throwaway session seeds it on purpose.
  `set memora.legacy_fixture = 'on'`,
  `create temp table t_page as
     select g, gen_random_uuid() as id, gen_random_uuid() as revision, gen_random_uuid() as grp
       from generate_series(1, ${pagesCount}) g`,
  `insert into wiki_pages (id, title, kind, archived, current_revision_id)
   select id, 'Page ' || g, case when g % 10 = 1 then 'entity' when g % 10 = 2 then 'synthesis' else 'topic' end,
          g % 50 = 0, revision from t_page`,
  `insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash)
   select revision, id, 1, 'seed', '{}'::jsonb, revision::text from t_page`,
  `insert into wiki_toc_groups (id, page_id, revision_id, snapshot)
   select grp, id, revision, '{}'::jsonb from t_page`,
  // Every third target is one of five hot sources, so some sources are heavily referenced.
  `create temp table t_target as
     select p.g, j, p.id as page, p.revision, p.grp,
            case when j % 2 = 0 then 'source' else 'atomic_note' end as kind,
            case when j % 2 = 0
              then (select id from t_source_rank where rn =
                      case when j % 3 = 0 then 1 + (p.g % 5)
                           else 1 + ((p.g * 131 + j * 7919) % (select count(*) from t_source_rank)) end)
              else (select id from t_note_rank where rn = 1 + ((p.g * 151 + j * 104729) % (select count(*) from t_note_rank)))
            end as target
       from t_page p, generate_series(1, 15) j`,
  `insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot)
   select gen_random_uuid(), page, grp, kind, target, j, '{}'::jsonb from t_target`,
  `insert into wiki_dependencies (revision_id, section_id, kind, input_id, fingerprint, snapshot)
   select revision, gen_random_uuid(), kind, target, 'seed', '{}'::jsonb from t_target
    where (g + j) % 3 <> 0 on conflict do nothing`,
  `insert into wiki_evidence (page_id, source_item_id, document_id, chunk_id, snapshot)
   select p.id, k.source_item_id, d.id, k.id, '{}'::jsonb
     from t_page p cross join generate_series(1, 10) j
     join t_chunk k on k.rn = 1 + ((p.g * 977 + j * 13) % (select count(*) from t_chunk))
     join documents d on d.source_item_id = k.source_item_id
    on conflict do nothing`,
  `analyze`
];

export interface NoteRelationSeedOptions {
  /** Relations from every note to pseudo-random other notes. */
  relationsPerNote: number;
  /** Notes with many relations (the heaviest Note pages). */
  hubNotes: number;
  hubRelations: number;
}

/**
 * Note-page data on top of `librarySeedSteps` (same session): one SourceSpan per chunk (every
 * fourth with a page), relations with mixed types, scores and explanations (half are message keys,
 * half text with a note reference; a quarter lack decision metadata and read in an unknown
 * direction; a third have an explanation written on open), hub notes, human edits on 5% of the
 * notes and retained evidence snapshots on 1%. Relations are stored as relations v2 rows (F3 D8):
 * the sorted pair with its direction; an eighth are banded v2 rows with the write vocabulary
 * (half of those suggested, a quarter of the applied ones withdrawn), the rest legacy rows.
 */
export const noteRelationSeedSteps = (options: NoteRelationSeedOptions): string[] => {
  const legacyTypes =
    "array['supports','contrasts','extends','similar_to','depends_on','clarifies']";
  const writeTypes =
    "array['supports','contradicts','extends','same_as','depends_on','example_of','clarifies']";
  /** Inserts one relation per row of `pairs` (columns f, t: the decided subject and object; k: a salt). */
  const insertRelations = (pairs: string) => `
    insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
        direction, band, probability, vetoed_at, veto_source, final_score, explanation,
        matching_model, metadata)
     select least(x.f, x.t), greatest(x.f, x.t), x.type,
            case when x.type in ('contrasts','similar_to','contradicts','same_as') then 'symmetric'
                 when not x.v2 and x.k % 4 = 0 then 'unknown'
                 when x.f < x.t then 'lo_to_hi' else 'hi_to_lo' end,
            case when x.v2 then case when x.k % 16 = 1 then 'suggest' else 'apply' end end,
            case when x.v2 then x.score end,
            case when x.v2 and x.k % 32 = 9 then now() end,
            case when x.v2 and x.k % 32 = 9 then 'explainer' end,
            x.score,
            case when x.k % 2 = 0 then 'knowledge.relations.explanations.reranked'
                 else 'Both describe it in <note-ref id="' || x.f || '" />.' end,
            'seed-decider',
            case when x.k % 4 = 0 then '{}'::jsonb else jsonb_build_object('decisionSource', 'model') end
       from (select p.f, p.t, p.k, p.score, p.k % 8 = 1 as v2,
                    case when p.k % 8 = 1 then (${writeTypes})[1 + ((p.k / 8) % 7)::int]
                         else (${legacyTypes})[1 + (p.k % 6)::int] end as type
               from (${pairs}) p) x
     on conflict do nothing`;
  return [
    // Write triggers (the projection clock) are irrelevant to a throwaway benchmark.
    `alter table chunks disable trigger user`,
    `alter table atomic_note_relations disable trigger user`,
    `create temp table t_span as
       select c.id as chunk_id, gen_random_uuid() as id, c.document_id, c.source_item_id, c.chunk_index
         from chunks c`,
    `insert into source_spans (id, document_id, source_item_id, start_offset, end_offset, page)
     select id, document_id, source_item_id, chunk_index * 100, chunk_index * 100 + 90,
            case when chunk_index % 4 = 0 then 1 + chunk_index / 4 end from t_span`,
    `update chunks c set source_span_id = s.id from t_span s where s.chunk_id = c.id`,
    insertRelations(`select a.id as f, b.id as t, a.rn + j as k,
            ((a.rn * 7 + j * 13) % 100) / 100.0 as score
       from t_note_rank a cross join generate_series(1, ${options.relationsPerNote}) j
       join t_note_rank b on b.rn = 1 + ((a.rn * 7919 + j * 104729) % (select count(*) from t_note_rank))
      where a.id <> b.id`),
    insertRelations(`select a.id as f, b.id as t, a.rn + j as k,
            ((a.rn * 7 + j * 13) % 100) / 100.0 as score
       from t_note_rank a cross join generate_series(1, ${options.hubRelations}) j
       join t_note_rank b on b.rn = 1 + ((a.rn * 31 + j * 997) % (select count(*) from t_note_rank))
      where a.rn <= ${options.hubNotes} and a.id <> b.id`),
    `alter table chunks enable trigger user`,
    `alter table atomic_note_relations enable trigger user`,
    // A third of the relations were opened and explained (stale or current, it is the same read).
    `insert into atomic_note_relation_explanations
       (relation_id, text, input_hash, prompt_version, provider, model, runtime, language)
     select id, 'An explanation written on open.', md5(id::text), 'seed', 'seed', 'seed-writer',
            'remote', 'en'
       from atomic_note_relations where abs(hashtext(id::text)) % 3 = 0`,
    `insert into atomic_note_review_events (atomic_note_id, action, previous_status, next_status)
     select id, 'edit', 'active', 'active' from t_note_rank where rn % 20 = 0`,
    `insert into atomic_note_evidence (note_id, chunk_id, source_id, snapshot)
     select n.id, n.chunk_id, n.source_id,
            jsonb_build_object('excerpt', 'Retained passage ' || n.g, 'sourceTitle', 'Seed source',
                               'contentHash', 'retained-' || n.g)
       from t_note n where n.g % 100 = 0`,
    `analyze`
  ];
};

export interface TopicTreeSeedOptions {
  /** Topics to create, the root included (default 2,500). */
  topics?: number;
  /** Areas under the root (default 10). */
  areas?: number;
  /** Subtopics per Area (default 12); the rest of the topics are leaves under them. */
  subtopicsPerArea?: number;
  /** Notes left out of the first build and placed by a later "place" change-set (default 400). */
  heldBack?: number;
  /** Rename change-sets applied after the build, each one a structural change "today" (default 25). */
  renames?: number;
  /** Proposals that wait for the owner (default 3). */
  proposals?: number;
  seed?: number;
}

export interface TopicTreeSeed {
  treeId: string;
  rootId: string;
  areaIds: string[];
  subtopicIds: string[];
  leafIds: string[];
  /** Placed primary items: notes and root sources. */
  placedItems: number;
  heldBack: number;
  changeSetIds: string[];
  generation: number;
}

const treeDimensions = 256;

/**
 * Places the notes and root sources of a seeded library in a topic tree of about `topics` topics:
 * the root, Areas, subtopics and leaves of 12 to 13 notes, with statistics, centralities, secondary
 * placements, a few waiting items and health findings, then a "place" change-set for the held-back
 * notes, rename change-sets and proposals, so that "new this week", "changed today" and the
 * warnings have rows to read. The library has no vectors, so the statistics are plausible, not
 * computed from embeddings (the reads never look at the vectors).
 */
export async function seedTopicTree(
  pool: PgPool,
  options: TopicTreeSeedOptions = {}
): Promise<TopicTreeSeed> {
  const areaCount = options.areas ?? 10;
  const perArea = options.subtopicsPerArea ?? 12;
  const total = options.topics ?? 2_500;
  const seed = options.seed ?? 20261015;
  const rng = createRng(deriveSeed(seed, "topic-tree-seed"));
  const noteIds = (
    await pool.query<{ id: string }>("select id from atomic_notes order by id")
  ).rows.map((row) => row.id);
  const rootSources = (
    await pool.query<{ id: string }>(
      "select id from source_items where parent_source_item_id is null order by id"
    )
  ).rows.map((row) => row.id);
  if (noteIds.length === 0) throw new Error("The library holds no notes to place.");

  const heldBack = Math.min(options.heldBack ?? 400, Math.floor(noteIds.length / 10));
  const placedNotes = noteIds.slice(0, noteIds.length - heldBack);
  const laterNotes = noteIds.slice(noteIds.length - heldBack);

  // Structure: the root, the Areas, their subtopics, then leaves spread over the subtopics.
  const treeId = randomUUID();
  const rootId = randomUUID();
  const topics: Array<ReturnType<typeof topicRecord>> = [];
  const parentOf = new Map<string, string>();
  const addTopic = (
    parentId: string,
    title: string,
    position: number,
    extra: Partial<Omit<ReturnType<typeof topicRecord>, "id" | "parentId">> = {}
  ): string => {
    const id = randomUUID();
    topics.push(
      topicRecord(id, parentId, {
        role: "topic",
        title,
        nameState: "named",
        nameSource: "llm",
        nameLanguage: "en",
        position,
        ...extra
      })
    );
    parentOf.set(id, parentId);
    return id;
  };
  const areaIds = Array.from({ length: areaCount }, (_, area) =>
    addTopic(rootId, `Area ${area + 1}`, area, { description: `Area ${area + 1} of the library.` })
  );
  const subtopicIds = areaIds.flatMap((area, a) =>
    Array.from({ length: perArea }, (_, sub) =>
      addTopic(
        area,
        `Subject ${a + 1}.${sub + 1}`,
        sub,
        rng.next() < 0.5 ? { description: "A subject." } : {}
      )
    )
  );
  const leafBudget = Math.max(subtopicIds.length, total - 1 - areaIds.length - subtopicIds.length);
  const leafIds: string[] = [];
  const perSubtopic = Math.floor(leafBudget / subtopicIds.length);
  const spare = leafBudget - perSubtopic * subtopicIds.length;
  subtopicIds.forEach((subtopic, index) => {
    const count = perSubtopic + (index < spare ? 1 : 0);
    for (let leaf = 0; leaf < count; leaf += 1) {
      leafIds.push(
        addTopic(
          subtopic,
          `Topic ${index + 1}.${leaf + 1}`,
          leaf,
          rng.next() < 0.3 ? { aliases: ["Also called"] } : {}
        )
      );
    }
  });

  // Placements: each note on one leaf (a few also on a second), each root source on a leaf.
  const placements: Array<{ item: ItemKey; placement: PlacementRecord }> = [];
  const central = new Map<string, Array<{ item: ItemKey; centrality: number }>>();
  const members = new Map<string, number>();
  const remember = (topic: string, item: ItemKey) => {
    const list = central.get(topic) ?? [];
    list.push({ item, centrality: 0.3 + 0.7 * rng.next() });
    central.set(topic, list);
    members.set(topic, (members.get(topic) ?? 0) + 1);
  };
  placedNotes.forEach((id, index) => {
    const item = itemKey("note", id);
    if (index < 5) {
      // A few notes wait at the root.
      placements.push({ item, placement: placementRecord(rootId) });
      members.set(rootId, (members.get(rootId) ?? 0) + 1);
      return;
    }
    const leaf = leafIds[(index * 7919) % leafIds.length] as string;
    const waiting = rng.next() < 0.005;
    placements.push({
      item,
      placement: placementRecord(leaf, {
        needsGate: waiting && index % 2 === 0,
        needsSplitCheck: waiting && index % 2 === 1
      })
    });
    remember(leaf, item);
    if (rng.next() < 0.03) {
      const other = leafIds[rng.int(leafIds.length)] as string;
      if (other !== leaf) placements.push({ item, placement: placementRecord(other, { rank: 1 }) });
    }
  });
  rootSources.forEach((id, index) => {
    const item = itemKey("source", id);
    if (index < 3) {
      placements.push({ item, placement: placementRecord(rootId, { needsVector: true }) });
      return;
    }
    const leaf = leafIds[rng.int(leafIds.length)] as string;
    placements.push({ item, placement: placementRecord(leaf) });
    remember(leaf, item);
  });

  // Subtree sums, children before parents (a topic is created after its parent).
  const subtree = new Map<string, number>(
    [rootId, ...topics.map((topic) => topic.id)].map((id) => [id, members.get(id) ?? 0])
  );
  for (let index = topics.length - 1; index >= 0; index -= 1) {
    const topic = topics[index] as ReturnType<typeof topicRecord>;
    const parent = topic.parentId as string;
    subtree.set(parent, (subtree.get(parent) ?? 0) + (subtree.get(topic.id) ?? 0));
  }
  const finding = (severity: "soft" | "hard", reason: string, awaiting: boolean) => ({
    code: severity === "hard" ? "I3" : "I4",
    severity,
    reason,
    topicId: null,
    item: null,
    awaitingApproval: awaiting,
    value: 1
  });
  const stats: TopicStatsWrite[] = [rootId, ...topics.map((topic) => topic.id)].map((topicId) => {
    const n = subtree.get(topicId) ?? 0;
    const ls = new Float64Array(treeDimensions);
    ls[0] = n * 0.8;
    const roll = rng.next();
    const write: TopicStatsWrite = {
      topicId,
      n,
      ls,
      cosSqSum: n * 0.64,
      lowCosPercentiles: [],
      centralities: central.get(topicId) ?? []
    };
    if (topicId !== rootId && roll < 0.03) {
      write.health = "attention";
      write.violations = [finding("soft", "leaf-size-outside-range", roll < 0.005)];
    } else if (topicId !== rootId && roll > 0.995) {
      write.health = "violation";
      write.violations = [finding("hard", "fan-out-above-hard-max", false)];
    }
    return write;
  });

  const repository = createTopicTreeRepository(pool);
  const tree = await repository.createTree({
    id: treeId,
    rootId,
    spaceKey: "local:synthetic:256",
    embeddingProvider: "synthetic",
    embeddingModel: "synthetic",
    embeddingRuntime: "none",
    dimensions: treeDimensions,
    config: {},
    configHash: "synthetic",
    seed
  });
  const built = await repository.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics,
    placements,
    stats
  });
  if (built.kind !== "applied") {
    throw new Error(`The synthetic tree was refused: ${JSON.stringify(built)}`);
  }
  let generation = built.generation;
  const changeSetIds = [built.changeSetId];

  // Arrivals this week: the held-back notes, placed by one "place" change-set.
  if (laterNotes.length > 0) {
    const events: StructureEvent[] = laterNotes.map((id, index) => {
      const leaf = leafIds[(index * 104729) % leafIds.length] as string;
      return {
        op: "item.place",
        item: itemKey("note", id),
        topicId: leaf,
        before: null,
        after: placementRecord(leaf)
      };
    });
    const placed = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: generation,
      origin: "place",
      titleKey: "topics.changeSets.place",
      events
    });
    if (placed.kind !== "applied") {
      throw new Error(`The held-back notes were refused: ${JSON.stringify(placed)}`);
    }
    generation = placed.generation;
    changeSetIds.push(placed.changeSetId);
  }

  // Structural changes today: renames of leaves, then proposals that wait for the owner.
  const titles = new Map(topics.map((topic) => [topic.id, topic.title as string]));
  const aliases = new Map(topics.map((topic) => [topic.id, [...topic.aliases]]));
  for (let n = 0; n < (options.renames ?? 25); n += 1) {
    const topicId = leafIds[(n * 61) % leafIds.length] as string;
    const named = {
      nameState: "named" as const,
      nameSource: "llm" as const,
      nameLanguage: "en",
      namedChangeSetId: null,
      aliases: aliases.get(topicId) ?? []
    };
    const before = titles.get(topicId) as string;
    const after = `${before} renamed ${n}`;
    const applied = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: generation,
      origin: "rebalance",
      titleKey: "topics.changeSets.rename",
      titleParams: { title: after },
      events: [
        {
          op: "topic.rename",
          topicId,
          before: { ...named, title: before },
          after: { ...named, title: after }
        }
      ]
    });
    if (applied.kind !== "applied") {
      throw new Error(`A rename was refused: ${JSON.stringify(applied)}`);
    }
    generation = applied.generation;
    changeSetIds.push(applied.changeSetId);
    titles.set(topicId, after);
  }
  for (let n = 0; n < (options.proposals ?? 3); n += 1) {
    const topicId = subtopicIds[n] as string;
    const target = areaIds[(n + 1) % areaIds.length] as string;
    const pending = await repository.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: generation,
      origin: "areas",
      titleKey: "topics.changeSets.areas",
      status: "pending_review",
      risk: "medium",
      events: [
        {
          op: "topic.move",
          topicId,
          before: { parentId: parentOf.get(topicId) as string, position: n },
          after: { parentId: target, position: 99 }
        }
      ]
    });
    if (pending.kind !== "pending") {
      throw new Error(`A proposal was refused: ${JSON.stringify(pending)}`);
    }
    generation = pending.generation;
    changeSetIds.push(pending.changeSetId);
  }
  // A bulk build leaves the planner without statistics until autovacuum runs; the topic service
  // does the same after its own bootstrap, so the reads are measured the way they run afterwards.
  await pool.query(
    "analyze topics, topic_stats, topic_placements, topic_change_sets, topic_structure_events"
  );
  return {
    treeId: tree.id,
    rootId,
    areaIds,
    subtopicIds,
    leafIds,
    placedItems: placedNotes.length + rootSources.length + laterNotes.length,
    heldBack: laterNotes.length,
    changeSetIds,
    generation
  };
}
