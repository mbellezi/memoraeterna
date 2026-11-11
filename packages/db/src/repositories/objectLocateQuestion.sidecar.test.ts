import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import {
  ObjectLocateResultSchema,
  type AskScope,
  type QuestionCitationInput,
  type QuestionCitationKind
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import { createQuestionRepository } from "./questionRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `objects.locate` for a question on a real PostgreSQL (F5 S4, T129): a topic scope keeps the scope
// topic's chain; a library or source scope is placed where most of the notes its newest cited
// answer rests on are primarily placed; the tie order is by title, then by topic ID; an answer with
// no citation that reaches a placed note has no place.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("locate for questions on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let locate: ReturnType<typeof createObjectLocateRepository>;
  let questions: ReturnType<typeof createQuestionRepository>;

  const rootId = randomUUID();
  const sourceId = randomUUID();
  const documentId = randomUUID();
  const topic = {
    area: randomUUID(),
    beta: randomUUID(),
    gamma: randomUUID(),
    twinA: randomUUID(),
    twinB: randomUUID(),
    retired: randomUUID(),
    unnamed: randomUUID()
  };
  /** One note per name, each with the passage that is its primary evidence. */
  const notes: Record<string, { id: string; chunk: string }> = {};
  let extraChunk = "";

  async function note(name: string, options: { superseded?: boolean } = {}) {
    const id = randomUUID();
    const chunk = randomUUID();
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        chunk,
        documentId,
        sourceId,
        Object.keys(notes).length,
        `Passage of ${name}.`,
        `hash-${chunk}`
      ]
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language)
       values ($1::uuid, $2, 'Body.', $2, 'active', $3, 'source', $4, $4, $5, 'seed', 'seed',
         'local', 'seed', $1::uuid::text, 'en')`,
      [id, name, options.superseded ? "superseded" : "current", sourceId, chunk]
    );
    notes[name] = { id, chunk };
  }

  /** A question whose newest answer cites these targets, one ordinal each. */
  async function ask(
    text: string,
    scope: AskScope,
    cited: Array<[QuestionCitationKind, string]>
  ): Promise<string> {
    const question = await questions.create({ text, scope, privacy: "offline_only" });
    if (cited.length) await answer(question.id, cited);
    return question.id;
  }

  async function answer(
    questionId: string,
    cited: Array<[QuestionCitationKind, string]>,
    status: "complete" | "canceled" = "complete"
  ) {
    const citations: QuestionCitationInput[] = cited.map(([kind, targetId], index) => ({
      ordinal: index + 1,
      kind,
      targetId
    }));
    await questions.appendAnswer(questionId, {
      paragraphs: [{ markdown: "An answer.", citations: citations.map((c) => c.ordinal) }],
      citations,
      provenance: { route: "class:answer" },
      status,
      startedAt: new Date(),
      completedAt: new Date()
    });
  }

  const pathIds = (result: { primaryPath: Array<{ id: string }> } | null) =>
    result?.primaryPath.map((item) => item.id);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-locate-question-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_locate_question_test",
        user: "memora_locate_question_test",
        password: `locate-question-${randomUUID()}`,
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
    locate = createObjectLocateRepository(pool);
    questions = createQuestionRepository(pool);

    await pool.query(
      `insert into source_items (id, type, title, language, content_hash)
       values ($1, 'Book', 'Sleep', 'en', 'content-s1')`,
      [sourceId]
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Doc', 'seed', 'doc-1')`,
      [documentId, sourceId]
    );
    for (const name of ["b1", "b2", "g1", "g2", "ta", "tb", "retired1", "unplaced", "unnamed1"])
      await note(name);
    await note("old", { superseded: true });
    // A passage that is no note's primary evidence: a note reaches it through a source link.
    extraChunk = randomUUID();
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 99, 'A linked passage.', 'hash-linked')`,
      [extraChunk, documentId, sourceId]
    );
    await pool.query(
      `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id) values ($1, $2, $3)`,
      [notes.g1!.id, sourceId, extraChunk]
    );

    const trees = createTopicTreeRepository(pool);
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:locate-question:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const named = (id: string, parent: string, title: string | null) =>
      topicRecord(id, parent, {
        role: "topic",
        ...(title
          ? { title, nameState: "named" as const, nameSource: "llm" as const, nameLanguage: "en" }
          : {})
      });
    const boot = await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.area, rootId, "Alpha area"),
        named(topic.beta, topic.area, "Beta"),
        named(topic.gamma, rootId, "Gamma"),
        // Two topics with one title (under different parents): the lower ID wins a tie between them.
        named(topic.twinA, rootId, "Twin"),
        named(topic.twinB, topic.gamma, "Twin"),
        named(topic.retired, rootId, "Retired"),
        named(topic.unnamed, rootId, null)
      ],
      placements: [
        { item: itemKey("note", notes.b1!.id), placement: placementRecord(topic.beta) },
        { item: itemKey("note", notes.b2!.id), placement: placementRecord(topic.beta) },
        { item: itemKey("note", notes.g1!.id), placement: placementRecord(topic.gamma) },
        { item: itemKey("note", notes.g2!.id), placement: placementRecord(topic.gamma) },
        { item: itemKey("note", notes.ta!.id), placement: placementRecord(topic.twinA) },
        { item: itemKey("note", notes.tb!.id), placement: placementRecord(topic.twinB) },
        { item: itemKey("note", notes.retired1!.id), placement: placementRecord(topic.retired) },
        { item: itemKey("note", notes.unnamed1!.id), placement: placementRecord(topic.unnamed) },
        // A superseded note placed in Gamma does not count there.
        { item: itemKey("note", notes.old!.id), placement: placementRecord(topic.gamma) }
      ]
    });
    if (boot.kind !== "applied")
      throw new Error(`The fixture tree was not built: ${JSON.stringify(boot)}`);
    await pool.query("update topics set retired_at = now(), redirect_to = $2 where id = $1", [
      topic.retired,
      topic.beta
    ]);
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("places a library question in the topic where most of its cited notes are placed", async () => {
    const id = await ask("What helps memory?", { kind: "library" }, [
      ["chunk", notes.b1!.chunk],
      ["chunk", notes.b2!.chunk],
      ["chunk", notes.g1!.chunk]
    ]);
    const result = await locate.locateQuestion(id);
    expect(ObjectLocateResultSchema.parse(result)).toEqual(result);
    expect(result?.object).toEqual({ kind: "question", id, title: "What helps memory?" });
    // The tree root, its child, the winner (two notes) and then the question itself.
    expect(pathIds(result)).toEqual([rootId, topic.area, topic.beta, id]);
    expect(result?.primaryPath.map((item) => item.title)).toEqual([
      "",
      "Alpha area",
      "Beta",
      "What helps memory?"
    ]);
    expect(result?.alsoIn).toEqual([{ kind: "topic", id: topic.gamma, title: "Gamma" }]);
    expect(result?.counts).toMatchObject({ alsoIn: 1, notes: 3, passages: 3, citedBy: 0 });
  });

  it("places a question whose sources are chosen the same way", async () => {
    const id = await ask("About these sources", { kind: "sources", sourceIds: [sourceId] }, [
      ["chunk", notes.g1!.chunk],
      ["chunk", notes.g2!.chunk],
      ["chunk", notes.b1!.chunk]
    ]);
    expect(pathIds(await locate.locateQuestion(id))).toEqual([rootId, topic.gamma, id]);
  });

  it("breaks a tie by topic title, then by topic ID", async () => {
    const byTitle = await ask("Beta against Gamma", { kind: "library" }, [
      ["chunk", notes.g1!.chunk],
      ["chunk", notes.b1!.chunk]
    ]);
    const first = await locate.locateQuestion(byTitle);
    expect(pathIds(first)).toEqual([rootId, topic.area, topic.beta, byTitle]);
    expect(first?.alsoIn.map((item) => item.id)).toEqual([topic.gamma]);

    const byId = await ask("Twin against twin", { kind: "library" }, [
      ["chunk", notes.tb!.chunk],
      ["chunk", notes.ta!.chunk]
    ]);
    const [low, high] = [topic.twinA, topic.twinB].sort() as [string, string];
    const chainOf = (twin: string) =>
      twin === topic.twinA ? [rootId, twin] : [rootId, topic.gamma, twin];
    const twins = await locate.locateQuestion(byId);
    expect(pathIds(twins)).toEqual([...chainOf(low), byId]);
    expect(twins?.alsoIn.map((item) => item.id)).toEqual([high]);
    // The answer does not depend on the order the citations were written in.
    const reversed = await ask("Twin against twin, reversed", { kind: "library" }, [
      ["chunk", notes.ta!.chunk],
      ["chunk", notes.tb!.chunk]
    ]);
    expect(pathIds(await locate.locateQuestion(reversed))).toEqual([...chainOf(low), reversed]);
  });

  it("counts a note once however many citations reach it, and takes a note cited as itself", async () => {
    const id = await ask("One note, three ways", { kind: "library" }, [
      ["note", notes.g1!.id],
      ["chunk", notes.g1!.chunk],
      ["chunk", extraChunk],
      ["chunk", notes.b1!.chunk],
      ["chunk", notes.b2!.chunk]
    ]);
    const result = await locate.locateQuestion(id);
    // g1 once (three citations), b1 and b2: Beta has two notes against one.
    expect(pathIds(result)).toEqual([rootId, topic.area, topic.beta, id]);
    expect(result?.counts).toMatchObject({ notes: 3, passages: 5 });
  });

  it("reads a note through the source link of a cited passage, not only its primary evidence", async () => {
    const id = await ask("A linked passage", { kind: "library" }, [["chunk", extraChunk]]);
    expect(pathIds(await locate.locateQuestion(id))).toEqual([rootId, topic.gamma, id]);
  });

  it("keeps a topic-scoped question in its scope topic, whatever its citations say", async () => {
    const id = await ask("Inside Gamma", { kind: "topic", topicId: topic.gamma }, [
      ["chunk", notes.b1!.chunk],
      ["chunk", notes.b2!.chunk]
    ]);
    const result = await locate.locateQuestion(id);
    expect(pathIds(result)).toEqual([rootId, topic.gamma, id]);
    expect(result?.alsoIn).toEqual([]);
    // Before any answer there is nothing to read, yet the scope still places the question.
    const asked = await ask(
      "Inside Beta, not answered yet",
      { kind: "topic", topicId: topic.beta },
      []
    );
    expect(pathIds(await locate.locateQuestion(asked))).toEqual([
      rootId,
      topic.area,
      topic.beta,
      asked
    ]);
  });

  it("follows a retired scope topic to its successor, and falls back to the citations when none is left", async () => {
    const retired = await ask("In a retired topic", { kind: "topic", topicId: topic.retired }, []);
    expect(pathIds(await locate.locateQuestion(retired))).toEqual([
      rootId,
      topic.area,
      topic.beta,
      retired
    ]);
    const gone = await ask("In a topic that is gone", { kind: "topic", topicId: randomUUID() }, [
      ["chunk", notes.g1!.chunk]
    ]);
    expect(pathIds(await locate.locateQuestion(gone))).toEqual([rootId, topic.gamma, gone]);
    const goneUnanswered = await ask(
      "A topic that is gone, no answer",
      { kind: "topic", topicId: randomUUID() },
      []
    );
    expect(await locate.locateQuestion(goneUnanswered)).toBeNull();
  });

  it("has no place without citations, or when none reaches a current note placed in a live topic", async () => {
    expect(
      await locate.locateQuestion(await ask("Still running", { kind: "library" }, []))
    ).toBeNull();
    const unplaced = await ask("Only an unplaced note", { kind: "library" }, [
      ["chunk", notes.unplaced!.chunk]
    ]);
    expect(await locate.locateQuestion(unplaced)).toBeNull();
    const superseded = await ask("Only a superseded note", { kind: "library" }, [
      ["note", notes.old!.id],
      ["chunk", notes.old!.chunk]
    ]);
    expect(await locate.locateQuestion(superseded)).toBeNull();
    // A note in a topic that was retired is read as placed nowhere (the topic has no live place).
    const retiredPlace = await ask("Only a retired topic's note", { kind: "library" }, [
      ["chunk", notes.retired1!.chunk]
    ]);
    expect(await locate.locateQuestion(retiredPlace)).toBeNull();
    // A citation of a source, a topic or a missing note names no note.
    const sourceOnly = await ask("Only a source", { kind: "library" }, [["source", sourceId]]);
    expect(await locate.locateQuestion(sourceOnly)).toBeNull();
    expect(await locate.locateQuestion(randomUUID())).toBeNull();
  });

  it("reads the place from the newest answer that cites something", async () => {
    const id = await ask("Asked again", { kind: "library" }, [["chunk", notes.g1!.chunk]]);
    expect(pathIds(await locate.locateQuestion(id))).toEqual([rootId, topic.gamma, id]);
    await answer(id, [["chunk", notes.b1!.chunk]]);
    expect(pathIds(await locate.locateQuestion(id))).toEqual([rootId, topic.area, topic.beta, id]);
    // A newer version that cited nothing (canceled before any text) leaves the place as it was.
    await answer(id, [], "canceled");
    expect(pathIds(await locate.locateQuestion(id))).toEqual([rootId, topic.area, topic.beta, id]);
  });

  it("answers an untitled topic's place with an empty title, for the interface to name", async () => {
    const id = await ask("In an unnamed topic", { kind: "library" }, [
      ["chunk", notes.unnamed1!.chunk]
    ]);
    const result = await locate.locateQuestion(id);
    expect(result?.primaryPath.map((item) => item.title)).toEqual(["", "", "In an unnamed topic"]);
  });

  it("plans under EXPLAIN", async () => {
    // The fixture is tiny, so this only proves the statement plans; the locate benchmark times it.
    const plan = await pool.query(`explain ${locate.statements.question}`, [randomUUID(), 5, 7]);
    expect(plan.rows.length).toBeGreaterThan(0);
  });
});
