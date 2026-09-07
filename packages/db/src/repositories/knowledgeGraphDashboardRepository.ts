import type { QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import type { AtomicNoteStatus, SourceItemType } from "./types.js";

export type KnowledgeGraphDashboardMode = "sources" | "atomic_notes";

export interface KnowledgeGraphDashboardNodeRecord {
  id: string;
  kind: "source" | "atomic_note";
  title: string;
  subtitle: string | null;
  content: string | null;
  sourceItemId: string;
  sourceType: SourceItemType | null;
  noteStatus: AtomicNoteStatus | null;
  detailCount: number;
}

export interface KnowledgeGraphDashboardEdgeRecord {
  id: string;
  source: string;
  target: string;
  kind: "shared_entity" | "semantic_relation" | "atomic_note_relation";
  label: string;
  description: string | null;
  weight: number;
  confidence: number;
  details: string[];
}

export interface KnowledgeGraphDashboardRecord {
  mode: KnowledgeGraphDashboardMode;
  nodes: KnowledgeGraphDashboardNodeRecord[];
  edges: KnowledgeGraphDashboardEdgeRecord[];
  truncated: boolean;
}

export interface KnowledgeGraphSourceConnectionDetailsRecord {
  sharedEntities: string[];
  semanticRelations: string[];
  entities: { id: string; label: string; shared: boolean }[];
  relations: { id: string; source: string; target: string; label: string }[];
}

const maxNodes = 20_000;
const maxEdges = 50_000;

interface SourceNodeRow extends QueryResultRow {
  id: string;
  type: SourceItemType;
  title: string;
  subtitle: string | null;
  entityCount: number;
}

interface SourceEdgeRow extends QueryResultRow {
  source: string;
  target: string;
  weight: number;
  confidence: number;
  details: string[];
}

interface AtomicNoteNodeRow extends QueryResultRow {
  id: string;
  title: string;
  ideaStatement: string;
  content: string;
  status: AtomicNoteStatus;
  sourceItemId: string;
  sourceTitle: string;
  entityCount: number;
}

interface AtomicNoteEdgeRow extends QueryResultRow {
  id: string;
  source: string;
  target: string;
  relationType: string;
  explanation: string;
  finalScore: number;
}

interface SourceConnectionDetailRow extends QueryResultRow {
  detail: string;
}

function score(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function createKnowledgeGraphDashboardRepository(pool: PgPool) {
  return {
    async get(mode: KnowledgeGraphDashboardMode): Promise<KnowledgeGraphDashboardRecord> {
      return mode === "sources" ? listSourceGraph(pool) : listAtomicNoteGraph(pool);
    },
    async getSourceConnectionDetails(
      sourceItemId: string,
      targetSourceItemId: string
    ): Promise<KnowledgeGraphSourceConnectionDetailsRecord> {
      return getSourceConnectionDetails(pool, sourceItemId, targetSourceItemId);
    }
  };
}

async function getSourceConnectionDetails(
  pool: PgPool,
  sourceItemId: string,
  targetSourceItemId: string
): Promise<KnowledgeGraphSourceConnectionDetailsRecord> {
  const [sharedResult, semanticResult] = await Promise.all([
    pool.query<SourceConnectionDetailRow & { id: string }>(
      `select distinct entity.id, entity.canonical_name as detail
       from entity_mentions source_mention
       join entity_mentions target_mention on target_mention.entity_id = source_mention.entity_id
       join entities entity on entity.id = source_mention.entity_id
       where source_mention.source_item_id = $1 and target_mention.source_item_id = $2
       order by detail`,
      [sourceItemId, targetSourceItemId]
    ),
    pool.query<SourceConnectionDetailRow & { id: string; source: string; target: string; sourceLabel: string; targetLabel: string; label: string }>(
      `with mentions as (
         select distinct source_item_id, entity_id
         from entity_mentions
         where source_item_id in ($1, $2)
       )
       select distinct relation.id, relation.subject_entity_id as source, relation.object_entity_id as target,
         subject_entity.canonical_name as "sourceLabel", object_entity.canonical_name as "targetLabel",
         relation.predicate as label, subject_entity.canonical_name || ' · ' || relation.predicate || ' · '
         || object_entity.canonical_name as detail
       from entity_relations relation
       join mentions subject_mention on subject_mention.entity_id = relation.subject_entity_id
       join mentions object_mention on object_mention.entity_id = relation.object_entity_id
       join entities subject_entity on subject_entity.id = relation.subject_entity_id
       join entities object_entity on object_entity.id = relation.object_entity_id
       where (subject_mention.source_item_id = $1 and object_mention.source_item_id = $2)
          or (subject_mention.source_item_id = $2 and object_mention.source_item_id = $1)
       order by detail`,
      [sourceItemId, targetSourceItemId]
    )
  ]);
  const entities = new Map<string, { id: string; label: string; shared: boolean }>();
  for (const row of sharedResult.rows) entities.set(row.id, { id: row.id, label: row.detail, shared: true });
  for (const row of semanticResult.rows) {
    if (!entities.has(row.source)) entities.set(row.source, { id: row.source, label: row.sourceLabel, shared: false });
    if (!entities.has(row.target)) entities.set(row.target, { id: row.target, label: row.targetLabel, shared: false });
  }
  return {
    sharedEntities: [...new Set(sharedResult.rows.map((row) => row.detail))],
    semanticRelations: [...new Set(semanticResult.rows.map((row) => row.detail))],
    entities: [...entities.values()],
    relations: semanticResult.rows.map(({ id, source, target, label }) => ({ id, source, target, label }))
  };
}

async function listSourceGraph(pool: PgPool): Promise<KnowledgeGraphDashboardRecord> {
  const nodeResult = await pool.query<SourceNodeRow>(
    `select source.id, source.type, source.title, source.subtitle,
            count(distinct mention.entity_id)::int as "entityCount"
     from source_items source
     left join entity_mentions mention on mention.source_item_id = source.id
     group by source.id
     order by source.updated_at desc, source.id
     limit $1`,
    [maxNodes + 1]
  );
  const hasMoreNodes = nodeResult.rows.length > maxNodes;
  const selectedRows = nodeResult.rows.slice(0, maxNodes);
  const sourceIds = selectedRows.map((row) => row.id);
  if (sourceIds.length === 0) return { mode: "sources", nodes: [], edges: [], truncated: false };

  const [sharedResult, semanticResult] = await Promise.all([
    pool.query<SourceEdgeRow>(
      `with mentions as (
         select source_item_id, entity_id, max(confidence) as confidence
         from entity_mentions
         where source_item_id = any($1::uuid[])
         group by source_item_id, entity_id
       )
       select left_mention.source_item_id as source, right_mention.source_item_id as target,
              count(*)::int as weight,
              max(least(left_mention.confidence, right_mention.confidence)) as confidence,
              (array_agg(entity.canonical_name order by entity.canonical_name))[1:6] as details
       from mentions left_mention
       join mentions right_mention on right_mention.entity_id = left_mention.entity_id
         and left_mention.source_item_id < right_mention.source_item_id
       join entities entity on entity.id = left_mention.entity_id
       group by left_mention.source_item_id, right_mention.source_item_id
       order by weight desc, source, target
       limit $2`,
      [sourceIds, maxEdges + 1]
    ),
    pool.query<SourceEdgeRow>(
      `with mentions as (
         select source_item_id, entity_id, max(confidence) as confidence
         from entity_mentions
         where source_item_id = any($1::uuid[])
         group by source_item_id, entity_id
       )
       select least(subject_mention.source_item_id, object_mention.source_item_id) as source,
              greatest(subject_mention.source_item_id, object_mention.source_item_id) as target,
              count(distinct relation.id)::int as weight,
              max(least(subject_mention.confidence, object_mention.confidence, relation.confidence)) as confidence,
              (array_agg(distinct subject_entity.canonical_name || ' · ' || relation.predicate || ' · ' || object_entity.canonical_name
                order by subject_entity.canonical_name || ' · ' || relation.predicate || ' · ' || object_entity.canonical_name))[1:6] as details
       from entity_relations relation
       join mentions subject_mention on subject_mention.entity_id = relation.subject_entity_id
       join mentions object_mention on object_mention.entity_id = relation.object_entity_id
         and object_mention.source_item_id <> subject_mention.source_item_id
       join entities subject_entity on subject_entity.id = relation.subject_entity_id
       join entities object_entity on object_entity.id = relation.object_entity_id
       group by least(subject_mention.source_item_id, object_mention.source_item_id),
                greatest(subject_mention.source_item_id, object_mention.source_item_id)
       order by weight desc, source, target
       limit $2`,
      [sourceIds, maxEdges + 1]
    )
  ]);

  const sharedRows = sharedResult.rows.slice(0, maxEdges);
  const remaining = Math.max(0, maxEdges - sharedRows.length);
  const semanticRows = semanticResult.rows.slice(0, remaining);
  return {
    mode: "sources",
    nodes: selectedRows.map((row) => ({
      id: row.id,
      kind: "source",
      title: row.title,
      subtitle: row.subtitle,
      content: null,
      sourceItemId: row.id,
      sourceType: row.type,
      noteStatus: null,
      detailCount: Number(row.entityCount)
    })),
    edges: [
      ...sharedRows.map((row, index) => ({
        id: `shared:${row.source}:${row.target}:${index}`,
        source: row.source,
        target: row.target,
        kind: "shared_entity" as const,
        label: "shared_entity",
        description: null,
        weight: Number(row.weight),
        confidence: score(Number(row.confidence)),
        details: row.details
      })),
      ...semanticRows.map((row, index) => ({
        id: `semantic:${row.source}:${row.target}:${index}`,
        source: row.source,
        target: row.target,
        kind: "semantic_relation" as const,
        label: "semantic_relation",
        description: null,
        weight: Number(row.weight),
        confidence: score(Number(row.confidence)),
        details: row.details
      }))
    ],
    truncated: hasMoreNodes || sharedResult.rows.length > maxEdges
      || semanticResult.rows.length > remaining
  };
}

async function listAtomicNoteGraph(pool: PgPool): Promise<KnowledgeGraphDashboardRecord> {
  const nodeResult = await pool.query<AtomicNoteNodeRow>(
    `select note.id, note.title, note.idea_statement as "ideaStatement",
            left(note.body_markdown, 4000) as content, note.status,
            note.created_from_source_item_id as "sourceItemId", source.title as "sourceTitle",
            count(distinct link.entity_id)::int as "entityCount"
     from atomic_notes note
     join source_items source on source.id = note.created_from_source_item_id
     left join atomic_note_entity_links link on link.atomic_note_id = note.id
     where note.supersession_status = 'current' and note.status not in ('rejected', 'archived')
     group by note.id, source.id
     order by note.updated_at desc, note.id
     limit $1`,
    [maxNodes + 1]
  );
  const hasMoreNodes = nodeResult.rows.length > maxNodes;
  const selectedRows = nodeResult.rows.slice(0, maxNodes);
  const noteIds = selectedRows.map((row) => row.id);
  if (noteIds.length === 0) return { mode: "atomic_notes", nodes: [], edges: [], truncated: false };

  const edgeResult = await pool.query<AtomicNoteEdgeRow>(
    `select relation.id, relation.source_atomic_note_id as source,
            relation.target_atomic_note_id as target, relation.relation_type as "relationType",
            relation.explanation, relation.final_score as "finalScore"
     from atomic_note_relations relation
     where relation.status <> 'rejected'
       and relation.source_atomic_note_id = any($1::uuid[])
       and relation.target_atomic_note_id = any($1::uuid[])
     order by relation.final_score desc, relation.id
     limit $2`,
    [noteIds, maxEdges + 1]
  );

  return {
    mode: "atomic_notes",
    nodes: selectedRows.map((row) => ({
      id: row.id,
      kind: "atomic_note",
      title: row.title,
      subtitle: row.ideaStatement || row.sourceTitle,
      content: row.content,
      sourceItemId: row.sourceItemId,
      sourceType: null,
      noteStatus: row.status,
      detailCount: Number(row.entityCount)
    })),
    edges: edgeResult.rows.slice(0, maxEdges).map((row) => ({
      id: row.id,
      source: row.source,
      target: row.target,
      kind: "atomic_note_relation",
      label: row.relationType,
      description: row.explanation,
      weight: 1,
      confidence: score(Number(row.finalScore)),
      details: []
    })),
    truncated: hasMoreNodes || edgeResult.rows.length > maxEdges
  };
}
