import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createAtomicNoteRepository,
  createGardenerOutcomeRepository,
  createIngestionRunRepository,
  createJobRepository,
  createNoteMatchStateRepository,
  createPgPool,
  createRelationTypingRepository,
  noteRelationDirectionSql,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type PgPool
} from "@app/db";
import { relationsConfig } from "@app/domain";

import type { AiService } from "../ai-service.js";
import { JobSupervisor } from "../job-supervisor.js";
import { KnowledgeService } from "../knowledge-service.js";
import { createTopicChangeHooks } from "../topic-tree/topic-hooks.js";
import type { TopicTriggers } from "../topic-tree/topic-triggers.js";
import { InFlightRegistry } from "./in-flight-registry.js";
import { createRelationCallBudget } from "./relation-call-budget.js";
import { enqueueRelationLink, RelationLinker, StoredDecidedNoteSchema } from "./relation-link.js";
import { createNoteMatchRequests } from "./relation-match.js";
import { matchBacklogFingerprint, RelationMatchBacklog } from "./relation-match-backlog.js";
import { noteMatchInputHash, type DecidedNote } from "./relation-matcher.js";
import { typeRelationPairs, type TyperRoute } from "./relation-typing.js";

// MATCH on a real database (F4 D16, spec 3.5): the hook that queues it for an edited or accepted
// note, the job through the supervisor (fingerprint, outcome, blocker, scope exclusion), its link
// job leaving a titled change-set of suggestions with no direction of its own, and the backlog a
// decider change offers. The matcher and the typing writer are fakes; the rest is the product's.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));
const quiet = { error: () => undefined, warn: () => undefined };
const space = "space-1";

/** The topic triggers the hooks wrap: placement is not under test here. */
const triggers = {
  notesChanged: async () => [],
  sourcesChanged: async () => [],
  repair: async () => [],
  reembeddingEnded: async () => []
} as unknown as TopicTriggers;

const route: TyperRoute = {
  lane: "remote",
  provider: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  parameters: { reasoningLevel: "off" }
};

