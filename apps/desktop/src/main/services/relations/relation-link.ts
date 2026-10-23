// The link job of relations v2 (F3 D20, D21, D24; spec 3.11). A source's heavy ingestion job
// decides its notes (relation-matcher.ts) and keeps the accepted pairs in its matching checkpoint,
// parks its `sourceMatching` stage with reason `linking` and queues `relation-link:<rootId>` on the
// light `relations` worker. The link job then, each step committing before the next:
//   1. collects the accepted pairs of the root's parked runs that have no relation yet, and the
//      root's untyped relations (typed later by its next link job, D20);
//   2. types them (relation-typing.ts) under the in-flight registry and the daily cap, coalescing
//      a small source with other due link jobs' pairs (product only);
//   3. persists them in one transaction: one `link` run, one event per change (D14);
//   4. pushes `relationsChanged` for the notes it changed;
//   5. promotes (T53) and discovers the root's source relations (at the daily cap, the root's
//      link job is queued again for the next local day to discover them, D26);
//   6. completes the parked runs: a run completes when its link job does.
// A failing link job never holds back another root's: each root has its own job, and a failure
// ends only the runs it was linking, which stay retryable.
import { z } from "zod";

import { sha256 } from "@app/conversion";
import {
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createIngestionRunRepository,
  createJobRepository,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  currentNoteEndpointsSql,
  immediateJobDebounce,
  noteRelationStateSql,
  relationDecisionPair,
  withTransaction,
  type AtomicNoteRecord,
  type IngestionRunRecord,
  type JobRecord,
  type JsonObject,
  type NoteRelationUpsert,
  type PgPool,
  type Queryable
} from "@app/db";
import {
  automaticNoteRelationDirection,
  DecisionsFallbackReasonSchema,
  NoteDeciderModeSchema,
  NoteRelationBandSchema,
  NoteRelationWriteTypeSchema,
  relationsConfig as defaultRelationsConfig,
  renderRelationPairText,
  type BudgetClass,
  type RelationsConfig
} from "@app/domain";

import type { AiPriorityInput } from "../ai-priority.js";
import type { AiTaskLogContext } from "../ai-service.js";
import type { LightJobExecutor, LightJobRegistry } from "../job-lanes.js";
import type { InFlightRegistry } from "./in-flight-registry.js";
import { relationLinkRuntime, type RelationLinkRuntime } from "./link-runtime.js";
import {
  nextLocalDay,
  relationDailyCapError,
  type RelationCallBudget
} from "./relation-call-budget.js";
import { relationMatcherVersion } from "./relation-matcher.js";
import type {
  PairTyping,
  RelationTypingOptions,
  RelationTypingResult,
  TypingPair
} from "./relation-typing.js";

export const relationLinkJobType = "relation-link";
/** The untyped re-typing sweep (D20): daily, at P3, under the cap. */
export const relationRetypeJobType = "relation-retype";
/** Re-promotion of one root's source relations after a typing outside its link job (R14, T53). */
export const relationPromoteJobType = "relation-promote";

export const relationLinkDedupeKey = (rootId: string) => `relation-link:${rootId}`;
export const relationPromoteDedupeKey = (rootId: string) => `relation-promote:${rootId}`;
export const relationRetypeDedupeKey = "relation-retype";

/** Untyped relations one sweep step types before it queues its next step. */
const sweepPageSize = 96;
/** Untyped relations of a root a link job types again. */
const rootUntypedLimit = 96;
/** Other due link jobs a small source looks at for pairs to coalesce. */
const coalesceJobLimit = 20;

// --- what a run hands on --------------------------------------------------------------------------

const DecidedPairSchema = z
  .object({
    noteId: z.string().min(1),
    candidateId: z.string().min(1),
    candidateSourceItemId: z.string().min(1),
    band: NoteRelationBandSchema,
    probability: z.number().min(0).max(1).nullable(),
    score: z.number().finite(),
    calibration: z.enum(["frozen", "provisional", "uncalibrated"]),
    relationType: NoteRelationWriteTypeSchema.nullable(),
    subjectId: z.string().min(1).nullable(),
    // The Decisions decider's clear direction (decision 31b); absent in a checkpoint written before.
    directionSubjectId: z.string().min(1).nullable().optional(),
    decisionSource: z.enum(["model", "cache", "reverse_cache"]),
    vectorScore: z.number().finite().nullable(),
    graphScore: z.number().finite().nullable()
  })
  .strict();

/**
 * A decided note with its accepted pairs, as the matching checkpoint keeps it until the link job
 * persists them (D21: no relation row before the link job commits). The matcher's `DecidedNote`.
 */
const StoredDeciderBaseSchema = z.object({
  mode: NoteDeciderModeSchema,
  deciderKey: z.string().min(1),
  calibration: z.enum(["frozen", "provisional", "uncalibrated"]),
  modelId: z.string().min(1)
});
export const StoredDecidedNoteSchema = z
  .object({
    noteId: z.string().min(1),
    sourceItemId: z.string().min(1),
    decider: z.discriminatedUnion("kind", [
      // A local decider has a profile; when it decided in place of the Decisions API, the reason.
      StoredDeciderBaseSchema.extend({
        kind: z.enum(["ranker", "generative"]),
        profileId: z.string().min(1),
        fallback: DecisionsFallbackReasonSchema.optional()
      }).strict(),
      // The Decisions API is remote and opt-in (plan decision 30): it has no profile row.
      StoredDeciderBaseSchema.extend({ kind: z.literal("decisions"), profileId: z.null() }).strict()
    ]),
    pairs: z.array(DecidedPairSchema).max(100)
  })
  .strict();
export type StoredDecidedNote = z.infer<typeof StoredDecidedNoteSchema>;
type StoredDecidedPair = StoredDecidedNote["pairs"][number];

/** The decided notes a run's matching checkpoint holds; an entry that does not parse is skipped. */
export function decidedNotesOf(
  run: Pick<IngestionRunRecord, "stagesCheckpoint">
): StoredDecidedNote[] {
  const stage = run.stagesCheckpoint.atomicNoteMatching;
  const metadata =
    typeof stage === "object" && stage !== null && "metadata" in stage ? stage.metadata : null;
  const decided =
    typeof metadata === "object" && metadata !== null && "decided" in metadata
      ? metadata.decided
      : null;
  return parseDecidedNotes(decided);
}

