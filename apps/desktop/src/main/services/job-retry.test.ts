import { describe, expect, it } from "vitest";

import { canManuallyRetryJob, hasIncompleteIngestionStages } from "./job-retry.js";

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
  it("allows a failed ingestion after automatic retries are exhausted", () => {
    expect(canManuallyRetryJob(
      { type: "ingestion", status: "failed" },
      { status: "failed", stagesCheckpoint: { chunking: { status: "completed" } } }
    )).toBe(true);
  });

  it("allows a canceled ingestion to resume its missing stages", () => {
    expect(canManuallyRetryJob(
      { type: "ingestion", status: "canceled" },
      { status: "canceled", stagesCheckpoint: { chunking: { status: "completed" } } }
    )).toBe(true);
  });

  it("allows an inconsistent succeeded job when an ingestion stage is missing", () => {
    expect(canManuallyRetryJob(
      { type: "ingestion", status: "succeeded" },
      { status: "succeeded", stagesCheckpoint: { ...completedStages, atomicNotes: { status: "running" } } }
    )).toBe(true);
  });

  it("does not restart a fully completed ingestion", () => {
    const ingestionRun = { status: "succeeded" as const, stagesCheckpoint: completedStages };
    expect(hasIncompleteIngestionStages(ingestionRun)).toBe(false);
    expect(canManuallyRetryJob({ type: "ingestion", status: "succeeded" }, ingestionRun)).toBe(false);
  });

  it("does not retry internal stage jobs directly", () => {
    const ingestionRun = { status: "failed" as const, stagesCheckpoint: {} };
    expect(canManuallyRetryJob({ type: "atomic-note-generation", status: "failed" }, ingestionRun)).toBe(false);
    expect(canManuallyRetryJob({ type: "ingestion", status: "running" }, ingestionRun)).toBe(false);
  });
});
