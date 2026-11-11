// What the first-run end-to-end test (F4 T90) reads back from the library it just made: T1 (a note of
// the first source in a named topic with a shown relation), the models and their validation, the
// routes the Hybrid preset left, and whether the pipeline can still progress. Plain SELECTs; the
// verdict is `assertions.ts`. Relation visibility goes through the one module that owns it.
import {
  createAiConfigRepository,
  createLocalModelRepository,
  createSettingsRepository,
  noteRelationStateLabelSql,
  shownNoteRelationSql
} from "@app/db";
import type { PgPool } from "@app/db";

import { presetSettingKey } from "../ai-class-routes.js";
import { FirstRunRankerStateSchema, firstRunRankerSettingKey } from "../first-run-ranker.js";
import type { FirstRunRankerState } from "../first-run-ranker.js";
import type { FirstRunModelPlan } from "./models.js";

/** The note that settles T1: its topic, and one relation shown for it. */
export interface FirstSourceConnection {
  noteId: string;
  noteTitle: string;
  topicId: string;
  topicTitle: string;
  relationId: string;
  /** `applied`, `suggested` or `kept`: the states a shown relation can be in. */
  relationState: string;
  otherNoteId: string;
  /** Whether the other end sits in another source than the first. */
  crossSource: boolean;
}

/**
 * T1 as it stands now: a current note of the first source (a note of its own or of one of its
 * divisions) whose primary placement is a live, named topic of the active tree, with at least one
 * relation shown between current notes (applied or suggested, D9). A relation to another source is
 * preferred. Null while no note qualifies.
 */
export async function readFirstSourceConnection(
  pool: PgPool,
  firstRootId: string
): Promise<FirstSourceConnection | null> {
  const row = (
    await pool.query<{
      noteId: string;
      noteTitle: string;
      topicId: string;
      topicTitle: string;
      relationId: string;
      relationState: string;
      otherNoteId: string;
      crossSource: boolean;
    }>(
      `select n.id::text as "noteId", n.title as "noteTitle", t.id::text as "topicId",
         t.title as "topicTitle", r.id::text as "relationId",
         ${noteRelationStateLabelSql("r")} as "relationState", o.id::text as "otherNoteId",
         coalesce(os.parent_source_item_id, os.id) <> $1::uuid as "crossSource"
       from topic_trees tree
         join topic_placements p on p.tree_id = tree.id and p.item_kind = 'note' and p.rank = 0
         join topics t on t.id = p.topic_id and t.retired_at is null and t.role = 'topic'
           and t.name_state = 'named'
         join atomic_notes n on n.id = p.note_id
         join source_items ns on ns.id = n.created_from_source_item_id
         join atomic_note_relations r on n.id in (r.source_atomic_note_id, r.target_atomic_note_id)
         join atomic_notes o on o.id = case when r.source_atomic_note_id = n.id
           then r.target_atomic_note_id else r.source_atomic_note_id end
         join source_items os on os.id = o.created_from_source_item_id
       where tree.status = 'active' and coalesce(ns.parent_source_item_id, ns.id) = $1::uuid
         and ${shownNoteRelationSql("r", ["n", "o"])}
       order by (coalesce(os.parent_source_item_id, os.id) <> $1::uuid) desc, r.id
       limit 1`,
      [firstRootId]
    )
  ).rows[0];
  return row ?? null;
}

export interface RelationFacts {
  /** Relations shown (applied or suggested) between current notes. */
  shown: number;
  /** Of those, the ones between the two imported sources. */
  betweenSources: number;
  byState: Record<string, number>;
}

/** The shown relations of the library, and how many join the two sources. */
export async function readRelationFacts(
  pool: PgPool,
  roots: { first: string; second: string | null }
): Promise<RelationFacts> {
  const rows = (
    await pool.query<{ state: string; betweenSources: boolean; count: number }>(
      `select ${noteRelationStateLabelSql("r")} as state,
         (coalesce(ls.parent_source_item_id, ls.id) = $1::uuid
            and coalesce(hs.parent_source_item_id, hs.id) = $2::uuid)
           or (coalesce(ls.parent_source_item_id, ls.id) = $2::uuid
            and coalesce(hs.parent_source_item_id, hs.id) = $1::uuid) as "betweenSources",
         count(*)::int as count
       from atomic_note_relations r
         join atomic_notes lo on lo.id = r.source_atomic_note_id
         join atomic_notes hi on hi.id = r.target_atomic_note_id
         join source_items ls on ls.id = lo.created_from_source_item_id
         join source_items hs on hs.id = hi.created_from_source_item_id
       where ${shownNoteRelationSql("r", ["lo", "hi"])}
       group by 1, 2`,
      [roots.first, roots.second]
    )
  ).rows;
  const byState: Record<string, number> = {};
  let shown = 0;
  let betweenSources = 0;
  for (const row of rows) {
    shown += row.count;
    if (row.betweenSources) betweenSources += row.count;
    byState[row.state] = (byState[row.state] ?? 0) + row.count;
  }
  return { shown, betweenSources, byState };
}

