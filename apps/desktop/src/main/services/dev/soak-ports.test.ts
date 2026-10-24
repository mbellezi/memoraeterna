import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { SoakActionFailure } from "./soak-driver.js";
import { LocalFaultController } from "./soak-local-faults.js";
import { soakProfileSchema } from "./soak-plan.js";
import {
  articleDescriptor,
  articleMarkdown,
  createSoakPorts,
  readCorpus,
  type SoakPortsDeps
} from "./soak-ports.js";
import { MemoryEventSink, soakFiles, soakSampleSchema } from "./soak-records.js";

const queries = vi.hoisted(() => ({
  countAnswerCalls: vi.fn(),
  pickRelationsToExplain: vi.fn(),
  forgetExplanations: vi.fn(),
  pickEditableNote: vi.fn(),
  pickQuestionTitle: vi.fn(),
  readFailedJobs: vi.fn(),
  readJobs: vi.fn(),
  readTaskRuns: vi.fn(),
  relationSourceNotes: vi.fn()
}));
vi.mock("./soak-queries.js", () => queries);

const profile = soakProfileSchema.parse({
  seed: 20261021,
  durationHours: 1,
  driver: {
    article: { everyMinutes: 20 },
    ask: { everyMinutes: 10 },
    explain: { everyMinutes: 5 },
    explainBurst: { everyMinutes: 60, count: 10 },
    noteEdit: { everyMinutes: 120 },
    sourceReimport: { everyMinutes: 360 },
    typingFault: { everyMinutes: 240 }
  },
  remote: {
    openAiCompatible: { latency: {}, faults: {} },
    codexWire: { latency: {}, faults: {} }
  },
  local: { mlxKill: { everyMinutes: 180 }, ggufAbort: { everyMinutes: 360 } }
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
  vi.clearAllMocks();
});

const article = (lang: "en" | "pt", pageId: number, title: string) => ({
  lang,
  domain: "biology",
  title,
  pageId,
  revisionId: pageId * 10,
  revisionTimestamp: "2026-10-08T19:44:08Z",
  url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
  extract: `${title} is a subject.\n\n== History ==\n${"A long sentence about the subject. ".repeat(100)}\n=== Details ===\nMore.`
});

