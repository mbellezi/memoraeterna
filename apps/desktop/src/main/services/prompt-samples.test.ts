import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { promptDefinitions, PromptSampleProgressSchema } from "@app/domain";
import { defaultPromptPin, promptAudit } from "./prompt-runtime.js";
import {
  isRetiredPromptFamily,
  runPromptSamples,
  promptSampleLimits,
  promptSampleCases
} from "./prompt-samples.js";
function model() {
  const calls: Array<{ id: string; input: string }> = [];
  return {
    calls,
    describePromptRoute: vi.fn(async () => ({
      provider: "openai-codex",
      modelId: "qwen3-embedding-fixture",
      repository: "fixture"
    })),
    runDefaultTask: vi.fn(async (task: string, input: string) => {
      const id = promptAudit(input)[0]?.promptId ?? "";
      calls.push({ id, input });
      let output: unknown;
      if (task === "embedding") output = [1, ...Array(255).fill(0)];
      else if (task === "text-generation") output = "OK";
      else if (id.startsWith("summary."))
        output = { summary: "A fictional study qualified the role of feedback.", concepts: [] };
      else if (id.startsWith("notes.") && id !== "notes.match") output = { notes: [] };
      else if (id === "notes.match") output = { results: [[1, 0, "related"]] };
      else if (id.includes("_identity")) output = { matches: [["r1", "c1"]] };
      else if (id === "graph.relation_labels")
        output = { labels: [{ key: "r1", displayLabel: "Improves recall" }] };
      else if (id.startsWith("graph.")) output = { entities: [], relations: [] };
      else if (id === "sources.decide") output = { relations: [] };
      else if (id.startsWith("consultation."))
        output = {
          change: { meaningful: false, explanation: [] },
          paragraphs: [
            { markdown: "Feedback qualified the benefit [e1].", citations: ["e1"], contextIds: [] }
          ],
          gaps: []
        };
      else throw new Error("Untested sample " + id);
      return {
        taskType: task as any,
        output,
        providerId: "fixture",
        modelId: "fixture",
        runtime: "remote" as const,
        durationMs: 1,
        aiTaskRunId: randomUUID(),
        profileId: randomUUID(),
        outputLanguage: "en"
      };
    })
  };
}
describe("bounded catalog sample runner", () => {
  it("leaves the ranker diagnostic out of the cases: only a dedicated ranker can run it", () => {
    expect(promptDefinitions.find((d) => d.id === "diagnostics.local_ranking")).toMatchObject({
      task: "reranking",
      variables: []
    });
    expect(
      promptSampleCases(["summary.short", "diagnostics.local_ranking"]).map((entry) => entry.id)
    ).toEqual(["summary.short"]);
    expect(() => promptSampleCases(["diagnostics.local_ranking"])).toThrow("prompts.errors.sample");
  });
  it("executes every registered required variant with real builders and validators, including exact same-root repair and local diagnostics", async () => {
    const ai = model(),
      pin = defaultPromptPin(),
      ids = promptDefinitions.map((d) => d.id);
    let progress = PromptSampleProgressSchema.parse({});
    for (let batch = 0; batch < 10; batch++) {
      progress = await runPromptSamples(ai, [{ pin, ids }], { progress });
      if (progress.error !== "prompts.errors.partial") break;
    }
    expect(progress.error).toBeNull();
    expect(progress.completedKeys).toHaveLength(promptSampleCases(ids).length);
    expect(progress.inapplicable).toEqual({});
    expect(progress.calls).toBe(ai.calls.length);
    expect(progress.auditIds).toHaveLength(ai.calls.length);
    // The retired curator, organization and maintenance prompts have no sampler (T39r).
    expect(ids.some(isRetiredPromptFamily)).toBe(true);
    expect(promptSampleCases(ids).some((entry) => isRetiredPromptFamily(entry.id))).toBe(false);
    expect(ai.calls.some((c) => isRetiredPromptFamily(c.id))).toBe(false);
    expect(
      progress.completedKeys.some((key) => key.startsWith("sources.decide.repair.same_root:"))
    ).toBe(true);
    expect(ai.calls.some((c) => c.input.includes("SAME root/work"))).toBe(true);
    for (const id of ["diagnostics.local_generation", "diagnostics.local_embedding"])
      expect(ai.calls.some((c) => c.id === id)).toBe(true);
  });
  it("resumes after twelve admissions without rerunning completed compositions and retains reservations on failure", async () => {
    const ai = model(),
      contexts = Array.from({ length: 15 }, (_, i) => {
        const pin = defaultPromptPin();
        pin.entries.find((e) => e.id === "summary.short")!.fields.body += "\nVariant " + i;
        return { pin, ids: ["summary.short"] };
      }),
      saved: any[] = [];
    const first = await runPromptSamples(ai, contexts, {
      onProgress: async (value) => {
        saved.push(structuredClone(value));
      }
    });
    expect(first.error).toBe("prompts.errors.partial");
    expect(first.calls).toBe(12);
    expect(first.completedKeys).toHaveLength(12);
    expect(saved.some((v) => v.calls === 1 && v.auditIds.length === 0)).toBe(true);
    const second = await runPromptSamples(ai, contexts, {
      progress: JSON.parse(JSON.stringify(first))
    });
    expect(second.error).toBeNull();
    expect(second.calls).toBe(15);
    expect(ai.calls).toHaveLength(15);
    expect(new Set(ai.calls.map((c) => c.input)).size).toBe(15);
    const failing = model();
    failing.runDefaultTask.mockRejectedValueOnce(
      Object.assign(new Error("model failed"), { aiTaskRunId: randomUUID() })
    );
    const failure = await runPromptSamples(failing, [contexts[0]!]);
    expect(failure.calls).toBe(1);
    expect(failure.outputTokensReserved).toBe(4096);
    expect(failure.completedKeys).toEqual([]);
    expect(failure.auditIds).toHaveLength(1);
  });
  it("enforces the cumulative ceiling and never certifies a non-Codex route for adapter wording", async () => {
    const ai = model(),
      pin = defaultPromptPin();
    const budget = await runPromptSamples(ai, [{ pin, ids: ["summary.short"] }], {
      progress: PromptSampleProgressSchema.parse({ calls: promptSampleLimits.totalCalls })
    });
    expect(budget.error).toBe("prompts.errors.budget");
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
    ai.describePromptRoute.mockResolvedValue({
      provider: "local",
      modelId: "fixture",
      repository: "fixture"
    });
    const result = await runPromptSamples(ai, [
      { pin, ids: ["shared.codex_adapter_instruction", "summary.short"] }
    ]);
    expect(result.error).toBe("prompts.errors.model");
    expect(result.completedKeys).toEqual([]);
    expect(Object.values(result.inapplicable)).toEqual(["provider:local"]);
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
  });
});
