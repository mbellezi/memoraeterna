import type { QueryResultRow } from "pg";

import type { TopicManagement, TopicNameSource, TopicNameState, TopicRole } from "@app/domain";
import { itemKey } from "@app/domain/topic-tree";
import type { ItemKey, TopicRecord } from "@app/domain/topic-tree";

import type { TopicLoadSpace } from "./topicTreeLoadRepository.js";
import type { Queryable } from "./types.js";

// What topic naming (F2 T18, D11) reads and the label vectors it stores. Reads only touch the
// topic tables: the engine remains their single writer (D9), and every name is written as a
// change-set through `topicTreeRepository`. Label vectors are not structure: they go to the
// per-dimension embedding tables as `target_type = 'topic_label'`, strategy
// `topic-label-v1:<space key>`, one row per topic and model, content-hashed by the label text.

/** Storage identity of topic label vectors: `topic-label-v1:<space key>`. */
export const topicLabelStrategyPrefix = "topic-label-v1:";
export const topicLabelTargetType = "topic_label";

/** Item ids per statement. */
const pageSize = 1_000;

/** What a naming prompt and the TF-IDF fallback read of an item. */
export interface TopicMemberText {
  kind: "note" | "source";
  title: string;
  /** The note's idea statement; null for a source. */
  idea: string | null;
  /** A BCP 47 code, or `und`. */
  language: string;
}

/** The current rows of some topics, for checking a name just before it is written. */
export interface TopicNamingRows {
  /** Null when the tree does not exist. */
  status: "active" | "retired" | null;
  generation: number;
  topics: Map<string, TopicRecord>;
  /** The live children of each of those topics' parents: id and title. */
  siblings: Map<string, Array<{ id: string; title: string | null }>>;
}

interface TopicRow extends QueryResultRow {
  id: string;
  parentId: string | null;
  role: TopicRole;
  title: string | null;
  nameState: TopicNameState;
  nameSource: TopicNameSource | null;
  nameLanguage: string | null;
  namedChangeSetId: string | null;
  description: string | null;
  aliases: unknown;
  management: TopicManagement;
  position: number | string;
  retiredAt: Date | string | null;
  redirectTo: string | null;
  createdChangeSetId: string | null;
}

const embeddingTable = (dimensions: number): string => {
  if (dimensions === 256 || dimensions === 768 || dimensions === 1024) {
    return `embeddings_${dimensions}`;
  }
  throw new RangeError(`Unsupported embedding dimension: ${dimensions}`);
};

const dimensionList = [256, 768, 1024] as const;

function toRecord(row: TopicRow): TopicRecord {
  return {
    id: row.id,
    parentId: row.parentId,
    role: row.role,
    title: row.title,
    nameState: row.nameState,
    nameSource: row.nameSource,
    nameLanguage: row.nameLanguage,
    namedChangeSetId: row.namedChangeSetId,
    description: row.description,
    aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
    management: row.management,
    position: Number(row.position),
    retiredAt: row.retiredAt === null ? null : new Date(row.retiredAt).toISOString(),
    redirectTo: row.redirectTo,
    createdChangeSetId: row.createdChangeSetId
  };
}

/** A `vector_send` payload (`int16 dim, int16 unused, float32 big-endian × dim`) as a unit vector. */
function decodeUnitVector(payload: Uint8Array, dimensions: number): Float32Array | null {
  const header = payload.byteLength >= 4 ? (payload[0]! << 8) | payload[1]! : -1;
  if (header !== dimensions || payload.byteLength !== 4 + dimensions * 4) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const vector = new Float32Array(dimensions);
  let sum = 0;
  for (let index = 0; index < dimensions; index += 1) {
    const value = view.getFloat32(4 + index * 4, false);
    if (!Number.isFinite(value)) return null;
    vector[index] = value;
    sum += value * value;
  }
  if (!(sum > 0)) return null;
  const scale = 1 / Math.sqrt(sum);
  for (let index = 0; index < dimensions; index += 1) {
    vector[index] = (vector[index] as number) * scale;
  }
  return vector;
}

function vectorLiteral(values: readonly number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new RangeError("Embedding contains a non-finite value.");
  }
  return `[${values.join(",")}]`;
}

