// MATCH as a Gardener task (F4 D16, spec 3.5). A note a person edited, once its vector is current
// again, or accepted is decided again by one `relation-match:<noteId>` job on the light `relations`
// worker, debounced so a burst of edits settles into one decision. The job
//   1. skips a note whose rendered text and embedding space equal the ones its match state
//      recorded (`note_match_state.input_hash`), whoever decided it then: an ingestion run or an
//      earlier MATCH. The decider is provenance, so a model change never re-runs it by itself;
//   2. otherwise decides the note with the matcher ingestion uses (retrieval, the validated ranker
//      or the generative decider, calibrated bands) and hands the accepted pairs to the link job of
//      its root, which types, persists, promotes and discovers (a `relation_match_runs`
//      change-set, titled in `relation-run-title.ts`).
// MATCH writes no relation: its pairs are suggestions of the deciders (decision 29), carry no
// direction of their own (31b) and appear only once the link job persists them. A decider change
// offers a backlog instead of re-running anything (`relation-match-backlog.ts`).
import { sha256 } from "@app/conversion";
import {
  createAtomicNoteRepository,
  createJobRepository,
  type AtomicNoteRecord,
  type JobDebounce,
  type JobRecord,
  type JsonObject,
  type PgPool,
  type Queryable
} from "@app/db";
import {
  gardenerFingerprint,
  relationMatchJobType,
  relationsConfig as defaultRelationsConfig,
  waitingForDeciderSkipReason,
  type RelationsConfig
} from "@app/domain";

import type { AiTaskLogContext } from "../ai-service.js";
import type { LightJobExecutor, LightJobRegistry } from "../job-lanes.js";
import type { KnowledgeService } from "../knowledge-service.js";
import {
  enqueueRematchLink,
  linkRootOf,
  StoredDecidedNoteSchema,
  type StoredDecidedNote
} from "./relation-link.js";
import { noteMatchInputHash, type DecidedNote } from "./relation-matcher.js";
import { matchedNoteEntry } from "./relation-run-title.js";

export { relationMatchJobType };

export const relationMatchDedupeKey = (noteId: string) => `relation-match:${noteId}`;
/** A backlog's request is its own job: a queued edit request must not swallow its flag (D16). */
export const relationMatchBacklogDedupeKey = (noteId: string) => `relation-match:backlog:${noteId}`;

/** The queue priority of a backlog's jobs: below every ordinary request, so edits go first. */
const backlogJobPriority = -1;

const isCurrentNote = (note: AtomicNoteRecord | null): note is AtomicNoteRecord =>
  note !== null &&
  note.status !== "rejected" &&
  note.status !== "archived" &&
  note.supersessionStatus === "current";

// --- queueing -------------------------------------------------------------------------------------

/** Queues the MATCH job of one note whose root is known; a queued job of the note absorbs it. */
export async function enqueueMatchJob(
  db: Queryable,
  input: { noteId: string; rootId: string; backlog: boolean; debounce: JobDebounce }
): Promise<JobRecord> {
  const { job } = await createJobRepository(db).enqueueDeduped({
    type: relationMatchJobType,
    lane: "light",
    dedupeKey: input.backlog
      ? relationMatchBacklogDedupeKey(input.noteId)
      : relationMatchDedupeKey(input.noteId),
    payload: {
      noteId: input.noteId,
      rootId: input.rootId,
      ...(input.backlog ? { backlog: true } : {})
    },
    priority: input.backlog ? backlogJobPriority : 0,
    maxAttempts: 3,
    debounce: input.debounce
  });
  return job;
}

/**
 * Queues the MATCH job of each of these notes that is current: debounced by the typed wait
 * (`relations.match`), one queued job per note (D16). A note that is gone, rejected, archived or
 * superseded is left out. Resolves to the jobs it queued or merged into.
 */
export async function enqueueRelationMatches(
  db: Queryable,
  noteIds: readonly string[],
  config: RelationsConfig["match"] = defaultRelationsConfig.match
): Promise<JobRecord[]> {
  const notes = createAtomicNoteRepository(db);
  const debounce = { delayMs: config.debounceMs, maxDelayMs: config.maxDebounceMs };
  const jobs: JobRecord[] = [];
  for (const noteId of new Set(noteIds.map((id) => id.toLowerCase()))) {
    const note = await notes.findById(noteId);
    if (!isCurrentNote(note)) continue;
    const rootId = await linkRootOf(db, note.createdFromSourceItemId);
    jobs.push(await enqueueMatchJob(db, { noteId, rootId, backlog: false, debounce }));
  }
  return jobs;
}

export interface NoteMatchRequestsDeps {
  getPool: () => PgPool | null;
  /** Whether a job executor of this type is registered: a request is skipped, never queued unclaimed. */
  isRegistered: (type: string) => boolean;
  config?: RelationsConfig;
}

/**
 * What the topic hooks call to queue MATCH for a note a person edited or accepted
 * (`topic-hooks.ts` `NoteMatchRequests`). The job is debounced, so no worker is woken: the light
 * lane finds it when it is due.
 */
