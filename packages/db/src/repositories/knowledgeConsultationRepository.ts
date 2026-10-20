import { retainedNoteCurrentSql } from "./noteEvidence.js";
import {
  currentSourceRelationEvidenceSql,
  sourceRelationEvidenceJoins
} from "./sourceRelationRepository.js";
import { inTopicNotes, topicScopeCtes } from "./topicScopeSql.js";
import type { PgPool } from "../client.js";

export interface ConsultationContextRecord {
  id: string;
  kind: "summary" | "atomic_note" | "entity_mention";
  sourceItemId: string;
  text: string;
  review: string | null;
  fingerprint: string;
  chunkIds: string[];
  dependencies: Array<{ kind: string; id: string; fingerprint: string }>;
}
type Dependency = { kind: string; id: string; fingerprint: string };
const stamp = (v: unknown) => new Date(v as string).toISOString();
const noteFingerprint = (alias: string) =>
  `md5((md5((to_jsonb(${alias})-'updated_at'-'created_at'-'ownership'-'owning_source_item_id'-'owning_chunk_id')::text))||coalesce((select string_agg((to_jsonb(l)-'created_at')::text,'|' order by l.id) from atomic_note_source_links l where l.atomic_note_id=${alias}.id),''))`;
const rowFingerprint = (alias: string) =>
  `md5((to_jsonb(${alias})-'updated_at'-'created_at')::text)`;
/** Every table a context or relation can depend on. A dependency on anything else is invalid. */
const dependencyTables: Record<string, string> = {
  atomic_note: "atomic_notes",
  summary: "source_summaries",
  entity: "entities",
  entity_mention: "entity_mentions",
  source_relation: "source_relations",
  relation_evidence: "source_relation_evidence",
  note_relation: "atomic_note_relations"
};

/**
 * What Ask grounds an answer in beyond the retrieved passages: the sources in scope, the notes,
 * summary concepts, entity mentions and source relations tied to those passages, and the check that
 * all of it is still current. It reads no page and no organization state.
 */
