import { describe, expect, it } from "vitest";

import {
  canDeleteCanceledJob,
  canManuallyRetryJob,
  hasIncompleteIngestionStages,
  isParkedForLinking,
  manualRetryStages,
  stageRetryStages
} from "./job-retry.js";

describe("runs parked for their link job and the stage-level retry (F3 D24, D25)", () => {
  const waiting = { status: "skipped", reason: "waiting_for_decider" };

  it("offers no manual retry while the link job has the run", () => {
    const parked = {
      status: "running" as const,
      stagesCheckpoint: {
        atomicNoteMatching: { status: "completed" },
        sourceMatching: { status: "linking" }
      }
    };
    expect(isParkedForLinking(parked)).toBe(true);
    expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, parked)).toBe(false);
    // Its link job failed for good: the run failed and is retried as any failed run.
    const failed = { ...parked, status: "failed" as const };
    expect(isParkedForLinking(failed)).toBe(false);
    expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, failed)).toBe(true);
  });

  it("re-runs both matching stages skipped for a decider, or one failed stage alone", () => {
    const skipped = {
      status: "succeeded" as const,
      stagesCheckpoint: { atomicNoteMatching: waiting, sourceMatching: waiting }
    };
    expect(stageRetryStages(skipped, "atomicNoteMatching")).toEqual([
      "atomicNoteMatching",
      "sourceMatching"
    ]);
    const graph = {
      status: "succeeded" as const,
      stagesCheckpoint: { knowledgeGraph: { status: "failed" }, atomicNoteMatching: waiting }
    };
    expect(stageRetryStages(graph, "knowledgeGraph")).toEqual(["knowledgeGraph"]);
    // Not finished, not skipped for a decider, or skipped for another reason: no stage retry.
    expect(stageRetryStages({ ...skipped, status: "running" }, "atomicNoteMatching")).toBeNull();
    expect(
      stageRetryStages(
        { status: "succeeded", stagesCheckpoint: { sourceMatching: { status: "completed" } } },
        "sourceMatching"
      )
    ).toBeNull();
    expect(
      stageRetryStages(
        {
          status: "succeeded",
          stagesCheckpoint: { atomicNoteMatching: { status: "skipped", reason: "not_requested" } }
        },
        "atomicNoteMatching"
      )
    ).toBeNull();
  });
});

describe("a run that ended with its graph incomplete (F3 D25, R25)", () => {
  const failedGraph = { status: "failed", error: "errors.knowledgeGraph.invalidOutput" };
  const incomplete = {
    status: "succeeded" as const,
    stagesCheckpoint: {
      chunking: { status: "completed" },
      embedding: { status: "completed" },
      summarization: { status: "completed" },
      atomicNotes: { status: "completed" },
      knowledgeGraph: failedGraph,
      atomicNoteMatching: { status: "completed" },
      sourceMatching: { status: "completed" },
      obsidianProjection: { status: "completed" }
    }
  };

  it("offers the retry and re-runs the graph stage alone", () => {
    expect(hasIncompleteIngestionStages(incomplete)).toBe(true);
    expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, incomplete)).toBe(true);
    expect(stageRetryStages(incomplete, "knowledgeGraph")).toEqual(["knowledgeGraph"]);
    expect(manualRetryStages(incomplete)).toEqual(["knowledgeGraph"]);
  });

  it("adds the matching stages that also waited for a ranker, graph first", () => {
    const waiting = { status: "skipped", reason: "waiting_for_decider" };
    expect(
      manualRetryStages({
        ...incomplete,
        stagesCheckpoint: {
          ...incomplete.stagesCheckpoint,
          atomicNoteMatching: waiting,
          sourceMatching: waiting
        }
      })
    ).toEqual(["knowledgeGraph", "atomicNoteMatching", "sourceMatching"]);
    expect(
      manualRetryStages({
        status: "succeeded",
        stagesCheckpoint: { atomicNoteMatching: waiting, sourceMatching: waiting }
      })
    ).toEqual(["atomicNoteMatching", "sourceMatching"]);
  });

  it("resumes a failed, canceled or complete run from its own checkpoints instead", () => {
    expect(manualRetryStages({ ...incomplete, status: "failed" })).toBeNull();
    expect(manualRetryStages({ ...incomplete, status: "canceled" })).toBeNull();
    expect(
      manualRetryStages({
        status: "succeeded",
        stagesCheckpoint: { knowledgeGraph: { status: "completed" } }
      })
    ).toBeNull();
  });
});