export function createNoteMatchRequests(deps: NoteMatchRequestsDeps) {
  return {
    async request(
      noteIds: readonly string[],
      options: { client?: Queryable }
    ): Promise<JobRecord[]> {
      const db = options.client ?? deps.getPool();
      if (!db || !deps.isRegistered(relationMatchJobType)) return [];
      return enqueueRelationMatches(db, noteIds, (deps.config ?? defaultRelationsConfig).match);
    }
  };
}

/**
 * Hands the notes MATCH decided to the link job of their root (deduplicated per root), which
 * persists their pairs, types them, promotes and discovers (D16). The job carries the decided
 * notes in its payload, as a re-match run's does, and their titles, which name its change-set.
 */
export function enqueueMatchLink(
  db: Queryable,
  input: {
    rootId: string;
    decided: readonly StoredDecidedNote[];
    note: { id: string; title: string };
  }
): Promise<JobRecord> {
  return enqueueRematchLink(db, {
    rootId: input.rootId,
    decided: input.decided,
    matched: [matchedNoteEntry(input.note)]
  });
}

// --- the task -------------------------------------------------------------------------------------

export interface RelationMatchTaskDeps {
  getPool: () => PgPool;
  /** The knowledge service's matcher: the decision ingestion makes, with MATCH's skip. */
  knowledge: Pick<KnowledgeService, "matchAtomicNotes">;
  /** The embedding space the route writes to, known without a call (the fingerprint's space). */
  spaceKey?: () => Promise<string | null>;
  config?: RelationsConfig;
  /** Wakes the light lane after a link job was queued. */
  wake?: () => void;
}

function readString(payload: JsonObject, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) throw new Error(`missing_${key}`);
  return value;
}

/** The decider that cannot run for lack of a route: the job waits for one, it does not fail. */
const noRouteError = "errors.ai.noCompatibleModel";

export class RelationMatchTask {
  private readonly config: RelationsConfig;

  public constructor(private readonly deps: RelationMatchTaskDeps) {
    this.config = deps.config ?? defaultRelationsConfig;
  }

  /** The light job type of MATCH, on the `relations` worker (it decides, and queues a link job). */
  public jobs(): LightJobRegistry {
    const executor: LightJobExecutor = {
      needsModel: true,
      worker: "relations",
      execute: (job, signal) => this.match(job, signal),
      fingerprint: (job) => this.fingerprint(job)
    };
    return { [relationMatchJobType]: executor };
  }

  /**
   * The note's content-only fingerprint (D9): the hash of the text its decider sees and the
   * embedding space. A backlog's job states none: it exists to decide an unchanged note again.
   */
  public async fingerprint(job: Pick<JobRecord, "payload">): Promise<string | null> {
    if (job.payload.backlog === true) return null;
    const note = await createAtomicNoteRepository(this.deps.getPool()).findById(
      readString(job.payload, "noteId")
    );
    if (!note) return null;
    return gardenerFingerprint(
      relationMatchJobType,
      {
        input: noteMatchInputHash(note, this.config.decide.bodyCharacters),
        space: (await this.deps.spaceKey?.()) ?? ""
      },
      sha256
    );
  }

  /** One MATCH job (steps 1 and 2 of the module comment). */
  public async match(job: JobRecord, signal: AbortSignal): Promise<JsonObject> {
    const noteId = readString(job.payload, "noteId");
    const rootId = readString(job.payload, "rootId");
    const backlog = job.payload.backlog === true;
    const pool = this.deps.getPool();
    const note = await createAtomicNoteRepository(pool).findById(noteId);
    if (!isCurrentNote(note)) return { status: "no_change", reason: "note_not_current", noteId };
    let decided: DecidedNote | null = null;
    const context: AiTaskLogContext = {
      jobId: job.id,
      sourceItemId: note.createdFromSourceItemId,
      stage: "atomic_note_matching",
      origin: "job",
      // A person's edit is ordinary background work; a backlog waits behind everything (D16).
      priority: backlog ? "P3" : "P2",
      budgetClass: "background"
    };
    let result: Awaited<ReturnType<RelationMatchTaskDeps["knowledge"]["matchAtomicNotes"]>>;
    try {
      result = await this.deps.knowledge.matchAtomicNotes([noteId], signal, undefined, context, {
        skipUnchanged: !backlog,
        onNoteDecided: (note) => {
          decided = note;
        }
      });
    } catch (error) {
      if (!signal.aborted && error instanceof Error && error.message === noRouteError)
        return { status: "no_route", noteId };
      throw error;
    }
    if (result.skipped === waitingForDeciderSkipReason) return { status: "no_decider", noteId };
    if (result.decided === 0)
      return result.unchanged
        ? { status: "skipped", reason: "same_input", noteId }
        : { status: "no_change", reason: "note_not_current", noteId };
    if (result.accepted === 0 || decided === null)
      return { status: "no_change", noteId, decided: 1, accepted: 0 };
    // The link job types the accepted pairs and persists them (D21); this job writes no relation.
    const link = await enqueueMatchLink(pool, {
      rootId,
      decided: [StoredDecidedNoteSchema.parse(decided)],
      note
    });
    this.deps.wake?.();
    return {
      status: "completed",
      noteId,
      decided: 1,
      accepted: result.accepted,
      linkJobId: link.id
    };
  }
}