/**
 * The decided notes a re-match run's link job carries (F3 T52b, 3.17): the harness decides a root's
 * records outside any ingestion run, so no run parks for them and the job's payload holds them.
 */
export function decidedNotesOfJob(job: Pick<JobRecord, "payload">): StoredDecidedNote[] {
  return parseDecidedNotes(job.payload.decided);
}

function parseDecidedNotes(decided: unknown): StoredDecidedNote[] {
  if (!Array.isArray(decided)) return [];
  return decided.flatMap((entry) => {
    const parsed = StoredDecidedNoteSchema.safeParse(entry);
    return parsed.success ? [parsed.data] : [];
  });
}

/** The runs of an interactive import, and so its link job, run at P1 (D30). */
export function isInteractiveRun(run: Pick<IngestionRunRecord, "trigger">): boolean {
  return run.trigger === "interactive_import";
}

/**
 * Who a link job spends for (F4 D14): the imports whose runs parked for it (`user`, counted and
 * never refused); a job with no parked run (a re-match's carried notes, a discovery the daily cap
 * deferred) is background work, metered and refused at the remote caps.
 */
export function linkJobBudgetClass(runs: readonly unknown[]): BudgetClass {
  return runs.length > 0 ? "user" : "background";
}

/**
 * Whether a parked run asked for source relations: its plan has the source stage (a legacy run,
 * with no stored plan, runs every stage). A run whose plan stops at note matching parks only for
 * its note pairs to be persisted (D21); its link job discovers nothing for it.
 */
export function requestsSourceDiscovery(run: Pick<IngestionRunRecord, "effectiveStages">): boolean {
  return run.effectiveStages.length === 0 || run.effectiveStages.includes("sourceMatching");
}

// --- the steps the knowledge service provides -----------------------------------------------------

export interface RelationDiscoveryInput {
  rootId: string;
  /** The run state key of the judging pass: the link job's, so a retry resumes it. */
  runKey: string;
  regenerate: boolean;
  priority: AiPriorityInput;
  /** Who the judge's calls spend for (F4 D14): `user` for an imported source's own link job. */
  budgetClass: BudgetClass;
  /** Asked before every remote call; false stops the pass (`relationDailyCapError`). */
  reserveCall: (lane: "local" | "remote") => Promise<boolean>;
  /** The link jobs' in-flight registry: a pair another job is judging is judged once (D24). */
  registry: InFlightRegistry;
  context: AiTaskLogContext;
}

export interface RelationLinkSteps {
  /** Types accepted pairs with the writer (`relations.type`, D20); never fails for typing. */
  typeRelationPairs: (
    pairs: readonly TypingPair[],
    options: RelationTypingOptions,
    signal?: AbortSignal
  ) => Promise<RelationTypingResult>;
  /**
   * Discovers and judges the root's source relations by design E (T53, D27): promotion, then
   * nearest-root discovery with each selected pair judged once.
   */
  discoverSourceRelations: (
    input: RelationDiscoveryInput,
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
  /** Promotes the typed shown note relations of these roots to source relations (T53, D27). */
  promoteSourceRelations?: (
    rootIds: readonly string[],
    signal?: AbortSignal
  ) => Promise<Record<string, unknown>>;
}

export interface RelationLinkDeps {
  getPool: () => PgPool;
  steps: RelationLinkSteps;
  registry: InFlightRegistry;
  budget: RelationCallBudget;
  config?: RelationsConfig;
  runtime?: () => Readonly<RelationLinkRuntime>;
  /** The notes whose relations a commit changed (the `relationsChanged` push). */
  relationsChanged?: (noteIds: Iterable<string>) => void;
  /** Runs a link job completed or failed: their batches are refreshed and the views notified. */
  runsSettled?: (runs: readonly IngestionRunRecord[]) => Promise<void>;
  logger?: Pick<Console, "warn">;
}

// --- queueing -------------------------------------------------------------------------------------

/**
 * Queues the link job of a root, or makes the queued one due now (a running one never absorbs a
 * request: it may have read its runs already, so a new job is queued beside it). The link job of an
 * interactive import is claimed before background ones (D30: `jobs.priority` 1). `discovery` asks
 * the job to discover the root's source relations even with no parked run, from `notBefore` on:
 * discovery the daily cap deferred (D26).
 */
export async function enqueueRelationLink(
  db: Queryable,
  input: {
    rootId: string;
    batchId?: string | null;
    interactive?: boolean;
    discovery?: { regenerate: boolean; notBefore: Date };
  }
): Promise<JobRecord> {
  const discovery = input.discovery
    ? { discover: true, ...(input.discovery.regenerate ? { regenerate: true } : {}) }
    : null;
  const delayMs = input.discovery
    ? Math.max(0, input.discovery.notBefore.getTime() - Date.now())
    : 0;
  const { job, created } = await createJobRepository(db).enqueueDeduped({
    type: relationLinkJobType,
    lane: "light",
    dedupeKey: relationLinkDedupeKey(input.rootId),
    // The root as `sourceItemId` too: cancelling or deleting the source reaches the job (F4 D6).
    payload: {
      rootId: input.rootId,
      sourceItemId: input.rootId,
      ...(input.batchId ? { batchId: input.batchId } : {}),
      ...discovery
    },
    priority: input.interactive ? 1 : 0,
    debounce: delayMs > 0 ? { delayMs, maxDelayMs: delayMs } : immediateJobDebounce,
    maxAttempts: 3
  });
  if (
    !discovery ||
    created ||
    (job.payload.discover === true && (!discovery.regenerate || job.payload.regenerate === true))
  )
    return job;
  // A queued job keeps its payload when a request merges into it: it is told to discover too.
  const patched = await db.query<{ payload: JsonObject }>(
    `update jobs set payload = payload || $2::jsonb, updated_at = now()
     where id = $1 and status = 'queued' returning payload`,
    [job.id, JSON.stringify(discovery)]
  );
  const payload = patched.rows[0]?.payload;
  // Claimed meanwhile: it read its payload already, so the request is queued beside it.
  return payload ? { ...job, payload } : enqueueRelationLink(db, input);
}

/**
 * Queues the link job of a root a re-match run decided (F3 T52b, 3.17). The run decides the root's
 * records outside any ingestion run, so the job carries their decided notes in its payload and is
 * told to discover with no parked run; a queued job of the root takes the notes in beside its own.
 */
export async function enqueueRematchLink(
  db: Queryable,
  input: { rootId: string; decided: readonly StoredDecidedNote[] }
): Promise<JobRecord> {
  const decided = input.decided.map((note) => StoredDecidedNoteSchema.parse(note));
  const { job, created } = await createJobRepository(db).enqueueDeduped({
    type: relationLinkJobType,
    lane: "light",
    dedupeKey: relationLinkDedupeKey(input.rootId),
    payload: {
      rootId: input.rootId,
      sourceItemId: input.rootId,
      rematch: true,
      discover: true,
      decided: decided as unknown as JsonObject[]
    },
    debounce: immediateJobDebounce,
    maxAttempts: 3
  });
  if (created) return job;
  const patched = await db.query<{ payload: JsonObject }>(
    `update jobs set payload = payload || jsonb_build_object('rematch', true, 'discover', true,
       'decided', coalesce(payload -> 'decided', '[]'::jsonb) || $2::jsonb), updated_at = now()
     where id = $1 and status = 'queued' returning payload`,
    [job.id, JSON.stringify(decided)]
  );
  const payload = patched.rows[0]?.payload;
  // Claimed meanwhile: it read its payload already, so the notes are queued beside it.
  return payload ? { ...job, payload } : enqueueRematchLink(db, input);
}

/** The root of a source item's tree (the item itself when it has no parent or is gone). */
export async function linkRootOf(db: Queryable, sourceItemId: string): Promise<string> {
  const result = await db.query<{ id: string }>(
    `with recursive up as (
       select id, parent_source_item_id, 0 as depth from source_items where id = $1::uuid
       union all
       select parent.id, parent.parent_source_item_id, up.depth + 1
       from source_items parent join up on parent.id = up.parent_source_item_id
       where up.depth < 64
     )
     select id from up order by depth desc limit 1`,
    [sourceItemId]
  );
  return result.rows[0]?.id ?? sourceItemId;
}

async function linkRootsOf(
  db: Queryable,
  sourceItemIds: Iterable<string>,
  cache: Map<string, string>
): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const id of sourceItemIds) {
    let root = cache.get(id);
    if (!root) {
      root = await linkRootOf(db, id);
      cache.set(id, root);
    }
    roots.add(root);
  }
  return roots;
}