export function createKnowledgeConsultationRepository(pool: Pick<PgPool, "query">) {
  const api = {
    /**
     * The sources a question may read: the selected ones (all when none) and, optionally, their
     * descendants; for a topic, the sources holding the passages of the topic's subtree. The
     * passages themselves stay limited to the topic (`topicMembers`, and the `topicId` of the
     * retrieval and context reads).
     */
    async scope(input: {
      sourceIds: string[];
      includeDescendants: boolean;
      topicId?: string | null | undefined;
    }) {
      if (input.topicId)
        return (
          await pool.query(
            `with recursive ${topicScopeCtes("$1")} select distinct c.source_item_id as id from chunks c where c.id in (select chunk_id from topic_chunks) order by 1`,
            [input.topicId]
          )
        ).rows.map((r) => r.id as string);
      return (
        await pool.query(
          `with recursive allowed as(select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[]) union select s.id from source_items s join allowed a on s.parent_source_item_id=a.id where $2) select id from allowed order by id`,
          [input.sourceIds, input.includeDescendants]
        )
      ).rows.map((r) => r.id as string);
    },
    /**
     * Which of these passages and notes belong to the topic's subtree. A question about a topic
     * cites only these, so the check runs again before and after the answer.
     */
    async topicMembers(topicId: string, items: { chunkIds: string[]; noteIds: string[] }) {
      const row = (
        await pool.query(
          `with recursive ${topicScopeCtes("$1")} select
        array(select c.chunk_id from topic_chunks c where c.chunk_id=any($2::uuid[]) order by 1) as "chunkIds",
        array(select n.note_id from topic_note_ids n where n.note_id=any($3::uuid[]) order by 1) as "noteIds"`,
          [topicId, items.chunkIds, items.noteIds]
        )
      ).rows[0]!;
      return { chunkIds: row.chunkIds as string[], noteIds: row.noteIds as string[] };
    },
    async contexts(
      sourceIds: string[],
      chunkIds: string[],
      reviewedOnly: boolean,
      topicId: string | null = null
    ): Promise<ConsultationContextRecord[]> {
      // Optional text is admitted only with complete original provenance in this bounded scope.
      // Within a topic, a note is admitted only when it is placed in the topic's subtree.
      const notes = (
        await pool.query(
          `with recursive ${topicScopeCtes("$4")} select n.id,'atomic_note' as kind,n.created_from_source_item_id as "sourceItemId",n.idea_statement||E'\\n'||n.body_markdown as text,n.status as review,${noteFingerprint("n")} as fingerprint,
      array(select refs.id from (select n.evidence_chunk_id as id union select l.chunk_id from atomic_note_source_links l where l.atomic_note_id=n.id union select e.chunk_id from atomic_note_evidence e where e.note_id=n.id) refs left join chunks rc on rc.id=refs.id order by (select si.title from source_items si where si.id=rc.source_item_id),rc.chunk_index,refs.id) as "chunkIds"
      from atomic_notes n join chunks c on c.id=n.evidence_chunk_id join documents d on d.id=c.document_id
      where n.created_from_source_item_id=any($1::uuid[]) and c.source_item_id=n.created_from_source_item_id and n.evidence_chunk_id=any($2::uuid[]) and n.status not in('rejected','archived') and n.supersession_status='current' and ${retainedNoteCurrentSql()}
      and not exists(select 1 from atomic_note_evidence e where e.note_id=n.id and (e.source_id<>all($1::uuid[]) or e.chunk_id<>all($2::uuid[])))
      and (not $3 or n.status='approved') and d.metadata->>'supersededByDocumentId' is null and ${inTopicNotes("$4", "n.id")}
      and not exists(select 1 from atomic_note_source_links l left join chunks lc on lc.id=l.chunk_id left join documents ld on ld.id=lc.document_id where l.atomic_note_id=n.id and (l.source_item_id<>lc.source_item_id or l.source_item_id<>all($1::uuid[]) or l.chunk_id<>all($2::uuid[]) or ld.id is null or ld.metadata->>'supersededByDocumentId' is not null))
      order by (select si.title from source_items si where si.id=n.created_from_source_item_id),
        c.chunk_index,n.title,n.idea_statement,n.id limit 20`,
          [sourceIds, chunkIds, reviewedOnly, topicId]
        )
      ).rows;
      const summaries = reviewedOnly
        ? []
        : (
            await pool.query(
              `select s.id,'summary' as kind,s.source_item_id as "sourceItemId",s.metadata->'concepts' as concepts,${rowFingerprint("s")} as fingerprint
      from source_summaries s join source_items src on src.id=s.source_item_id where s.source_item_id=any($1::uuid[]) and s.is_current and src.metadata->>'summaryStale' is distinct from 'true' and jsonb_typeof(s.metadata->'concepts')='array' order by src.title,s.id limit 20`,
              [sourceIds]
            )
          ).rows;
      const concepts = summaries.flatMap((s) => {
        // summary-v3 concepts carry original chunk IDs; ungrounded legacy strings are navigation only.
        const eligible = (s.concepts as Array<Record<string, unknown>>).filter(
          (c) =>
            Array.isArray(c.evidenceChunkIds) &&
            c.evidenceChunkIds.length > 0 &&
            (c.evidenceChunkIds as string[]).every((id) => chunkIds.includes(id))
        );
        if (!eligible.length) return [];
        return [
          {
            ...s,
            text: JSON.stringify(eligible),
            review: null,
            chunkIds: [...new Set(eligible.flatMap((c) => c.evidenceChunkIds as string[]))]
          }
        ];
      });
      const entities = reviewedOnly
        ? []
        : (
            await pool.query(
              `select m.id,'entity_mention' as kind,m.source_item_id as "sourceItemId",e.canonical_name as text,null::text as review,${rowFingerprint("m")} as fingerprint,array[m.chunk_id] as "chunkIds",e.id as "entityId",${rowFingerprint("e")} as "entityFingerprint"
      from entity_mentions m join entities e on e.id=m.entity_id join chunks c on c.id=m.chunk_id
      where m.source_item_id=any($1::uuid[]) and m.source_item_id=c.source_item_id and m.chunk_id=any($2::uuid[])
      order by (select si.title from source_items si where si.id=m.source_item_id),c.chunk_index,e.canonical_name,m.id limit 20`,
              [sourceIds, chunkIds]
            )
          ).rows;
      return [...notes, ...concepts, ...entities]
        .filter((c) => c.text.length <= 6000)
        .map((c) => ({
          id: c.id,
          kind: c.kind,
          sourceItemId: c.sourceItemId,
          text: c.text,
          review: c.review,
          fingerprint: c.fingerprint,
          chunkIds: c.chunkIds,
          dependencies: [
            { kind: c.kind, id: c.id, fingerprint: c.fingerprint },
            ...(c.entityId
              ? [{ kind: "entity", id: c.entityId, fingerprint: c.entityFingerprint }]
              : [])
          ]
        }));
    },
    async relations(sourceIds: string[]) {
      return (
        await pool.query(
          `select * from (select distinct on(r.id) r.id,e.id as "evidenceId",md5(e.snapshot::text) as fingerprint,r.source_item_id as "sourceItemId",r.target_source_item_id as "targetSourceItemId",r.status as review,r.updated_at as "updatedAt",r.source_idea as "sourceIdea",r.target_idea as "targetIdea",r.explanation,e.source_chunk_id as "sourceChunkId",e.target_chunk_id as "targetChunkId"
        from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins}
        where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[]) and r.status<>'rejected' and ${currentSourceRelationEvidenceSql}
          and r.source_idea is not null and r.target_idea is not null and r.explanation is not null
        order by r.id,e.snapshot->>'sourceHash',e.snapshot->>'targetHash',e.id) picked
        order by picked."sourceIdea",picked."targetIdea",picked."evidenceId" limit 20`,
          [sourceIds]
        )
      ).rows.map((r) => ({ ...r, updatedAt: stamp(r.updatedAt) }));
    },
    async relationDependencies(evidenceId: string) {
      const row = (
        await pool.query(
          `select e.*,${rowFingerprint("e")} as fingerprint,${rowFingerprint("r")} as "relationFingerprint" from source_relation_evidence e join source_relations r on r.id=e.relation_id where e.id=$1`,
          [evidenceId]
        )
      ).rows[0];
      if (!row) throw new Error("consultation.errors.evidence");
      const deps = [
        { kind: "relation_evidence", id: row.id, fingerprint: row.fingerprint },
        { kind: "source_relation", id: row.relation_id, fingerprint: row.relationFingerprint }
      ];
      for (const [kind, id] of [
        ["atomic_note", row.source_note_id],
        ["atomic_note", row.target_note_id],
        ["note_relation", row.note_relation_id]
      ] as const)
        if (id) {
          const current = (
            await pool.query(
              `select ${kind === "atomic_note" ? noteFingerprint("r") : rowFingerprint("r")} as fingerprint from ${dependencyTables[kind]} r where id=$1`,
              [id]
            )
          ).rows[0];
          if (!current) throw new Error("consultation.errors.evidence");
          deps.push({ kind, id, fingerprint: current.fingerprint });
        }
      return deps;
    },
    async validateEvidence(
      evidence: Array<{
        chunkId: string;
        sourceItemId: string;
        documentId: string;
        sourceSpanId: string | null;
        contentHash: string;
      }>
    ) {
      const current = (
        await pool.query(
          `select c.id,c.source_item_id,c.document_id,c.source_span_id,c.content_hash from chunks c join documents d on d.id=c.document_id where c.id=any($1::uuid[]) and d.metadata->>'supersededByDocumentId' is null and c.chunking_version<>'catalog-metadata-v1' and c.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'processingMode' is distinct from 'catalog_metadata'`,
          [evidence.map((e) => e.chunkId)]
        )
      ).rows;
      if (
        evidence.some(
          (e) =>
            !current.some(
              (c) =>
                c.id === e.chunkId &&
                c.source_item_id === e.sourceItemId &&
                c.document_id === e.documentId &&
                c.source_span_id === e.sourceSpanId &&
                c.content_hash === e.contentHash
            )
        )
      )
        throw new Error("consultation.errors.evidence");
    },
    async validateRelations(
      relations: Array<{
        id: string;
        evidenceId: string;
        fingerprint: string;
        review: string;
        updatedAt: string;
      }>,
      sourceIds: string[]
    ) {
      for (const relation of relations) {
        const current = (
          await pool.query(
            `select r.status,r.updated_at,md5(e.snapshot::text) as fingerprint from source_relations r join source_relation_evidence e on e.relation_id=r.id ${sourceRelationEvidenceJoins}
          where r.id=$1 and e.id=$2 and r.source_item_id=any($3::uuid[]) and r.target_source_item_id=any($3::uuid[]) and r.status<>'rejected' and ${currentSourceRelationEvidenceSql}`,
            [relation.id, relation.evidenceId, sourceIds]
          )
        ).rows[0];
        if (
          !current ||
          current.fingerprint !== relation.fingerprint ||
          current.status !== relation.review ||
          stamp(current.updated_at) !== relation.updatedAt
        )
          throw new Error("consultation.errors.evidence");
      }
    },
    /**
     * Throws `consultation.errors.evidence` unless every passage, relation and dependency of the
     * snapshot is still current: the chunk and its document revision, the relation evidence and the
     * fingerprints of the notes, concepts and entities the optional context was built from.
     */
    async validate(snapshot: {
      sourceIds: string[];
      evidence: Array<{
        chunkId: string;
        sourceItemId: string;
        documentId: string;
        sourceSpanId: string | null;
        contentHash: string;
      }>;
      relations: Array<{
        id: string;
        evidenceId: string;
        fingerprint: string;
        review: string;
        updatedAt: string;
        dependencies: Dependency[];
      }>;
      contexts: Array<{ dependencies: Dependency[] }>;
    }) {
      await api.validateEvidence(snapshot.evidence);
      await api.validateRelations(snapshot.relations, snapshot.sourceIds);
      await api.validateDependencies(
        [...snapshot.contexts, ...snapshot.relations].flatMap((c) => c.dependencies)
      );
    },
    async validateDependencies(dependencies: Dependency[]) {
      for (const dep of dependencies.toSorted(
        (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id)
      )) {
        const table = dependencyTables[dep.kind];
        if (!table) throw new Error("consultation.errors.evidence");
        const row = (
          await pool.query(
            `select ${dep.kind === "atomic_note" ? noteFingerprint("r") : rowFingerprint("r")} as fingerprint from ${table} r where id=$1`,
            [dep.id]
          )
        ).rows[0];
        if (!row || row.fingerprint !== dep.fingerprint)
          throw new Error("consultation.errors.evidence");
      }
    }
  };
  return api;
}