export interface SourceFacts {
  rootId: string;
  title: string;
  /** Current notes of the root and of its divisions. */
  notes: number;
}

/** The notes of each imported source. */
export async function readSourceFacts(
  pool: PgPool,
  rootIds: readonly string[]
): Promise<SourceFacts[]> {
  const facts: SourceFacts[] = [];
  for (const rootId of rootIds) {
    const row = (
      await pool.query<{ title: string; notes: number }>(
        `select root.title as title,
           (select count(*)::int from atomic_notes n join source_items s on s.id = n.created_from_source_item_id
            where coalesce(s.parent_source_item_id, s.id) = root.id
              and n.status::text not in ('rejected', 'archived')
              and n.supersession_status = 'current') as notes
         from source_items root where root.id = $1::uuid`,
        [rootId]
      )
    ).rows[0];
    facts.push({ rootId, title: row?.title ?? "(missing)", notes: row?.notes ?? 0 });
  }
  return facts;
}

export interface ModelFacts {
  catalogId: string;
  runtime: "gguf" | "mlx" | null;
  status: string;
  installed: boolean;
  installedSizeBytes: number;
  /** A ranker passed the decide validation (it then exposes `reranking`). */
  validated: boolean;
  lastError: string | null;
}

/** The two first-run models as the library holds them. */
export async function readModelFacts(
  pool: PgPool,
  plan: FirstRunModelPlan
): Promise<{ embedding: ModelFacts; ranker: ModelFacts }> {
  const models = await createLocalModelRepository(pool).listModels();
  const facts = (catalogId: string): ModelFacts => {
    const model = models.find((candidate) => candidate.catalogId === catalogId);
    return {
      catalogId,
      runtime: model?.runtime ?? null,
      status: model?.status ?? "missing",
      installed: model?.status === "ready" && Boolean(model.managedPath),
      installedSizeBytes: model?.installedSizeBytes ?? 0,
      validated: model?.capabilities.includes("reranking") === true,
      lastError: model?.lastError ?? null
    };
  };
  return { embedding: facts(plan.embedding), ranker: facts(plan.ranker) };
}

/** Where the first-run ranker stands (the setting), null before it started. */
export async function readFirstRunRanker(pool: PgPool): Promise<FirstRunRankerState | null> {
  const parsed = FirstRunRankerStateSchema.safeParse(
    await createSettingsRepository(pool).get(firstRunRankerSettingKey)
  );
  return parsed.success ? parsed.data : null;
}

export type RouteRole = "writer" | "embedder" | "ranker" | "other";

export interface HybridRouteFacts {
  /** The preset mode stored (`hybrid` once applied). */
  preset: string | null;
  /** Task and class route keys to the kind of model they point at. */
  routes: Record<string, RouteRole>;
}

/** What the routes point at once the preset and the first-run ranker did their part. */
export async function readHybridRoutes(
  pool: PgPool,
  plan: FirstRunModelPlan
): Promise<HybridRouteFacts> {
  const config = createAiConfigRepository(pool);
  const [profiles, routes, models] = await Promise.all([
    config.listProfiles(),
    config.listTaskRoutes(),
    createLocalModelRepository(pool).listModels()
  ]);
  const roleOf = (profileId: string): RouteRole => {
    const profile = profiles.find((candidate) => candidate.id === profileId);
    if (!profile) return "other";
    if (profile.providerConfigId) return "writer";
    const model = models.find((candidate) => candidate.id === profile.localModelId);
    if (model?.catalogId === plan.embedding) return "embedder";
    if (model?.catalogId === plan.ranker) return "ranker";
    return "other";
  };
  const stored = await createSettingsRepository(pool).get(presetSettingKey);
  const mode = (stored as { mode?: unknown } | null)?.mode;
  return {
    preset: typeof mode === "string" ? mode : null,
    routes: Object.fromEntries(routes.map((route) => [route.task, roleOf(route.profileId)]))
  };
}

/** Jobs a blocker is holding now, by blocker class (empty when none): the status has a reason for each. */
export async function readBlockedJobs(pool: PgPool): Promise<Record<string, number>> {
  const rows = (
    await pool.query<{ blocked: string; count: number }>(
      `select blocked_class::text as blocked, count(*)::int as count from jobs
       where blocked_class is not null and status::text = 'queued' group by 1 order by 1`
    )
  ).rows;
  return Object.fromEntries(rows.map((row) => [row.blocked, row.count]));
}