// --- collecting -----------------------------------------------------------------------------------

/** An accepted pair waiting for its link job. */
interface PendingPair {
  key: string;
  lo: string;
  hi: string;
  pair: StoredDecidedPair;
  decider: StoredDecidedNote["decider"];
  /** The source items of the decided note and of its candidate. */
  sourceItemIds: readonly [string, string];
}

/** An untyped relation to type again (D20). */
interface UntypedRelation {
  id: string;
  key: string;
  lo: string;
  hi: string;
  band: "apply" | "suggest";
  upsert: Omit<NoteRelationUpsert, "relationType" | "direction" | "typerKey" | "runId">;
  sourceItemIds: readonly [string, string];
}

const isCurrentNote = (note: AtomicNoteRecord | null): note is AtomicNoteRecord =>
  note !== null &&
  note.status !== "rejected" &&
  note.status !== "archived" &&
  note.supersessionStatus === "current";

/** The accepted pairs of these runs, in decide order, once each, with no relation row yet. */
async function collectPending(
  db: Queryable,
  runs: readonly IngestionRunRecord[],
  carried: readonly StoredDecidedNote[] = []
): Promise<PendingPair[]> {
  const pending = new Map<string, PendingPair>();
  for (const note of [...runs.flatMap((run) => decidedNotesOf(run)), ...carried])
    for (const pair of note.pairs) {
      const noteId = pair.noteId.toLowerCase(),
        candidateId = pair.candidateId.toLowerCase();
      if (noteId === candidateId) continue;
      const { lo, hi, key } = relationDecisionPair(noteId, candidateId);
      if (pending.has(key)) continue;
      pending.set(key, {
        key,
        lo,
        hi,
        pair,
        decider: note.decider,
        sourceItemIds: [note.sourceItemId, pair.candidateSourceItemId]
      });
    }
  if (pending.size === 0) return [];
  const values = [...pending.values()];
  const related = await existingPairKeys(db, values);
  return values.filter((pair) => !related.has(pair.key));
}

/** The keys of the pairs that have a relation row already (any state). */
async function existingPairKeys(
  db: Queryable,
  pairs: ReadonlyArray<{ lo: string; hi: string }>
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const existing = await db.query<{ key: string }>(
    `select r.source_atomic_note_id::text || ':' || r.target_atomic_note_id::text as key
     from atomic_note_relations r
     join unnest($1::uuid[], $2::uuid[]) as wanted(lo, hi)
       on r.source_atomic_note_id = wanted.lo and r.target_atomic_note_id = wanted.hi`,
    [pairs.map((pair) => pair.lo), pairs.map((pair) => pair.hi)]
  );
  return new Set(existing.rows.map((row) => row.key));
}

/** The keys of the pairs a typer `none` vetoed already (a `vetoed` event with no relation, D20). */
async function vetoedPairKeys(db: Queryable, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const vetoed = await db.query<{ key: string }>(
    `select distinct pair_key as key from relation_events
     where relation_kind = 'note' and kind = 'vetoed' and relation_id is null
       and pair_key = any($1::text[])`,
    [[...keys]]
  );
  return new Set(vetoed.rows.map((row) => row.key));
}

interface UntypedRow {
  id: string;
  lo: string;
  hi: string;
  band: "apply" | "suggest";
  probability: number | null;
  deciderKey: string | null;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: JsonObject;
  loSourceItemId: string;
  hiSourceItemId: string;
}

/**
 * Untyped relations between current notes with no human verdict and no veto (D20): of the tree
 * under `rootId`, or of the whole library, in ID order (a sweep pages on it).
 */
