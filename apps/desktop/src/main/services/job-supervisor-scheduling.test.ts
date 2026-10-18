import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiProviderError } from "@app/ai";
import type { JobRecord, PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";
import { resetRelationLinkRuntime, setRelationLinkRuntime } from "./relations/link-runtime.js";

const mocks = vi.hoisted(() => ({
  jobs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    retry: vi.fn(),
    claimNext: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
    reportProgress: vi.fn(),
    enqueueDeduped: vi.fn(),
    activeIdsForBatch: vi.fn(),
    requestCancel: vi.fn()
  },
  runs: {
    recoverInterrupted: vi.fn(),
    findById: vi.fn(),
    fail: vi.fn(),
    listByBatch: vi.fn(),
    cancel: vi.fn(),
    startOrResume: vi.fn(),
    beginStage: vi.fn(),
    updateStageProgress: vi.fn(),
    completeStage: vi.fn(),
    skipStage: vi.fn(),
    failStage: vi.fn(),
    parkForLinking: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    countIncompleteBatchStage: vi.fn(),
    listLinkingSourceItems: vi.fn(),
    listSkippedMatching: vi.fn(),
    reopenStages: vi.fn()
  },
  hierarchy: { refreshBatch: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listBySourceItem: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => mocks.jobs,
  createIngestionRunRepository: () => mocks.runs,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createAtomicNoteRepository: () => mocks.notes
}));
let supervisor: JobSupervisor | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  mocks.jobs.findById.mockResolvedValue({
    type: "ingestion",
    status: "canceled",
    payload: { ingestionRunId: "run" }
  });
  mocks.jobs.retry.mockResolvedValue({ id: "retry", status: "queued" });
  mocks.runs.findById.mockResolvedValue({ status: "canceled", stagesCheckpoint: {} });
});
afterEach(async () => {
  await supervisor?.stop();
  vi.useRealTimers();
});

