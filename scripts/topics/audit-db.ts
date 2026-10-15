// Reads a stored topic tree for the audit (F2 T17). Every statement is a plain SELECT, so the
// audit runs on a read-only session and the KPI collector can call it: nothing here can write.
// The rows are read in a few statements and checked against the tree's generation (the engine
// bumps it with every committed change-set); a tree that moves while it is read is read again.
import { TopicTreeConfigSchema, itemKey } from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";
import type { TopicItemKind, TopicManagement, TopicPlacementManagement } from "@app/domain";

import {
  TopicAuditError,
  analyzeTopicTree,
  defaultListLimit,
  defaultUndoWindowDays
} from "./audit-core.js";
import type { AuditInput, AuditPlacement, AuditTopic, TopicAuditReport } from "./audit-core.js";

/** The part of a driver the audit needs; a `pg` client or pool satisfies it. */
export interface AuditDb {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface AuditOptions {
  /** The tree to audit; the active tree when omitted. */
  treeId?: string | null;
  /** `auto` takes the Areas band for the root once an Areas change-set is applied (D12). */
  areas?: "auto" | "on" | "off";
  /** The instant the undo window ends at. */
  asOf?: Date;
  undoWindowDays?: number;
  /** Entries per detail list. */
  limit?: number;
  /** Reads before accepting a tree that keeps changing under the audit. */
  attempts?: number;
  now?: () => Date;
}

interface TreeRow {
  id: string;
  status: "active" | "retired";
  generation: string;
  config: unknown;
}

interface TopicRow {
  id: string;
  parent_id: string | null;
  role: "root" | "topic";
  title: string | null;
  management: TopicManagement;
  position: number;
  retired_at: Date | string | null;
  redirect_to: string | null;
}

interface PlacementRow {
  item_kind: TopicItemKind;
  item_id: string;
  topic_id: string;
  rank: number;
  management: TopicPlacementManagement;
  needs_gate: boolean;
  needs_split_check: boolean;
  needs_vector: boolean;
}

const treeSql = `select id::text as id, status, generation::text as generation, config
  from topic_trees`;
const generationSql = "select generation::text as generation from topic_trees where id = $1::uuid";
const topicsSql = `select id::text as id, parent_id::text as parent_id, role, title, management,
    position, retired_at, redirect_to::text as redirect_to
  from topics where tree_id = $1::uuid`;
const placementsSql = `select item_kind, coalesce(note_id, source_item_id)::text as item_id,
    topic_id::text as topic_id, rank, management, needs_gate, needs_split_check, needs_vector
  from topic_placements where tree_id = $1::uuid`;
// Current notes and root sources are what I1 expects (E1). A root source is any source without a parent.
const expectedNotesSql = `select id::text as id from atomic_notes
  where status::text not in ('rejected', 'archived') and supersession_status = 'current'`;
const expectedSourcesSql =
  "select id::text as id from source_items where parent_source_item_id is null";
const areasSql = `select exists (select 1 from topic_change_sets
    where tree_id = $1::uuid and origin = 'areas' and status = 'applied') as active`;
// Automatic change-sets are everything the engine applies on its own: not human, not an undo.
const undoSql = `select count(*) filter (where status in ('applied', 'undone'))::int as automatic,
    count(*) filter (where status = 'undone')::int as undone
  from topic_change_sets
  where tree_id = $1::uuid and origin not in ('human', 'undo') and applied_at is not null
    and applied_at > $2::timestamptz - make_interval(days => $3::int)
    and applied_at <= $2::timestamptz`;

const iso = (value: Date | string | null): string | null =>
  value === null ? null : new Date(value).toISOString();

async function readTree(db: AuditDb, treeId: string | null): Promise<TreeRow> {
  const { rows } =
    treeId === null
      ? await db.query<TreeRow>(`${treeSql} where status = 'active'`)
      : await db.query<TreeRow>(`${treeSql} where id = $1::uuid`, [treeId]);
  const tree = rows[0];
  if (!tree) {
    throw new TopicAuditError(
      treeId === null ? "There is no active topic tree." : "That topic tree does not exist."
    );
  }
  return tree;
}

async function readInput(
  db: AuditDb,
  tree: TreeRow,
  options: AuditOptions,
  asOf: Date
): Promise<Omit<AuditInput, "tree">> {
  const parsed = TopicTreeConfigSchema.safeParse(tree.config);
  if (!parsed.success) throw new TopicAuditError("The stored tree configuration is invalid.");

  const topics = (await db.query<TopicRow>(topicsSql, [tree.id])).rows.map((row): AuditTopic => ({
    id: row.id,
    parentId: row.parent_id,
    role: row.role,
    title: row.title,
    management: row.management,
    position: row.position,
    retiredAt: iso(row.retired_at),
    redirectTo: row.redirect_to
  }));
  const placements = (await db.query<PlacementRow>(placementsSql, [tree.id])).rows.map(
    (row): AuditPlacement => ({
      item: itemKey(row.item_kind, row.item_id),
      topicId: row.topic_id,
      rank: row.rank,
      management: row.management,
      needsGate: row.needs_gate,
      needsSplitCheck: row.needs_split_check,
      needsVector: row.needs_vector
    })
  );
  const expectedItems: ItemKey[] = [
    ...(await db.query<{ id: string }>(expectedNotesSql)).rows.map((row) =>
      itemKey("note", row.id)
    ),
    ...(await db.query<{ id: string }>(expectedSourcesSql)).rows.map((row) =>
      itemKey("source", row.id)
    )
  ];
  const areasMode = options.areas ?? "auto";
  const areasActive =
    areasMode === "auto"
      ? (await db.query<{ active: boolean }>(areasSql, [tree.id])).rows[0]?.active === true
      : areasMode === "on";
  const days = options.undoWindowDays ?? defaultUndoWindowDays;
  const undo = (
    await db.query<{ automatic: number; undone: number }>(undoSql, [
      tree.id,
      asOf.toISOString(),
      days
    ])
  ).rows[0];
  return {
    config: parsed.data,
    topics,
    placements,
    expectedItems,
    areasActive,
    undo: { days, automatic: undo?.automatic ?? 0, undone: undo?.undone ?? 0 }
  };
}

/** Reads and audits one tree. Throws `TopicAuditError` when there is no tree to audit. */
export async function auditDatabase(
  db: AuditDb,
  options: AuditOptions = {}
): Promise<TopicAuditReport> {
  const now = options.now ?? (() => new Date());
  const asOf = options.asOf ?? now();
  const attempts = Math.max(1, options.attempts ?? 3);
  let tree = await readTree(db, options.treeId ?? null);
  let input = await readInput(db, tree, options, asOf);
  let consistent: boolean;
  for (let attempt = 1; ; attempt += 1) {
    const after = (await db.query<{ generation: string }>(generationSql, [tree.id])).rows[0];
    consistent = after?.generation === tree.generation;
    if (consistent || attempt >= attempts) break;
    tree = await readTree(db, tree.id);
    input = await readInput(db, tree, options, asOf);
  }
  return analyzeTopicTree(
    {
      ...input,
      tree: {
        id: tree.id,
        status: tree.status,
        generation: Number(tree.generation),
        consistent
      }
    },
    { limit: options.limit ?? defaultListLimit, now: () => now().toISOString() }
  );
}