describe.skipIf(!sidecarInstalled)("MATCH on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let profileId = "";
  let aiRunId = "";
  let supervisor: JobSupervisor | undefined;
  /** What the next decision of the faked matcher does. */
  type Decision =
    | { kind: "accept"; with: Note[] }
    | { kind: "nothing" }
    | { kind: "unchanged" }
    | { kind: "waiting" };
  let decision: Decision = { kind: "nothing" };
  const matchAtomicNotes = vi.fn();
  const db = () => pool!;
  const jobs = () => createJobRepository(db());

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-match-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_relation_match_test",
      user: "memora_relation_match_test",
      password: `relation-match-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    profileId = (await createAiConfigRepository(pool).createProfile({ name: "Match decider" })).id;
    aiRunId = (
      await pool.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
         values ('structured-output', 'verify', 'gpt-test', 'remote', 1, 'succeeded', now()) returning id`
      )
    ).rows[0]!.id;
    const knowledge = {
      matchAtomicNotes,
      embedAtomicNote: async () => ({ embedded: true }),
      typeRelationPairs: async () => {
        throw new Error("the link job types with its own steps in these tests");
      },
      discoverSourceRelations: async () => ({ persistedCount: 0 }),
      promoteSourceRelations: async () => ({})
    } as unknown as KnowledgeService;
    // The edit's hook reaches the same queue the product's does: the real hooks and requests.
    const hooks = createTopicChangeHooks(
      triggers,
      quiet,
      createNoteMatchRequests({ getPool: () => pool!, isRegistered: () => true })
    );
    supervisor = new JobSupervisor({
      getPool: () => pool!,
      knowledgeService: knowledge,
      embeddingSpaceKey: async () => space,
      topicHooks: hooks,
      logger: quiet
    });
  }, 120_000);

  afterAll(async () => {
    await supervisor?.stop().catch(() => undefined);
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const client = db();
    await client.query("delete from jobs");
    await client.query("delete from gardener_outcomes");
    await client.query("delete from gardener_findings");
    await client.query("delete from relation_events");
    await client.query("delete from relation_match_runs");
    await client.query("delete from relation_typings");
    await client.query("delete from atomic_note_relations");
    await client.query("delete from note_match_state");
    matchAtomicNotes.mockReset();
    decision = { kind: "nothing" };
    matchAtomicNotes.mockImplementation(
      async (
        ids: string[],
        _signal: AbortSignal,
        _progress: unknown,
        _context: unknown,
        options: { onNoteDecided?: (note: DecidedNote) => void }
      ) => {
        const note = (await createAtomicNoteRepository(db()).findById(ids[0]!))!;
        if (decision.kind === "waiting")
          return { decided: 0, accepted: 0, persistedCount: 0, skipped: "waiting_for_decider" };
        if (decision.kind === "unchanged")
          return { decided: 0, accepted: 0, persistedCount: 0, unchanged: 1, decider: "ranker" };
        if (decision.kind === "accept") {
          options.onNoteDecided?.(
            decidedNote({ id: note.id, sourceId: note.createdFromSourceItemId }, decision.with)
          );
          return { decided: 1, accepted: decision.with.length, persistedCount: 0 };
        }
        return { decided: 1, accepted: 0, persistedCount: 0, decider: "ranker" };
      }
    );
  });

  // --- the library ----------------------------------------------------------------------------

  /** A source with one document and chunk; `parent` makes it a record of a book. */
  const seedSource = async (title: string, parent?: string) => {
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID();
    await db().query(
      `insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)`,
      [sourceId, parent ? "DocumentSection" : "PersonalNote", title, parent ?? null]
    );
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    return { sourceId, chunkId };
  };

  const seedNote = async (
    source: { sourceId: string; chunkId: string },
    title: string,
    status = "pending_review"
  ) => {
    const id = randomUUID();
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, $5, 'current', 'source', $6, $6, $7, 'seed', 'seed', 'local',
               'seed', $8)`,
      [
        id,
        title,
        `${title} body.`,
        `${title} idea.`,
        status,
        source.sourceId,
        source.chunkId,
        `key-${id}`
      ]
    );
    return { id, sourceId: source.sourceId, title };
  };
  type Note = Awaited<ReturnType<typeof seedNote>>;

  /** The state the matcher records for a note: its text hash and the decider that decided it. */
  const recordState = async (note: Note, deciderKey: string, spaceKey = space) => {
    const record = (await createAtomicNoteRepository(db()).findById(note.id))!;
    await createNoteMatchStateRepository(db()).record({
      noteId: note.id,
      deciderKey,
      spaceKey,
      kthCosine: null,
      inputHash: noteMatchInputHash(record, relationsConfig.decide.bodyCharacters)
    });
  };

  /** A note decided by the local ranker: its accepted pairs are suggestions of the decider. */
  const decidedNote = (note: { id: string; sourceId: string }, others: Note[]): DecidedNote => ({
    noteId: note.id,
    sourceItemId: note.sourceId,
    decider: {
      kind: "ranker",
      mode: "ranker",
      deciderKey: "ranker-key",
      calibration: "frozen",
      profileId,
      modelId: "ranker"
    },
    pairs: others.map((other) => ({
      noteId: note.id,
      candidateId: other.id,
      candidateSourceItemId: other.sourceId,
      band: "suggest" as const,
      probability: 0.8,
      score: 2.2,
      calibration: "frozen" as const,
      relationType: null,
      subjectId: null,
      decisionSource: "model" as const,
      vectorScore: 0.7,
      graphScore: null
    }))
  });

  const queued = async (type: string) =>
    (
      await db().query<{
        id: string;
        dedupeKey: string | null;
        scopeKey: string | null;
        subjectKey: string | null;
        priority: number;
        payload: Record<string, unknown>;
        secondsAway: number;
      }>(
        `select id, dedupe_key as "dedupeKey", scope_key as "scopeKey", subject_key as "subjectKey",
                priority, payload, extract(epoch from (run_after - now()))::float as "secondsAway"
           from jobs where type = $1 and status = 'queued' order by created_at, id`,
        [type]
      )
    ).rows;

  /**
   * Makes every queued job but the link jobs due and runs the `relations` worker until it finds
   * nothing: the link job a MATCH job queues is read, then run by the test that is about it.
   */
  const drain = async (limit = 10) => {
    const ran: JobRecord[] = [];
    for (let pass = 0; pass < limit; pass += 1) {
      await db().query(
        `update jobs set run_after = case when type = 'relation-link'
            then now() + interval '1 hour' else now() end
          where status = 'queued' and blocked_class is null`
      );
      const job = await supervisor!.runLightOnce("relations");
      if (!job) break;
      ran.push(job);
    }
    return ran;
  };

  /** The hook the edit and the approval reach, as the product wires it. */
  const knowledgeWithHooks = () =>
    new KnowledgeService({
      getPool: () => db(),
      aiService: {} as AiService,
      userDataPath: workDir,
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      topicHooks: createTopicChangeHooks(
        triggers,
        quiet,
        createNoteMatchRequests({ getPool: () => db(), isRegistered: () => true })
      )
    });

  // --- queueing -------------------------------------------------------------------------------

  describe("queueing", () => {
    it("queues one debounced job per edited note, scoped by its root, however often it is asked", async () => {
      const book = await seedSource("Book");
      const chapter = await seedSource("Chapter", book.sourceId);
      const edited = await seedNote(chapter, "Spacing");
      const hooks = createTopicChangeHooks(
        triggers,
        quiet,
        createNoteMatchRequests({ getPool: () => db(), isRegistered: () => true })
      );
      await hooks.notesToMatch!([edited.id]);
      await hooks.notesToMatch!([edited.id]);
      const [only, ...rest] = await queued("relation-match");
      expect(rest).toEqual([]);
      expect(only).toMatchObject({
        dedupeKey: `relation-match:${edited.id}`,
        // The exclusion scope is the hierarchy root of the note's source, the subject the note.
        scopeKey: `root:${book.sourceId}`,
        subjectKey: `note:${edited.id}`,
        priority: 0,
        payload: { noteId: edited.id, rootId: book.sourceId, sourceItemId: book.sourceId }
      });
      // 60 s for the next edit (typed configuration), counted from the first request.
      expect(only!.secondsAway).toBeGreaterThan(50);
      expect(only!.secondsAway).toBeLessThanOrEqual(60);
      // A discarded note is never matched.
      const gone = await seedNote(chapter, "Gone", "rejected");
      await hooks.notesToMatch!([gone.id]);
      expect(await queued("relation-match")).toHaveLength(1);
    });

    it("queues MATCH when the re-embedding of an edit ends, and for an approval, not before", async () => {
      const source = await seedSource("Edits");
      const edited = await seedNote(source, "Interleaving");
      const approved = await seedNote(source, "Retrieval");
      // The edit: the note's review deletes its vectors and queues the re-embedding job.
      await createAtomicNoteRepository(db()).review({
        id: edited.id,
        action: "edit",
        title: "Interleaving practice"
      });
      expect(await queued("relation-match")).toEqual([]);
      await supervisor!.runOnce();
      expect((await queued("relation-match")).map((job) => job.subjectKey)).toEqual([
        `note:${edited.id}`
      ]);
      // The approval changes no vector: MATCH looks only for a note it never matched.
      await knowledgeWithHooks().reviewNote({ id: approved.id, action: "approve" });
      expect((await queued("relation-match")).map((job) => job.subjectKey)).toEqual([
        `note:${edited.id}`,
        `note:${approved.id}`
      ]);
      // A discard queues none.
      const discarded = await seedNote(source, "Discarded");
      await knowledgeWithHooks().reviewNote({ id: discarded.id, action: "discard" });
      expect(await queued("relation-match")).toHaveLength(2);
    });
  });

  // --- the job through the supervisor ---------------------------------------------------------

  describe("the job", () => {
    const request = async (note: Note) => {
      const hooks = createTopicChangeHooks(
        triggers,
        quiet,
        createNoteMatchRequests({ getPool: () => db(), isRegistered: () => true })
      );
      await hooks.notesToMatch!([note.id]);
    };
    const outcomeOf = (note: Note) =>
      createGardenerOutcomeRepository(db()).get("relation-match", `note:${note.id}`);

    it("decides the note, hands its suggestions to the root's link job and records a done outcome", async () => {
      const source = await seedSource("Alpha");
      const other = await seedSource("Beta");
      const edited = await seedNote(source, "Alpha one");
      const target = await seedNote(other, "Beta one");
      decision = { kind: "accept", with: [target] };
      await request(edited);
      const [ran] = await drain();
      expect(ran).toMatchObject({
        type: "relation-match",
        status: "succeeded",
        outcome: "done",
        result: { status: "completed", decided: 1, accepted: 1 }
      });
      expect(ran!.inputFingerprint).toMatch(/^gf1:[0-9a-f]{64}$/u);
      expect(await outcomeOf(edited)).toMatchObject({
        lastOutcome: "done",
        lastFingerprint: ran!.inputFingerprint
      });
      // The matcher was asked to leave an unchanged note alone, as background work.
      expect(matchAtomicNotes.mock.calls[0]![3]).toMatchObject({
        jobId: ran!.id,
        priority: "P2",
        budgetClass: "background"
      });
      expect(matchAtomicNotes.mock.calls[0]![4]).toMatchObject({ skipUnchanged: true });
      // The root's link job carries the decided note and names the note; MATCH wrote no relation.
      const [link] = await queued("relation-link");
      expect(link).toMatchObject({
        dedupeKey: `relation-link:${source.sourceId}`,
        scopeKey: `root:${source.sourceId}`,
        payload: {
          rootId: source.sourceId,
          sourceItemId: source.sourceId,
          discover: true,
          matched: [{ noteId: edited.id, title: "Alpha one" }]
        }
      });
      expect(link!.payload.decided).toEqual([
        expect.objectContaining({
          noteId: edited.id,
          pairs: [expect.objectContaining({ candidateId: target.id, band: "suggest" })]
        })
      ]);
      expect(ran!.result).toMatchObject({ linkJobId: link!.id });
      expect(
        (await db().query("select 1 from atomic_note_relations")).rowCount,
        "MATCH writes no relation"
      ).toBe(0);
      expect((await db().query("select 1 from relation_events")).rowCount).toBe(0);
    });

    it("skips an equal input by fingerprint without a call, and decides an edited note again", async () => {
      const source = await seedSource("Gamma");
      const note = await seedNote(source, "Gamma one");
      await request(note);
      await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(1);
      // The same text again (an approval, a second save): skipped, with its outcome.
      await request(note);
      const [again] = await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(1);
      expect(again).toMatchObject({
        status: "succeeded",
        outcome: "skipped",
        result: { status: "skipped", reason: "same_input" }
      });
      // An edit of what the decider is shown changes the fingerprint, and the note is decided.
      await db().query("update atomic_notes set idea_statement = 'A new idea.' where id = $1", [
        note.id
      ]);
      await request(note);
      const [edited] = await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(2);
      expect(edited).toMatchObject({ outcome: "no_change" });
      expect((await outcomeOf(note))!.lastFingerprint).toBe(edited!.inputFingerprint);
      expect(edited!.inputFingerprint).not.toBe(again!.inputFingerprint);
    });

    it("ends as no change when the matcher finds the note matched already (ingestion decided it)", async () => {
      const source = await seedSource("Delta");
      const note = await seedNote(source, "Delta one");
      decision = { kind: "unchanged" };
      await request(note);
      const [ran] = await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(1);
      expect(ran).toMatchObject({
        outcome: "no_change",
        result: { status: "skipped", reason: "same_input" }
      });
      expect(await queued("relation-link")).toEqual([]);
    });

    it("sets the job aside for a missing decider without burning an attempt, and runs when it is back", async () => {
      const source = await seedSource("Epsilon");
      const note = await seedNote(source, "Epsilon one");
      decision = { kind: "waiting" };
      await request(note);
      const [waiting] = await drain(1);
      expect(waiting).toMatchObject({
        status: "queued",
        attempts: 0,
        dedupeKey: `relation-match:${note.id}`,
        blockedClass: "no_model",
        blockedReason: "no_decider"
      });
      // Back: the blocker is released and the job runs.
      decision = { kind: "nothing" };
      await db().query(
        "update jobs set blocked_class = null, blocked_reason = null, blocked_at = null, run_after = now() where id = $1",
        [waiting!.id]
      );
      const [ran] = await drain();
      expect(ran).toMatchObject({ id: waiting!.id, status: "succeeded", outcome: "no_change" });
    });

    it("waits for a running task of its own root and for nothing else (per-source exclusion)", async () => {
      const busy = await seedSource("Busy");
      const free = await seedSource("Free");
      const busyNote = await seedNote(busy, "Busy one");
      const freeNote = await seedNote(free, "Free one");
      // A link job of the first root runs (discovery takes minutes).
      await enqueueRelationLink(db(), { rootId: busy.sourceId });
      await db().query(
        "update jobs set status = 'running', locked_at = now(), dedupe_key = null where type = 'relation-link'"
      );
      await request(busyNote);
      await request(freeNote);
      const ran = await drain();
      expect(ran.map((job) => job.subjectKey)).toEqual([`note:${freeNote.id}`]);
      expect((await queued("relation-match")).map((job) => job.subjectKey)).toEqual([
        `note:${busyNote.id}`
      ]);
      // The link job ends: the first root's MATCH runs.
      await db().query(
        "update jobs set status = 'succeeded', finished_at = now() where type = 'relation-link'"
      );
      expect((await drain()).map((job) => job.subjectKey)).toEqual([`note:${busyNote.id}`]);
    });

    it("decides an unchanged note for a backlog's job, which states no fingerprint", async () => {
      const source = await seedSource("Zeta");
      const note = await seedNote(source, "Zeta one");
      await request(note);
      await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(1);
      await jobs().enqueueDeduped({
        type: "relation-match",
        lane: "light",
        dedupeKey: `relation-match:backlog:${note.id}`,
        payload: { noteId: note.id, rootId: source.sourceId, backlog: true },
        priority: -1,
        debounce: { delayMs: 0, maxDelayMs: 0 }
      });
      const [ran] = await drain();
      expect(matchAtomicNotes).toHaveBeenCalledTimes(2);
      expect(matchAtomicNotes.mock.calls[1]![3]).toMatchObject({ priority: "P3" });
      expect(matchAtomicNotes.mock.calls[1]![4]).toMatchObject({ skipUnchanged: false });
      expect(ran).toMatchObject({ outcome: "no_change", inputFingerprint: null });
    });
  });

  // --- the link job's change-set --------------------------------------------------------------

  describe("the change-set of what MATCH decided", () => {
    const writer = () =>
      vi.fn(async (_task: string, prompt: string) => {
        const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{ p: string }>;
        return {
          taskType: "structured-output" as const,
          output: { pairs: wire.map((entry) => ({ p: entry.p, t: "supports", d: "ab" })) },
          providerId: "openai-codex" as const,
          modelId: "gpt-test",
          runtime: "remote" as const,
          durationMs: 1,
          profileId,
          aiTaskRunId: aiRunId,
          outputLanguage: "en"
        };
      });
    const linker = () =>
      new RelationLinker({
        getPool: () => db(),
        steps: {
          typeRelationPairs: (pairs, options, signal) =>
            typeRelationPairs(
              {
                ai: { runDefaultTask: writer() } as never,
                store: createRelationTypingRepository(db()),
                resolveRoute: async () => route
              },
              pairs,
              options,
              signal
            ),
          discoverSourceRelations: async () => ({ persistedCount: 0 })
        },
        registry: new InFlightRegistry(),
        budget: createRelationCallBudget({ db: () => db(), cap: () => 500 }),
        runtime: () => ({ drain: false, remoteCallsOff: false })
      });
    /** Claims the root's queued link job, as the `relations` worker does. */
    const claim = async (rootId: string): Promise<JobRecord> => {
      const id = (
        await db().query<{ id: string }>(
          `select id from jobs where type = 'relation-link' and status = 'queued' and payload->>'rootId' = $1`,
          [rootId]
        )
      ).rows[0]!.id;
      await db().query(
        `update jobs set status = 'running', locked_at = now(), dedupe_key = null where id = $1`,
        [id]
      );
      return (await jobs().findById(id))!;
    };
    const runs = async () =>
      (
        await db().query<{
          kind: string;
          titleKey: string | null;
          titleParams: Record<string, unknown>;
          risk: string;
          reviewStatus: string | null;
          jobId: string | null;
        }>(
          `select kind, title_key as "titleKey", title_params as "titleParams", risk,
                  review_status as "reviewStatus", job_id::text as "jobId"
             from relation_match_runs order by started_at`
        )
      ).rows;

    it("persists the note's suggestions with the typer's guess of direction, under a run named after the note", async () => {
      const source = await seedSource("Theta");
      const other = await seedSource("Iota");
      const edited = await seedNote(source, "Theta one");
      const target = await seedNote(other, "Iota one");
      decision = { kind: "accept", with: [target] };
      await db().query("delete from jobs");
      const hooks = createTopicChangeHooks(
        triggers,
        quiet,
        createNoteMatchRequests({ getPool: () => db(), isRegistered: () => true })
      );
      await hooks.notesToMatch!([edited.id]);
      await drain();
      const link = await claim(source.sourceId);
      const result = await linker().link(link, new AbortController().signal);
      expect(result).toMatchObject({ runs: 0, suggested: 1, applied: 0 });
      const stored = (
        await db().query<{
          band: string;
          type: string | null;
          directionSource: string | null;
          shown: string;
        }>(
          `select band, relation_type as type, direction_source as "directionSource",
                  ${noteRelationDirectionSql("r")} as shown from atomic_note_relations r`
        )
      ).rows;
      // A suggestion of the local decider; the direction is the typer's guess, which no page shows.
      expect(stored).toEqual([
        { band: "suggest", type: "supports", directionSource: "typer", shown: "unknown" }
      ]);
      expect(await runs()).toEqual([
        {
          kind: "link",
          titleKey: "changes.titles.relationMatched",
          titleParams: { note: "Theta one" },
          risk: "low",
          reviewStatus: null,
          jobId: link.id
        }
      ]);
      // The change-set is read through the one view, with its title and an undo.
      const view = (
        await db().query<{ kind: string; titleKey: string; titleParams: unknown; undo: string }>(
          `select kind, title_key as "titleKey", title_params as "titleParams", undo from change_sets`
        )
      ).rows;
      expect(view).toEqual([
        {
          kind: "relation",
          titleKey: "changes.titles.relationMatched",
          titleParams: { note: "Theta one" },
          undo: "available"
        }
      ]);
    });

    it("names an import's run after its source when it only suggested, and gives the job to every run", async () => {
      const source = await seedSource("Kappa book");
      const other = await seedSource("Lambda");
      const k1 = await seedNote(source, "Kappa one");
      const l1 = await seedNote(other, "Lambda one");
      const decided = StoredDecidedNoteSchema.parse(decidedNote(k1, [l1]));
      const created = createIngestionRunRepository(db());
      const run = await created.create({
        sourceItemId: source.sourceId,
        status: "running",
        trigger: "library_action",
        effectiveStages: ["atomicNoteMatching", "sourceMatching"]
      });
      await created.completeStage(run.id, "atomicNoteMatching", { decided: [decided] });
      await created.parkForLinking(run.id, { rootId: source.sourceId });
      await enqueueRelationLink(db(), { rootId: source.sourceId });
      const link = await claim(source.sourceId);
      await linker().link(link, new AbortController().signal);
      expect(await runs()).toEqual([
        expect.objectContaining({
          kind: "link",
          titleKey: "changes.titles.relationSuggested",
          titleParams: { n: 1, source: "Kappa book" },
          jobId: link.id
        })
      ]);
    });
  });

  // --- the match state ------------------------------------------------------------------------

  it("keeps the hash of the text a note was matched with, replaced by each match", async () => {
    const source = await seedSource("State");
    const note = await seedNote(source, "State one");
    const states = createNoteMatchStateRepository(db());
    await states.record({ noteId: note.id, deciderKey: "a", spaceKey: space, kthCosine: 0.5 });
    expect((await states.read([note.id], space)).get(note.id)).toMatchObject({ inputHash: null });
    await states.record({
      noteId: note.id,
      deciderKey: "b",
      spaceKey: space,
      kthCosine: 0.4,
      inputHash: "hash-1"
    });
    expect((await states.read([note.id], space)).get(note.id)).toMatchObject({
      deciderKey: "b",
      inputHash: "hash-1"
    });
    expect((await states.read([note.id], "another-space")).size).toBe(0);
    await expect(
      states.record({
        noteId: note.id,
        deciderKey: "b",
        spaceKey: space,
        kthCosine: 0,
        inputHash: ""
      })
    ).rejects.toThrow("input hash");
  });

  // --- the backlog ----------------------------------------------------------------------------

  describe("the backlog", () => {
    let currentKey = "decider-new";
    const backlog = (pageSize = 500) =>
      new RelationMatchBacklog({
        getPool: () => db(),
        deciderKey: async () => currentKey,
        spaceKey: async () => space,
        config: {
          ...relationsConfig,
          match: { ...relationsConfig.match, backlogPageSize: pageSize }
        }
      });
    const findings = async () =>
      (
        await db().query<{
          id: string;
          fingerprint: string;
          status: string;
          params: Record<string, unknown>;
        }>(
          `select id, fingerprint, status, params from gardener_findings where kind = 'backlog'
            order by created_at, id`
        )
      ).rows;

    /** Two notes (one in a chapter) matched under the old decider; others the offer leaves out. */
    async function library() {
      const book = await seedSource("Backlog book");
      const chapter = await seedSource("Backlog chapter", book.sourceId);
      const loose = await seedSource("Backlog loose");
      const inChapter = await seedNote(chapter, "In chapter");
      const alone = await seedNote(loose, "Alone");
      const current = await seedNote(loose, "Already current");
      const rejected = await seedNote(loose, "Rejected", "rejected");
      const elsewhere = await seedNote(loose, "Other space");
      await recordState(inChapter, "decider-old");
      await recordState(alone, "decider-old");
      await recordState(current, "decider-new");
      await recordState(rejected, "decider-old");
      await recordState(elsewhere, "decider-old", "space-0");
      return { book, loose, inChapter, alone };
    }

    beforeEach(() => {
      currentKey = "decider-new";
    });

    it("offers the current notes matched by another decider, as one Inbox item kept up to date", async () => {
      await library();
      const offer = await backlog().offer();
      expect(offer).toMatchObject({ status: "offered", notes: 2 });
      expect(await findings()).toEqual([
        expect.objectContaining({
          fingerprint: matchBacklogFingerprint("decider-new"),
          status: "open",
          params: { task: "match", reason: "decider_changed", notes: 2 }
        })
      ]);
      // The offer queues nothing, and a second offer updates the count of the same finding.
      expect(await queuedCount()).toBe(0);
      const more = await seedNote(await seedSource("More"), "More");
      await recordState(more, "decider-old");
      expect(await backlog().offer()).toMatchObject({ status: "updated", notes: 3 });
      expect(await findings()).toHaveLength(1);
      expect((await findings())[0]!.params).toMatchObject({ notes: 3 });
    });

    it("queues the notes at the lowest priority, a page at a time, when the owner accepts", async () => {
      const { book, loose, inChapter, alone } = await library();
      const offer = await backlog(1).offer();
      if (offer.status !== "offered") throw new Error("expected an offer");
      expect(await backlog(1).accept(offer.findingId)).toEqual({ status: "queued", queued: 2 });
      const jobsQueued = await queued("relation-match");
      expect(jobsQueued.map((job) => job.subjectKey).sort()).toEqual(
        [`note:${inChapter.id}`, `note:${alone.id}`].sort()
      );
      for (const job of jobsQueued) {
        expect(job).toMatchObject({
          priority: -1,
          payload: expect.objectContaining({ backlog: true })
        });
        expect(job.dedupeKey).toBe(`relation-match:backlog:${job.payload.noteId as string}`);
        // The scope is the note's hierarchy root: a chapter's note belongs to its book.
        expect(job.scopeKey).toBe(
          job.payload.noteId === inChapter.id ? `root:${book.sourceId}` : `root:${loose.sourceId}`
        );
        expect(job.secondsAway).toBeLessThanOrEqual(1);
      }
      expect((await findings())[0]).toMatchObject({ status: "resolved" });
      // Accepted once: asking again queues nothing more.
      expect(await backlog().accept(offer.findingId)).toEqual({ status: "closed" });
      expect(await queued("relation-match")).toHaveLength(2);
    });

    it("keeps a dismissed offer closed, and closes the offer of a decider that was replaced", async () => {
      await library();
      const offer = await backlog().offer();
      if (offer.status !== "offered") throw new Error("expected an offer");
      await db().query(
        "update gardener_findings set status = 'dismissed', closed_at = now() where id = $1",
        [offer.findingId]
      );
      expect(await backlog().offer()).toEqual({ status: "closed", notes: 2 });
      expect(await findings()).toHaveLength(1);
      expect((await findings())[0]).toMatchObject({ status: "dismissed" });
      // The decider changes again: a new offer for it, and an open offer of the old one is moot.
      await db().query("update gardener_findings set status = 'open', closed_at = null");
      currentKey = "decider-newer";
      const newer = await backlog().offer();
      expect(newer).toMatchObject({ status: "offered", notes: 3 });
      expect((await findings()).map((finding) => finding.status)).toEqual(["resolved", "open"]);
      // Accepting the moot offer finds it closed; one resolved by a decider change is stale.
      expect(await backlog().accept(offer.findingId)).toEqual({ status: "closed" });
      await db().query(
        "update gardener_findings set status = 'open', closed_at = null where id = $1",
        [offer.findingId]
      );
      expect(await backlog().accept(offer.findingId)).toEqual({ status: "stale" });
      expect(await queued("relation-match")).toEqual([]);
    });

    it("closes the offer when nothing is left to match again", async () => {
      await library();
      await backlog().offer();
      await db().query("delete from note_match_state where decider_key <> 'decider-new'");
      expect(await backlog().offer()).toEqual({ status: "none", notes: 0 });
      expect((await findings())[0]).toMatchObject({ status: "resolved" });
    });
  });

  const queuedCount = async () =>
    Number(
      (
        await db().query<{ count: number }>(
          "select count(*)::int as count from jobs where type = 'relation-match'"
        )
      ).rows[0]!.count
    );
});
