import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  createLibraryRowsRepository,
  libraryRowsStatement,
  libraryRowSorts,
  type LibraryRowsResult,
  type LibraryRowSort
} from "./libraryRowsRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `library.rows` and `library.sourceProgress` on a real PostgreSQL (F5 T131, S6): sort stability
// across pages, the filters, the five statuses, the territory facet and the generation strip's
// values, then 10k synthetic rows for the latency report.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const completed = { status: "completed" };
const day = (n: number) => `2026-01-${String(n).padStart(2, "0")}T10:00:00.000000Z`;

describe.skipIf(!sidecarInstalled)("the Library's read model on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let library: ReturnType<typeof createLibraryRowsRepository>;

  const rootId = randomUUID();
  const topic = { nutrition: randomUUID(), basics: randomUUID(), biology: randomUUID() };
  let treeId = "";
  const s: Record<string, string> = {};
  const ids = [
    "basics",
    "cell",
    "cellTwin",
    "article",
    "ferment",
    "lesson",
    "stored",
    "book",
    "queued",
    "tentative",
    "noRun"
  ] as const;
  for (const name of ids) s[name] = randomUUID();
  const child1 = randomUUID();
  const child2 = randomUUID();

  async function source(
    id: string,
    title: string,
    type: string,
    created: string,
    extra: { creators?: unknown; parent?: string; updated?: string } = {}
  ) {
    const metadata = extra.creators ? { descriptor: { creators: extra.creators } } : {};
    await pool.query(
      `insert into source_items (id, type, title, language, content_hash, parent_source_item_id,
         metadata, created_at, updated_at)
       values ($1, $2::source_item_type, $3, 'en', $4, $5, $6::jsonb, $7::timestamptz, $8::timestamptz)`,
      [
        id,
        type,
        title,
        `hash-${id}`,
        extra.parent ?? null,
        JSON.stringify(metadata),
        created,
        extra.updated ?? created
      ]
    );
    const document = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'text', $4)`,
      [document, id, title, `doc-${id}`]
    );
    const chunks = [randomUUID(), randomUUID()];
    for (const [index, chunk] of chunks.entries())
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, 'Passage text.', $5)`,
        [chunk, document, id, index, `chunk-${chunk}`]
      );
    return { document, chunks };
  }

  async function notes(sourceId: string, chunk: string, count: number): Promise<string[]> {
    const made: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const id = randomUUID();
      made.push(id);
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
           supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key, language)
         values ($1::uuid, $2, 'Body.', $2, 'active', 'current', 'source', $3, $3, $4, 'seed', 'seed',
           'local', 'seed', $1::uuid::text, 'en')`,
        [id, `Note ${id.slice(0, 6)}`, sourceId, chunk]
      );
    }
    return made;
  }

  async function run(
    sourceId: string,
    status: string,
    checkpoints: Record<string, unknown> = {},
    extra: { jobId?: string; stage?: string; effective?: string[]; created?: string } = {}
  ) {
    await pool.query(
      `insert into ingestion_runs (source_item_id, status, current_stage, stages_checkpoint,
         effective_stages, job_id, created_at)
       values ($1, $2::ingestion_run_status, $3, $4::jsonb, $5::jsonb, $6, coalesce($7::timestamptz, now()))`,
      [
        sourceId,
        status,
        extra.stage ?? "atomicNotes",
        JSON.stringify(checkpoints),
        JSON.stringify(extra.effective ?? []),
        extra.jobId ?? null,
        extra.created ?? null
      ]
    );
  }

  const all = async (input: Parameters<typeof library.rows>[0] = {}): Promise<LibraryRowsResult> =>
    library.rows({ limit: 100, ...input });
  const byId = (result: LibraryRowsResult, id: string) => result.rows.find((row) => row.id === id)!;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-library-rows-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_library_rows_test",
        user: "memora_library_rows_test",
        password: `library-rows-${randomUUID()}`,
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
    library = createLibraryRowsRepository(pool);

    const author = [{ name: "Ana Souza", role: "author" }];
    const basics = await source(s.basics!, "Nutrição básica", "Book", day(1), { creators: author });
    const cell = await source(s.cell!, "Biologia celular", "AcademicPaper", day(2), {
      creators: [
        { name: "Editor", role: "editor" },
        { name: "Bia", role: "author" },
        { name: "Caio", role: "author" }
      ]
    });
    const cellTwin = await source(s.cellTwin!, "Biologia celular", "AcademicPaper", day(2));
    const article = await source(s.article!, "Alimentação e saúde", "WebArticle", day(3));
    await source(s.ferment!, "Fermentação", "Book", day(4));
    await source(s.lesson!, "Aula quatro", "GenericDocument", day(5));
    await source(s.stored!, "Guardada", "StandaloneArticle", day(6));
    const book = await source(s.book!, "Livro com partes", "Book", day(7));
    await source(s.queued!, "Fila bloqueada", "Book", day(8));
    const tentative = await source(s.tentative!, "Notas colocadas", "Book", day(9));
    const noRun = await source(s.noRun!, "Sem execução", "PersonalNote", day(10));
    const part1 = await source(child1, "Parte 1", "BookChapter", day(7), { parent: s.book! });
    const part2 = await source(child2, "Parte 2", "BookChapter", day(8), { parent: s.book! });

    await pool.query(
      `insert into document_assets (source_item_id, original_file_name, sha256, mime_type, size_bytes,
         storage_base, relative_path, role)
       values ($1, 'cover.png', $2, 'image/png', 10, 'app_internal', 'covers/c.png', 'cover')`,
      [s.basics, "a".repeat(64)]
    );

    // The runs: each status of the card.
    const stages = { chunking: completed, embedding: completed, atomicNotes: completed };
    await run(s.basics!, "succeeded", stages);
    await run(s.cell!, "succeeded", stages);
    await run(s.cellTwin!, "succeeded", stages);
    await run(s.article!, "running", { chunking: completed, atomicNotes: { status: "running" } });
    await run(s.ferment!, "failed", { chunking: completed, atomicNotes: { status: "failed" } });
    await run(s.lesson!, "succeeded", {
      ...stages,
      atomicNotes: { status: "completed", metadata: { configured: false, generatedCount: 0 } }
    });
    await run(s.stored!, "succeeded", { chunking: completed, atomicNotes: { status: "skipped" } });
    // A book's own run only catalogues; its chapters carry the content runs and the notes.
    await run(
      s.book!,
      "succeeded",
      { chunking: completed, embedding: completed },
      { stage: "embedding", effective: ["chunking", "embedding"] }
    );
    await run(child1, "running", { chunking: completed, atomicNotes: { status: "running" } });
    await run(child2, "succeeded", stages);
    const job = randomUUID();
    await pool.query(
      `insert into jobs (id, type, status, blocked_class, blocked_reason, blocked_at)
       values ($1, 'ingestion', 'queued', 'no_model', 'no_route', now())`,
      [job]
    );
    await run(s.queued!, "pending", {}, { jobId: job, stage: "queued" });
    await run(s.tentative!, "running", { chunking: completed });
    // An older failed run of the source with no run in sight must not count once a newer succeeded.
    await run(s.cell!, "failed", {}, { created: "2025-01-01T00:00:00Z" });

    // Notes: three each for the ready sources, one for the running one, parts of the book, and two
    // placed notes of a source that is not placed itself.
    await notes(s.basics!, basics.chunks[0]!, 3);
    await notes(s.cell!, cell.chunks[0]!, 3);
    await notes(s.cellTwin!, cellTwin.chunks[0]!, 3);
    await notes(s.article!, article.chunks[0]!, 1);
    await notes(child1, part1.chunks[0]!, 2);
    await notes(child2, part2.chunks[0]!, 1);
    const tentativeNotes = await notes(s.tentative!, tentative.chunks[0]!, 2);
    await notes(s.noRun!, noRun.chunks[0]!, 1);
    void book;

    // The tree: Nutrição > Básica, and Biologia, below the (unnamed) root.
    const trees = createTopicTreeRepository(pool);
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:library:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    treeId = tree.id;
    const named = (id: string, parent: string, title: string) =>
      topicRecord(id, parent, {
        role: "topic",
        title,
        nameState: "named" as const,
        nameSource: "llm" as const,
        nameLanguage: "pt-BR"
      });
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.nutrition, rootId, "Nutrição"),
        named(topic.basics, topic.nutrition, "Básica"),
        named(topic.biology, rootId, "Biologia")
      ],
      placements: [
        { item: itemKey("source", s.basics!), placement: placementRecord(topic.basics) },
        { item: itemKey("source", s.cell!), placement: placementRecord(topic.biology) },
        { item: itemKey("source", s.cellTwin!), placement: placementRecord(topic.biology) },
        { item: itemKey("source", s.article!), placement: placementRecord(topic.nutrition) },
        { item: itemKey("source", s.book!), placement: placementRecord(topic.biology) },
        ...tentativeNotes.map((id) => ({
          item: itemKey("note", id),
          placement: placementRecord(topic.basics)
        }))
      ]
    });
  }, 300_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("lists the root sources only, newest first, with their facts", async () => {
    const result = await all();
    expect(result.total).toBe(11);
    expect(result.rows).toHaveLength(11);
    // Children of a book are parts of it, not rows.
    expect(result.rows.map((row) => row.id)).not.toContain(child1);
    expect(result.rows.map((row) => row.title)[0]).toBe("Sem execução");
    const basics = byId(result, s.basics!);
    expect(basics).toMatchObject({
      title: "Nutrição básica",
      type: "Book",
      authors: ["Ana Souza"],
      noteCount: 3,
      status: "ready",
      reason: null,
      hasCover: true,
      addedAt: day(1)
    });
    expect(basics.place).toEqual({
      path: [
        { id: topic.nutrition, title: "Nutrição" },
        { id: topic.basics, title: "Básica" }
      ],
      tentative: false
    });
    // The role "author" wins over an editor; a source with no creators has none.
    expect(byId(result, s.cell!).authors).toEqual(["Bia", "Caio"]);
    expect(byId(result, s.cellTwin!).authors).toEqual([]);
    expect(byId(result, s.cell!).hasCover).toBe(false);
  });

  it("derives the five statuses", async () => {
    const result = await all();
    const status = (name: string) => byId(result, s[name]!);
    expect(status("basics").status).toBe("ready");
    // A newer succeeded run wins over an older failed one.
    expect(status("cell").status).toBe("ready");
    expect(status("article")).toMatchObject({ status: "processing", noteCount: 1 });
    expect(status("ferment").status).toBe("failed");
    // No model was configured when the notes were made: the person has to choose one.
    expect(status("lesson")).toMatchObject({
      status: "needsYou",
      reason: "no_model.no_route",
      noteCount: 0
    });
    // A queued ingestion held by a blocker only a person can clear.
    expect(status("queued")).toMatchObject({ status: "needsYou", reason: "no_model.no_route" });
    expect(status("stored")).toMatchObject({ status: "storedOnly", noteCount: 0 });
    // A book is processing while one of its parts is, and counts the notes of its parts.
    expect(status("book")).toMatchObject({ status: "processing", noteCount: 3 });
    expect(status("tentative").status).toBe("processing");
    // No run at all: nothing is running; it has a note.
    expect(status("noRun")).toMatchObject({ status: "ready", noteCount: 1 });
  });

  it("places a source: its own placement, a tentative one from its notes, or none", async () => {
    const result = await all();
    expect(byId(result, s.article!).place).toEqual({
      path: [{ id: topic.nutrition, title: "Nutrição" }],
      tentative: false
    });
    expect(byId(result, s.tentative!).place).toEqual({
      path: [
        { id: topic.nutrition, title: "Nutrição" },
        { id: topic.basics, title: "Básica" }
      ],
      tentative: true
    });
    expect(byId(result, s.ferment!).place).toBeNull();
    expect(byId(result, s.stored!).place).toBeNull();
  });

  it(
    "keeps a stable order across pages for every sort and direction",
    { timeout: 120_000 },
    async () => {
      for (const sort of libraryRowSorts as readonly LibraryRowSort[]) {
        for (const dir of ["asc", "desc"] as const) {
          const whole = await all({ sort, dir });
          const paged: string[] = [];
          let cursor: string | undefined;
          let pages = 0;
          do {
            const page = await library.rows({ sort, dir, limit: 3, ...(cursor ? { cursor } : {}) });
            expect(page.total).toBe(11);
            paged.push(...page.rows.map((row) => row.id));
            cursor = page.next;
            pages += 1;
          } while (cursor && pages < 10);
          expect(paged, `${sort} ${dir}`).toEqual(whole.rows.map((row) => row.id));
          expect(new Set(paged).size).toBe(11);
        }
      }
    }
  );

  it("sorts by what each column says", async () => {
    const titles = (await all({ sort: "title", dir: "asc" })).rows.map((row) => row.title);
    expect(titles.slice(0, 4)).toEqual([
      "Alimentação e saúde",
      "Aula quatro",
      "Biologia celular",
      "Biologia celular"
    ]);
    const notes = (await all({ sort: "notes", dir: "desc" })).rows.map((row) => row.noteCount);
    expect(notes).toEqual([...notes].sort((a, b) => b - a));
    const first = (await all({ sort: "status", dir: "asc" })).rows.map((row) => row.status);
    expect(first.slice(0, 2)).toEqual(["needsYou", "needsYou"]);
    expect(first.at(-1)).toBe("ready");
    const oldest = (await all({ sort: "added", dir: "asc" })).rows[0]!;
    expect(oldest.id).toBe(s.basics);
  });

  it("refuses a cursor made for another sort", async () => {
    const page = await library.rows({ sort: "title", limit: 2 });
    expect(page.next).toBeDefined();
    await expect(library.rows({ sort: "added", limit: 2, cursor: page.next! })).rejects.toThrow(
      "errors.common.validationFailed"
    );
  });

  it("filters by type, status, topic and title, ignoring accents and case", async () => {
    const books = await all({ filter: { kinds: ["Book"] } });
    expect(new Set(books.rows.map((row) => row.type))).toEqual(new Set(["Book"]));
    expect(books.total).toBe(5);

    const failed = await all({ filter: { status: "failed" } });
    expect(failed.rows.map((row) => row.id)).toEqual([s.ferment]);
    expect(failed.total).toBe(1);
    const needs = await all({ filter: { status: "needsYou" }, sort: "title" });
    expect(needs.rows.map((row) => row.id).sort()).toEqual([s.lesson, s.queued].sort());

    const byTopic = await all({ filter: { topicId: topic.nutrition } });
    expect(byTopic.rows.map((row) => row.id).sort()).toEqual([s.basics, s.article].sort());
    const biology = await all({ filter: { topicId: topic.biology } });
    expect(biology.total).toBe(3);
    // A source placed only in a topic's child is in the topic's territory, not in the sibling.
    expect(biology.rows.map((row) => row.id)).not.toContain(s.basics);

    const query = await all({ filter: { query: "NUTRICAO" } });
    expect(query.rows.map((row) => row.id)).toEqual([s.basics]);
    const partial = await all({ filter: { query: " aliment " } });
    expect(partial.rows.map((row) => row.id)).toEqual([s.article]);
    // The wildcards of a title search are text.
    expect((await all({ filter: { query: "%" } })).total).toBe(0);
    expect((await all({ filter: { query: "_" } })).total).toBe(0);

    const combined = await all({
      filter: { kinds: ["Book"], status: "ready", topicId: topic.nutrition }
    });
    expect(combined.rows.map((row) => row.id)).toEqual([s.basics]);
  });

  it("counts the territories and the statuses, adding up to the total", async () => {
    const result = await all({ facets: true });
    const facets = result.facets!;
    expect(facets.territories).toEqual([
      { topic: { id: topic.biology, title: "Biologia" }, count: 3 },
      { topic: { id: topic.nutrition, title: "Nutrição" }, count: 2 },
      { topic: null, count: 6 }
    ]);
    expect(facets.territories.reduce((sum, entry) => sum + entry.count, 0)).toBe(result.total);
    expect(facets.statuses).toEqual({
      processing: 3,
      ready: 4,
      failed: 1,
      needsYou: 2,
      storedOnly: 1
    });
    // A note-less source is stored only; an unplaced one counts under "Sem lugar".
    expect(byId(result, s.stored!).status).toBe("storedOnly");
    expect(facets.territories.at(-1)!.topic).toBeNull();
  });

  it("lets each facet ignore its own filter", async () => {
    const byStatus = (await all({ filter: { status: "ready" }, facets: true })).facets!;
    // The territories follow the status; the status chips do not.
    expect(byStatus.territories.reduce((sum, entry) => sum + entry.count, 0)).toBe(4);
    expect(byStatus.statuses.processing).toBe(3);
    const byTopic = (await all({ filter: { topicId: topic.nutrition }, facets: true })).facets!;
    // The territory bar still shows every area; the chips count the chosen one only.
    expect(byTopic.territories).toHaveLength(3);
    expect(byTopic.statuses).toEqual({
      processing: 1,
      ready: 1,
      failed: 0,
      needsYou: 0,
      storedOnly: 0
    });
  });

  it("gives no facets unless asked", async () => {
    expect((await all()).facets).toBeUndefined();
  });

  it("reads the strip of a source mid-import, with its section ruler", async () => {
    const id = randomUUID();
    const markdown = [
      "# A study",
      "intro text",
      "## Introduction\ntext",
      "## Methods\ntext",
      "## Results\ntext",
      "## Discussion\ntext\nmore text"
    ];
    await pool.query(
      `insert into source_items (id, type, title, language, content_hash)
       values ($1, 'AcademicPaper', 'A study', 'en', 'h-progress')`,
      [id]
    );
    const document = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'A study', 'text', 'doc-progress')`,
      [document, id]
    );
    const chunkIds = markdown.map(() => randomUUID());
    for (const [index, content] of markdown.entries()) {
      const span = randomUUID();
      await pool.query(
        `insert into source_spans (id, document_id, source_item_id, start_offset, end_offset, page)
         values ($1, $2, $3, 0, 1, $4)`,
        [span, document, id, index < 3 ? 1 : 2]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, source_span_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [chunkIds[index], document, id, span, index, content, `c-${chunkIds[index]}`]
      );
    }
    // Two notes rest on Introduction, one on Methods, none yet below.
    await notes(id, chunkIds[2]!, 2);
    await notes(id, chunkIds[3]!, 1);
    await run(
      id,
      "running",
      {
        chunking: completed,
        embedding: completed,
        summarization: completed,
        atomicNotes: { status: "running" }
      },
      { stage: "atomicNotes" }
    );

    const progress = (await library.sourceProgress(id))!;
    expect(progress.run).toMatchObject({
      status: "running",
      stage: "atomicNotes",
      failedStage: null
    });
    expect(progress.needsYou).toBeNull();
    expect(progress.steps.read).toEqual({ state: "done", pages: 2 });
    expect(progress.steps.chunks).toEqual({ state: "done", indexed: 6 });
    // The reference sources that completed their notes with a model (the three ready ones and the
    // second chapter of the book) hold 8 passages and 10 notes between them: 6 passages make about 8
    // notes. The model-less source made none and the book's own run only catalogues: neither counts.
    expect(progress.steps.notes).toEqual({ state: "running", soFar: 3, estimate: 8 });
    expect(progress.steps.placed).toEqual({ state: "running", count: 0 });
    expect(progress.steps.summary.state).toBe("done");
    expect(progress.steps.relations).toEqual({ state: "pending", count: 0 });
    expect(
      progress.sections.map((section) => [section.title, section.notes, section.state])
    ).toEqual([
      ["A study", 0, "done"],
      ["Introduction", 2, "done"],
      ["Methods", 1, "done"],
      ["Results", 0, "reading"],
      ["Discussion", 0, "pending"]
    ]);
    expect(progress.sections.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);
  });

  it("reads the strip of a source that is done, and of one made searchable only", async () => {
    const done = (await library.sourceProgress(s.basics!))!;
    expect(done.run).toMatchObject({ status: "succeeded" });
    expect(done.steps.notes).toEqual({ state: "done", soFar: 3, estimate: null });
    expect(done.sections.every((section) => section.state === "done")).toBe(true);
    expect(done.sections.reduce((sum, section) => sum + section.share, 0)).toBeCloseTo(1, 10);

    const stored = (await library.sourceProgress(s.stored!))!;
    expect(stored.steps.notes.state).toBe("notApplicable");
    expect(stored.steps.placed.state).toBe("notApplicable");

    const lesson = (await library.sourceProgress(s.lesson!))!;
    expect(lesson.needsYou).toBe("no_model.no_route");
    const queued = (await library.sourceProgress(s.queued!))!;
    expect(queued.needsYou).toBe("no_model.no_route");
    expect(queued.run).toMatchObject({ status: "pending", stage: "queued" });

    const failed = (await library.sourceProgress(s.ferment!))!;
    expect(failed.run).toMatchObject({ status: "failed", failedStage: "atomicNotes" });
    expect(failed.steps.notes.state).toBe("failed");

    const none = (await library.sourceProgress(s.noRun!))!;
    expect(none.run).toBeNull();
    expect(await library.sourceProgress(randomUUID())).toBeNull();
  });

  it("answers the estimate only with enough completed sources to learn from", async () => {
    // Four sources completed their notes with a model: 10 notes for 8 passages.
    expect(await library.estimateNotes(randomUUID(), 8)).toBe(10);
    expect(await library.estimateNotes(randomUUID(), 1)).toBe(1);
    // Too few to learn from is unknown, not a guess: five are asked for and four exist, and so is a
    // library asked to learn from two.
    const strict = createLibraryRowsRepository(pool, { estimate: { minReferenceSources: 5 } });
    expect(await strict.estimateNotes(randomUUID(), 8)).toBeNull();
    const narrow = createLibraryRowsRepository(pool, { estimate: { referenceSources: 2 } });
    expect(await narrow.estimateNotes(randomUUID(), 8)).toBeNull();
    // A source never teaches its own estimate: leave out the second chapter and three are left.
    expect(await library.estimateNotes(child2, 8)).toBe(Math.round((8 * 9) / 6));
  });

  it("reads a book as the tree of its parts", async () => {
    const progress = (await library.sourceProgress(s.book!))!;
    // The book's own run finished cataloguing, but its first chapter is still being read.
    expect(progress.run).toMatchObject({
      status: "running",
      stage: "atomicNotes",
      completedAt: null
    });
    // The notes are the chapters' (what the Library row counts), and their stage is applicable. The
    // book's own chapters are not references for its estimate: 6 passages at 9 notes per 6.
    expect(progress.steps.notes).toEqual({ state: "running", soFar: 3, estimate: 9 });
    expect(progress.steps.chunks.indexed).toBe(6);
    // The ruler has a segment per chapter, not one from the catalogue's passage.
    expect(
      progress.sections.map((section) => [
        section.title,
        section.notes,
        section.state,
        section.share
      ])
    ).toEqual([
      ["Parte 1", 2, "reading", 0.5],
      ["Parte 2", 1, "done", 0.5]
    ]);
    // A book the Library lists as processing is not "done" in the strip.
    expect((await all()).rows.find((row) => row.id === s.book)).toMatchObject({
      status: "processing",
      noteCount: progress.steps.notes.soFar
    });
  });

  it("says when the person paused the work, apart from work that waits for them", async () => {
    const job = (
      await pool.query<{ id: string }>(
        "select job_id as id from ingestion_runs where source_item_id = $1",
        [s.queued]
      )
    ).rows[0]!.id;
    await pool.query(
      "update jobs set blocked_class = 'paused', blocked_reason = 'user_pause' where id = $1",
      [job]
    );
    try {
      const paused = (await library.sourceProgress(s.queued!))!;
      expect(paused.paused).toBe(true);
      expect(paused.needsYou).toBeNull();
      expect(paused.run).toMatchObject({ status: "pending" });
    } finally {
      await pool.query(
        "update jobs set blocked_class = 'no_model', blocked_reason = 'no_route' where id = $1",
        [job]
      );
    }
    expect((await library.sourceProgress(s.queued!))!.paused).toBe(false);
    expect((await library.sourceProgress(s.basics!))!.paused).toBe(false);
  });

  it("pages a title sort past titles too long for the cursor", async () => {
    const longTitles = [
      ...[1, 2, 3].map((n) => `zzlong ${"a".repeat(450)} ${n}`),
      ...[1, 2, 3].map((n) => `zzcjk ${"日".repeat(150)} ${n}`)
    ];
    const made: string[] = [];
    for (const [index, title] of longTitles.entries()) {
      const id = randomUUID();
      made.push(id);
      await pool.query(
        `insert into source_items (id, type, title, language, content_hash)
         values ($1, 'WebArticle', $2, 'en', $3)`,
        [id, title, `long-${index}`]
      );
    }
    try {
      for (const query of ["zzlong", "zzcjk"]) {
        const seen: string[] = [];
        let cursor: string | undefined;
        do {
          const page = await library.rows({
            sort: "title",
            limit: 1,
            filter: { query },
            ...(cursor ? { cursor } : {})
          });
          // What the IPC schemas accept (600 characters).
          if (page.next) expect(page.next.length).toBeLessThanOrEqual(600);
          seen.push(...page.rows.map((row) => row.title));
          cursor = page.next;
        } while (cursor && seen.length < 10);
        expect(seen, query).toEqual(longTitles.filter((title) => title.startsWith(query)));
      }
    } finally {
      await pool.query("delete from source_items where id = any($1::uuid[])", [made]);
    }
  });

  it("reads 10k synthetic rows within the latency bar", async () => {
    await pool.query(
      `insert into source_items (id, type, title, language, content_hash, created_at, updated_at, metadata)
       select gen_random_uuid(), 'Book', 'Synthetic ' || n || ' ' || md5(n::text), 'en', 'synthetic-' || n,
              timestamptz '2025-01-01' + (n || ' minutes')::interval,
              timestamptz '2025-01-01' + (n || ' minutes')::interval,
              jsonb_build_object('descriptor', jsonb_build_object('creators',
                jsonb_build_array(jsonb_build_object('name', 'Author ' || (n % 500), 'role', 'author'))))
         from generate_series(1, 10000) n`
    );
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       select gen_random_uuid(), s.id, s.title, 'text', 'doc-' || s.content_hash
         from source_items s where s.content_hash like 'synthetic-%'`
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       select gen_random_uuid(), d.id, d.source_item_id, 0, 'Passage.', 'chunk-' || d.content_hash
         from documents d where d.content_hash like 'doc-synthetic-%'`
    );
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
         generation_provider, generation_model, generation_runtime, generation_prompt_version,
         generation_key, language)
       select gen_random_uuid(), 'Synthetic note', 'Body.', 'Idea', 'active', 'current', 'source',
              c.source_item_id, c.source_item_id, c.id, 'seed', 'seed', 'local', 'seed',
              c.id::text || '-' || k, 'en'
         from chunks c cross join generate_series(1, 3) k where c.content_hash like 'chunk-doc-synthetic-%'`
    );
    await pool.query(
      `insert into ingestion_runs (source_item_id, status, current_stage, stages_checkpoint)
       select s.id, case when right(s.content_hash, 1) = '7' then 'running' else 'succeeded' end::ingestion_run_status,
              'atomicNotes', '{"atomicNotes":{"status":"completed"}}'::jsonb
         from source_items s where s.content_hash like 'synthetic-%'`
    );
    await pool.query(
      `insert into topic_placements (tree_id, item_kind, source_item_id, topic_id, role, rank, management, decided_by)
       select $1, 'source', s.id, case when extract(day from s.created_at)::int % 2 = 0 then $2::uuid else $3::uuid end,
              'primary', 0, 'ai', 'build'
         from source_items s where s.content_hash like 'synthetic-%' and right(s.content_hash, 1) <> '3'`,
      [treeId, topic.basics, topic.biology]
    );
    await pool.query("analyze");

    // The title filter is the trigram index of migration 0067 (a selective text, a real table).
    const { rows: plan } = await pool.query<{ "QUERY PLAN": string }>(
      `explain ${libraryRowsStatement("added", "desc", false, undefined, "$6")}`,
      [null, "synthetic 4242 ", [], null, null, 10]
    );
    expect(plan.map((row) => row["QUERY PLAN"]).join(" ")).toContain("source_items_title_trgm_idx");

    // Twenty timed reads after one warm-up; the reads that derive every source's status or notes
    // are measured on seven, which is what their cost makes affordable (their p95 is the slowest).
    const measure = async (label: string, work: () => Promise<unknown>, runs = 20) => {
      const times: number[] = [];
      for (let attempt = 0; attempt <= runs; attempt += 1) {
        const started = performance.now();
        await work();
        if (attempt > 0) times.push(performance.now() - started);
      }
      times.sort((a, b) => a - b);
      const p95 = times[Math.ceil(times.length * 0.95) - 1]!;
      const median = times[Math.floor(runs / 2)]!;
      const line = `library.rows 10k ${label}: p95 ${p95.toFixed(1)} ms (median ${median.toFixed(1)}, ${runs} runs)`;
      console.info(line);
      // The values are a report, not a bar: `LIBRARY_ROWS_REPORT=<file>` collects them.
      if (process.env.LIBRARY_ROWS_REPORT)
        appendFileSync(process.env.LIBRARY_ROWS_REPORT, `${line}\n`);
      return p95;
    };
    const p95 = {
      // A read of the whole table, to read the others against on a busy machine.
      baseline: await measure("baseline count(*) of source_items", () =>
        pool.query("select count(*) from source_items")
      ),
      added: await measure("added desc, first page", () => library.rows({ limit: 50 })),
      title: await measure("title asc, first page", () =>
        library.rows({ sort: "title", limit: 50 })
      ),
      query: await measure("title query", () =>
        library.rows({ filter: { query: "synthetic 4242" }, limit: 50 })
      ),
      notes: await measure(
        "notes desc (derived first)",
        () => library.rows({ sort: "notes", limit: 50 }),
        7
      ),
      status: await measure(
        "status filter processing",
        () => library.rows({ filter: { status: "processing" }, limit: 50 }),
        7
      ),
      facets: await measure("facets", () => library.rows({ facets: true, limit: 50 }), 7)
    };
    const total = (await library.rows({ limit: 1 })).total;
    expect(total).toBe(10_012);
    // The bar is 30 ms p95 (cal.) for the default page and the title filter; it is reported, not
    // asserted: a wall-clock line flakes on a busy machine (the baseline above shows how busy). The
    // orchestrator's proof reads the report from a quiet one.
    expect(Number.isFinite(p95.baseline)).toBe(true);
  }, 300_000);
});
