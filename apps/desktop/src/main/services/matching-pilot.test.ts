import { describe, expect, it } from "vitest";
import { isMatchingPilotComplete } from "./matching-pilot.js";

describe("DEV pilot completion", () => {
  it("waits for deferred matching even after ingestion jobs succeed", () => {
    expect(isMatchingPilotComplete([{ status: "succeeded", stages_checkpoint: { sourceMatching: { status: "waiting_for_batch" } } }])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "succeeded", stages_checkpoint: { atomicNoteMatching: { status: "running" } } }])).toBe(false);
  });
  it("recognizes terminal stages and failures without treating an empty batch as complete", () => {
    expect(isMatchingPilotComplete([])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "failed", job_status: "queued" }])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "succeeded", stages_checkpoint: { atomicNoteMatching: { status: "completed" }, sourceMatching: { status: "completed" } } }])).toBe(true);
    expect(isMatchingPilotComplete([{ status: "failed" }, { status: "running" }])).toBe(false);
    expect(isMatchingPilotComplete([{ status: "failed" }, { status: "canceled" }])).toBe(true);
  });
});