async function listUntyped(
  db: Queryable,
  input: { rootId: string | null; limit: number; afterId?: string | null }
): Promise<UntypedRelation[]> {
  const result = await db.query<UntypedRow>(
    `with recursive link_tree as (
       select id from source_items where id = $1::uuid
       union all
       select child.id from source_items child join link_tree parent on child.parent_source_item_id = parent.id
     )
     select r.id, r.source_atomic_note_id as lo, r.target_atomic_note_id as hi, r.band,
            r.probability, r.decider_key as "deciderKey", r.vector_score as "vectorScore",
            r.graph_score as "graphScore", r.rerank_score as "rerankScore",
            r.final_score as "finalScore", r.explanation,
            r.matching_profile_id as "matchingProfileId", r.matching_model as "matchingModel",
            r.metadata, lo_note.created_from_source_item_id as "loSourceItemId",
            hi_note.created_from_source_item_id as "hiSourceItemId"
     from atomic_note_relations r
     join atomic_notes lo_note on lo_note.id = r.source_atomic_note_id
     join atomic_notes hi_note on hi_note.id = r.target_atomic_note_id
     where r.relation_type is null and ${noteRelationStateSql.vetoable("r")}
       and ${currentNoteEndpointsSql("r", ["lo_note", "hi_note"])}
       and ($1::uuid is null
            or lo_note.created_from_source_item_id in (select id from link_tree)
            or hi_note.created_from_source_item_id in (select id from link_tree))
       and ($3::uuid is null or r.id > $3::uuid)
     order by r.id
     limit $2`,
    [input.rootId, input.limit, input.afterId ?? null]
  );
  return result.rows.map((row) => ({
    id: row.id,
    key: `${row.lo}:${row.hi}`,
    lo: row.lo,
    hi: row.hi,
    band: row.band,
    upsert: {
      loAtomicNoteId: row.lo,
      hiAtomicNoteId: row.hi,
      band: row.band,
      probability: row.probability === null ? null : Number(row.probability),
      deciderKey: row.deciderKey,
      vectorScore: row.vectorScore === null ? null : Number(row.vectorScore),
      graphScore: row.graphScore === null ? null : Number(row.graphScore),
      rerankScore: row.rerankScore === null ? null : Number(row.rerankScore),
      finalScore: Number(row.finalScore),
      explanation: row.explanation,
      matchingProfileId: row.matchingProfileId,
      matchingModel: row.matchingModel,
      metadata: row.metadata
    },
    sourceItemIds: [row.loSourceItemId, row.hiSourceItemId]
  }));
}

// --- typing ---------------------------------------------------------------------------------------

/** Loads notes once per job; null for a note that is gone. */
function noteLoader(db: Queryable) {
  const notes = createAtomicNoteRepository(db);
  const cache = new Map<string, Promise<AtomicNoteRecord | null>>();
  return (id: string) => {
    let found = cache.get(id);
    if (!found) {
      found = notes.findById(id);
      cache.set(id, found);
    }
    return found;
  };
}

interface TypingRequest {
  key: string;
  pair: TypingPair;
  /** The two notes' source items (the calls' monitoring context). */
  sourceItemIds: readonly [string, string];
}

/** The typing pair of two current notes, with the decider's rendered text (D13, D20); else null. */
async function typingRequest(
  load: (id: string) => Promise<AtomicNoteRecord | null>,
  input: { key: string; lo: string; hi: string; band: "apply" | "suggest" },
  bodyCharacters: number
): Promise<TypingRequest | null> {
  const [lo, hi] = await Promise.all([load(input.lo), load(input.hi)]);
  if (!isCurrentNote(lo) || !isCurrentNote(hi)) return null;
  const render = (note: AtomicNoteRecord) => {
    const text = renderRelationPairText(note, bodyCharacters);
    return { id: note.id, text, hash: sha256(text) };
  };
  return {
    key: input.key,
    pair: { first: render(lo), second: render(hi), band: input.band },
    sourceItemIds: [lo.createdFromSourceItemId, hi.createdFromSourceItemId]
  };
}

/** What one typing pass settled, by pair key. */
interface TypingPass {
  typings: Map<string, PairTyping>;
  typerKey: string | null;
  calls: number;
  cacheHits: number;
  untyped: Partial<Record<string, number>>;
}

// --- the link job ---------------------------------------------------------------------------------

export interface RelationLinkCounts {
  applied: number;
  suggested: number;
  typed: number;
  untyped: number;
  vetoed: number;
  unchanged: number;
}

const emptyCounts = (): RelationLinkCounts => ({
  applied: 0,
  suggested: 0,
  typed: 0,
  untyped: 0,
  vetoed: 0,
  unchanged: 0
});

/** Why discovery did not run in this link job. */
export type DiscoveryDeferral =
  "nothing_new" | "records_pending" | "remote_calls_off" | "discovery_off" | "daily_cap";

export class RelationLinker {
  private readonly config: RelationsConfig;

  public constructor(private readonly deps: RelationLinkDeps) {
    this.config = deps.config ?? defaultRelationsConfig;
  }

  /** The light job types of relations v2, all on the `relations` worker. */
  public jobs(): LightJobRegistry {
    const registry: Record<string, LightJobExecutor> = {
      [relationLinkJobType]: {
        needsModel: true,
        worker: "relations",
        execute: (job, signal) => this.link(job, signal),
        ended: (job, error, canceled) => this.linkEnded(job, error, canceled)
      },
      [relationRetypeJobType]: {
        needsModel: true,
        worker: "relations",
        execute: (job, signal) => this.sweep(job, signal)
      }
    };
    if (this.deps.steps.promoteSourceRelations)
      registry[relationPromoteJobType] = {
        needsModel: false,
        worker: "relations",
        execute: async (job, signal) => {
          const rootId = readRootId(job);
          return { rootId, ...(await this.deps.steps.promoteSourceRelations!([rootId], signal)) };
        }
      };
    return registry;
  }

  private runtime(): Readonly<RelationLinkRuntime> {
    return (this.deps.runtime ?? relationLinkRuntime)();
  }

