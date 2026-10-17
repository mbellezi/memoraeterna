import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool, SourceRelationExplanationContext } from "@app/db";

import { relationExplanationLimits } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";

const repository = vi.hoisted(() => ({ readContext: vi.fn(), save: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  createSourceRelationExplanationRepository: () => repository
}));

const { sourceRelationExplanationPlan } = await import("@app/db");
const { SourceRelationExplanationService } =
  await import("./source-relation-explanation-service.js");
const { registerSourceRelationExplanationIpc } =
  await import("./source-relation-explanation-ipc.js");
const {
  acceptSourceRelationExplanation,
  buildSourceRelationExplanationPrompt,
  sourceRelationExplanationPromptVersion
} = await import("./source-relation-explanation.js");

const ids = {
  relation: "00000000-0000-4000-8000-000000000010",
  source: "00000000-0000-4000-8000-0000000000aa",
  target: "00000000-0000-4000-8000-0000000000bb",
  run: "00000000-0000-4000-8000-000000000099"
};
const writtenAt = new Date("2026-10-15T10:00:00.000Z");

const context = (
  overrides: Partial<SourceRelationExplanationContext> = {}
): SourceRelationExplanationContext => ({
  relationId: ids.relation,
  type: "supports",
  status: "pending_review",
  hasProse: false,
  source: {
    id: ids.source,
    title: "Feedback study",
    passages: [{ chunkId: "c1", content: "Feedback improved delayed recall.", chunkIndex: 0 }]
  },
  target: {
    id: ids.target,
    title: "Retrieval review",
    passages: [{ chunkId: "c2", content: "Retrieval strengthens recall.", chunkIndex: 3 }]
  },
  stored: null,
  ...overrides
});

const execution = (output: unknown) => ({
  output,
  taskType: "text-generation" as const,
  providerId: "openai-codex",
  modelId: "writer-model",
  runtime: "remote" as const,
  durationMs: 5,
  profileId: "profile",
  aiTaskRunId: ids.run,
  outputLanguage: "pt-BR"
});

function setup(outputs: unknown[] = ["s1 gives the evidence s2 generalizes."]) {
  const runDefaultTask = vi.fn<
    (...args: unknown[]) => Promise<ReturnType<typeof execution> | null>
  >(async () => {
    const next = outputs.shift();
    return next === undefined ? null : execution(next);
  });
  const service = new SourceRelationExplanationService({
    getPool: () => ({}) as PgPool,
    ai: { runDefaultTask } as never,
    getContentLanguage: async () => "pt-BR"
  });
  return { service, runDefaultTask };
}

beforeEach(() => {
  repository.readContext.mockReset();
  repository.save.mockReset();
  repository.readContext.mockResolvedValue(context());
  repository.save.mockResolvedValue({ writtenAt });
});

