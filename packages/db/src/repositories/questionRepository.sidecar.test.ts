import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { topicRecord } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createQuestionRepository } from "./questionRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import { createTopicOverviewRepository } from "./topicOverviewRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";
import { questionCitationHashSql } from "./questionCitationHashSql.js";

// The questions tables and their repository on a real PostgreSQL (F5 T116, D14): every method, the
// hash each kind of citation stores, and an answer going stale when what it cites changes or goes.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const noteHash = (title: string, idea: string, body: string) =>
  sha256(`${title}\u001f${idea}\u001f${body}`);
const sourceHash = (contentHash: string | null, summary: string | null) =>
  `${contentHash ?? ""}:${sha256(summary ?? "")}`;

describe.skipIf(!sidecarInstalled)("question repository on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let questions: ReturnType<typeof createQuestionRepository>;
  let overviews: ReturnType<typeof createTopicOverviewRepository>;
  const topicIds = Array.from({ length: 12 }, () => randomUUID());
  let nextTopic = 0;

  /** A source with a passage, a note resting on it and a topic of its own: one cited world. */
  async function world() {
    const source = await createSourceItemRepository(pool).create({
      type: "Book",
      title: `Sleep ${randomUUID()}`
    });
    await pool.query(
      "update source_items set content_hash = 'src-hash-1', summary = 'A summary.' where id = $1",
      [source.id]
    );
    const documentId = randomUUID();
    await pool.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'D', 't', 'doc')",
      [documentId, source.id]
    );
    const chunkId = randomUUID();
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Naps help.', 'chunk-hash-1')`,
      [chunkId, documentId, source.id]
    );
    const noteId = randomUUID();
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
          evidence_chunk_id, generation_provider, generation_model, generation_runtime,
          generation_prompt_version, generation_key)
       values ($1::uuid, 'Naps', 'Short naps restore focus.', 'Naps restore focus', $2, $3, 't', 't', 'local', 't', $1::text)`,
      [noteId, source.id, chunkId]
    );
    const topicId = topicIds[nextTopic++];
    if (!topicId) throw new Error("Out of fixture topics.");
    await overviews.write({
      topicId,
      paragraphs: [{ text: "Naps help.", citations: [] }],
      evidence: [],
      memberFingerprint: "members-1",
      memberCount: 1,
      inputHash: "input-1",
      promptRevisionId: "topic.overview@test",
      provider: "test",
      model: "test",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "unchecked", unsupported: [] },
      divergences: [],
      citations: []
    });
    return { sourceId: source.id, chunkId, noteId, topicId };
  }

  const answerOf = (
    cited: Array<{ kind: "note" | "source" | "topic" | "chunk"; targetId: string }>,
    status: "complete" | "canceled" | "failed" = "complete"
  ) => ({
    paragraphs: [{ markdown: "Naps help [1].", citations: cited.map((_, index) => index + 1) }],
    citations: cited.map((citation, index) => ({ ordinal: index + 1, ...citation })),
    provenance: { provider: "test", model: "test", promptRevisionId: "ask@test" },
    status,
    startedAt: new Date("2026-11-11T10:00:00.000Z"),
    completedAt: new Date("2026-11-11T10:00:01.000Z")
  });

  const newQuestion = (text = "Do naps help?") =>
    questions.create({ text, privacy: "offline_only", mode: "text" });

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-questions-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_questions_test",
        user: "memora_questions_test",
        password: `questions-${randomUUID()}`,
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
    await runMigrations(pool, migrationsFolder);
    questions = createQuestionRepository(pool);
    overviews = createTopicOverviewRepository(pool);

    const trees = createTopicTreeRepository(pool);
    const rootId = randomUUID();
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:questions:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: topicIds.map((id, index) =>
        topicRecord(id, rootId, {
          role: "topic",
          title: `Topic ${index}`,
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "en"
        })
      ),
      placements: []
    });
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("creates a running question before any answer, with the library as its default scope", async () => {
    const id = randomUUID();
    const created = await questions.create({
      id,
      text: "  Do naps help?  ",
      privacy: "allow_remote",
      mode: "hybrid"
    });
    expect(created).toMatchObject({
      id,
      text: "  Do naps help?  ",
      language: "und",
      scope: { kind: "library" },
      privacy: "allow_remote",
      mode: "hybrid",
      status: "running",
      errorKey: null,
      answers: []
    });
    expect(created.createdAt).toBeInstanceOf(Date);
    // The address is valid from the first token: a read finds it with no answer yet.
    expect(await questions.get(id)).toMatchObject({ id, status: "running", answers: [] });
    const tsv = await pool.query<{ search_tsv: string }>(
      "select search_tsv::text from questions where id = $1",
      [id]
    );
    expect(tsv.rows[0]?.search_tsv).toBe("'do':1 'help':3 'naps':2");

    const scoped = await questions.create({
      text: "About one topic",
      privacy: "offline_only",
      scope: { kind: "topic", topicId: randomUUID() }
    });
    expect(scoped.scope.kind).toBe("topic");
    expect(scoped.mode).toBe("text");
    await expect(
      questions.create({ text: "", privacy: "offline_only", mode: "text" })
    ).rejects.toThrow();
    await expect(
      questions.create({ text: "x".repeat(2001), privacy: "offline_only", mode: "text" })
    ).rejects.toThrow();
    await expect(
      questions.create({
        text: "too many",
        privacy: "offline_only",
        scope: { kind: "sources", sourceIds: Array.from({ length: 51 }, () => randomUUID()) }
      })
    ).rejects.toThrow();
  });

  it("stores an answer with its citations and their hashes in one transaction", async () => {
    const cited = await world();
    const question = await newQuestion();
    const stored = await questions.appendAnswer(
      question.id,
      answerOf([
        { kind: "note", targetId: cited.noteId },
        { kind: "chunk", targetId: cited.chunkId },
        { kind: "source", targetId: cited.sourceId },
        { kind: "topic", targetId: cited.topicId }
      ])
    );
    expect(stored).toMatchObject({ version: 1, missingTargets: 0 });
    const hashes = await pool.query<{ ordinal: number; kind: string; hash: string }>(
      `select ordinal, target_kind as kind, content_hash as hash
         from question_citations where answer_id = $1 order by ordinal`,
      [stored?.answerId]
    );
    // The one SQL expression per kind agrees with an independent computation of what it hashes.
    expect(hashes.rows).toEqual([
      {
        ordinal: 1,
        kind: "note",
        hash: noteHash("Naps", "Naps restore focus", "Short naps restore focus.")
      },
      { ordinal: 2, kind: "chunk", hash: "chunk-hash-1" },
      { ordinal: 3, kind: "source", hash: sourceHash("src-hash-1", "A summary.") },
      { ordinal: 4, kind: "topic", hash: "v1" }
    ]);
    expect((await questions.get(question.id))?.status).toBe("complete");

    // The answer is a version up and the question follows it; a failure keeps its message key.
    const failed = await questions.appendAnswer(question.id, {
      ...answerOf([], "failed"),
      paragraphs: [],
      errorKey: "consultation.errors.provider"
    });
    expect(failed?.version).toBe(2);
    expect(await questions.get(question.id)).toMatchObject({
      status: "failed",
      errorKey: "consultation.errors.provider"
    });
    const canceled = await questions.appendAnswer(question.id, answerOf([], "canceled"));
    expect(canceled?.version).toBe(3);
    expect(await questions.get(question.id)).toMatchObject({
      status: "canceled",
      errorKey: null
    });
  });

  it("refuses a malformed answer and stores nothing for a question that is gone", async () => {
    const question = await newQuestion();
    const base = answerOf([]);
    await expect(
      questions.appendAnswer(question.id, {
        ...base,
        paragraphs: [{ markdown: "Cites [1].", citations: [1] }]
      })
    ).rejects.toThrow(/not stored with the answer/);
    const target = randomUUID();
    await expect(
      questions.appendAnswer(question.id, {
        ...answerOf([
          { kind: "note", targetId: target },
          { kind: "note", targetId: target }
        ]),
        citations: [
          { ordinal: 1, kind: "note", targetId: target },
          { ordinal: 1, kind: "note", targetId: target }
        ]
      })
    ).rejects.toThrow(/twice/);
    expect((await questions.get(question.id))?.answers).toEqual([]);

    expect(await questions.appendAnswer(randomUUID(), base)).toBeNull();
    // A target that vanished before the save is kept with no hash: it reads unavailable, and stale.
    const missing = await questions.appendAnswer(
      question.id,
      answerOf([{ kind: "note", targetId: randomUUID() }])
    );
    expect(missing?.missingTargets).toBe(1);
    const read = await questions.get(question.id);
    expect(read?.answers[0]?.stale).toBe(true);
    expect(read?.answers[0]?.citations[0]).toMatchObject({ unavailable: true, stale: true });
  });

  it("serializes two answers of one question onto two versions", async () => {
    const question = await newQuestion();
    const results = await Promise.all(
      [1, 2, 3].map(() => questions.appendAnswer(question.id, answerOf([])))
    );
    expect(results.map((result) => result?.version).sort()).toEqual([1, 2, 3]);
  });

  it("reads an unchanged answer as fresh, with an address for each citation", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(question.id, {
      ...answerOf([
        { kind: "note", targetId: cited.noteId },
        { kind: "chunk", targetId: cited.chunkId },
        { kind: "source", targetId: cited.sourceId },
        { kind: "topic", targetId: cited.topicId }
      ]),
      citations: [
        { ordinal: 1, kind: "note", targetId: cited.noteId, anchor: { passage: cited.chunkId } },
        { ordinal: 2, kind: "chunk", targetId: cited.chunkId },
        { ordinal: 3, kind: "source", targetId: cited.sourceId },
        { ordinal: 4, kind: "topic", targetId: cited.topicId }
      ]
    });
    const read = await questions.get(question.id);
    expect(read?.answers).toHaveLength(1);
    const answer = read?.answers[0];
    expect(answer?.stale).toBe(false);
    expect(answer?.citations).toEqual([
      {
        ordinal: 1,
        address: `memora://note/${cited.noteId}`,
        anchor: { passage: cited.chunkId },
        unavailable: false,
        stale: false
      },
      {
        ordinal: 2,
        // A passage is read inside its source.
        address: `memora://source/${cited.sourceId}`,
        anchor: { passage: cited.chunkId },
        unavailable: false,
        stale: false
      },
      {
        ordinal: 3,
        address: `memora://source/${cited.sourceId}`,
        unavailable: false,
        stale: false
      },
      { ordinal: 4, address: `memora://topic/${cited.topicId}`, unavailable: false, stale: false }
    ]);
    expect(answer?.paragraphs[0]?.markdown).toBe("Naps help [1].");
    expect(answer?.provenance).toMatchObject({ provider: "test", promptRevisionId: "ask@test" });
    expect(await questions.get(randomUUID())).toBeNull();
  });

  it("marks an answer stale when a cited note's text changes", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(question.id, answerOf([{ kind: "note", targetId: cited.noteId }]));
    await pool.query("update atomic_notes set body_markdown = 'Edited body.' where id = $1", [
      cited.noteId
    ]);
    const answer = (await questions.get(question.id))?.answers[0];
    expect(answer?.stale).toBe(true);
    expect(answer?.citations[0]).toMatchObject({ unavailable: false, stale: true });
  });

  it("marks an answer stale when a cited passage's content hash changes", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(
      question.id,
      answerOf([{ kind: "chunk", targetId: cited.chunkId }])
    );
    await pool.query("update chunks set content_hash = 'chunk-hash-2' where id = $1", [
      cited.chunkId
    ]);
    expect((await questions.get(question.id))?.answers[0]?.stale).toBe(true);
  });

  it("marks an answer stale when a cited source's summary changes", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(
      question.id,
      answerOf([{ kind: "source", targetId: cited.sourceId }])
    );
    await pool.query("update source_items set summary = 'A new summary.' where id = $1", [
      cited.sourceId
    ]);
    expect((await questions.get(question.id))?.answers[0]?.stale).toBe(true);
  });

  it("marks an answer stale when a cited topic's overview version rises", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(
      question.id,
      answerOf([{ kind: "topic", targetId: cited.topicId }])
    );
    expect((await questions.get(question.id))?.answers[0]?.stale).toBe(false);
    const rewritten = await overviews.write({
      topicId: cited.topicId,
      paragraphs: [
        { text: "Naps help.", citations: [] },
        { text: "Not too long.", citations: [] }
      ],
      evidence: [],
      memberFingerprint: "members-2",
      memberCount: 1,
      inputHash: "input-2",
      promptRevisionId: "topic.overview@test",
      provider: "test",
      model: "test",
      runtime: "none",
      aiTaskRunId: null,
      language: "en",
      support: { status: "unchecked", unsupported: [] },
      divergences: [],
      citations: []
    });
    expect(rewritten.kind).toBe("written");
    expect((await questions.get(question.id))?.answers[0]?.stale).toBe(true);
  });

  it("reads a deleted target as unavailable and stale", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(
      question.id,
      answerOf([
        { kind: "note", targetId: cited.noteId },
        { kind: "chunk", targetId: cited.chunkId }
      ])
    );
    await pool.query("delete from atomic_notes where id = $1", [cited.noteId]);
    const answer = (await questions.get(question.id))?.answers[0];
    expect(answer?.stale).toBe(true);
    expect(answer?.citations[0]).toMatchObject({
      address: `memora://note/${cited.noteId}`,
      unavailable: true,
      stale: true
    });
    expect(answer?.citations[1]).toMatchObject({ unavailable: false, stale: false });
    // The passage goes with its source: its address can no longer be rebuilt.
    await pool.query("delete from source_items where id = $1", [cited.sourceId]);
    const gone = (await questions.get(question.id))?.answers[0];
    expect(gone?.citations[1]).toMatchObject({ address: null, unavailable: true, stale: true });
  });

  it("keeps each version's own staleness", async () => {
    const cited = await world();
    const question = await newQuestion();
    await questions.appendAnswer(question.id, answerOf([{ kind: "note", targetId: cited.noteId }]));
    await pool.query("update atomic_notes set title = 'Renamed' where id = $1", [cited.noteId]);
    await questions.setStatus(question.id, "running");
    await questions.appendAnswer(question.id, answerOf([{ kind: "note", targetId: cited.noteId }]));
    const read = await questions.get(question.id);
    expect(read?.answers.map((answer) => [answer.version, answer.stale])).toEqual([
      [1, true],
      [2, false]
    ]);
  });

  it("sets a status and reports a question that is gone", async () => {
    const question = await newQuestion();
    expect(await questions.setStatus(question.id, "failed", "consultation.errors.provider")).toBe(
      true
    );
    expect(await questions.get(question.id)).toMatchObject({
      status: "failed",
      errorKey: "consultation.errors.provider"
    });
    expect(await questions.setStatus(question.id, "running", "ignored")).toBe(true);
    expect(await questions.get(question.id)).toMatchObject({ status: "running", errorKey: null });
    expect(await questions.setStatus(randomUUID(), "canceled")).toBe(false);
  });

  it("lists newest first by keyset, with no row lost or repeated across ties", async () => {
    await questions.clear();
    const created: string[] = [];
    for (let index = 0; index < 7; index += 1) {
      const question = await newQuestion(`Question number ${index} about sleep`);
      created.push(question.id);
    }
    // Four share one instant: only the ID breaks the tie.
    await pool.query(
      "update questions set created_at = '2026-11-01T10:00:00.123456Z' where id = any($1::uuid[])",
      [created.slice(0, 4)]
    );
    await pool.query(
      "update questions set created_at = '2026-11-02T10:00:00.000001Z' where id = any($1::uuid[])",
      [created.slice(4)]
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await questions.list({ limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
      pages += 1;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect(seen.slice(0, 3).sort()).toEqual(created.slice(4).sort());
    const idsDescending = (ids: string[]) => [...ids].sort().reverse();
    expect(seen.slice(0, 3)).toEqual(idsDescending(seen.slice(0, 3)));
    expect(seen.slice(3)).toEqual(idsDescending(seen.slice(3)));

    const first = await questions.list();
    expect(first.items[0]).toMatchObject({
      scope: { kind: "library" },
      status: "running",
      answerCount: 0
    });
    expect((await questions.list({ limit: 500 })).items).toHaveLength(7);
    await expect(questions.list({ cursor: "not-a-cursor" })).rejects.toThrow(
      "errors.questions.cursor"
    );
  });

  it("filters a list by the question's words, accents and case folded", async () => {
    await questions.clear();
    await questions.create({
      text: "Como a memória consolida o sono?",
      language: "pt",
      privacy: "offline_only",
      mode: "text"
    });
    await questions.create({ text: "What is a note?", privacy: "offline_only", mode: "text" });
    const found = await questions.list({ query: "MEMORIA" });
    expect(found.items.map((item) => item.text)).toEqual(["Como a memória consolida o sono?"]);
    expect((await questions.list({ query: "sono" })).items).toHaveLength(1);
    expect((await questions.list({ query: "   " })).items).toHaveLength(2);
    expect((await questions.list({ query: "unrelated gibberish" })).items).toHaveLength(0);
  });

  it("deletes a question with its answers and citations, and clears them all", async () => {
    await questions.clear();
    const cited = await world();
    const first = await newQuestion("First question");
    const second = await newQuestion("Second question");
    for (const question of [first, second])
      await questions.appendAnswer(
        question.id,
        answerOf([{ kind: "note", targetId: cited.noteId }])
      );
    const count = async (table: string) =>
      Number((await pool.query<{ n: string }>(`select count(*) as n from ${table}`)).rows[0]?.n);
    expect([await count("question_answers"), await count("question_citations")]).toEqual([2, 2]);

    expect(await questions.delete(first.id)).toBe(true);
    expect(await questions.delete(first.id)).toBe(false);
    expect([await count("question_answers"), await count("question_citations")]).toEqual([1, 1]);
    // What a question cited is untouched by deleting the question.
    expect(
      (await pool.query("select 1 from atomic_notes where id = $1", [cited.noteId])).rowCount
    ).toBe(1);

    expect(await questions.clear()).toBe(1);
    expect(await questions.clear()).toBe(0);
    expect([
      await count("questions"),
      await count("question_answers"),
      await count("question_citations")
    ]).toEqual([0, 0, 0]);
  });

  it("keeps the hash expressions in one place for both the save and the read", () => {
    expect(Object.keys(questionCitationHashSql).sort()).toEqual([
      "chunk",
      "note",
      "source",
      "topic"
    ]);
  });
});