  /** One link job: steps 1 to 6 of the module comment, for the root its payload names. */
  public async link(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const pool = this.deps.getPool();
    const rootId = readRootId(job);
    const runRepository = createIngestionRunRepository(pool);
    const runs = await runRepository.listLinkingRuns(rootId);
    const runtime = this.runtime();
    const interactive = runs.some(isInteractiveRun);
    const priority: AiPriorityInput = interactive ? "P1" : "P2";
    const budgetClass = linkJobBudgetClass(runs);
    const roots = new Map<string, string>();
    // Drain mode types each run's pairs by themselves, in decide order: a prompt never depends on
    // how many runs of the root had parked when the job was claimed (deterministic replays).
    const units = runtime.drain && runs.length > 1 ? runs.map((run) => [run]) : [runs];
    // A re-match run's notes come with the job (T52b), after every parked run's.
    const carried = decidedNotesOfJob(job);
    const counts = emptyCounts();
    const typing = { calls: 0, cacheHits: 0, untyped: {} as Record<string, number> };
    const promotedRoots = new Set<string>([rootId]);
    for (const [index, unit] of units.entries()) {
      signal.throwIfAborted();
      const linked = await this.linkUnit({
        job,
        rootId,
        runs: unit,
        carried: index === units.length - 1 ? carried : [],
        retypeRoot: index === units.length - 1,
        coalesce: !runtime.drain,
        priority,
        budgetClass,
        runtime,
        roots,
        signal
      });
      for (const key of Object.keys(counts) as Array<keyof RelationLinkCounts>)
        counts[key] += linked.counts[key];
      typing.calls += linked.typing.calls;
      typing.cacheHits += linked.typing.cacheHits;
      for (const [reason, count] of Object.entries(linked.typing.untyped))
        typing.untyped[reason] = (typing.untyped[reason] ?? 0) + (count ?? 0);
      for (const root of linked.typedRoots) promotedRoots.add(root);
    }
    // Step 5: promotion of the typed shown relations, suggestions included (T53, decision 29), for
    // the root and every root its new typed relations reach, then discovery.
    const promotion =
      this.deps.steps.promoteSourceRelations &&
      (runs.length > 0 || carried.length > 0 || counts.typed > 0)
        ? await this.deps.steps.promoteSourceRelations([...promotedRoots].sort(), signal)
        : null;
    const discovery = await this.discover({
      job,
      rootId,
      runs,
      interactive,
      budgetClass,
      runtime,
      signal
    });
    // Step 6: the parked runs complete with their link job.
    const summary: JsonObject = {
      linkJobId: job.id,
      ...counts,
      typingCalls: typing.calls,
      typingCacheHits: typing.cacheHits,
      ...(Object.keys(typing.untyped).length ? { untypedReasons: typing.untyped } : {}),
      discovery: discovery.summary
    };
    const completed: IngestionRunRecord[] = [];
    for (const run of runs) {
      const done = await runRepository.completeLinking(run.id, summary);
      if (done) completed.push(done);
    }
    if (completed.length) await this.deps.runsSettled?.(completed);
    return {
      rootId,
      runs: runs.length,
      completedRuns: completed.length,
      priority,
      ...summary,
      ...(promotion ? { promotion: promotion as JsonObject } : {}),
      // The job's status says why typing went untyped or discovery waited (D26).
      ...(runtime.drain ? {} : { dailyCalls: { ...(await this.deps.budget.status()) } })
    };
  }

  /**
   * A link job that ended for good without completing (failed with no attempt left, or canceled):
   * the runs it was linking end with its error and stay retryable; a run that parked after it was
   * claimed has a link job of its own and is left to it.
   */
  public async linkEnded(job: JobRecord, error: unknown, canceled: boolean): Promise<void> {
    const pool = this.deps.getPool();
    const runRepository = createIngestionRunRepository(pool);
    const claimedAt = job.lockedAt ?? job.updatedAt;
    const message = error instanceof Error ? error.message : "worker_failed";
    const ended: IngestionRunRecord[] = [];
    for (const run of await runRepository.listLinkingRuns(readRootId(job))) {
      if (run.parkedAt.getTime() > claimedAt.getTime()) continue;
      const done = await runRepository.failLinking(run.id, message, canceled);
      if (done) ended.push(done);
    }
    if (ended.length) await this.deps.runsSettled?.(ended);
  }

  private async linkUnit(input: {
    job: JobRecord;
    rootId: string;
    runs: readonly IngestionRunRecord[];
    /** Decided notes the job itself carries (a re-match run's, T52b). */
    carried: readonly StoredDecidedNote[];
    retypeRoot: boolean;
    coalesce: boolean;
    priority: AiPriorityInput;
    budgetClass: BudgetClass;
    runtime: Readonly<RelationLinkRuntime>;
    roots: Map<string, string>;
    signal: AbortSignal;
  }): Promise<{ counts: RelationLinkCounts; typing: TypingPass; typedRoots: Set<string> }> {
    const pool = this.deps.getPool();
    const load = noteLoader(pool);
    const bodyCharacters = this.config.decide.bodyCharacters;
    // Step 1: collect.
    const pending = await collectPending(pool, input.runs, input.carried);
    const untyped = input.retypeRoot
      ? await listUntyped(pool, { rootId: input.rootId, limit: rootUntypedLimit })
      : [];
    const requests: TypingRequest[] = [];
    const toPersist: PendingPair[] = [];
    for (const item of pending) {
      const request = await typingRequest(load, { ...item, band: item.pair.band }, bodyCharacters);
      // A note discarded, archived or superseded since it was decided takes its pairs with it.
      if (!request) continue;
      toPersist.push(item);
      // A generative verdict that maps into the write vocabulary keeps its type (D20).
      if (!item.pair.relationType) requests.push(request);
    }
    const retypes: Array<{ relation: UntypedRelation; request: TypingRequest }> = [];
    const requested = new Set(requests.map((request) => request.key));
    for (const relation of untyped) {
      if (requested.has(relation.key)) continue;
      const request = await typingRequest(load, relation, bodyCharacters);
      if (request) {
        retypes.push({ relation, request });
        requests.push(request);
      }
    }
    // Small-source coalescing (D20, product only): other due link jobs' pairs fill this call.
    const typingSize = this.config.typing.pairsPerCall;
    if (input.coalesce && requests.length > 0 && requests.length < this.config.typing.coalesceBelow)
      requests.push(
        ...(await this.coalesced(input.rootId, typingSize - requests.length, load, requests))
      );
    // Step 2: type.
    const typing = await this.type(requests, {
      job: input.job,
      priority: input.priority,
      budgetClass: input.budgetClass,
      runtime: input.runtime,
      signal: input.signal
    });
    // Step 3: persist.
    const persisted = await this.persist({
      kind: "link",
      rootId: input.rootId,
      pending: toPersist,
      retypes: retypes.map((item) => item.relation),
      typing
    });
    // Step 4: push.
    if (persisted.changedNoteIds.size) this.deps.relationsChanged?.(persisted.changedNoteIds);
    const typedRoots = await linkRootsOf(pool, persisted.typedSourceItemIds, input.roots);
    return { counts: persisted.counts, typing, typedRoots };
  }