describe("source relation explanation prompt", () => {
  it("names the sources s1 and s2 with titles and passages, never an ID", () => {
    const prompt = buildSourceRelationExplanationPrompt({
      type: "supports",
      direction: "s1_to_s2",
      first: { title: "Feedback study", passages: ["Feedback improved delayed recall."] },
      second: { title: "Retrieval review", passages: ["Retrieval strengthens recall."] }
    });
    expect(prompt).toContain("its direction is s1_to_s2");
    expect(prompt).toContain(
      '{"source":"s1","title":"Feedback study","passages":["Feedback improved delayed recall."]}'
    );
    expect(prompt).toContain(`at most ${relationExplanationLimits.modelCharacters} characters`);
    expect(prompt).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("turns only the standalone aliases into source references and refuses tags", () => {
    expect(
      acceptSourceRelationExplanation("s1 extends the S1 trial that s2 reviews; s12 is content.", {
        first: ids.source,
        second: ids.target
      })
    ).toBe(
      `<source-ref id="${ids.source}" /> extends the S1 trial that <source-ref id="${ids.target}" /> reviews; s12 is content.`
    );
    expect(
      acceptSourceRelationExplanation('<source-ref id="x" /> s1', {
        first: ids.source,
        second: ids.target
      })
    ).toBeNull();
    expect(
      acceptSourceRelationExplanation("x".repeat(301), { first: ids.source, second: ids.target })
    ).toBeNull();
  });
});

describe("SourceRelationExplanationService", () => {
  it("writes a missing explanation on the writer route, at interactive priority, and caches it", async () => {
    const { service, runDefaultTask } = setup();
    const result = await service.explain({ relationId: ids.relation });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    const [task, prompt, logContext, signal, limits] = runDefaultTask.mock.calls[0]!;
    expect(task).toBe("text-generation");
    expect(prompt).toContain("its direction is s1_to_s2");
    expect(prompt).not.toContain(ids.source);
    expect(logContext).toMatchObject({
      priority: "P0",
      workloadClass: "write-fast",
      contentLanguage: "pt-BR",
      promptVersion: sourceRelationExplanationPromptVersion,
      stage: "source_relation_explanation",
      operation: "source_relation_explanation",
      sourceItemIds: [ids.source, ids.target]
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(limits).toEqual({ maxOutputTokens: relationExplanationLimits.maxOutputTokens });
    const text = `<source-ref id="${ids.source}" /> gives the evidence <source-ref id="${ids.target}" /> generalizes.`;
    expect(result).toEqual({
      relationId: ids.relation,
      text,
      writtenBy: "writer-model",
      writtenAt: writtenAt.toISOString()
    });
    expect(repository.save).toHaveBeenCalledWith({
      relationId: ids.relation,
      text,
      inputHash: sourceRelationExplanationPlan(context(), "pt-BR").inputHash,
      promptVersion: sourceRelationExplanationPromptVersion,
      provider: "openai-codex",
      model: "writer-model",
      runtime: "remote",
      aiTaskRunId: ids.run,
      language: "pt-BR"
    });
  });

  it("reuses a cached explanation while its inputs hold, and rewrites a stale one", async () => {
    const cached = setup();
    repository.readContext.mockResolvedValue(
      context({
        stored: {
          text: "Cached.",
          inputHash: sourceRelationExplanationPlan(context(), "pt-BR").inputHash,
          model: "earlier-model",
          writtenAt
        }
      })
    );
    expect(await cached.service.explain({ relationId: ids.relation })).toEqual({
      relationId: ids.relation,
      text: "Cached.",
      writtenBy: "earlier-model",
      writtenAt: writtenAt.toISOString()
    });
    expect(cached.runDefaultTask).not.toHaveBeenCalled();
    repository.readContext.mockResolvedValue(
      context({ stored: { text: "Old.", inputHash: "stale", model: "m", writtenAt } })
    );
    const stale = setup();
    expect((await stale.service.explain({ relationId: ids.relation }))?.text).toContain(
      "generalizes"
    );
    expect(stale.runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid output once, then fails visibly", async () => {
    const repaired = setup(["s1 supports <b>s2</b>.", "s1 and s2 agree."]);
    expect((await repaired.service.explain({ relationId: ids.relation }))?.text).toContain("agree");
    expect(repaired.runDefaultTask.mock.calls[1]![1]).toContain(
      "referring to the sources only as s1 and s2"
    );
    expect(repaired.runDefaultTask.mock.calls[1]![2]).toMatchObject({ attempt: 1 });
    const failing = setup(["x".repeat(301), "<b>s1</b>"]);
    await expect(failing.service.explain({ relationId: ids.relation })).rejects.toThrow(
      "notePage.explain.errors.invalid"
    );
    const noModel = setup([]);
    await expect(noModel.service.explain({ relationId: ids.relation })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
  });

  it("explains nothing that is gone, rejected, already in stored prose or without current evidence", async () => {
    const { service, runDefaultTask } = setup();
    for (const read of [
      null,
      context({ status: "rejected" }),
      context({ hasProse: true }),
      context({ target: { ...context().target, passages: [] } })
    ]) {
      repository.readContext.mockResolvedValueOnce(read);
      expect(await service.explain({ relationId: ids.relation })).toBeNull();
    }
    expect(runDefaultTask).not.toHaveBeenCalled();
    repository.save.mockResolvedValueOnce(null);
    expect(await service.explain({ relationId: ids.relation })).toBeNull();
  });

  it("runs one request per relation and cancels it when the relation closes", async () => {
    const { service, runDefaultTask } = setup();
    let received: AbortSignal | undefined;
    runDefaultTask.mockImplementationOnce(
      (...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          received = args[3] as AbortSignal;
          received.addEventListener("abort", () => reject(received!.reason));
        }) as never
    );
    const pending = service.explain({ relationId: ids.relation });
    expect(service.explain({ relationId: ids.relation })).toBe(pending);
    await vi.waitFor(() => expect(received).toBeDefined());
    expect(service.cancel({ relationId: ids.relation })).toBe(true);
    await expect(pending).rejects.toThrow("canceled");
    expect(service.cancel({ relationId: ids.relation })).toBe(false);
    expect((await service.explain({ relationId: ids.relation }))?.text).toContain("generalizes");
  });

  it("registers validated IPC handlers for explain and cancel", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const { service } = setup();
    registerSourceRelationExplanationIpc(ipc as unknown as IpcMain, service);
    expect([...handlers.keys()]).toEqual([
      ipcChannels.relationsExplainSource,
      ipcChannels.relationsCancelExplainSource
    ]);
    expect(() =>
      handlers.get(ipcChannels.relationsExplainSource)!({}, { relationId: "x" })
    ).toThrow();
    expect(
      handlers.get(ipcChannels.relationsCancelExplainSource)!({}, { relationId: ids.relation })
    ).toBe(false);
  });
});
