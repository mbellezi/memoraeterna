import { createHash } from "node:crypto";
import type { QueryResultRow } from "pg";

import { isDirectedRelationType, sourceRelationExplanationLimits } from "@app/domain";

import { mapTimestamp } from "./sql.js";
import {
  currentSourceRelationEvidenceSql,
  directedSourceRelationSql,
  sourceRelationEvidenceJoins
} from "./sourceRelationRepository.js";
import type { Queryable } from "./types.js";

/**
 * Explanations of source relations, written on demand when the owner opens a relation decided
 * without prose (docs/plan.md decision 17) and cached beside it with their provenance and the hash
 * of the inputs they were written from. A cached explanation whose inputs changed is stale: it is
 * written again the next time the relation is opened.
 */
export const sourceRelationExplanationInputVersion = "source-relation-explanation-input-v1";

/** How the relation reads between the two sources, as the prompt states it. */
export type SourceRelationExplanationDirection = "s1_to_s2" | "symmetric";

export interface SourceRelationExplanationPassage {
  chunkId: string;
  content: string;
  chunkIndex: number;
}

export interface SourceRelationExplanationSide {
  id: string;
  title: string;
  /** Current evidence passages of this side, in document order, at most `passagesPerSource`. */
  passages: SourceRelationExplanationPassage[];
}

export interface StoredSourceRelationExplanation {
  text: string;
  inputHash: string;
  model: string;
  writtenAt: Date;
}

export interface SourceRelationExplanationContext {
  relationId: string;
  type: string;
  status: string;
  /** Relations saved with prose by the earlier matcher keep it and are not explained again. */
  hasProse: boolean;
  /** The relation reads from its source to its target (decision 31b); see `directedSourceRelationSql`. */
  directed: boolean;
  source: SourceRelationExplanationSide;
  target: SourceRelationExplanationSide;
  stored: StoredSourceRelationExplanation | null;
}

/**
 * Whether an explanation may be written: a relation the owner did not reject, without stored prose,
 * with current evidence on both sides.
 */
export function sourceRelationExplainable(context: SourceRelationExplanationContext): boolean {
  return (
    context.status !== "rejected" &&
    !context.hasProse &&
    context.source.passages.length > 0 &&
    context.target.passages.length > 0
  );
}

function compareSides(a: SourceRelationExplanationSide, b: SourceRelationExplanationSide): number {
  const key = (side: SourceRelationExplanationSide) => [
    side.title,
    ...side.passages.map((passage) => passage.content),
    side.id
  ];
  const [ka, kb] = [key(a), key(b)];
  for (let index = 0; index < Math.min(ka.length, kb.length); index++)
    if (ka[index] !== kb[index]) return ka[index]! < kb[index]! ? -1 : 1;
  return ka.length - kb.length;
}

/**
 * The sources in prompt order with the direction, and the hash of what the explanation depends on.
 * A directed type with a direction (the judge's, or a note relation's from the owner or the decider)
 * reads from the relation's source (s1) to its target (s2); a symmetric one, or a directed type
 * promoted from linked notes, orders the sources by content (title, then passages), so the prompt
 * is a function of content, and states no direction.
 */
export function sourceRelationExplanationPlan(
  context: Pick<SourceRelationExplanationContext, "type" | "directed" | "source" | "target">,
  language: string
): {
  direction: SourceRelationExplanationDirection;
  first: SourceRelationExplanationSide;
  second: SourceRelationExplanationSide;
  inputHash: string;
} {
  const directed = isDirectedRelationType(context.type) && context.directed;
  const [first, second] =
    directed || compareSides(context.source, context.target) <= 0
      ? [context.source, context.target]
      : [context.target, context.source];
  const direction: SourceRelationExplanationDirection = directed ? "s1_to_s2" : "symmetric";
  const inputHash = createHash("sha256")
    .update(
      JSON.stringify([
        sourceRelationExplanationInputVersion,
        context.type,
        direction,
        language,
        first.title,
        first.passages.map((passage) => passage.content),
        second.title,
        second.passages.map((passage) => passage.content)
      ])
    )
    .digest("hex");
  return { direction, first, second, inputHash };
}

interface RelationRow extends QueryResultRow {
  relationId: string;
  type: string;
  status: string;
  hasProse: boolean;
  directed: boolean;
  sourceId: string;
  targetId: string;
  sourceTitle: string;
  targetTitle: string;
  stored: { text: string; inputHash: string; model: string; writtenAt: string } | null;
}

interface PassageRow extends QueryResultRow {
  relationId: string;
  side: "source" | "target";
  chunkId: string;
  content: string;
  chunkIndex: number;
}

/** $1 relation IDs: the relations, their endpoints and the cached explanation. */
const relationsSql = `
select r.id as "relationId", r.relation_type as type, r.status::text as status,
       (r.source_idea is not null or r.target_idea is not null or r.explanation is not null) as "hasProse",
       ${directedSourceRelationSql("r")} as directed,
       r.source_item_id as "sourceId", r.target_source_item_id as "targetId",
       a.title as "sourceTitle", b.title as "targetTitle",
       case when x.relation_id is null then null else jsonb_build_object(
         'text', x.text, 'inputHash', x.input_hash, 'model', x.model, 'writtenAt', x.written_at) end as stored
  from source_relations r
  join source_items a on a.id = r.source_item_id
  join source_items b on b.id = r.target_source_item_id
  left join source_relation_explanations x on x.relation_id = r.id
 where r.id = any($1::uuid[])`;