  /** Pairs of other due link jobs to type with this root's, up to `room` (D20 coalescing). */
  private async coalesced(
    rootId: string,
    room: number,
    load: (id: string) => Promise<AtomicNoteRecord | null>,
    taken: readonly TypingRequest[]
  ): Promise<TypingRequest[]> {
    if (room <= 0) return [];
    const pool = this.deps.getPool();
    const due = await pool.query<{ rootId: string }>(
      `select payload->>'rootId' as "rootId" from jobs
       where type = $1 and status = 'queued' and run_after <= now() and blocked_class is null
         and payload->>'rootId' is not null and payload->>'rootId' <> $2
       order by priority desc, run_after asc, id
       limit $3`,
      [relationLinkJobType, rootId, coalesceJobLimit]
    );
    const keys = new Set(taken.map((request) => request.key));
    const absorbed: TypingRequest[] = [];
    const runRepository = createIngestionRunRepository(pool);
    for (const { rootId: otherRoot } of due.rows) {
      for (const item of await collectPending(
        pool,
        await runRepository.listLinkingRuns(otherRoot)
      )) {
        if (absorbed.length >= room) return absorbed;
        if (item.pair.relationType || keys.has(item.key)) continue;
        const request = await typingRequest(
          load,
          { ...item, band: item.pair.band },
          this.config.decide.bodyCharacters
        );
        if (!request) continue;
        keys.add(item.key);
        absorbed.push(request);
      }
    }
    return absorbed;
  }

  /**
   * Types the requests under the in-flight registry: a pair another link job is typing is waited
   * for and then read from the typing cache, so no call is paid twice (D24). Remote calls ask the
   * daily cap first (D26); with relation remote calls off they are not made (5.6).
   */
  private async type(
    requests: readonly TypingRequest[],
    input: {
      job: JobRecord;
      priority: AiPriorityInput;
      budgetClass: BudgetClass;
      runtime: Readonly<RelationLinkRuntime>;
      signal: AbortSignal;
    }
  ): Promise<TypingPass> {
    const pass: TypingPass = {
      typings: new Map(),
      typerKey: null,
      calls: 0,
      cacheHits: 0,
      untyped: {}
    };
    if (requests.length === 0) return pass;
    const byKey = new Map(requests.map((request) => [request.key, request]));
    const options: RelationTypingOptions = {
      priority: input.priority,
      budgetClass: input.budgetClass,
      jobId: input.job.id,
      reserveCall: (route) =>
        this.deps.budget.reserve({
          lane: route.lane,
          priority: input.priority,
          drain: input.runtime.drain
        }),
      ...(input.runtime.remoteCallsOff ? { remoteCallsOff: true } : {}),
      limits: {
        pairsPerCall: this.config.typing.pairsPerCall,
        attemptsPerBatch: this.config.typing.maxAttempts
      }
    };
    const results = await this.deps.registry.run(
      [...byKey.keys()],
      (claimed) =>
        this.deps.steps.typeRelationPairs(
          claimed.map((key) => byKey.get(key)!.pair),
          {
            ...options,
            sourceItemIds: [...new Set(claimed.flatMap((key) => byKey.get(key)!.sourceItemIds))]
          },
          input.signal
        ),
      input.signal
    );
    for (const result of results) {
      pass.typerKey = result.typerKey ?? pass.typerKey;
      pass.calls += result.calls;
      pass.cacheHits += result.cacheHits;
      for (const [key, typing] of result.pairs) {
        pass.typings.set(key, typing);
        if (typing.outcome.kind === "untyped")
          pass.untyped[typing.outcome.reason] = (pass.untyped[typing.outcome.reason] ?? 0) + 1;
      }
    }
    return pass;
  }

