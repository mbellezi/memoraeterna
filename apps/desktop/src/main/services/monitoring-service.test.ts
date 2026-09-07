import { describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { MonitoringService, monitoringCutoff } from "./monitoring-service.js";
import { monitoringPruneSchema, monitoringQuerySchema } from "../../shared/monitoring.js";

function harness(debugMode = false, debugFullCapture = false) {
  const settings = { debugMode, debugFullCapture };
  const query = vi.fn().mockResolvedValue({ rows: [{ id: "11111111-1111-4111-8111-111111111111" }] });
  const error = vi.fn();
  const service = new MonitoringService(() => ({ query }) as unknown as PgPool, async () => settings, { error });
  return { settings, query, service, error };
}
const start = { kind: "ai" as const, operation: "embedding", stage: "chunk_embedding", context: {}, sourceItemIds: [], input: "full source" };
describe("monitoring capture and retention", () => {
  it("always records AI metadata but captures content only behind both switches", async () => {
    for (const flags of [[false, false], [false, true], [true, false], [true, true]] as const) {
      const { service, query } = harness(...flags);
      const capture = await service.start(start);
      await service.finish(capture, { status: "succeeded", durationMs: 3, output: "response" });
      expect(query.mock.calls[0]![1][12]).toBe(flags[0] && flags[1] ? '"full source"' : null);
      expect(query.mock.calls[1]![1][6]).toBe(flags[0] && flags[1] ? '"response"' : null);
    }
  });
  it("honors disabling full capture during an in-flight call", async () => {
    const { service, settings, query } = harness(true, true);
    const capture = await service.start(start);
    settings.debugFullCapture = false;
    await service.finish(capture, { status: "succeeded", durationMs: 2, output: "do not store" });
    expect(query.mock.calls[1]![1][6]).toBeNull();
  });
  it("records non-AI operations only in debug and never alters their result or error", async () => {
    const { service, query, settings } = harness();
    expect(await service.operation("canonicalization", {}, async () => 42)).toBe(42);
    expect(query).not.toHaveBeenCalled();
    settings.debugMode = true;
    const failure = new DOMException("canceled", "AbortError");
    await expect(service.operation("canonicalization", {}, async () => { throw failure; })).rejects.toBe(failure);
    expect(query.mock.calls[1]![1][1]).toBe("canceled");
  });
  it("does not let monitoring storage failures break processing", async () => {
    const { service, query, error } = harness(true);
    query.mockRejectedValue(new Error("storage unavailable"));
    expect(await service.operation("normalization", {}, async () => "normalized")).toBe("normalized");
    await expect(service.recover()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
  it("clamps calendar-month cutoffs and uses UTC days across DST", () => {
    expect(monitoringCutoff(new Date("2024-03-31T12:34:56Z"), 1, "months").toISOString()).toBe("2024-02-29T12:34:56.000Z");
    expect(monitoringCutoff(new Date("2026-03-31T12:34:56Z"), 1, "months").toISOString()).toBe("2026-02-28T12:34:56.000Z");
    expect(monitoringCutoff(new Date("2026-03-30T12:34:56Z"), 1, "days").toISOString()).toBe("2026-03-29T12:34:56.000Z");
  });
  it("rejects unbounded or invalid boundary requests", () => {
    expect(monitoringPruneSchema.safeParse({ amount: 0, unit: "days" }).success).toBe(false);
    expect(monitoringPruneSchema.safeParse({ amount: 1.5, unit: "months" }).success).toBe(false);
    expect(monitoringQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(monitoringQuerySchema.safeParse({ search: "x".repeat(201) }).success).toBe(false);
  });
});