export function createTopicNamingRepository(db: Queryable) {
  return {
    /**
     * Titles, ideas and languages of items, a page of ids per statement. An item that no longer
     * exists is missing from the result.
     */
    async memberTexts(
      items: ReadonlyArray<{ kind: "note" | "source"; id: string }>
    ): Promise<Map<ItemKey, TopicMemberText>> {
      const found = new Map<ItemKey, TopicMemberText>();
      for (const kind of ["note", "source"] as const) {
        const ids = [...new Set(items.filter((item) => item.kind === kind).map((i) => i.id))];
        for (let start = 0; start < ids.length; start += pageSize) {
          const page = ids.slice(start, start + pageSize).map((id) => id.toLowerCase());
          if (kind === "note") {
            const result = await db.query<
              QueryResultRow & { id: string; title: string; idea: string; language: string }
            >(
              `select id, title, idea_statement as idea, language
                 from atomic_notes where id = any($1::uuid[])`,
              [page]
            );
            for (const row of result.rows) {
              found.set(itemKey("note", row.id), {
                kind: "note",
                title: row.title,
                idea: row.idea,
                language: row.language
              });
            }
          } else {
            const result = await db.query<
              QueryResultRow & { id: string; title: string; language: string }
            >(`select id, title, language from source_items where id = any($1::uuid[])`, [page]);
            for (const row of result.rows) {
              found.set(itemKey("source", row.id), {
                kind: "source",
                title: row.title,
                idea: null,
                language: row.language
              });
            }
          }
        }
      }
      return found;
    },

    /** The `summary` of change-sets (a naming change-set keeps its members' sketches there). */
    async changeSetSummaries(ids: readonly string[]): Promise<Map<string, unknown>> {
      const found = new Map<string, unknown>();
      const unique = [...new Set(ids)];
      for (let start = 0; start < unique.length; start += pageSize) {
        const result = await db.query<QueryResultRow & { id: string; summary: unknown }>(
          "select id, summary from topic_change_sets where id = any($1::uuid[])",
          [unique.slice(start, start + pageSize)]
        );
        for (const row of result.rows) found.set(row.id, row.summary);
      }
      return found;
    },

    /**
     * The stored rows of some topics, the live children of their parents and the tree's
     * generation: what a name is checked against right before it is written.
     */
    async topicRows(treeId: string, ids: readonly string[]): Promise<TopicNamingRows> {
      const tree = await db.query<
        QueryResultRow & { status: "active" | "retired"; generation: string }
      >("select status, generation::text as generation from topic_trees where id = $1", [treeId]);
      const head = tree.rows[0];
      if (!head) return { status: null, generation: 0, topics: new Map(), siblings: new Map() };
      const topics = new Map<string, TopicRecord>();
      const columns = `id, parent_id as "parentId", role, title, name_state as "nameState",
        name_source as "nameSource", name_language as "nameLanguage",
        named_change_set_id as "namedChangeSetId", description, aliases, management, position,
        retired_at as "retiredAt", redirect_to as "redirectTo",
        created_change_set_id as "createdChangeSetId"`;
      const unique = [...new Set(ids)];
      for (let start = 0; start < unique.length; start += pageSize) {
        const result = await db.query<TopicRow>(
          `select ${columns} from topics where tree_id = $1 and id = any($2::uuid[])`,
          [treeId, unique.slice(start, start + pageSize)]
        );
        for (const row of result.rows) topics.set(row.id, toRecord(row));
      }
      const parents = [
        ...new Set(
          [...topics.values()].flatMap((topic) => (topic.parentId ? [topic.parentId] : []))
        )
      ];
      const siblings = new Map<string, Array<{ id: string; title: string | null }>>();
      for (let start = 0; start < parents.length; start += pageSize) {
        const result = await db.query<
          QueryResultRow & { id: string; parentId: string; title: string | null }
        >(
          `select id, parent_id as "parentId", title from topics
            where tree_id = $1 and parent_id = any($2::uuid[]) and retired_at is null
            order by parent_id, id`,
          [treeId, parents.slice(start, start + pageSize)]
        );
        for (const row of result.rows) {
          const list = siblings.get(row.parentId) ?? [];
          list.push({ id: row.id, title: row.title });
          siblings.set(row.parentId, list);
        }
      }
      return { status: head.status, generation: Number(head.generation), topics, siblings };
    },

    /**
     * How many AI-managed topics of the tree wait for a name (unnamed or provisional) and how many
     * carry an LLM name that a membership drift could replace.
     */
    async namingNeeds(treeId: string): Promise<{ pending: number; llmNamed: number }> {
      const result = await db.query<QueryResultRow & { pending: string; llmNamed: string }>(
        `select count(*) filter (where name_state <> 'named') as pending,
                count(*) filter (where name_state = 'named' and name_source = 'llm') as "llmNamed"
           from topics
          where tree_id = $1 and retired_at is null and role = 'topic' and management = 'ai'
            and name_source is distinct from 'human'`,
        [treeId]
      );
      const row = result.rows[0];
      return { pending: Number(row?.pending ?? 0), llmNamed: Number(row?.llmNamed ?? 0) };
    },

    /** The AI-managed topics that wait for a name (unnamed or provisional), in ID order. */
    async pendingNamingTopicIds(treeId: string): Promise<string[]> {
      const result = await db.query<QueryResultRow & { id: string }>(
        `select id from topics
          where tree_id = $1 and retired_at is null and role = 'topic' and management = 'ai'
            and name_source is distinct from 'human' and name_state <> 'named'
          order by id`,
        [treeId]
      );
      return result.rows.map((row) => row.id);
    },

    /** The live titled topics of a tree with what their label embeds, and the retired topics' IDs. */
    async labelSources(treeId: string): Promise<{
      live: Array<{ id: string; title: string; aliases: string[]; description: string | null }>;
      retired: string[];
    }> {
      const result = await db.query<
        QueryResultRow & {
          id: string;
          title: string | null;
          aliases: unknown;
          description: string | null;
          retired: boolean;
        }
      >(
        `select id, title, aliases, description, retired_at is not null as retired
           from topics
          where tree_id = $1 and role = 'topic' and (title is not null or retired_at is not null)
          order by id`,
        [treeId]
      );
      const live: Array<{
        id: string;
        title: string;
        aliases: string[];
        description: string | null;
      }> = [];
      const retired: string[] = [];
      for (const row of result.rows) {
        if (row.retired) retired.push(row.id);
        else if (row.title !== null) {
          live.push({
            id: row.id,
            title: row.title,
            aliases: Array.isArray(row.aliases) ? row.aliases.map(String) : [],
            description: row.description
          });
        }
      }
      return { live, retired };
    },

    /**
     * Stores a topic's label vector in the tree's space (one row per topic and model). The caller
     * has checked that the vector was made in this space.
     */
    async upsertTopicLabel(input: {
      topicId: string;
      space: TopicLoadSpace;
      contentHash: string;
      embedding: readonly number[];
    }): Promise<void> {
      if (input.embedding.length !== input.space.dimensions) {
        throw new RangeError(
          `A label vector has ${input.embedding.length} dimensions, the tree's space has ${input.space.dimensions}.`
        );
      }
      const table = embeddingTable(input.space.dimensions);
      await db.query(
        `insert into ${table} (target_type, target_id, chunk_id, provider, model, runtime, usage,
                               strategy, content_hash, embedding)
         values ($1, $2, null, $3, $4, $5, 'topic', $6, $7, $8::vector)
         on conflict (target_type, target_id, model) do update set
           provider = excluded.provider, runtime = excluded.runtime, usage = excluded.usage,
           strategy = excluded.strategy, content_hash = excluded.content_hash,
           embedding = excluded.embedding, created_at = now()`,
        [
          topicLabelTargetType,
          input.topicId,
          input.space.provider,
          input.space.model,
          input.space.runtime,
          `${topicLabelStrategyPrefix}${input.space.spaceKey}`,
          input.contentHash,
          vectorLiteral(input.embedding)
        ]
      );
    },

    /** The label text hash each of these topics' stored label vector in the space was made from. */
    async topicLabelHashes(
      space: TopicLoadSpace,
      topicIds: readonly string[]
    ): Promise<Map<string, string>> {
      const found = new Map<string, string>();
      const table = embeddingTable(space.dimensions);
      const unique = [...new Set(topicIds)];
      for (let start = 0; start < unique.length; start += pageSize) {
        const result = await db.query<QueryResultRow & { id: string; hash: string }>(
          `select target_id as id, content_hash as hash from ${table}
            where target_type = $1 and target_id = any($2::uuid[]) and model = $3 and strategy = $4`,
          [
            topicLabelTargetType,
            unique.slice(start, start + pageSize),
            space.model,
            `${topicLabelStrategyPrefix}${space.spaceKey}`
          ]
        );
        for (const row of result.rows) found.set(row.id, row.hash);
      }
      return found;
    },

    /** The stored label vectors of these topics in the space, unit length, with their text hashes. */
    async loadTopicLabels(
      space: TopicLoadSpace,
      topicIds: readonly string[]
    ): Promise<Map<string, { vector: Float32Array; textHash: string }>> {
      const found = new Map<string, { vector: Float32Array; textHash: string }>();
      const table = embeddingTable(space.dimensions);
      const unique = [...new Set(topicIds)];
      for (let start = 0; start < unique.length; start += pageSize) {
        const result = await db.query<
          QueryResultRow & { id: string; hash: string; vector: Buffer }
        >(
          `select target_id as id, content_hash as hash, vector_send(embedding) as vector
             from ${table}
            where target_type = $1 and target_id = any($2::uuid[]) and model = $3 and strategy = $4`,
          [
            topicLabelTargetType,
            unique.slice(start, start + pageSize),
            space.model,
            `${topicLabelStrategyPrefix}${space.spaceKey}`
          ]
        );
        for (const row of result.rows) {
          const vector = decodeUnitVector(row.vector, space.dimensions);
          if (vector) found.set(row.id, { vector, textHash: row.hash });
        }
      }
      return found;
    },

    /** Removes the label vectors of these topics in every dimension (retired topics). */
    async deleteTopicLabels(topicIds: readonly string[]): Promise<number> {
      const unique = [...new Set(topicIds)];
      if (unique.length === 0) return 0;
      let removed = 0;
      for (const dimensions of dimensionList) {
        const result = await db.query(
          `delete from ${embeddingTable(dimensions)}
            where target_type = $1 and target_id = any($2::uuid[])`,
          [topicLabelTargetType, unique]
        );
        removed += result.rowCount ?? 0;
      }
      return removed;
    }
  };
}

export type TopicNamingRepository = ReturnType<typeof createTopicNamingRepository>;
