import { describe, expect, it, vi } from "vitest";

import { ConsultationService } from "./consultation-service.js";
import { consultationSnapshot } from "./consultation-fixture.js";

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
    contentLanguage: async () => "en"
  });
  return { service, runOrganizationTask };
}

const contexts = (runOrganizationTask: ReturnType<typeof consultation>["runOrganizationTask"]) =>
  (
    runOrganizationTask.mock.calls as unknown as Array<[unknown, unknown, Record<string, unknown>]>
  ).map((call) => call[2]);

describe("the priority of a consultation answer", () => {
  it("keeps an Ask interactive: its context states P0 and the answer class, and keeps the consultation origin", async () => {
    const { service, runOrganizationTask } = consultation();
    await expect(
      service.generate(consultationSnapshot(), "question", new AbortController().signal)
    ).rejects.toThrow("consultation.errors.invalid");
    const calls = contexts(runOrganizationTask);
    expect(calls).toHaveLength(2);
    for (const context of calls) {
      expect(context).toMatchObject({
        origin: "consultation",
        operation: "wiki-consultation",
        workloadClass: "answer",
        priority: "P0"
      });
    }
  });
});
