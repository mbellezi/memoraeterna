import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JobRecord, PgPool } from "@app/db";
import { parseRelationLabels, processRelationLabels } from "./relation-label-processing.js";

const db = vi.hoisted(() => ({
  listRelationLabels: vi.fn(), countRelationLabels: vi.fn(), relationLabelProgress: vi.fn(), saveRelationLabels: vi.fn(), update: vi.fn()
}));
vi.mock("@app/db", () => ({ createKnowledgeGraphRepository: () => db, createJobRepository: () => db }));
const job = { id: "job-1", payload: { mode: "all", contentLanguage: "pt-BR", before: "2026-09-07T00:00:00.000Z" } } as unknown as JobRecord;
const relation = { id: "relation-1", predicate: "used_to_accuse", subject: "Evidence", object: "Person", sourceItemId: "source-1" };
const execution = { taskType: "knowledge-graph-generation" as const, output: { labels: [{ key: "r1", displayLabel: "Foi usado para acusar" }] }, aiTaskRunId: "run-1", profileId: "profile-1", providerId: "test", modelId: "test", runtime: "remote" as const, outputLanguage: "pt-BR", durationMs: 1 };

beforeEach(() => {
  vi.resetAllMocks();
  db.countRelationLabels.mockResolvedValue(1);
  db.relationLabelProgress.mockResolvedValue(1);
  db.listRelationLabels.mockResolvedValueOnce([relation]).mockResolvedValue([]);
});

describe("relation description processing", () => {
  it("rejects incomplete, duplicate and invented aliases", () => {
    for (const labels of [[], [{ key: "r2", displayLabel: "x" }], [{ key: "r1", displayLabel: "x" }, { key: "r1", displayLabel: "y" }]]) {
      expect(() => parseRelationLabels({ labels }, [relation.id])).toThrow();
    }
    expect(() => parseRelationLabels({ labels: [{ key: "r1", displayLabel: "  " }] }, [relation.id])).toThrow();
  });

  it("uses the graph model route and the snapshotted language, preserving provenance", async () => {
    const runDefaultTask = vi.fn().mockResolvedValue(execution);
    await processRelationLabels({} as PgPool, { runDefaultTask }, job, new AbortController().signal);
    expect(runDefaultTask).toHaveBeenCalledWith("knowledge-graph-generation", expect.stringContaining("used_to_accuse"),
      expect.objectContaining({ contentLanguage: "pt-BR", sourceItemIds: ["source-1"] }), expect.any(AbortSignal));
    expect(db.saveRelationLabels).toHaveBeenCalledWith([{ id: relation.id, displayLabel: "Foi usado para acusar" }],
      expect.objectContaining({ displayLanguage: "pt-BR", labelJobId: job.id, labelGeneration: expect.objectContaining({ aiTaskRunId: "run-1" }) }));
    expect(db.listRelationLabels).toHaveBeenCalledWith({ jobId: job.id, mode: "all", before: job.payload.before });
  });

  it("does not invoke AI when all batches have already been persisted", async () => {
    db.listRelationLabels.mockReset().mockResolvedValue([]);
    const runDefaultTask = vi.fn();
    const result = await processRelationLabels({} as PgPool, { runDefaultTask }, job, new AbortController().signal);
    expect(result.updated).toBe(1);
    expect(runDefaultTask).not.toHaveBeenCalled();
  });

  it("repairs once and leaves stored labels untouched after two invalid responses", async () => {
    const runDefaultTask = vi.fn().mockResolvedValue({ ...execution, output: { labels: [] } });
    await expect(processRelationLabels({} as PgPool, { runDefaultTask }, job, new AbortController().signal)).rejects.toThrow("errors.relationLabels.invalidOutput");
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    expect(db.saveRelationLabels).not.toHaveBeenCalled();
  });

  it("does not persist an in-flight result after cancellation", async () => {
    const controller = new AbortController();
    const runDefaultTask = vi.fn(async () => { controller.abort(); return execution; });
    await expect(processRelationLabels({} as PgPool, { runDefaultTask }, job, controller.signal)).rejects.toThrow();
    expect(db.saveRelationLabels).not.toHaveBeenCalled();
  });
});