/** A workspace with a four-article corpus and a run directory. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "soak-ports-"));
  directories.push(root);
  const corpus = join(root, ".cache", "corpus", "wikipedia");
  mkdirSync(corpus, { recursive: true });
  writeFileSync(
    join(corpus, "en.jsonl"),
    `${[article("en", 1, "Photosynthesis"), article("en", 2, "Memory")].map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
  writeFileSync(
    join(corpus, "pt.jsonl"),
    `${[article("pt", 3, "Fotossíntese"), { ...article("pt", 4, "Curto"), extract: "too short" }].map((entry) => JSON.stringify(entry)).join("\n")}\n`
  );
  const directory = join(root, ".cache", "f3", "soak", "run");
  mkdirSync(directory, { recursive: true });
  return { root, directory };
}

function deps(overrides: Partial<SoakPortsDeps> = {}) {
  const { root, directory } = workspace();
  const sink = new MemoryEventSink();
  const imports: Array<{ path: string; input: Record<string, unknown> }> = [];
  let imported = 0;
  const base: SoakPortsDeps = {
    profile,
    workspaceRoot: root,
    directory,
    pool: { totalCount: 3, idleCount: 2, waitingCount: 0 } as never,
    ai: {
      laneSnapshots: () => [
        {
          lane: "remote:abc",
          limit: 2,
          maximum: 2,
          running: 1,
          held: 0,
          waiting: { P0: 0, P1: 1, P2: 2, P3: 0 },
          pausedForMs: null,
          successStreak: 4,
          rateLimits: 1,
          breaker: {
            state: "closed",
            consecutiveFailures: 0,
            reopensInMs: null,
            opened: 0,
            refused: 0
          }
        }
      ],
      mlxHelperStats: () => ({ pid: 4242, spawnCount: 2 })
    },
    ingestion: {
      importFile: vi.fn(async (path: string, input: Record<string, unknown>) => {
        imports.push({ path, input });
        imported += 1;
        return {
          sourceItemId: `00000000-0000-4000-8000-${String(imported).padStart(12, "0")}`,
          documentId: null,
          ingestionRunId: null,
          jobId: null,
          batchId: null,
          structureId: null,
          requiresStructureReview: false,
          duplicate: false
        };
      })
    } as never,
    knowledge: {
      reviewNote: vi.fn(async () => ({ id: "n" })),
      deleteSource: vi.fn(async () => ({ deleted: true }))
    } as never,
    consultation: {
      ask: vi.fn(async () => ({
        answer: { paragraphs: [{}, {}] },
        evidence: [{}],
        coverage: { stale: false }
      }))
    } as never,
    explanations: { explain: vi.fn(async () => ({ relationId: "r", text: "t" })) } as never,
    faults: new LocalFaultController(sink),
    jobs: { wake: vi.fn() },
    kill: vi.fn(),
    ...overrides
  };
  return { deps: base, imports, directory, root, sink };
}

describe("the corpus", () => {
  it("keeps articles of a useful length, in an order that depends on the seed only", () => {
    const { root } = workspace();
    const first = readCorpus(root, 20261021).map((entry) => entry.title);
    expect(first.toSorted()).toEqual(["Fotossíntese", "Memory", "Photosynthesis"]);
    expect(readCorpus(root, 20261021).map((entry) => entry.title)).toEqual(first);
    expect(readCorpus(root, 7).map((entry) => entry.title)).not.toEqual(first);
  });

  it("writes an article with its headings as Markdown and describes it as a standalone article", () => {
    const { root } = workspace();
    const [entry] = readCorpus(root, 1).filter((candidate) => candidate.lang === "pt");
    const markdown = articleMarkdown(entry!);
    expect(markdown).toContain("# Fotossíntese");
    expect(markdown).toContain("\n## History\n");
    expect(markdown).toContain("\n### Details\n");
    expect(articleMarkdown(entry!, 2)).toContain("## Revision 2");
    expect(articleDescriptor(entry!)).toMatchObject({
      type: "StandaloneArticle",
      language: "pt-BR",
      publicationDate: "2026-10-08",
      creators: [{ name: "Wikipedia contributors", role: "author" }]
    });
  });
});

describe("the ports", () => {
  it("imports corpus articles through the ingestion service, one new source each, until the corpus is used up", async () => {
    const { deps: d, imports, directory } = deps();
    const ports = await createSoakPorts(d);
    const detail = await ports.importArticle(0);
    expect(detail).toMatchObject({ language: expect.stringMatching(/^(en|pt)$/u), imported: 1 });
    expect(imports[0]!.input).toMatchObject({
      duplicatePolicy: "ignore",
      processingPlan: { preset: "full_knowledge" }
    });
    expect(readFileSync(imports[0]!.path, "utf8")).toMatch(/^# /u);
    expect(imports[0]!.path.startsWith(join(directory, "articles"))).toBe(true);
    expect(d.jobs.wake).toHaveBeenCalled();
    await ports.importArticle(1);
    await ports.importArticle(2);
    expect(await ports.importArticle(3)).toEqual({ exhausted: true });
  });

  it("skips an article the library already holds", async () => {
    const { deps: d } = deps();
    const importFile = d.ingestion.importFile as unknown as ReturnType<typeof vi.fn>;
    importFile.mockResolvedValueOnce({ sourceItemId: "old", duplicate: true });
    const detail = await (await createSoakPorts(d)).importArticle(0);
    expect(detail).toMatchObject({ duplicatesSkipped: 1, imported: 1 });
    expect(importFile).toHaveBeenCalledTimes(2);
  });

  it("poisons the source of the typing-fault article before anything can type it", async () => {
    const { deps: d } = deps();
    const ports = await createSoakPorts(d);
    const detail = await ports.importTypingFaultSource(0);
    expect(detail.sourceItemId).toBe("00000000-0000-4000-8000-000000000001");
    expect(d.faults.poisonedSources).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("asks about a title of the library, with remote allowed, and tells an answer from no evidence", async () => {
    queries.pickQuestionTitle.mockResolvedValue("Memory");
    const { deps: d } = deps();
    const ports = await createSoakPorts(d);
    expect(await ports.ask(3)).toEqual({
      outcome: "answered",
      paragraphs: 2,
      evidence: 1,
      stale: false
    });
    expect(d.consultation.ask).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What does the library say about Memory?",
        privacy: "allow_remote",
        mode: "text"
      })
    );
    (d.consultation.ask as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("consultation.errors.noRelevantEvidence")
    );
    expect(await ports.ask(4)).toEqual({ outcome: "no_evidence" });
    (d.consultation.ask as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("boom")
    );
    queries.countAnswerCalls.mockResolvedValueOnce(0);
    await expect(ports.ask(5)).rejects.toThrow("boom");
    queries.pickQuestionTitle.mockResolvedValue(null);
    expect(await ports.ask(6)).toEqual({ outcome: "no_source" });
  });

  it("records how long a failed Ask ran and whether it reached its model", async () => {
    queries.pickQuestionTitle.mockResolvedValue("Memory");
    const { deps: d } = deps();
    const ports = await createSoakPorts(d);
    const ask = d.consultation.ask as unknown as ReturnType<typeof vi.fn>;
    const failure = async () => ports.ask(7).catch((error: unknown) => error);
    ask.mockRejectedValueOnce(new Error("consultation.errors.deadline"));
    queries.countAnswerCalls.mockResolvedValueOnce(0);
    const late = await failure();
    expect(late).toBeInstanceOf(SoakActionFailure);
    expect(late).toMatchObject({
      message: "consultation.errors.deadline",
      detail: { wallMs: expect.any(Number), remoteCallStarted: false }
    });
    // The calls counted are those since the Ask began.
    const [db, since] = queries.countAnswerCalls.mock.calls.at(-1)!;
    expect(db).toBe(d.pool);
    expect(since).toBeLessThanOrEqual(Date.now());
    ask.mockRejectedValueOnce(new Error("AI provider request failed (429)."));
    queries.countAnswerCalls.mockResolvedValueOnce(1);
    expect(await failure()).toMatchObject({ detail: { remoteCallStarted: true } });
    // Unknown when the audit cannot be read.
    ask.mockRejectedValueOnce(new Error("consultation.errors.failed"));
    queries.countAnswerCalls.mockRejectedValueOnce(new Error("pool closed"));
    expect(await failure()).toMatchObject({ detail: { remoteCallStarted: null } });
  });

  it("opens explanations together, forgets the ones that were written before, and tallies the outcomes", async () => {
    queries.pickRelationsToExplain.mockResolvedValue([
      { id: "r1", explained: false },
      { id: "r2", explained: false },
      { id: "r3", explained: true },
      { id: "r4", explained: false }
    ]);
    const { deps: d } = deps();
    const explain = d.explanations.explain as unknown as ReturnType<typeof vi.fn>;
    explain
      .mockResolvedValueOnce({ relationId: "r1", text: "t" })
      .mockResolvedValueOnce({ relationId: "r2", vetoed: true })
      .mockResolvedValueOnce({ relationId: "r3", unrelated: true })
      .mockRejectedValueOnce(new Error("sourceWorkspace.conflict"));
    const detail = await (await createSoakPorts(d)).explain(4, 0);
    expect(queries.pickRelationsToExplain).toHaveBeenCalledWith(d.pool, 4, 20261021);
    expect(queries.forgetExplanations).toHaveBeenCalledWith(d.pool, ["r3"]);
    expect(detail).toEqual({
      opened: 4,
      recycled: 1,
      explained: 1,
      vetoed: 1,
      unrelated: 1,
      none: 0,
      failed: 1
    });
    expect(explain.mock.calls.every(([input]) => typeof input.requestId === "string")).toBe(true);
  });

  it("records the Note pages first under F4, so the explanation backfill (T84) has notes opened lately", async () => {
    queries.pickRelationsToExplain.mockResolvedValue([
      { id: "r1", explained: false },
      { id: "r2", explained: false }
    ]);
    queries.relationSourceNotes.mockResolvedValue([{ id: "n1", title: "Recall" }]);
    const order: string[] = [];
    const recordNoteView = vi.fn(
      async (input: { id: string }) => void order.push(`view ${input.id}`)
    );
    const { deps: d } = deps({
      f4: { pool: {}, seed: 1, recordNoteView } as never,
      explanations: {
        explain: vi.fn(async (input: { relationId: string }) => {
          order.push(`explain ${input.relationId}`);
          return { relationId: input.relationId, text: "t" };
        })
      } as never
    });
    const detail = await (await createSoakPorts(d)).explain(2, 0);
    expect(queries.relationSourceNotes).toHaveBeenCalledWith({}, ["r1", "r2"]);
    expect(order).toEqual(["view n1", "explain r1", "explain r2"]);
    expect(detail).toMatchObject({ opened: 2, explained: 2, notePages: 1 });
    // A view that cannot be recorded never stops the opens.
    queries.relationSourceNotes.mockRejectedValueOnce(new Error("pool closed"));
    expect(await (await createSoakPorts(d)).explain(2, 1)).toMatchObject({
      explained: 2,
      notePages: null
    });
  });

  it("edits a note at the revision it read, and says when there is none", async () => {
    queries.pickEditableNote.mockResolvedValue({
      id: "n1",
      title: "T",
      bodyMarkdown: "Body.\n",
      updatedAt: "2026-10-20T08:00:00.000Z"
    });
    const { deps: d } = deps();
    const ports = await createSoakPorts(d);
    expect(await ports.editNote(0)).toEqual({ outcome: "edited" });
    expect(d.knowledge.reviewNote).toHaveBeenCalledWith({
      id: "n1",
      action: "edit",
      expectedUpdatedAt: "2026-10-20T08:00:00.000Z",
      bodyMarkdown: "Body.\n\nReviewed by hand."
    });
    queries.pickEditableNote.mockResolvedValue(null);
    expect(await ports.editNote(1)).toEqual({ outcome: "no_note" });
  });

  it("versions the oldest article it imported and deletes the next one", async () => {
    const { deps: d, imports } = deps();
    const ports = await createSoakPorts(d);
    await ports.importArticle(0);
    await ports.importArticle(1);
    await ports.importArticle(2);
    const detail = await ports.reimportSource(0);
    const versioned = imports.at(-1)!;
    expect(versioned.input).toMatchObject({ duplicatePolicy: "version" });
    expect(readFileSync(versioned.path, "utf8")).toContain("## Revision 1");
    expect(d.knowledge.deleteSource).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000002");
    expect(detail).toMatchObject({
      candidates: 3,
      deleted: "00000000-0000-4000-8000-000000000002"
    });
    // The deleted article is not chosen again: the next deletion is the third.
    await ports.reimportSource(1);
    expect(d.knowledge.deleteSource).toHaveBeenLastCalledWith(
      "00000000-0000-4000-8000-000000000003"
    );
  });

  it("kills the helper process it is told of, and only when one runs", async () => {
    const { deps: d } = deps();
    const ports = await createSoakPorts(d);
    expect(await ports.killMlxHelper()).toEqual({
      killed: true,
      detail: { pid: 4242, spawnCountBefore: 2 }
    });
    expect(d.kill).toHaveBeenCalledWith(4242);
    const none = deps({ ai: { laneSnapshots: () => [], mlxHelperStats: () => null } });
    expect(await (await createSoakPorts(none.deps)).killMlxHelper()).toMatchObject({
      killed: false
    });
  });

  it("arms the GGUF abort on the fault controller", async () => {
    const { deps: d } = deps();
    await (await createSoakPorts(d)).armGgufAbort();
    expect(d.faults.ggufAbortArmed).toBe(true);
  });

  it("samples lanes, jobs, helper, memory and the pool in the shape the report reads", async () => {
    queries.readJobs.mockResolvedValue({
      jobs: [
        {
          id: "j1",
          type: "ingest",
          lane: "heavy",
          status: "running",
          sourceItemId: null,
          attempts: 1,
          updatedAt: 1,
          runAfter: 1,
          lockedAt: 1
        }
      ],
      counts: { running: 1 }
    });
    const { deps: d, directory } = deps();
    const ports = await createSoakPorts(d);
    const sample = await ports.sample();
    expect(
      soakSampleSchema.parse({ ...sample, at: "2026-10-20T08:00:00.000Z", elapsedMs: 0 })
    ).toMatchObject({
      lanes: [{ lane: "remote:abc", running: 1, breaker: "closed", waiting: { P1: 1, P2: 2 } }],
      helper: { pid: 4242, spawnCount: 2 },
      dbPool: { total: 3, idle: 2, waiting: 0 }
    });
    expect(sample.appRssMb).toBeGreaterThan(0);
    expect(await ports.stopRequested()).toBe(false);
    writeFileSync(join(directory, soakFiles.stop), "");
    expect(await ports.stopRequested()).toBe(true);
    queries.readTaskRuns.mockResolvedValue([]);
    await ports.taskRuns(1_000);
    expect(queries.readTaskRuns).toHaveBeenCalledWith(d.pool, 1_000);
    queries.readFailedJobs.mockResolvedValue([]);
    await ports.failedJobs(2_000);
    expect(queries.readFailedJobs).toHaveBeenCalledWith(d.pool, 2_000);
  });

  it("refuses to start without the public corpus", async () => {
    const { deps: d, root } = deps();
    rmSync(join(root, ".cache", "corpus"), { recursive: true });
    await expect(createSoakPorts(d)).rejects.toThrow(/corpus is missing/u);
  });
});