  /**
   * Step 3: one transaction for the unit: a `link` (or `retype`) run, the upsert of every pending
   * pair (typed, untyped by D20's fallback, or with the generative decider's own type), a `vetoed`
   * event for a new `none` (no relation, only the typing row), and the typed or withdrawn untyped
   * relations. Nothing is written when there is nothing to write.
   */
  private async persist(input: {
    kind: "link" | "retype";
    rootId: string | null;
    pending: readonly PendingPair[];
    retypes: readonly UntypedRelation[];
    typing: TypingPass;
  }): Promise<{
    counts: RelationLinkCounts;
    changedNoteIds: Set<string>;
    typedSourceItemIds: Set<string>;
  }> {
    const counts = emptyCounts();
    const changedNoteIds = new Set<string>();
    const typedSourceItemIds = new Set<string>();
    if (input.pending.length === 0 && input.retypes.length === 0)
      return { counts, changedNoteIds, typedSourceItemIds };
    const pool = this.deps.getPool();
    const events = createRelationEventRepository(pool);
    await withTransaction(pool, async (client) => {
      const relations = createAtomicNoteRelationRepository(client);
      const runs = createRelationMatchRunRepository(client);
      const first = input.pending[0]?.decider;
      const run = await runs.start({
        kind: input.kind,
        rootId: input.rootId,
        deciderKey: first?.deciderKey ?? null,
        calibrationVersion: first?.calibration ?? null
      });
      const record = (
        written: Awaited<ReturnType<typeof relations.upsert>>,
        sourceItemIds: readonly string[]
      ) => {
        if (written.change === "unchanged" || written.change === "reviewed") {
          counts.unchanged += 1;
          return;
        }
        changedNoteIds.add(written.relation.sourceAtomicNoteId);
        changedNoteIds.add(written.relation.targetAtomicNoteId);
        const typed = written.relation.relationType !== null;
        if (written.change === "updated") counts[typed ? "typed" : "untyped"] += 1;
        else if (!typed) counts.untyped += 1;
        else counts[written.relation.band === "suggest" ? "suggested" : "applied"] += 1;
        // A typed relation, or a change of its type or direction, re-promotes both roots (R14).
        if (typed) for (const id of sourceItemIds) typedSourceItemIds.add(id);
      };
      // Two link jobs may hold one pair (both notes' roots decided it). The pair's lock, then a
      // second look, lets the first commit win: the other job writes nothing for it.
      await client.query(
        `select pg_advisory_xact_lock(hashtext('relation-link:' || key))
         from unnest($1::text[]) as key order by key`,
        [[...input.pending.map((item) => item.key), ...input.retypes.map((item) => item.key)]]
      );
      const taken = await existingPairKeys(client, input.pending);
      // A `none` read from the typing cache vetoes too: a pair another job typed while coalescing
      // it, or this job's retry after its commit failed. Each veto gets its event once (D14, D20).
      const vetoed = await vetoedPairKeys(
        client,
        input.pending
          .filter(
            (item) =>
              !taken.has(item.key) &&
              !item.pair.relationType &&
              input.typing.typings.get(item.key)?.outcome.kind === "none"
          )
          .map((item) => item.key)
      );
      for (const item of input.pending) {
        if (taken.has(item.key)) continue;
        const typing = input.typing.typings.get(item.key);
        const base = decidedRelationRow(item, run.id);
        if (item.pair.relationType) {
          const subject = (item.pair.subjectId ?? item.pair.noteId).toLowerCase();
          record(
            await relations.upsertDecided({
              ...base,
              subjectAtomicNoteId: subject,
              objectAtomicNoteId: subject === item.lo ? item.hi : item.lo,
              relationType: item.pair.relationType
            }),
            item.sourceItemIds
          );
        } else if (typing?.outcome.kind === "typed") {
          // The typer's direction is a guess from note position (decision 31b): it is kept, and
          // shown only when the Decisions decider named the same pair's subject clearly.
          const direction = automaticNoteRelationDirection({
            relationType: typing.outcome.relationType,
            typed: typing.outcome.direction,
            decider: deciderDirectionOf(item)
          });
          record(
            await relations.upsert({
              ...base,
              loAtomicNoteId: item.lo,
              hiAtomicNoteId: item.hi,
              ...direction,
              relationType: typing.outcome.relationType,
              typerKey: input.typing.typerKey
            }),
            item.sourceItemIds
          );
        } else if (typing?.outcome.kind === "none") {
          // The typer's veto: no relation; its typing row stays, so nobody asks again (D20).
          if (!vetoed.has(item.key)) {
            vetoed.add(item.key);
            await events.append(
              {
                runId: run.id,
                relationKind: "note",
                relationId: null,
                pairKey: item.key,
                kind: "vetoed",
                before: null,
                after: null
              },
              client
            );
            counts.vetoed += 1;
          }
        } else {
          // D20's untyped fallback: shown with a neutral stance, typed by a later link job.
          record(
            await relations.upsert({
              ...base,
              loAtomicNoteId: item.lo,
              hiAtomicNoteId: item.hi,
              direction: "symmetric",
              relationType: null
            }),
            item.sourceItemIds
          );
        }
      }
      for (const relation of input.retypes) {
        const typing = input.typing.typings.get(relation.key);
        if (typing?.outcome.kind === "typed")
          record(
            await relations.upsert({
              ...relation.upsert,
              direction: typing.outcome.direction,
              relationType: typing.outcome.relationType,
              typerKey: input.typing.typerKey,
              runId: run.id
            }),
            relation.sourceItemIds
          );
        else if (typing?.outcome.kind === "none") {
          // A `none` on an untyped relation withdraws it (D20, the sweep's veto).
          const vetoed = await relations.veto(relation.id, "typer", run.id);
          if (vetoed) {
            counts.vetoed += 1;
            changedNoteIds.add(relation.lo);
            changedNoteIds.add(relation.hi);
          }
        }
      }
      await runs.finish(run.id, {
        outcome: "succeeded",
        counts: { ...counts },
        timings: {}
      });
    });
    return { counts, changedNoteIds, typedSourceItemIds };
  }

  /** Step 5's discovery, or why it waits (D26, 3.11). */
  private async discover(input: {
    job: JobRecord;
    rootId: string;
    runs: readonly IngestionRunRecord[];
    interactive: boolean;
    budgetClass: BudgetClass;
    runtime: Readonly<RelationLinkRuntime>;
    signal: AbortSignal;
  }): Promise<{ summary: JsonObject }> {
    const deferred = (reason: DiscoveryDeferral) => ({ summary: { status: "deferred", reason } });
    // Discovery the daily cap deferred is due again with no parked run (D26).
    const queued = input.job.payload.discover === true;
    if (input.runs.length === 0 && !queued) return deferred("nothing_new");
    // Runs whose plans stop at note matching parked only for their pairs (D21).
    if (!queued && !input.runs.some(requestsSourceDiscovery))
      return { summary: { status: "skipped", reason: "not_in_plan" } };
    if (input.runtime.discoveryOff) return deferred("discovery_off");
    if (input.runtime.remoteCallsOff) return deferred("remote_calls_off");
    const pool = this.deps.getPool();
    // A book's discovery runs once its last record has linked (3.11 step 5).
    if (
      await createIngestionRunRepository(pool).hasRunsBeforeStage(
        input.rootId,
        "atomicNoteMatching"
      )
    )
      return deferred("records_pending");
    const priority: AiPriorityInput = input.interactive ? "P1" : "P2";
    const regenerate =
      input.job.payload.regenerate === true ||
      input.runs.some((run) => run.previousArtifactPolicy === "regenerate_selected");
    // At the cap discovery waits for the next local day, when the count starts again (D26).
    const waitForNextDay = async () => {
      const notBefore = nextLocalDay(new Date());
      await enqueueRelationLink(pool, {
        rootId: input.rootId,
        discovery: { regenerate, notBefore }
      });
      return {
        summary: { status: "deferred", reason: "daily_cap", retryAfter: notBefore.toISOString() }
      };
    };
    if (!input.interactive && !input.runtime.drain && (await this.deps.budget.capped()))
      return waitForNextDay();
    try {
      const result = await this.deps.steps.discoverSourceRelations(
        {
          rootId: input.rootId,
          runKey: `${relationLinkJobType}:${input.job.id}`,
          regenerate,
          priority,
          budgetClass: input.budgetClass,
          reserveCall: (lane) =>
            this.deps.budget.reserve({ lane, priority, drain: input.runtime.drain }),
          registry: this.deps.registry,
          context: {
            jobId: input.job.id,
            sourceItemId: input.rootId,
            stage: "sourceMatching",
            origin: "job",
            budgetClass: input.budgetClass
          }
        },
        input.signal
      );
      return { summary: { status: "completed", ...(result as JsonObject) } };
    } catch (error) {
      if (error instanceof Error && error.message === relationDailyCapError)
        return waitForNextDay();
      throw error;
    }
  }