describe("ingestion queue scheduling", () => {
  it("resumes polling after a database or admission failure", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool, pollIntervalMs: 100 });
    const run = vi
      .spyOn(supervisor, "runOnce")
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("keeps polling when idle model cleanup rejects", async () => {
    const release = vi
      .fn()
      .mockRejectedValueOnce(new Error("runtime unavailable"))
      .mockResolvedValue(undefined);
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      pollIntervalMs: 100,
      releaseAiRuntime: release
    });
    const run = vi.spyOn(supervisor, "runOnce").mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenCalledTimes(2);
  });

  it("admits the vault projection on the compute worker and claims even when admission fails", async () => {
    const enqueue = vi.fn().mockRejectedValue(new Error("missing projection clock"));
    supervisor = new JobSupervisor({
      getPool: () => ({}) as PgPool,
      obsidianSyncService: {
        projectSource: vi.fn(),
        wiki: { enqueue, execute: vi.fn() }
      } as unknown as NonNullable<
        ConstructorParameters<typeof JobSupervisor>[0]["obsidianSyncService"]
      >
    });
    mocks.jobs.claimNext.mockResolvedValue(null);
    // The heavy pass neither admits nor claims the projection: it is light work (D30, D33).
    await expect(supervisor.runOnce()).resolves.toBeNull();
    expect(enqueue).not.toHaveBeenCalled();
    expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.not.arrayContaining(["obsidian-wiki"]),
      "heavy"
    );
    await expect(supervisor.runLightOnce("compute")).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
      expect.any(String),
      ["obsidian-wiki"],
      "light"
    );
    // The model worker never admits or claims it.
    await expect(supervisor.runLightOnce("model")).resolves.toBeNull();
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("cancels the active jobs of a batch and its pending and running runs", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    mocks.jobs.activeIdsForBatch.mockResolvedValue(["job-a", "job-b"]);
    mocks.jobs.requestCancel.mockImplementation(async (id: string) => ({
      id,
      type: "ingestion",
      status: "canceled",
      payload: {}
    }));
    mocks.runs.listByBatch.mockResolvedValue([
      { id: "run-1", status: "running" },
      { id: "run-2", status: "succeeded" },
      { id: "run-3", status: "pending" }
    ]);
    await expect(supervisor.cancelBatch("batch")).resolves.toBeNull();
    expect(mocks.jobs.activeIdsForBatch).toHaveBeenCalledWith("batch");
    expect(mocks.jobs.requestCancel.mock.calls.map(([id]) => id)).toEqual(["job-a", "job-b"]);
    expect(mocks.runs.cancel.mock.calls.map(([id]) => id)).toEqual(["run-1", "run-3"]);
    expect(mocks.hierarchy.refreshBatch).toHaveBeenCalledWith("batch");
  });
  it("fails a document without text with a localized error and does not retry it", async () => {
    // A web capture whose Defuddle result was empty used to fail here as "missing_markdown".
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    mocks.jobs.claimNext.mockResolvedValue({
      id: "job",
      type: "ingestion",
      attempts: 1,
      maxAttempts: 3,
      payload: {
        ingestionRunId: "run",
        documentId: "document",
        sourceItemId: "source",
        markdown: "",
        processingMode: "content"
      }
    });
    mocks.jobs.update.mockResolvedValue({ id: "job", status: "failed" });
    await supervisor.runOnce();
    expect(mocks.runs.fail).toHaveBeenCalledWith("run", "errors.conversion.emptyResult");
    expect(mocks.jobs.update).toHaveBeenCalledWith(
      "job",
      expect.objectContaining({ status: "failed", error: "errors.conversion.emptyResult" })
    );
  });
  describe("retrying a failed job", () => {
    const failing = (attempts = 1, maxAttempts = 3) => ({
      id: "job",
      type: "ingestion",
      attempts,
      maxAttempts,
      payload: { ingestionRunId: "run", documentId: "document", sourceItemId: "source" }
    });
    const fail = async (error: unknown, job = failing()) => {
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
      vi.spyOn(
        supervisor as never as { executeIngestion: () => Promise<unknown> },
        "executeIngestion"
      ).mockRejectedValue(error);
      mocks.jobs.claimNext.mockResolvedValue(job);
      mocks.jobs.update.mockResolvedValue({ id: "job" });
      await supervisor.runOnce();
      return mocks.jobs.update.mock.calls.at(-1)?.[1] as {
        status: string;
        error: string | null;
        runAfter: Date;
        finishedAt: Date | null;
      };
    };

    it("fails invalid model output once, with its real error, instead of retrying it", async () => {
      const update = await fail(new Error("knowledge_graph_output_invalid:schema_validation"));
      expect(update).toMatchObject({
        status: "failed",
        error: "knowledge_graph_output_invalid:schema_validation"
      });
      expect(update.finishedAt).toBeInstanceOf(Date);
      expect(mocks.runs.fail).toHaveBeenCalledWith(
        "run",
        "knowledge_graph_output_invalid:schema_validation"
      );
    });

    it.each([
      [
        "a rejected request",
        new AiProviderError("bad", { kind: "http", transient: false, status: 400 })
      ],
      [
        "a context overflow",
        new AiProviderError("long", { kind: "context_overflow", transient: false })
      ],
      ["an unclassified error", new Error("something unexpected")]
    ])("does not retry %s", async (_name, error) => {
      expect(await fail(error)).toMatchObject({ status: "failed" });
    });

    it("queues a transient provider failure again after a growing backoff", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      const before = Date.now();
      const first = await fail(busy, failing(1));
      expect(first).toMatchObject({ status: "queued", finishedAt: null });
      expect(first.runAfter.getTime() - before).toBeGreaterThanOrEqual(2_000);
      expect(first.runAfter.getTime() - before).toBeLessThan(3_000);
      const second = await fail(busy, failing(2));
      expect(second.runAfter.getTime() - before).toBeGreaterThanOrEqual(4_000);
    });

    it("waits at least as long as the provider asked with Retry-After", async () => {
      const limited = new AiProviderError("limited", {
        kind: "http",
        transient: true,
        status: 429,
        retryAfterMs: 90_000
      });
      const before = Date.now();
      const update = await fail(limited, failing(1));
      expect(update.status).toBe("queued");
      expect(update.runAfter.getTime() - before).toBeGreaterThanOrEqual(90_000);
    });

    it("stops retrying a transient failure when the attempts are used up", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      expect(await fail(busy, failing(3, 3))).toMatchObject({ status: "failed" });
    });

    it("keeps retrying a crashed worker", async () => {
      expect(await fail(new Error("Worker exited with code 1."))).toMatchObject({
        status: "queued"
      });
    });
  });
  describe("re-embedding an edited note", () => {
    const embeddingJob = (payload: Record<string, unknown> = {}, attempts = 1) => ({
      id: "job",
      type: "note-embedding",
      attempts,
      maxAttempts: 3,
      progress: 0,
      payload: { atomicNoteId: "note-1", sourceItemId: "source-1", ...payload } as Record<
        string,
        unknown
      >
    });
    const runWith = async (embedAtomicNote: ReturnType<typeof vi.fn>, job = embeddingJob()) => {
      supervisor = new JobSupervisor({
        getPool: () => ({}) as PgPool,
        knowledgeService: { embedAtomicNote } as unknown as KnowledgeService
      });
      mocks.jobs.claimNext.mockResolvedValue(job);
      mocks.jobs.update.mockResolvedValue({ id: "job" });
      await supervisor.runOnce();
      return mocks.jobs.update.mock.calls.at(-1)?.[1] as {
        status: string;
        error: string | null;
        result?: unknown;
        runAfter: Date;
      };
    };

    it("embeds the note with the embedding model and records the outcome", async () => {
      const embedAtomicNote = vi.fn().mockResolvedValue({ embedded: true });
      const update = await runWith(embedAtomicNote);
      expect(embedAtomicNote).toHaveBeenCalledOnce();
      expect(embedAtomicNote).toHaveBeenCalledWith(
        "note-1",
        expect.any(AbortSignal),
        expect.objectContaining({ jobId: "job", sourceItemId: "source-1" })
      );
      expect(update).toMatchObject({ status: "succeeded", result: { embedded: true } });
    });

    it("embeds into the space a re-embedding names (D26)", async () => {
      const embedAtomicNote = vi.fn().mockResolvedValue({ embedded: true });
      await runWith(embedAtomicNote, embeddingJob({ spaceKey: "space-b" }));
      expect(embedAtomicNote).toHaveBeenCalledWith(
        "note-1",
        expect.any(AbortSignal),
        expect.objectContaining({ jobId: "job" }),
        { spaceKey: "space-b" }
      );
    });

    it("finishes without error when there is nothing to embed", async () => {
      const update = await runWith(
        vi.fn().mockResolvedValue({ embedded: false, reason: "note_not_current" })
      );
      expect(update).toMatchObject({
        status: "succeeded",
        result: { embedded: false, reason: "note_not_current" }
      });
    });

    it("queues a transient provider failure again like any other job", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
      const update = await runWith(vi.fn().mockRejectedValue(busy));
      expect(update).toMatchObject({ status: "queued" });
      expect(update.runAfter.getTime()).toBeGreaterThan(Date.now());
    });

    it("fails once when the job does not name a note", async () => {
      const embedAtomicNote = vi.fn();
      const update = await runWith(embedAtomicNote, {
        ...embeddingJob(),
        payload: { sourceItemId: "source-1" }
      });
      expect(embedAtomicNote).not.toHaveBeenCalled();
      expect(update).toMatchObject({ status: "failed", error: "missing_atomicNoteId" });
    });
  });
  describe("per-source matching with no barrier (F3 D24)", () => {
    // A run that only matches: every earlier stage is outside its plan.
    const matchingRun = (overrides: Record<string, unknown> = {}) => ({
      id: "run",
      batchId: "batch",
      trigger: "library_action",
      runKind: "initial",
      effectiveStages: ["atomicNoteMatching", "sourceMatching"],
      stagesCheckpoint: {},
      ...overrides
    });
    const decided = {
      noteId: "note-1",
      sourceItemId: "source",
      decider: {
        kind: "ranker",
        mode: "ranker",
        deciderKey: "decider",
        calibration: "provisional",
        profileId: "profile",
        modelId: "ranker"
      },
      pairs: []
    };
    const ingest = async (
      knowledge: Partial<Record<keyof KnowledgeService, unknown>>,
      run = matchingRun(),
      payload: Record<string, unknown> = {},
      attempts = 1
    ) => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: "root" }] }) };
      supervisor = new JobSupervisor({
        getPool: () => pool as unknown as PgPool,
        knowledgeService: knowledge as unknown as KnowledgeService
      });
      mocks.jobs.claimNext.mockResolvedValue({
        id: "job",
        type: "ingestion",
        attempts,
        maxAttempts: 3,
        payload: {
          ingestionRunId: "run",
          documentId: "document",
          sourceItemId: "source",
          batchId: "batch",
          markdown: "Text.",
          ...payload
        }
      });
      mocks.jobs.create.mockResolvedValue({ id: "stage-job" });
      mocks.jobs.update.mockImplementation(async (id: string, input: object) => ({ id, ...input }));
      mocks.jobs.enqueueDeduped.mockResolvedValue({ job: { id: "link-job" }, created: true });
      mocks.documents.findById.mockResolvedValue({ metadata: {} });
      mocks.chunks.listByDocument.mockResolvedValue([]);
      mocks.notes.listBySourceItem.mockResolvedValue([{ id: "note-1", status: "pending_review" }]);
      mocks.runs.startOrResume.mockResolvedValue(run);
      const job = await supervisor.runOnce();
      return { job, pool };
    };

    it("decides the run's own notes at once and parks its source stage for the root's link job", async () => {
      const matchAtomicNotes = vi.fn(
        async (
          _ids: string[],
          _signal: AbortSignal,
          _progress: unknown,
          _context: unknown,
          options: {
            onNoteDecided: (note: unknown) => void;
            onNoteCompleted: (id: string, count: number) => Promise<void>;
          }
        ) => {
          options.onNoteDecided(decided);
          await options.onNoteCompleted("note-1", 0);
          return { persistedCount: 0, decided: 1, accepted: 0, decider: "ranker" };
        }
      );
      const { job } = await ingest({ matchAtomicNotes });
      expect(job).toMatchObject({ status: "succeeded" });
      // No batch barrier: matching never asks whether a sibling is still generating notes.
      expect(mocks.runs.countIncompleteBatchStage).not.toHaveBeenCalled();
      expect(matchAtomicNotes).toHaveBeenCalledWith(
        ["note-1"],
        expect.any(AbortSignal),
        expect.any(Function),
        expect.objectContaining({ ingestionRunId: "run", sourceItemId: "source", priority: "P2" }),
        expect.objectContaining({ onNoteDecided: expect.any(Function) })
      );
      // The decided pairs stay in the stage checkpoint for the link job (D21).
      expect(mocks.runs.completeStage).toHaveBeenCalledWith(
        "run",
        "atomicNoteMatching",
        expect.objectContaining({ decided: [decided] })
      );
      expect(mocks.runs.parkForLinking).toHaveBeenCalledWith("run", { rootId: "root" });
      expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "relation-link",
          lane: "light",
          dedupeKey: "relation-link:root",
          payload: { rootId: "root", batchId: "batch" }
        })
      );
      // The run completes when its link job does, not here.
      expect(mocks.runs.complete).not.toHaveBeenCalled();
    });

    it("parks a run whose plan stops at note matching, so its link job persists the pairs (D21)", async () => {
      const matchAtomicNotes = vi.fn(
        async (
          _ids: string[],
          _signal: AbortSignal,
          _progress: unknown,
          _context: unknown,
          options: { onNoteDecided: (note: unknown) => void }
        ) => {
          options.onNoteDecided(decided);
          return { persistedCount: 0, decided: 1, accepted: 0, decider: "ranker" };
        }
      );
      // A custom plan with note matching and no source stage (ProcessingPlanPicker allows it).
      await ingest({ matchAtomicNotes }, matchingRun({ effectiveStages: ["atomicNoteMatching"] }));
      expect(mocks.runs.parkForLinking).toHaveBeenCalledWith("run", { rootId: "root" });
      expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledWith(
        expect.objectContaining({ type: "relation-link", dedupeKey: "relation-link:root" })
      );
      // The source stage is outside the plan: nothing records it as skipped or completed here.
      expect(mocks.runs.skipStage).not.toHaveBeenCalled();
      expect(mocks.runs.completeStage).not.toHaveBeenCalledWith(
        "run",
        "sourceMatching",
        expect.anything()
      );
      expect(mocks.runs.complete).not.toHaveBeenCalled();
    });

    it("completes a run whose plan stops at note matching while it waits for a decider", async () => {
      const matchAtomicNotes = vi
        .fn()
        .mockResolvedValue({ persistedCount: 0, skipped: "waiting_for_decider", decider: null });
      await ingest({ matchAtomicNotes }, matchingRun({ effectiveStages: ["atomicNoteMatching"] }));
      expect(mocks.runs.skipStage.mock.calls).toEqual([
        ["run", "atomicNoteMatching", "waiting_for_decider"]
      ]);
      expect(mocks.runs.parkForLinking).not.toHaveBeenCalled();
      expect(mocks.runs.complete).toHaveBeenCalledWith("run");
    });

    describe("a knowledge-graph failure no longer stops matching (D25, R25)", () => {
      const graphRun = () =>
        matchingRun({
          effectiveStages: ["knowledgeGraph", "atomicNoteMatching", "sourceMatching"]
        });
      const matching = () => vi.fn().mockResolvedValue({ persistedCount: 0 });

      it("fails the graph stage alone, matches without it and ends the run's job succeeded", async () => {
        const matchAtomicNotes = matching();
        const generateKnowledgeGraph = vi
          .fn()
          .mockRejectedValue(new Error("errors.knowledgeGraph.invalidOutput"));
        const { job } = await ingest({ generateKnowledgeGraph, matchAtomicNotes }, graphRun());
        expect(mocks.runs.failStage.mock.calls).toEqual([
          ["run", "knowledgeGraph", "errors.knowledgeGraph.invalidOutput"]
        ]);
        // The run is not failed and the stage is not completed: it stays failed and retryable.
        expect(mocks.runs.fail).not.toHaveBeenCalled();
        expect(mocks.runs.completeStage).not.toHaveBeenCalledWith(
          "run",
          "knowledgeGraph",
          expect.anything()
        );
        // Matching ran, and the run parks for its link job as any other run.
        expect(matchAtomicNotes).toHaveBeenCalledOnce();
        expect(mocks.runs.completeStage).toHaveBeenCalledWith(
          "run",
          "atomicNoteMatching",
          expect.anything()
        );
        expect(mocks.runs.parkForLinking).toHaveBeenCalledWith("run", { rootId: "root" });
        expect(job).toMatchObject({ status: "succeeded" });
      });

      it("completes a run whose plan stops at the graph, with the graph failed", async () => {
        const { job } = await ingest(
          { generateKnowledgeGraph: vi.fn().mockRejectedValue(new Error("bad_graph")) },
          matchingRun({ effectiveStages: ["knowledgeGraph"] })
        );
        expect(mocks.runs.failStage).toHaveBeenCalledWith("run", "knowledgeGraph", "bad_graph");
        expect(mocks.runs.complete).toHaveBeenCalledWith("run");
        expect(job).toMatchObject({ status: "succeeded" });
      });

      it("leaves a failure the job's own retry can mend to that retry, with matching still waiting", async () => {
        const matchAtomicNotes = matching();
        const outage = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
        const { job } = await ingest(
          { generateKnowledgeGraph: vi.fn().mockRejectedValue(outage), matchAtomicNotes },
          graphRun()
        );
        expect(job).toMatchObject({ status: "queued" });
        expect(mocks.runs.failStage).not.toHaveBeenCalled();
        expect(mocks.runs.fail).toHaveBeenCalledWith("run", expect.any(String));
        expect(matchAtomicNotes).not.toHaveBeenCalled();
      });

      it("fails the stage once a transient failure has used the job's attempts", async () => {
        const matchAtomicNotes = matching();
        const outage = new AiProviderError("busy", { kind: "http", transient: true, status: 503 });
        const { job } = await ingest(
          { generateKnowledgeGraph: vi.fn().mockRejectedValue(outage), matchAtomicNotes },
          graphRun(),
          {},
          3
        );
        expect(job).toMatchObject({ status: "succeeded" });
        expect(mocks.runs.failStage).toHaveBeenCalledWith("run", "knowledgeGraph", "busy");
        expect(matchAtomicNotes).toHaveBeenCalledOnce();
      });

      it("never turns a cancellation into a failed stage", async () => {
        const matchAtomicNotes = matching();
        const { job } = await ingest(
          {
            generateKnowledgeGraph: vi.fn(async () => {
              await supervisor!.requestCancel("job");
              throw new Error("canceled mid-call");
            }),
            matchAtomicNotes
          },
          graphRun()
        );
        expect(job).toMatchObject({ status: "canceled" });
        expect(mocks.runs.failStage).not.toHaveBeenCalled();
        expect(mocks.runs.cancel).toHaveBeenCalledWith("run");
        expect(matchAtomicNotes).not.toHaveBeenCalled();
      });

      it("completes the graph stage as before when the graph succeeds", async () => {
        const graph = { configured: true, generated: true };
        await ingest(
          {
            generateKnowledgeGraph: vi.fn().mockResolvedValue(graph),
            matchAtomicNotes: matching()
          },
          graphRun()
        );
        expect(mocks.runs.completeStage).toHaveBeenCalledWith("run", "knowledgeGraph", graph);
        expect(mocks.runs.failStage).not.toHaveBeenCalled();
      });

      it("re-runs only the graph stage when a graph-incomplete run is retried", async () => {
        supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
        const incomplete = {
          id: "run",
          jobId: "job",
          status: "succeeded",
          stagesCheckpoint: {
            knowledgeGraph: { status: "failed", error: "bad_graph" },
            atomicNoteMatching: { status: "completed" },
            sourceMatching: { status: "completed" }
          }
        };
        mocks.jobs.findById.mockResolvedValue({
          id: "job",
          type: "ingestion",
          status: "succeeded",
          payload: { ingestionRunId: "run" }
        });
        mocks.runs.findById.mockResolvedValue(incomplete);
        mocks.runs.reopenStages.mockResolvedValue(incomplete);
        await expect(supervisor.retry("job")).resolves.toMatchObject({ id: "retry" });
        expect(mocks.runs.reopenStages.mock.calls).toEqual([["run", ["knowledgeGraph"]]]);
        expect(mocks.jobs.retry).toHaveBeenCalledWith("job");
      });

      it("re-runs the graph of a finished run through retryStage, and nothing else", async () => {
        supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
        const incomplete = {
          id: "run",
          jobId: "job",
          status: "succeeded",
          stagesCheckpoint: { knowledgeGraph: { status: "failed" } }
        };
        mocks.runs.findById.mockResolvedValue(incomplete);
        mocks.jobs.findById.mockResolvedValue({ id: "job", status: "succeeded" });
        mocks.runs.reopenStages.mockResolvedValue(incomplete);
        await supervisor.retryStage("run", "knowledgeGraph");
        expect(mocks.runs.reopenStages.mock.calls).toEqual([["run", ["knowledgeGraph"]]]);
        // A stage that did not fail is not retried that way.
        mocks.runs.reopenStages.mockClear();
        await expect(supervisor.retryStage("run", "embedding")).resolves.toBeNull();
        expect(mocks.runs.reopenStages).not.toHaveBeenCalled();
      });
    });

    it("decides an interactive import at P1", async () => {
      const matchAtomicNotes = vi.fn().mockResolvedValue({ persistedCount: 0 });
      await ingest({ matchAtomicNotes }, matchingRun({ trigger: "interactive_import" }));
      expect(matchAtomicNotes.mock.calls[0]![3]).toMatchObject({ priority: "P1" });
    });

    it("skips both matching stages and completes the run while no ranker is validated (C7)", async () => {
      const matchAtomicNotes = vi
        .fn()
        .mockResolvedValue({ persistedCount: 0, skipped: "waiting_for_decider", decider: null });
      await ingest({ matchAtomicNotes });
      expect(mocks.runs.skipStage.mock.calls).toEqual([
        ["run", "atomicNoteMatching", "waiting_for_decider"],
        ["run", "sourceMatching", "waiting_for_decider"]
      ]);
      expect(mocks.runs.parkForLinking).not.toHaveBeenCalled();
      expect(mocks.jobs.enqueueDeduped).not.toHaveBeenCalled();
      expect(mocks.runs.complete).toHaveBeenCalledWith("run");
    });

    it("re-runs matching skipped for a decider through the stage-level retry once one validates", async () => {
      const skipped = { status: "skipped", reason: "waiting_for_decider" };
      const waiting = {
        id: "waiting-run",
        jobId: "waiting-job",
        status: "succeeded",
        stagesCheckpoint: { atomicNoteMatching: skipped, sourceMatching: skipped }
      };
      const noteDeciderAvailable = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
      supervisor = new JobSupervisor({
        getPool: () => ({}) as PgPool,
        pollIntervalMs: 100,
        knowledgeService: { noteDeciderAvailable } as unknown as KnowledgeService
      });
      mocks.runs.listLinkingSourceItems.mockResolvedValue([]);
      mocks.runs.listSkippedMatching.mockResolvedValue([waiting]);
      mocks.runs.findById.mockResolvedValue(waiting);
      mocks.runs.reopenStages.mockResolvedValue(waiting);
      mocks.jobs.findById.mockResolvedValue({ id: "waiting-job", status: "succeeded" });
      mocks.jobs.claimNext.mockResolvedValue(null);
      await supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      // Still no ranker: nothing is retried.
      expect(noteDeciderAvailable).toHaveBeenCalledOnce();
      expect(mocks.runs.reopenStages).not.toHaveBeenCalled();
      // The idle check runs at most every 30 s; then a ranker is ready.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(mocks.runs.reopenStages).toHaveBeenCalledWith("waiting-run", [
        "atomicNoteMatching",
        "sourceMatching"
      ]);
      expect(mocks.jobs.retry).toHaveBeenCalledWith("waiting-job");
    });

    it("never retries a stage of a run whose job is still queued or running", async () => {
      supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
      mocks.runs.findById.mockResolvedValue({
        id: "run",
        jobId: "job",
        status: "succeeded",
        stagesCheckpoint: {
          atomicNoteMatching: { status: "skipped", reason: "waiting_for_decider" }
        }
      });
      mocks.jobs.findById.mockResolvedValue({ id: "job", status: "queued" });
      await expect(supervisor.retryStage("run", "atomicNoteMatching")).resolves.toBeNull();
      expect(mocks.runs.reopenStages).not.toHaveBeenCalled();
    });

    it("queues the link job of every run parked at a restart", async () => {
      const pool = { query: vi.fn().mockResolvedValue({ rows: [{ id: "root" }] }) };
      supervisor = new JobSupervisor({
        getPool: () => pool as unknown as PgPool,
        knowledgeService: {} as KnowledgeService
      });
      mocks.runs.listLinkingSourceItems.mockResolvedValue(["chapter"]);
      mocks.jobs.enqueueDeduped.mockResolvedValue({ job: { id: "link-job" }, created: false });
      mocks.jobs.claimNext.mockResolvedValue(null);
      await supervisor.start();
      expect(mocks.jobs.enqueueDeduped).toHaveBeenCalledWith(
        expect.objectContaining({ dedupeKey: "relation-link:root", payload: { rootId: "root" } })
      );
    });
  });
  describe("a light job that ends for good", () => {
    const lightJob = (attempts: number) => ({
      id: "light-job",
      type: "relation-test",
      attempts,
      maxAttempts: 3,
      lockedAt: new Date(),
      payload: {}
    });
    const runFailing = async (error: unknown, attempts: number) => {
      const ended = vi.fn();
      supervisor = new JobSupervisor({
        getPool: () => ({}) as PgPool,
        lightJobs: {
          "relation-test": {
            needsModel: true,
            worker: "relations",
            execute: vi.fn().mockRejectedValue(error),
            ended
          }
        }
      });
      mocks.jobs.claimNext.mockResolvedValue(lightJob(attempts));
      mocks.jobs.update.mockImplementation(async (id: string, input: object) => ({ id, ...input }));
      await supervisor.runLightOnce("relations");
      return ended;
    };

    it("settles the work it owned when no attempt is left", async () => {
      const ended = await runFailing(new Error("errors.sourceRelations.invalidOutput"), 1);
      expect(ended).toHaveBeenCalledWith(
        expect.objectContaining({ id: "light-job" }),
        expect.any(Error),
        false
      );
    });

    it("leaves its work alone while it is queued again", async () => {
      const busy = new AiProviderError("busy", { kind: "http", transient: true, status: 500 });
      expect(await runFailing(busy, 1)).not.toHaveBeenCalled();
      expect(await runFailing(busy, 3)).toHaveBeenCalledOnce();
    });

    it.each([
      ["the product pool of 2", false, [0, 1]],
      ["one link job at a time in drain mode", true, [0]]
    ])("runs the relations worker with %s", async (_name, drain, slots) => {
      setRelationLinkRuntime({ drain });
      try {
        supervisor = new JobSupervisor({
          getPool: () => ({}) as PgPool,
          pollIntervalMs: 100,
          knowledgeService: {} as KnowledgeService
        });
        mocks.runs.listLinkingSourceItems.mockResolvedValue([]);
        mocks.jobs.claimNext.mockResolvedValue(null);
        const light = vi.spyOn(supervisor, "runLightOnce").mockResolvedValue(null);
        await supervisor.start();
        await vi.advanceTimersByTimeAsync(0);
        const claimed = light.mock.calls
          .filter(([worker]) => worker === "relations")
          .map(([, slot]) => slot);
        expect([...new Set(claimed)].sort()).toEqual(slots);
      } finally {
        resetRelationLinkRuntime();
      }
    });

    it("holds the heavy lane in drain mode while relation jobs are pending, models kept loaded", async () => {
      const pending = { rows: [{ pending: 1 }] };
      const query = vi.fn().mockResolvedValue(pending);
      const release = vi.fn().mockResolvedValue(undefined);
      supervisor = new JobSupervisor({
        getPool: () => ({ query }) as unknown as PgPool,
        pollIntervalMs: 100,
        knowledgeService: {} as KnowledgeService,
        releaseAiRuntime: release
      });
      mocks.runs.listLinkingSourceItems.mockResolvedValue([]);
      mocks.jobs.claimNext.mockResolvedValue(null);
      // The product never holds it: the heavy lane claims beside running link jobs.
      expect(await supervisor.runOnce()).toBeNull();
      expect(query).not.toHaveBeenCalled();
      expect(mocks.jobs.claimNext).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(Array),
        "heavy"
      );
      setRelationLinkRuntime({ drain: true });
      try {
        mocks.jobs.claimNext.mockClear();
        const light = vi.spyOn(supervisor, "runLightOnce").mockResolvedValue(null);
        await supervisor.start();
        await vi.advanceTimersByTimeAsync(300);
        // A link job is due or running: no heavy claim, and the lane is not idle. Promotion jobs
        // (T53) count too: discovery reads the source relations they write.
        expect(query).toHaveBeenCalledWith(expect.stringContaining("from jobs"), [
          ["catalog-header", "relation-link", "relation-promote", "relation-retype"]
        ]);
        expect(mocks.jobs.claimNext).not.toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Array),
          "heavy"
        );
        expect(release).not.toHaveBeenCalled();
        // The link jobs have run: the next heavy job is claimed, and an idle lane releases.
        query.mockResolvedValue({ rows: [] });
        await vi.advanceTimersByTimeAsync(100);
        expect(mocks.jobs.claimNext).toHaveBeenCalledWith(
          expect.any(String),
          expect.any(Array),
          "heavy"
        );
        expect(release).toHaveBeenCalled();
        light.mockRestore();
      } finally {
        resetRelationLinkRuntime();
      }
    });

    it("claims relation jobs on the relations worker only", async () => {
      supervisor = new JobSupervisor({
        getPool: () => ({}) as PgPool,
        lightJobs: {
          "relation-test": { needsModel: true, worker: "relations", execute: vi.fn() },
          "topic-test": { needsModel: true, execute: vi.fn() }
        }
      });
      mocks.jobs.claimNext.mockResolvedValue(null);
      await supervisor.runLightOnce("relations", 1);
      expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
        expect.stringMatching(/:light-relations-1$/u),
        ["relation-test"],
        "light"
      );
      await supervisor.runLightOnce("model");
      expect(mocks.jobs.claimNext).toHaveBeenLastCalledWith(
        expect.stringMatching(/:light-model$/u),
        ["topic-test"],
        "light"
      );
    });
  });
  it("coalesces retries during an active drain instead of starting overlapping ingestion", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool });
    let finish!: (job: JobRecord) => void;
    const pending = new Promise<JobRecord>((resolve) => {
      finish = resolve;
    });
    const run = vi
      .spyOn(supervisor, "runOnce")
      .mockImplementationOnce(() => pending)
      .mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    await supervisor.retry("retry");
    await supervisor.retry("retry");
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    finish({ id: "first" } as JobRecord);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(3);
  });
  it("keeps idle polling and stops scheduling after shutdown", async () => {
    supervisor = new JobSupervisor({ getPool: () => ({}) as PgPool, pollIntervalMs: 100 });
    const run = vi.spyOn(supervisor, "runOnce").mockResolvedValue(null);
    await supervisor.start();
    await vi.advanceTimersByTimeAsync(200);
    expect(run).toHaveBeenCalledTimes(3);
    await supervisor.stop();
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(3);
  });
});
