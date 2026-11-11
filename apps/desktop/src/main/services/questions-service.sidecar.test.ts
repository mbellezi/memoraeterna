import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createQuestionRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import type { QuestionCitationInput } from "@app/domain";

import { QuestionViewSchema } from "../../shared/ipc-questions.js";
import type { AppEvent } from "../../shared/app-events.js";
import type { ConsultationService } from "./consultation-service.js";
import { QuestionsService } from "./questions-service.js";

// The reads of Ask persistence (F5 T129) on a real PostgreSQL database: a stored question read back
// with its answer versions and the staleness of each (a cited note edited, a passage rewritten, a
// target deleted), the list paged by keyset with its search and its refused cursor, deleting one
// and clearing all, and asking again as the next version of the same question.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("Ask persistence reads on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  let repository: ReturnType<typeof createQuestionRepository>;
  const events: AppEvent[] = [];
  const consultation = {
    ask: vi.fn(),
    cancel: vi.fn(async () => null)
  };
  let service: QuestionsService;

  const sourceId = randomUUID();
  const documentId = randomUUID();
  const chunkId = randomUUID();
  const noteId = randomUUID();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-questions-reads-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_questions_reads_test",
        user: "memora_questions_reads_test",
        password: `questions-reads-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    repository = createQuestionRepository(pool);
    service = new QuestionsService({
      getPool: () => pool,
      consultation: consultation as unknown as Pick<ConsultationService, "ask" | "cancel">,
      contentLanguage: async () => "en",
      publish: (event) => events.push(event)
    });

    await pool.query(
      `insert into source_items (id, type, title, language, content_hash)
       values ($1, 'Book', 'Sleep', 'en', 'content-1')`,
      [sourceId]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'seed', 'doc-1')`,
      [documentId, sourceId]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Naps restore focus.', 'chunk-hash-1')`,
      [chunkId, documentId, sourceId]
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language)
       values ($1::uuid, 'Naps', 'Short naps restore focus.', 'Naps restore focus', 'active',
         'current', 'source', $2, $2, $3, 'seed', 'seed', 'local', 'seed', $1::uuid::text, 'en')`,
      [noteId, sourceId, chunkId]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  /** A finished question whose one answer cites the passage (ordinal 1) and the note (ordinal 2). */
  async function answered(text: string) {
    const question = await repository.create({ text, privacy: "offline_only" });
    const citations: QuestionCitationInput[] = [
      { ordinal: 1, kind: "chunk", targetId: chunkId, anchor: { span: randomUUID() } },
      { ordinal: 2, kind: "note", targetId: noteId }
    ];
    await repository.appendAnswer(question.id, {
      paragraphs: [
        { markdown: "Naps help [e1].", citations: [1] },
        { markdown: "Short ones most [e2].", citations: [2] }
      ],
      citations,
      provenance: { route: "class:answer", model: "m" },
      status: "complete",
      startedAt: new Date(),
      completedAt: new Date()
    });
    return question.id;
  }

  it("reads a stored answer with its citations as addresses, and its staleness from the targets", async () => {
    const id = await answered("Do naps help?");
    const view = await service.get({ id });
    expect(QuestionViewSchema.parse(view)).toEqual(view);
    expect(view).toMatchObject({ id, text: "Do naps help?", status: "complete" });
    expect(view!.answers).toHaveLength(1);
    const [answer] = view!.answers;
    expect(answer).toMatchObject({ version: 1, status: "complete", stale: false });
    const [first, second] = answer!.paragraphs;
    // A passage is read inside its source, with the passage as the anchor.
    expect(first!.citations).toEqual([
      expect.objectContaining({
        ordinal: 1,
        address: `memora://source/${sourceId}`,
        anchor: expect.objectContaining({ passage: chunkId }),
        unavailable: false,
        stale: false
      })
    ]);
    expect(second!.citations).toEqual([
      { ordinal: 2, address: `memora://note/${noteId}`, unavailable: false, stale: false }
    ]);

    // The cited note is edited: the answer is outdated, and the citation that changed says so.
    await pool.query("update atomic_notes set body_markdown = 'Edited.' where id = $1", [noteId]);
    const outdated = (await service.get({ id }))!.answers[0]!;
    expect(outdated.stale).toBe(true);
    expect(outdated.paragraphs[0]!.citations[0]!.stale).toBe(false);
    expect(outdated.paragraphs[1]!.citations[0]).toMatchObject({ stale: true, unavailable: false });
    await pool.query(
      "update atomic_notes set body_markdown = 'Short naps restore focus.' where id = $1",
      [noteId]
    );
    expect((await service.get({ id }))!.answers[0]!.stale).toBe(false);

    // The passage is rewritten: stale. Then it is gone: unavailable, with no address to open.
    await pool.query("update chunks set content_hash = 'chunk-hash-2' where id = $1", [chunkId]);
    expect((await service.get({ id }))!.answers[0]!.stale).toBe(true);
    await pool.query("update chunks set content_hash = 'chunk-hash-1' where id = $1", [chunkId]);
    expect((await service.get({ id }))!.answers[0]!.stale).toBe(false);
    expect(await service.get({ id: randomUUID() })).toBeNull();
  });

  it("reads a target that is gone as unavailable and stale, with no address for a deleted passage", async () => {
    const lonelyChunk = randomUUID();
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 5, 'Soon gone.', 'chunk-hash-gone')`,
      [lonelyChunk, documentId, sourceId]
    );
    const question = await repository.create({ text: "A doomed passage", privacy: "offline_only" });
    await repository.appendAnswer(question.id, {
      paragraphs: [{ markdown: "It says so [e1].", citations: [1] }],
      citations: [{ ordinal: 1, kind: "chunk", targetId: lonelyChunk }],
      provenance: {},
      status: "complete",
      startedAt: new Date(),
      completedAt: new Date()
    });
    await pool.query("delete from chunks where id = $1", [lonelyChunk]);
    const answer = (await service.get({ id: question.id }))!.answers[0]!;
    expect(answer.stale).toBe(true);
    expect(answer.paragraphs[0]!.citations[0]).toMatchObject({
      address: null,
      unavailable: true,
      stale: true
    });
  });

  it("pages the list newest first by keyset, filters by words, and refuses a cursor it did not issue", async () => {
    await pool.query("delete from questions");
    const ids: string[] = [];
    for (const text of [
      "Alpha sleep",
      "Beta memory",
      "Gamma sleep",
      "Delta focus",
      "Epsilon sleep"
    ])
      ids.push((await repository.create({ text, privacy: "offline_only" })).id);
    const first = await service.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([ids[4], ids[3]]);
    expect(first.next).toEqual(expect.any(String));
    const second = await service.list({ limit: 2, cursor: first.next });
    expect(second.items.map((item) => item.id)).toEqual([ids[2], ids[1]]);
    // A question asked between the pages never shifts the next page.
    await repository.create({ text: "Zeta late", privacy: "offline_only" });
    const third = await service.list({ limit: 2, cursor: second.next });
    expect(third.items.map((item) => item.id)).toEqual([ids[0]]);
    expect(third.next).toBeUndefined();
    const sleep = await service.list({ query: "SLEEP" });
    expect(sleep.items.map((item) => item.text).sort()).toEqual([
      "Alpha sleep",
      "Epsilon sleep",
      "Gamma sleep"
    ]);
    expect(first.items[0]).toMatchObject({
      status: "failed", // nothing is writing it in this process: the app quit while it ran
      answerCount: 0,
      scope: { kind: "library" }
    });

    const tampered = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    for (const cursor of [
      "not-a-cursor",
      tampered(["March 7", "------------------------------------"]),
      tampered(["1", "00000000-0000-0000-0000-00000000000z"]),
      tampered(["2026-11-11T10:00:00.000Z", "abcdefabcdefabcdefabcdefabcdefabcdef"])
    ])
      await expect(service.list({ cursor })).rejects.toThrow("questions.errors.cursor");
  });

  it("deletes one question with its answers, and clears every question in one call", async () => {
    await pool.query("delete from questions");
    events.length = 0;
    const a = await answered("To delete");
    const b = await answered("To clear");
    const c = await answered("To clear too");
    await expect(service.delete({ id: a })).resolves.toEqual({ deleted: true });
    expect(await service.get({ id: a })).toBeNull();
    expect(
      (
        await pool.query("select count(*)::int as n from question_answers where question_id = $1", [
          a
        ])
      ).rows[0].n
    ).toBe(0);
    await expect(service.delete({ id: a })).resolves.toEqual({ deleted: false });
    expect(events).toEqual([
      { type: "object.changed", refs: [{ kind: "question", id: a, change: "deleted" }] }
    ]);
    await expect(service.clear()).resolves.toEqual({ deleted: 2 });
    expect(events.at(-1)).toEqual({ type: "object.changed", overflow: true, kinds: ["question"] });
    for (const id of [b, c]) expect(await service.get({ id })).toBeNull();
    expect((await service.list({})).items).toEqual([]);
    expect((await pool.query("select count(*)::int as n from question_citations")).rows[0].n).toBe(
      0
    );
  });

  it("asks again as the next version of the same question, with the stored scope", async () => {
    const id = await answered("Do naps help, again?");
    events.length = 0;
    consultation.ask.mockImplementationOnce(
      async (_input: unknown, hooks: Parameters<ConsultationService["ask"]>[1]) => {
        hooks?.onPrepared?.({
          evidence: [
            { handle: "e1", chunkId, sourceItemId: sourceId, sourceSpanId: null }
          ] as never,
          profile: { provider: "fake", modelId: "m2", runtime: "remote" } as never,
          promptFingerprint: "fingerprint"
        });
        return {
          answer: { paragraphs: [{ markdown: "Yes [e1].", citations: ["e1"] }] },
          inputTokens: 10,
          outputTokens: 4,
          costEstimate: null
        } as never;
      }
    );
    const { requestId } = await service.askAgain({ id });
    expect(requestId).toEqual(expect.any(String));
    await service.idle();
    const view = (await service.get({ id }))!;
    expect(QuestionViewSchema.parse(view)).toEqual(view);
    expect(view.status).toBe("complete");
    expect(view.answers.map((answer) => answer.version)).toEqual([1, 2]);
    expect(view.answers[1]!.paragraphs[0]!.markdown).toBe("Yes [e1].");
    expect(view.answers[1]!.model).toMatchObject({ provider: "fake", model: "m2" });
    expect(consultation.ask).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestId, question: "Do naps help, again?", sourceIds: [] }),
      expect.anything()
    );
    expect(events.map((event) => event.type)).toEqual([
      "object.changed",
      "consultation.delta",
      "object.changed",
      "consultation.status"
    ]);
    // The row count says it is still one question.
    expect((await service.list({})).items.filter((item) => item.id === id)).toHaveLength(1);
  });
});