  /**
   * The untyped re-typing sweep (D20, P3): types untyped relations library-wide, a page at a time,
   * under the daily cap; a `none` withdraws the relation. Each page queues the next one.
   */
  public async sweep(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const pool = this.deps.getPool();
    const runtime = this.runtime();
    const afterId = typeof job.payload.afterId === "string" ? job.payload.afterId : null;
    const page = await listUntyped(pool, { rootId: null, limit: sweepPageSize, afterId });
    const load = noteLoader(pool);
    const retypes: Array<{ relation: UntypedRelation; request: TypingRequest }> = [];
    for (const relation of page) {
      const request = await typingRequest(load, relation, this.config.decide.bodyCharacters);
      if (request) retypes.push({ relation, request });
    }
    const typing = await this.type(
      retypes.map((item) => item.request),
      // The library-wide sweep is Gardener maintenance: metered and refused at the caps (D14).
      { job, priority: "P3", budgetClass: "background", runtime, signal }
    );
    const persisted = await this.persist({
      kind: "retype",
      rootId: null,
      pending: [],
      retypes: retypes.map((item) => item.relation),
      typing
    });
    if (persisted.changedNoteIds.size) this.deps.relationsChanged?.(persisted.changedNoteIds);
    // A typing outside a link job re-promotes both roots of the relation (R14).
    if (this.deps.steps.promoteSourceRelations)
      for (const root of await linkRootsOf(pool, persisted.typedSourceItemIds, new Map()))
        await createJobRepository(pool).enqueueDeduped({
          type: relationPromoteJobType,
          lane: "light",
          dedupeKey: relationPromoteDedupeKey(root),
          payload: { rootId: root, sourceItemId: root },
          debounce: immediateJobDebounce
        });
    const capped = (typing.untyped.daily_cap ?? 0) > 0;
    const last = page.at(-1)?.id ?? null;
    return {
      swept: page.length,
      ...persisted.counts,
      typingCalls: typing.calls,
      ...(capped ? { stopped: "daily_cap" } : {}),
      // The next page, unless this one was the last or the cap stopped it.
      ...(page.length === sweepPageSize && last && !capped
        ? { continueWith: { afterId: last } }
        : {})
    };
  }
}

/** Queues the day's re-typing sweep once (D20). Resolves true when it queued one. */
export async function enqueueRelationRetypeSweep(db: Queryable): Promise<boolean> {
  const { created } = await createJobRepository(db).enqueueDeduped({
    type: relationRetypeJobType,
    lane: "light",
    dedupeKey: relationRetypeDedupeKey,
    payload: {},
    debounce: immediateJobDebounce,
    maxAttempts: 3
  });
  return created;
}

/** Whether any relation waits for its type (the sweep has work). */
export async function hasUntypedRelations(db: Queryable): Promise<boolean> {
  return (await listUntyped(db, { rootId: null, limit: 1 })).length > 0;
}

/**
 * Whether a job of `types` (the `relations` worker's) is running, due, or waiting for its retry.
 * Drain mode holds the heavy lane while one is (3.11), so a link job's discovery never sees the
 * next source half ingested; a job queued for a later day (the daily cap's discovery) holds nothing,
 * and neither does one a blocker set aside (F4 D5: it waits for its blocker, not for a worker).
 */
export async function hasPendingRelationJobs(
  db: Queryable,
  types: readonly string[]
): Promise<boolean> {
  if (types.length === 0) return false;
  const result = await db.query(
    `select 1 from jobs
     where type = any($1::text[])
       and (status = 'running'
            or (status = 'queued' and blocked_class is null
                and (run_after <= now() or attempts > 0)))
     limit 1`,
    [[...types]]
  );
  return result.rows.length > 0;
}

function readRootId(job: JobRecord): string {
  const rootId = job.payload.rootId;
  if (typeof rootId !== "string" || !rootId) throw new Error("missing_rootId");
  return rootId;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

/** The direction the Decisions decider named for a pending pair, from its subject note (31b). */
function deciderDirectionOf(item: PendingPair): "lo_to_hi" | "hi_to_lo" | null {
  const subject = item.decider.kind === "decisions" ? item.pair.directionSubjectId : null;
  if (!subject) return null;
  return subject.toLowerCase() === item.lo
    ? "lo_to_hi"
    : subject.toLowerCase() === item.hi
      ? "hi_to_lo"
      : null;
}

/**
 * The stored columns of a decided pair (D17): its band and probability, the decider's key, the
 * retrieval scores, and `final_score` = the calibrated probability, or the decider's own when there
 * is none. The decider writes no prose: the explanation is written on demand.
 */
function decidedRelationRow(
  item: PendingPair,
  runId: string
): Omit<NoteRelationUpsert, "loAtomicNoteId" | "hiAtomicNoteId" | "direction" | "relationType"> {
  const { pair, decider } = item;
  return {
    band: pair.band,
    probability: pair.probability,
    deciderKey: decider.deciderKey,
    vectorScore: pair.vectorScore,
    graphScore: pair.graphScore,
    rerankScore: decider.kind === "generative" ? pair.score : null,
    // A ranker and the Decisions API score in log-odds; the generative decider in 0-1.
    finalScore:
      pair.probability ?? (decider.kind === "generative" ? pair.score : sigmoid(pair.score)),
    explanation: "knowledge.relations.explanations.reranked",
    matchingProfileId: decider.profileId,
    matchingModel: decider.modelId,
    metadata: {
      version: relationMatcherVersion,
      decisionSource: pair.decisionSource,
      calibration: pair.calibration,
      score: pair.score
    },
    runId
  };
}
