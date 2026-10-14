import { describe, expect, it, vi } from "vitest";
import type { OrganizationSnapshot } from "@app/domain";

import { ConsultationService } from "./consultation-service.js";

const snapshot = {
  contentLanguage: "en",
  evidence: [],
  contexts: [],
  relations: [],
  sourceIds: [],
  instructions: { slots: {} },
  profile: { provider: "openai-compatible", contextWindow: 65536, privacy: "allow_remote" },
  // A sample snapshot needs no database to be validated.
  sample: true,
  promptPin: null
} as unknown as OrganizationSnapshot;

function consultation() {
  const runOrganizationTask = vi.fn(async () => ({
    output: "not an answer",
    aiTaskRunId: "run-id"
  }));
  const service = new ConsultationService({
    getPool: () => null,
    ai: {
      runOrganizationTask,
      runConsultationEmbedding: vi.fn(),
      pinOrganizationProfile: vi.fn()
    } as never,
    contentLanguage: async () => "en",
    wake: () => undefined
  });
  return { service, runOrganizationTask };
}

const contexts = (runOrganizationTask: ReturnType<typeof consultation>["runOrganizationTask"]) =>
  (
    runOrganizationTask.mock.calls as unknown as Array<[unknown, unknown, Record<string, unknown>]>
  ).map((call) => call[2]);

describe("the priority of a consultation answer", () => {
  it("leaves an Ask interactive: its context states no priority and keeps the consultation origin", async () => {
    const { service, runOrganizationTask } = consultation();
    await expect(
      service.generate(snapshot, "question", [], new AbortController().signal)
    ).rejects.toThrow("organization.errors.invalid");
    const calls = contexts(runOrganizationTask);
    expect(calls).toHaveLength(2);
    for (const context of calls) {
      expect(context).toMatchObject({ origin: "consultation", operation: "wiki-consultation" });
      expect(context).not.toHaveProperty("priority");
    }
  });

  it("runs an automatic investigation refresh, which brings its hooks, as background work", async () => {
    const { service, runOrganizationTask } = consultation();
    const hooks = {
      before: vi.fn(async () => undefined),
      guard: vi.fn(async () => undefined),
      started: vi.fn(async () => undefined),
      settled: vi.fn(async () => undefined),
      runId: "00000000-0000-4000-8000-000000000001"
    };
    await expect(
      service.generate(snapshot, "question", [], new AbortController().signal, hooks)
    ).rejects.toThrow("organization.errors.invalid");
    const calls = contexts(runOrganizationTask);
    expect(calls).toHaveLength(2);
    for (const context of calls) {
      expect(context).toMatchObject({
        priority: "background",
        origin: "consultation",
        organizationRunId: hooks.runId
      });
    }
  });
});
