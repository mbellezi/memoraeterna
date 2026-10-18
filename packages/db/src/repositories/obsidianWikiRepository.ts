import type { PgPool } from "../client.js";
import { createJobRepository } from "./jobRepository.js";
import { readNoteEvidence, retainedNoteCurrentSql } from "./noteEvidence.js";
import {
  currentSourceRelationSql,
  currentSourceRelationEvidenceSql,
  sourceRelationEvidenceJoins,
  suggestedSourceRelationSql
} from "./sourceRelationRepository.js";
import type { Queryable } from "./types.js";

/** The vault projection's job: one per pass, queued again page by page (D30, D33). */
export const projectionJobType = "obsidian-wiki";
export interface ProjectionNoteRef {
  id: string;
  title: string;
  sourceId: string | null;
  ownership: string;
  status: string;
  sourceIds: string[];
}
export interface TopicProjectionTopic {
  id: string;
  parentId: string | null;
  role: "root" | "topic";
  title: string | null;
  nameState: "named" | "provisional" | "unnamed";
  aliases: string[];
  description: string | null;
  position: number;
}
export interface TopicProjectionPlacement {
  topicId: string;
  kind: "note" | "source";
  itemId: string;
  rootSourceId: string | null;
  /** Waits at this topic for the gate or a split check (shown as unsorted, D27). */
  waiting: boolean;
}
export interface TopicProjectionRows {
  treeId: string;
  generation: number;
  rootId: string;
  /** Live topics in position order. */
  topics: TopicProjectionTopic[];
  /** Retired topics that redirect to a successor: their titles become the successor's aliases. */
  redirects: Array<{ id: string; title: string; redirectTo: string }>;
  /** Primary placements, by topic, then centrality (highest first). */
  placements: TopicProjectionPlacement[];
}
export interface ProjectionDelivery {
  id: string;
  memora_id: string;
  revision_id: string;
  binding_hash: string;
  relative_path: string;
  content: string;
  editable_hash: string;
  generated_hash: string;
  rendered_hash: string;
  base_hash: string | null;
  before_content: string | null;
  status: string;
  error: string | null;
}
/** Notes a projection of these sources may hold ($1 source IDs, $2 the whole library). */
const noteScopeSql = `($2 or n.created_from_source_item_id=any($1::uuid[])) and not exists(select 1 from atomic_note_evidence e where e.note_id=n.id and not $2 and not(e.source_id=any($1::uuid[]))) and n.status not in('rejected','archived')
        and not exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and not(l.source_item_id=any($1::uuid[])))`;