const completedStages = {
  chunking: { status: "completed" },
  embedding: { status: "completed" },
  summarization: { status: "completed" },
  atomicNotes: { status: "completed" },
  knowledgeGraph: { status: "completed" },
  atomicNoteMatching: { status: "completed" },
  obsidianProjection: { status: "completed" }
};

describe("manual job retry", () => {
  it("reads a stored retired organization stage as settled, never as work to retry or wait for", () => {
    for (const status of ["pending", "waiting_for_batch", "running", "failed"]) {
      const ingestionRun = {
        status: "succeeded" as const,
        stagesCheckpoint: {
          ...completedStages,
          organizeKnowledge: { status, metadata: { organizationRunId: "linked-run" } }
        }
      };
      expect(hasIncompleteIngestionStages(ingestionRun)).toBe(false);
      expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, ingestionRun)).toBe(
        false
      );
      // A failed parent is retried as before; the retired stage does not hold it back.
      expect(
        canManuallyRetryJob(
          { type: "ingestion", status: "failed" },
          { ...ingestionRun, status: "failed" }
        )
      ).toBe(true);
    }
  });
  it("allows an interrupted source matching stage without adding that stage to historical runs", () => {
    expect(
      hasIncompleteIngestionStages({
        status: "succeeded",
        stagesCheckpoint: { ...completedStages, sourceMatching: { status: "failed" } }
      })
    ).toBe(true);
    expect(
      hasIncompleteIngestionStages({ status: "succeeded", stagesCheckpoint: completedStages })
    ).toBe(false);
  });
  it("allows a failed ingestion after automatic retries are exhausted", () => {
    expect(
      canManuallyRetryJob(
        { type: "ingestion", status: "failed" },
        { status: "failed", stagesCheckpoint: { chunking: { status: "completed" } } }
      )
    ).toBe(true);
  });

  it("allows a canceled ingestion to resume its missing stages", () => {
    expect(
      canManuallyRetryJob(
        { type: "ingestion", status: "canceled" },
        { status: "canceled", stagesCheckpoint: { chunking: { status: "completed" } } }
      )
    ).toBe(true);
  });

  it("allows an inconsistent succeeded job when an ingestion stage is missing", () => {
    expect(
      canManuallyRetryJob(
        { type: "ingestion", status: "succeeded" },
        {
          status: "succeeded",
          stagesCheckpoint: { ...completedStages, atomicNotes: { status: "running" } }
        }
      )
    ).toBe(true);
  });

  it("does not restart a fully completed ingestion", () => {
    const ingestionRun = { status: "succeeded" as const, stagesCheckpoint: completedStages };
    expect(hasIncompleteIngestionStages(ingestionRun)).toBe(false);
    expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, ingestionRun)).toBe(
      false
    );
  });

  it("does not retry internal stage jobs directly", () => {
    const ingestionRun = { status: "failed" as const, stagesCheckpoint: {} };
    expect(
      canManuallyRetryJob({ type: "atomic-note-generation", status: "failed" }, ingestionRun)
    ).toBe(false);
    expect(canManuallyRetryJob({ type: "ingestion", status: "running" }, ingestionRun)).toBe(false);
  });

  it("deletes only an incomplete ingestion explicitly canceled by the user", () => {
    expect(
      canDeleteCanceledJob(
        { type: "ingestion", status: "canceled", cancelRequestedAt: new Date() },
        { status: "canceled" }
      )
    ).toBe(true);
    expect(
      canDeleteCanceledJob(
        { type: "ingestion", status: "canceled", cancelRequestedAt: null },
        { status: "canceled" }
      )
    ).toBe(false);
    expect(
      canDeleteCanceledJob(
        { type: "ingestion", status: "canceled", cancelRequestedAt: new Date() },
        { status: "succeeded" }
      )
    ).toBe(false);
  });
});
