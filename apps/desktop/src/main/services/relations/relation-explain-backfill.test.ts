import { randomUUID } from "node:crypto";

import type { JobRecord } from "@app/db";
import { describe, expect, it, vi } from "vitest";

import {
  explainBackfillExecutor,
  relationExplainBackfillJobType
} from "./relation-explain-backfill.js";

describe("the explanation backfill job (F4 D18)", () => {
  it("runs again after a blocker set it aside past its first AI call (F4 D7)", async () => {
    // The gate S money window of 10-25: the budget refused the call at its 80% after the AI
    // service had written the model into the job's payload; the next claim met that key.
    const relationId = randomUUID();
    const backfill = vi.fn(async () => "written" as const);
    const executor = explainBackfillExecutor({ getPool: () => null, backfill });
    const job = {
      id: randomUUID(),
      type: relationExplainBackfillJobType,
      payload: {
        relationId,
        aiExecution: {
          provider: "openai-compatible",
          modelId: "dev-fake-priced-1",
          reasoningLevel: null
        },
        claimedDedupeKey: `${relationExplainBackfillJobType}:${relationId}`
      }
    } as unknown as JobRecord;
    const signal = new AbortController().signal;
    await expect(executor.execute(job, signal)).resolves.toEqual({
      status: "completed",
      outcome: "written"
    });
    expect(backfill).toHaveBeenCalledWith(relationId, { jobId: job.id, signal });
    // A task key it does not know still fails its strict payload.
    await expect(
      executor.execute({ ...job, payload: { relationId, unknownTaskKey: true } }, signal)
    ).rejects.toThrow();
  });
});