/**
 * What a release job holds while it waits for the ranker (E6A2): the heavy lane (the job is on it,
 * so the queued divisions and their unfinished ingestion runs cannot move) and the topic jobs (the
 * barrier, so its light types cannot move either).
 */
export interface PipelineHold {
  heavyHeld: boolean;
  heldLightTypes: readonly string[];
}

/**
 * Whether anything can progress now: a job runs or is due, or an ingestion run has not ended. A job
 * a blocker set aside waits for its blocker, not for the lane, and the install of a model is not
 * the pipeline's work (it is what the pipeline may wait for). Nor are the `ignored` job types: the
 * harness's own topic release, which waits for the ranker and then for the light lane. Under a
 * `hold` only what can still move counts: a running job, or a due light job of a type not held.
 */
export async function readPipelineBusy(
  pool: PgPool,
  ignored: readonly string[] = [],
  hold?: PipelineHold
): Promise<boolean> {
  const heavyHeld = hold?.heavyHeld ?? false;
  const row = (
    await pool.query<{ n: number }>(
      `select (
         (select count(*) from jobs
           where type::text <> 'local-model-download' and type::text <> all($1::text[])
             and (status::text = 'running'
               or (status::text = 'queued' and blocked_class is null
                   and (run_after is null or run_after <= now())
                   and (not $2::boolean or (lane = 'light' and type::text <> all($3::text[]))))))
         + (select count(*) from ingestion_runs
             where not $2::boolean and status::text in ('pending', 'running'))
       )::int as n`,
      [[...ignored], heavyHeld, [...(hold?.heldLightTypes ?? [])]]
    )
  ).rows[0];
  return Number(row?.n ?? 0) > 0;
}

/** The end of a heavy job of a source, as a release boundary (a2) reads it. */
export interface BoundaryReading {
  /** The hierarchy root of the job's source. */
  rootId: string;
  /** The root's current notes (its own and its divisions'), or its embedded ones (`embedded`). */
  notes: number;
}

const boundaryNotes = {
  current: `select count(*)::int from atomic_notes n
      join source_items s on s.id = n.created_from_source_item_id
    where coalesce(s.parent_source_item_id, s.id) = root.id
      and n.status::text not in ('rejected', 'archived') and n.supersession_status = 'current'`,
  embedded: `select count(*)::int from jobs j join source_items s on s.id::text = j.payload->>'sourceItemId'
    where j.type::text = 'note-embedding' and j.status::text in ('running', 'succeeded')
      and coalesce(s.parent_source_item_id, s.id) = root.id`
} as const;

/**
 * What the end of a heavy job of `sourceItemId` tells the release policy: its root and that root's
 * notes. `current` counts the current notes, as the import's division just wrote them. `embedded`
 * counts the notes whose embedding job ran or is running (the self-test: its notes arrive seeded at
 * once and become placeable one embedding at a time; the job that ends is still running).
 */
export async function readBoundary(
  pool: PgPool,
  sourceItemId: string,
  count: keyof typeof boundaryNotes
): Promise<BoundaryReading | null> {
  const row = (
    await pool.query<BoundaryReading>(
      `select root.id::text as "rootId", (${boundaryNotes[count]}) as notes
       from source_items item
         join source_items root on root.id = coalesce(item.parent_source_item_id, item.id)
       where item.id = $1::uuid`,
      [sourceItemId]
    )
  ).rows[0];
  return row ?? null;
}

/**
 * The Gardener's tasks that wait at a moment nothing runs (E5 (i) on the first run): queued, whether
 * a blocker set them aside or they are due later. Such a task needs a sentence that names why.
 */
export async function heldGardenerTasks(pool: PgPool, kinds: readonly string[]): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select count(*)::int as n from jobs where status::text = 'queued' and type::text = any($1::text[])`,
    [[...kinds]]
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Queued or running jobs: the topic ones (the light lane) or everything else (the heavy work). */
export async function activeJobs(pool: PgPool, topic: boolean): Promise<number> {
  const result = await pool.query<{ n: number }>(
    `select count(*)::int as n from jobs
     where (status::text = 'running' or (status::text = 'queued' and blocked_class is null))
       and type::text <> 'local-model-download'
       and (type::text like 'topic-%') = $1`,
    [topic]
  );
  return Number(result.rows[0]?.n ?? 0);
}

/** Ingestion runs that have not ended: the heavy work of the imports is over only when none is left. */
export async function unfinishedRuns(pool: PgPool): Promise<number> {
  const result = await pool.query<{ n: number }>(
    "select count(*)::int as n from ingestion_runs where status::text in ('pending', 'running')"
  );
  return Number(result.rows[0]?.n ?? 0);
}