/** ":<tree>@<generation>" of the active topic tree, or "" without one. */
async function treeGeneration(db: Queryable): Promise<string> {
  const tree = (
    await db.query<{ id: string; generation: string }>(
      "select id,generation::text as generation from topic_trees where status='active' limit 1"
    )
  ).rows[0];
  return tree ? `:${tree.id}@${tree.generation}` : "";
}
export function createObsidianWikiRepository(pool: PgPool) {
  const liveTopicIds = async (ids: string[]) => {
    if (!ids.length) return [];
    return (
      await pool.query(
        `select t.id from topics t join topic_trees tree on tree.id=t.tree_id and tree.status='active'
        where t.id=any($1::uuid[]) and t.retired_at is null`,
        [ids]
      )
    ).rows.map((r) => String(r.id));
  };
  return {
    async withTargetLock<T>(id: string, work: () => Promise<T>): Promise<T> {
      const db = await pool.connect();
      try {
        await db.query("select pg_advisory_lock(hashtextextended($1,0))", ["obsidian:" + id]);
        return await work();
      } finally {
        await db.query("select pg_advisory_unlock(hashtextextended($1,0))", ["obsidian:" + id]);
        db.release();
      }
    },
    /**
     * Admits a projection pass when the canonical data, the active topic tree or the binding changed
     * since the last pass (or `force`). The generation names both: the projection clock, which row
     * triggers and committed topic change-sets bump, and the active tree's generation, which no
     * skipped bump can hide. A pass is one light job that re-enqueues itself page after page; while
     * it runs or waits nothing new is queued, and a pass that ends behind the clocks is followed by a
     * new one. A projection job an older build queued on the heavy lane is canceled and replaced.
     */
    async enqueue(binding: string, force = false) {
      const db = await pool.connect();
      try {
        await db.query("begin");
        await db.query(
          "insert into obsidian_projection_clock(id,generation) values(1,0) on conflict(id) do nothing"
        );
        const clock = String(
          (await db.query("select generation from obsidian_projection_clock where id=1 for update"))
            .rows[0].generation
        );
        const generation = clock + (await treeGeneration(db));
        const jobs = createJobRepository(db);
        let latest = await jobs.latestByType(projectionJobType);
        if (latest && latest.lane !== "light" && latest.status === "queued") {
          await jobs.requestCancel(latest.id);
          latest = null;
        }
        const current =
          latest?.payload.generation === generation && latest.payload.binding === binding;
        // A pass the app stopped mid-way (quit, not a cancel the user asked for) goes on from its
        // checkpoint; a pass that failed waits for a change or an explicit start.
        if (
          latest &&
          !force &&
          current &&
          latest.status === "canceled" &&
          !latest.cancelRequestedAt &&
          typeof latest.payload.cursor === "string"
        ) {
          const resumed = await jobs.create({
            type: projectionJobType,
            lane: "light",
            payload: latest.payload,
            maxAttempts: 3
          });
          await db.query("commit");
          return resumed.id;
        }
        if (latest && (["queued", "running"].includes(latest.status) || (!force && current))) {
          await db.query("commit");
          return latest.id;
        }
        const job = await jobs.create({
          type: projectionJobType,
          lane: "light",
          payload: { binding, generation },
          maxAttempts: 3
        });
        await db.query("commit");
        return job.id;
      } catch (error) {
        await db.query("rollback");
        throw error;
      } finally {
        db.release();
      }
    },
    /** The generation a pass plans at now: the projection clock and the active tree's generation. */
    async currentGeneration() {
      const clock = (
        await pool.query("select generation from obsidian_projection_clock where id=1")
      ).rows[0]?.generation;
      return String(clock ?? 0) + (await treeGeneration(pool));
    },
    async sources(sourceIds: string[], includeDescendants: boolean) {
      return (
        await pool.query(
          `with recursive scope as(select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[])
        union select s.id from source_items s join scope p on s.parent_source_item_id=p.id where $2)
        select s.id,s.title,s.type,(with recursive ancestry as(select s.id,s.parent_source_item_id,0 depth,array[s.id] visited union all select p.id,p.parent_source_item_id,a.depth+1,a.visited||p.id from source_items p join ancestry a on p.id=a.parent_source_item_id where a.depth<100 and not p.id=any(a.visited)) select id from ancestry order by depth desc limit 1) as "rootId",s.parent_source_item_id as "parentId",s.subtitle,s.source_uri as "sourceUri",s.updated_at as "updatedAt", s.summary as "legacySummary", s.metadata as "fullMetadata",
          (select jsonb_build_object('id',ss.id,'text',ss.summary,'provider',ss.provider,'model',ss.model,'runtime',ss.runtime,'generatedAt',ss.generated_at,'promptVersion',ss.prompt_version,'inputHash',ss.input_hash,'generationId',ss.generation_id,'stale',coalesce(s.metadata->>'summaryStale'='true',false)) from source_summaries ss where ss.source_item_id=s.id and ss.is_current order by ss.generated_at desc,ss.id desc limit 1) as summary,
          (select dv.position from document_divisions dv join document_structures st on st.id=dv.structure_id where dv.child_source_item_id=s.id and st.status in ('confirmed','materialized') order by st.revision desc,dv.position limit 1) as position,
          jsonb_build_object('creators',s.metadata->'creators','publicationDate',s.metadata->'publicationDate','publisher',s.metadata->'publisher') as metadata,
          (select coalesce(jsonb_agg(item),'[]') from (select w.creators,w.identifiers,i.publication_date as "publicationDate",i.publisher,i.edition,i.isbn,i.doi,i.issn from source_item_bibliographic_links l join bibliographic_works w on w.id=l.work_id left join bibliographic_instances i on i.id=l.instance_id where l.source_item_id=s.id order by l.id) item) as bibliography,
          not exists(select 1 from documents d where d.source_item_id=s.id and d.metadata->>'processingMode' is distinct from 'catalog_metadata' and d.metadata->>'supersededByDocumentId' is null) as "catalogOnly"
        from source_items s where s.id in(select id from scope) order by s.id`,
          [sourceIds, includeDescendants]
        )
      ).rows;
    },
    async exportEligible(
      sourceId: string | null,
      noteIds: string[],
      sourceIds: string[],
      includeDescendants: boolean
    ): Promise<boolean> {
      const row = (
        await pool.query(
          `with recursive scope as (
              select id from source_items where cardinality($1::uuid[])=0 or id=any($1::uuid[])
              union select child.id from source_items child join scope parent on child.parent_source_item_id=parent.id where $2
            ) select (exists(select 1 from scope where id=$3) or cardinality($4::uuid[])>0) and not exists(
              select wanted.id from unnest($4::uuid[]) wanted(id) left join atomic_notes n on n.id=wanted.id
              where n.id is null or n.status in('rejected','archived') or (cardinality($1::uuid[])>0 and n.created_from_source_item_id not in(select id from scope))
                or exists(select 1 from atomic_note_evidence e where e.note_id=n.id and cardinality($1::uuid[])>0 and e.source_id not in(select id from scope))
                or exists(select 1 from atomic_note_source_links l where l.atomic_note_id=n.id and l.source_item_id not in(select id from scope))
            ) as allowed`,
          [sourceIds, includeDescendants, sourceId, noteIds]
        )
      ).rows[0];
      return row?.allowed === true;
    },
    /**
     * The notes a projection of these sources may write, without their bodies: what planning paths
     * and links needs. The whole library when `wholeLibrary`; never truncated.
     */
    async noteRefs(sourceIds: string[], wholeLibrary = false): Promise<ProjectionNoteRef[]> {
      return (
        await pool.query<ProjectionNoteRef>(
          `select n.id,n.title,n.created_from_source_item_id as "sourceId",n.ownership,n.status,
        array(select source_id from atomic_note_evidence where note_id=n.id) as "sourceIds"
        from atomic_notes n where ${noteScopeSql} order by n.id`,
          [sourceIds, wholeLibrary]
        )
      ).rows;
    },
    /** The full rows of these notes, for rendering one page of a pass. */
    async noteDetails(ids: string[]) {
      if (!ids.length) return [];
      return (
        await pool.query(
          `select n.id,n.title,n.body_markdown as "bodyMarkdown",n.updated_at as "updatedAt",n.evidence_chunk_id as "evidenceChunkId",n.created_from_source_item_id as "sourceId",n.status,n.metadata,n.ownership, array(select source_id from atomic_note_evidence where note_id=n.id) as "sourceIds",array(select next_id from atomic_note_evolution where previous_id=n.id) as "successorIds",
        (n.supersession_status='current' and ${retainedNoteCurrentSql()} and nc.source_item_id=n.created_from_source_item_id and nd.id is not null and nd.metadata->>'supersededByDocumentId' is null
          and not exists(select 1 from atomic_note_source_links l left join chunks lc on lc.id=l.chunk_id left join documents ld on ld.id=lc.document_id
            where l.atomic_note_id=n.id and (ld.id is null or lc.source_item_id is distinct from l.source_item_id or ld.metadata->>'supersededByDocumentId' is not null))) as current
        from atomic_notes n left join chunks nc on nc.id=n.evidence_chunk_id left join documents nd on nd.id=nc.document_id
        where n.id=any($1::uuid[]) order by n.id`,
          [ids]
        )
      ).rows;
    },
    async noteEvidence(noteId: string, primaryChunkId: string) {
      return (await readNoteEvidence(pool, noteId, primaryChunkId)).map((e) => ({
        ...e,
        sourceId: e.sourceItemId,
        content: e.excerpt
      }));
    },
    /**
     * The source relations between these sources, without their evidence. Like the vault's note
     * links (applied relations only, D9), the wiki keeps suggestions out: they are reviewed in
     * Memora, and a suggestion the owner keeps is written on the next pass (decision 29).
     */
    async relationRefs(sourceIds: string[]) {
      return (
        await pool.query(
          `select r.*,a.title as "sourceTitle",b.title as "targetTitle",${currentSourceRelationSql} as current
        from source_relations r join source_items a on a.id=r.source_item_id join source_items b on b.id=r.target_source_item_id
        where r.source_item_id=any($1::uuid[]) and r.target_source_item_id=any($1::uuid[])
          and not ${suggestedSourceRelationSql("r")} order by r.id`,
          [sourceIds]
        )
      ).rows;
    },
    /** The evidence of one source relation, for rendering its file. */
    async relationEvidence(relationId: string) {
      return (
        await pool.query(
          `select e.id,e.origin,e.snapshot,${currentSourceRelationEvidenceSql} as current,
        sc.document_id as "sourceDocumentId",tc.document_id as "targetDocumentId",
        coalesce(ss.label,ss.selector,ss.page::text) as "sourceLocator",coalesce(ts.label,ts.selector,ts.page::text) as "targetLocator"
        from source_relation_evidence e ${sourceRelationEvidenceJoins}
        left join source_spans ss on ss.id=sc.source_span_id left join source_spans ts on ts.id=tc.source_span_id
        where e.relation_id=$1 order by e.created_at,e.id`,
          [relationId]
        )
      ).rows;
    },
    /**
     * What the topic maps of content are made of, read in one snapshot: the active tree, its live
     * topics, the retired topics that redirect to a successor and every primary placement by
     * centrality. Null when no tree is active.
     */
    async topicProjection(): Promise<TopicProjectionRows | null> {
      const db = await pool.connect();
      try {
        await db.query("begin isolation level repeatable read read only");
        const tree = (
          await db.query<{ id: string; generation: string; rootId: string }>(
            `select t.id,t.generation::text as generation,r.id as "rootId" from topic_trees t
          join topics r on r.tree_id=t.id and r.role='root' and r.retired_at is null
          where t.status='active' limit 1`
          )
        ).rows[0];
        if (!tree) {
          await db.query("commit");
          return null;
        }
        const topics = (
          await db.query<TopicProjectionTopic>(
            `select id,parent_id as "parentId",role,title,name_state as "nameState",aliases,description,position
          from topics where tree_id=$1 and retired_at is null order by position,id`,
            [tree.id]
          )
        ).rows;
        const redirects = (
          await db.query<{ id: string; title: string; redirectTo: string }>(
            `select id,title,redirect_to as "redirectTo" from topics
          where tree_id=$1 and retired_at is not null and redirect_to is not null and title is not null order by id`,
            [tree.id]
          )
        ).rows;
        const placements = (
          await db.query<TopicProjectionPlacement>(
            `select p.topic_id as "topicId",p.item_kind as kind,coalesce(p.note_id,p.source_item_id) as "itemId",
          p.root_source_item_id as "rootSourceId",(p.needs_gate or p.needs_split_check) as waiting
          from topic_placements p where p.tree_id=$1 and p.rank=0
          order by p.topic_id,p.centrality desc nulls last,p.id`,
            [tree.id]
          )
        ).rows;
        await db.query("commit");
        return {
          treeId: tree.id,
          generation: Number(tree.generation),
          rootId: tree.rootId,
          topics,
          redirects,
          placements
        };
      } catch (error) {
        await db.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        db.release();
      }
    },
    /** Which of these topics are live in the active tree: the retire pass never takes their files. */
    liveTopicIds,
    /** Whether a topic is still live in the active tree, read just before its map is written. */
    async topicLive(id: string) {
      return (await liveTopicIds([id])).length === 1;
    },
    async latest(memoraId: string, binding: string): Promise<ProjectionDelivery | null> {
      return (
        (
          await pool.query(
            "select * from obsidian_projection_revisions where memora_id=$1 and binding_hash=$2 order by created_at desc,id desc limit 1",
            [memoraId, binding]
          )
        ).rows[0] ?? null
      );
    },
    async base(memoraId: string, binding: string): Promise<ProjectionDelivery | null> {
      return (
        (
          await pool.query(
            "select * from obsidian_projection_revisions where memora_id=$1 and binding_hash=$2 and status='written' order by created_at desc,id desc limit 1",
            [memoraId, binding]
          )
        ).rows[0] ?? null
      );
    },
    async prepare(
      input: Omit<ProjectionDelivery, "id" | "status" | "error">
    ): Promise<ProjectionDelivery> {
      return (
        await pool.query(
          `insert into obsidian_projection_revisions(memora_id,revision_id,binding_hash,relative_path,content,editable_hash,generated_hash,rendered_hash,base_hash,before_content)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *`,
          [
            input.memora_id,
            input.revision_id,
            input.binding_hash,
            input.relative_path,
            input.content,
            input.editable_hash,
            input.generated_hash,
            input.rendered_hash,
            input.base_hash,
            input.before_content
          ]
        )
      ).rows[0];
    },
    async finish(id: string, status: string, error: string | null = null) {
      await pool.query("update obsidian_projection_revisions set status=$2,error=$3 where id=$1", [
        id,
        status,
        error
      ]);
    },
    async conflicts(binding: string) {
      return (
        await pool.query(
          `select distinct on(memora_id) id,memora_id,relative_path,status,error from obsidian_projection_revisions r
        where binding_hash=$1 and not exists(select 1 from obsidian_sync_files f where f.memora_id=r.memora_id and f.status::text='retired')
        order by memora_id,created_at desc,id desc`,
          [binding]
        )
      ).rows
        .filter((r) => ["conflict", "error"].includes(r.status))
        .slice(0, 100);
    },
    async getDelivery(id: string): Promise<ProjectionDelivery | null> {
      return (
        (await pool.query("select * from obsidian_projection_revisions where id=$1", [id]))
          .rows[0] ?? null
      );
    }
  };
}
