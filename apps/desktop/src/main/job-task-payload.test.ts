import type { JobRecord } from "@app/db";
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import { jobTaskPayload } from "./job-task-payload.js";
import { explainBackfillExecutor } from "./services/relations/relation-explain-backfill.js";
import {
  TopicScopedPayloadSchema,
  TopicTreePayloadSchema
} from "./services/topic-tree/topic-jobs.js";

const relationId = "e8116c46-d436-4ae6-8f3e-1d2e108416b1";
const treeId = "ad4365de-3d4e-4e02-8ce8-c87d5f4d8973";
// What the AI service writes into a job's payload when one of its calls starts (`setAiExecution`).
const aiExecution = {
  provider: "openai-compatible",
  modelId: "dev-fake-priced-1",
  reasoningLevel: null
};

describe("persisted job envelope", () => {
  it("separates admission and monitoring metadata without mutating stored payload or weakening task validation", () => {
    const payload = {
      binding: "fixture",
      generation: "1",
      promptPin: { version: "prompt-catalog-v1" },
      errorHistory: [{ message: "Previous attempt" }],
      dashboardDismissedAt: "2026-09-12T00:00:00Z",
      inboxDismissedAt: "2026-09-12T00:00:00.000000Z",
      claimedDedupeKey: "topic-place:tree:root",
      aiExecution
    };
    const before = structuredClone(payload),
      task = jobTaskPayload(payload);
    expect(task).toEqual({ binding: "fixture", generation: "1" });
    expect(payload).toEqual(before);
    const schema = z.object({ binding: z.string(), generation: z.string() }).strict();
    expect(schema.parse(task)).toEqual(task);
    expect(() =>
      schema.parse(jobTaskPayload({ ...payload, unknownTaskAuthority: true }))
    ).toThrow();
  });
  it("keeps legacy task-only payloads equivalent", () => {
    expect(jobTaskPayload({ action: "write", content: "Literal %promptPin%" })).toEqual({
      action: "write",
      content: "Literal %promptPin%"
    });
  });

  it("lets a strict task schema read a job again after one of its calls ran (gate S, 10-25)", async () => {
    // A backfill whose call the money window refused at 80 % ran again with the model its call had
    // been routed to in its payload, and its strict schema failed the job for good.
    const annotated = {
      relationId,
      promptPin: { version: "prompt-catalog-v1" },
      claimedDedupeKey: `relation-explain-backfill:${relationId}`,
      errorHistory: [{ message: "gardener.blocked.cap.money_80" }],
      aiExecution
    };
    const backfill = vi.fn(async () => "written" as const);
    const executor = explainBackfillExecutor({ getPool: () => null, backfill });
    const job = { id: "job-1", payload: annotated } as unknown as JobRecord;
    await expect(executor.execute(job, new AbortController().signal)).resolves.toEqual({
      status: "completed",
      outcome: "written"
    });
    expect(backfill).toHaveBeenCalledWith(relationId, expect.objectContaining({ jobId: "job-1" }));
    // The topic jobs' strict schemas read the same envelope.
    expect(TopicTreePayloadSchema.parse(jobTaskPayload({ treeId, aiExecution }))).toEqual({
      treeId
    });
    expect(
      TopicScopedPayloadSchema.parse(
        jobTaskPayload({ treeId, noteId: relationId, aiExecution, claimedDedupeKey: "x" })
      )
    ).toEqual({ treeId, noteId: relationId });
  });
});