/** $1 relation IDs: the passages of their current evidence, one row per side. */
const passagesSql = `
select e.relation_id as "relationId", side.side, side.chunk_id as "chunkId", side.content,
       side.chunk_index as "chunkIndex"
  from source_relation_evidence e ${sourceRelationEvidenceJoins}
  cross join lateral (values
    ('source', sc.id, e.snapshot->>'sourceExcerpt', sc.chunk_index),
    ('target', tc.id, e.snapshot->>'targetExcerpt', tc.chunk_index)) side(side, chunk_id, content, chunk_index)
 where e.relation_id = any($1::uuid[]) and ${currentSourceRelationEvidenceSql}
   and side.content is not null`;

const saveSql = `
insert into source_relation_explanations
  (relation_id, text, input_hash, prompt_version, provider, model, runtime, ai_task_run_id, language, written_at)
select $1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, clock_timestamp()
 where exists (select 1 from source_relations where id = $1::uuid)
on conflict (relation_id) do update set
  text = excluded.text, input_hash = excluded.input_hash, prompt_version = excluded.prompt_version,
  provider = excluded.provider, model = excluded.model, runtime = excluded.runtime,
  ai_task_run_id = excluded.ai_task_run_id, language = excluded.language, written_at = excluded.written_at
returning written_at as "writtenAt"`;

/** Distinct passages of one side in document order (then content), bounded per source. */
function sidePassages(rows: PassageRow[]): SourceRelationExplanationPassage[] {
  const byChunk = new Map<string, SourceRelationExplanationPassage>();
  for (const row of rows)
    if (!byChunk.has(row.chunkId))
      byChunk.set(row.chunkId, {
        chunkId: row.chunkId,
        content: row.content,
        chunkIndex: Number(row.chunkIndex)
      });
  return [...byChunk.values()]
    .toSorted(
      (a, b) =>
        a.chunkIndex - b.chunkIndex ||
        (a.content < b.content ? -1 : a.content > b.content ? 1 : 0) ||
        (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0)
    )
    .slice(0, sourceRelationExplanationLimits.passagesPerSource);
}

export interface SaveSourceRelationExplanationInput {
  relationId: string;
  text: string;
  inputHash: string;
  promptVersion: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
}

export function createSourceRelationExplanationRepository(db: Queryable) {
  /** Everything the explanations of these relations are written from, by relation ID. */
  async function readContexts(
    relationIds: readonly string[]
  ): Promise<Map<string, SourceRelationExplanationContext>> {
    const contexts = new Map<string, SourceRelationExplanationContext>();
    if (!relationIds.length) return contexts;
    const ids = [...new Set(relationIds)];
    const relations = (await db.query<RelationRow>(relationsSql, [ids])).rows;
    if (!relations.length) return contexts;
    const passages = (await db.query<PassageRow>(passagesSql, [ids])).rows;
    for (const row of relations) {
      const of = (side: "source" | "target") =>
        sidePassages(
          passages.filter(
            (passage) => passage.relationId === row.relationId && passage.side === side
          )
        );
      contexts.set(row.relationId, {
        relationId: row.relationId,
        type: row.type,
        status: row.status,
        hasProse: row.hasProse,
        directed: row.directed,
        source: { id: row.sourceId, title: row.sourceTitle, passages: of("source") },
        target: { id: row.targetId, title: row.targetTitle, passages: of("target") },
        stored: row.stored
          ? {
              text: row.stored.text,
              inputHash: row.stored.inputHash,
              model: row.stored.model,
              writtenAt: mapTimestamp(row.stored.writtenAt)
            }
          : null
      });
    }
    return contexts;
  }

  return {
    readContexts,

    /** One relation's context; null when it does not exist. */
    async readContext(relationId: string): Promise<SourceRelationExplanationContext | null> {
      return (await readContexts([relationId])).get(relationId) ?? null;
    },

    /**
     * The written explanations that are still current for these relations in this content language:
     * a stale one, or one written in another language, reads as none.
     */
    async currentExplanations(
      relationIds: readonly string[],
      language: string
    ): Promise<Map<string, { text: string; writtenBy: string }>> {
      const current = new Map<string, { text: string; writtenBy: string }>();
      for (const [id, context] of await readContexts(relationIds)) {
        if (!context.stored || !sourceRelationExplainable(context)) continue;
        if (sourceRelationExplanationPlan(context, language).inputHash !== context.stored.inputHash)
          continue;
        current.set(id, { text: context.stored.text, writtenBy: context.stored.model });
      }
      return current;
    },

    /**
     * Caches an explanation for the inputs it was written from, replacing an earlier one. Resolves
     * to null when the relation was removed meanwhile (nothing is stored).
     */
    async save(input: SaveSourceRelationExplanationInput): Promise<{ writtenAt: Date } | null> {
      const row = (
        await db.query<{ writtenAt: Date | string }>(saveSql, [
          input.relationId,
          input.text,
          input.inputHash,
          input.promptVersion,
          input.provider,
          input.model,
          input.runtime,
          input.aiTaskRunId,
          input.language
        ])
      ).rows[0];
      return row ? { writtenAt: mapTimestamp(row.writtenAt) } : null;
    },

    statements: { relations: relationsSql, passages: passagesSql, save: saveSql }
  };
}
