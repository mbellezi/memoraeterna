import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMain } from "electron";
import type { PgPool, RelationExplanationContext } from "@app/db";

import { relationExplanationLimits } from "@app/domain";

import { ipcChannels } from "../../shared/ipc.js";
import { ActiveDeadline } from "@app/ai";

const repository = vi.hoisted(() => ({ readContext: vi.fn(), save: vi.fn() }));
vi.mock("@app/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@app/db")>()),
  createRelationExplanationRepository: () => repository
}));

const { relationExplanationPlan } = await import("@app/db");
const { RelationExplanationService } = await import("./relation-explanation-service.js");
const { registerRelationExplanationIpc } = await import("./relation-explanation-ipc.js");
const { relationExplanationPromptVersion } = await import("./relation-explanation.js");

const ids = {
  relation: "00000000-0000-4000-8000-000000000010",
  a: "00000000-0000-4000-8000-0000000000aa",
  b: "00000000-0000-4000-8000-0000000000bb",
  run: "00000000-0000-4000-8000-000000000099",
  sourceA: "00000000-0000-4000-8000-000000000001",
  sourceB: "00000000-0000-4000-8000-000000000002"
};
const writtenAt = new Date("2026-10-15T10:00:00.000Z");

const context = (
  overrides: Partial<RelationExplanationContext> = {}
): RelationExplanationContext => ({
  relationId: ids.relation,
  type: "supports",
  status: "pending_review",
  semanticSourceId: ids.b,
  listed: true,
  a: {
    id: ids.a,
    title: "Retrieval",
    ideaStatement: "Retrieval improves recall.",
    status: "active",
    language: "en",
    homeSourceId: ids.sourceA,
    passage: { chunkId: ids.sourceA, content: "Retrieval passage.", contentHash: "pa" }
  },
  b: {
    id: ids.b,
    title: "Feedback",
    ideaStatement: "Feedback qualifies recall.",
    status: "active",
    language: "en",
    homeSourceId: ids.sourceB,
    passage: null
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

function setup(
  outputs: unknown[] = ["n1 qualifies the recall benefit n2 reports."],
  getContentLanguage: () => Promise<string> = async () => "pt-BR"
) {
  const runDefaultTask = vi.fn<
    (...args: unknown[]) => Promise<ReturnType<typeof execution> | null>
  >(async () => {
    const next = outputs.shift();
    return next === undefined ? null : execution(next);
  });
  const service = new RelationExplanationService({
    getPool: () => ({}) as PgPool,
    ai: { runDefaultTask } as never,
    getContentLanguage
  });
  return { service, runDefaultTask };
}

beforeEach(() => {
  repository.readContext.mockReset();
  repository.save.mockReset();
  repository.readContext.mockResolvedValue(context());
  repository.save.mockResolvedValue({ writtenAt });
});

describe("RelationExplanationService", () => {
  it("writes a missing explanation on the writer route, at interactive priority, and caches it", async () => {
    const { service, runDefaultTask } = setup();
    const result = await service.explain({ relationId: ids.relation });
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    const [task, prompt, logContext, signal, limits] = runDefaultTask.mock.calls[0]!;
    expect(task).toBe("text-generation");
    expect(prompt).toContain("its direction is n1_to_n2");
    expect(prompt).not.toContain(ids.a);
    expect(logContext).toMatchObject({
      priority: "interactive",
      contentLanguage: "pt-BR",
      promptVersion: relationExplanationPromptVersion,
      stage: "relation_explanation",
      operation: "relation_explanation",
      sourceItemIds: [ids.sourceB, ids.sourceA]
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(limits).toEqual({ maxOutputTokens: relationExplanationLimits.maxOutputTokens });
    // The decided subject (b) is n1.
    const text = `<note-ref id="${ids.b}" /> qualifies the recall benefit <note-ref id="${ids.a}" /> reports.`;
    expect(result).toEqual({
      relationId: ids.relation,
      text,
      writtenBy: "writer-model",
      writtenAt: writtenAt.toISOString()
    });
    expect(repository.save).toHaveBeenCalledWith({
      relationId: ids.relation,
      text,
      inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash,
      promptVersion: relationExplanationPromptVersion,
      provider: "openai-codex",
      model: "writer-model",
      runtime: "remote",
      aiTaskRunId: ids.run,
      language: "pt-BR"
    });
  });

  it("reuses a cached explanation while its inputs are unchanged, without AI", async () => {
    repository.readContext.mockResolvedValue(
      context({
        stored: {
          text: "Cached.",
          inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash,
          model: "earlier-model",
          writtenAt
        }
      })
    );
    const { service, runDefaultTask } = setup();
    expect(await service.explain({ relationId: ids.relation })).toEqual({
      relationId: ids.relation,
      text: "Cached.",
      writtenBy: "earlier-model",
      writtenAt: writtenAt.toISOString()
    });
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("rewrites a stale explanation", async () => {
    repository.readContext.mockResolvedValue(
      context({ stored: { text: "Old.", inputHash: "stale", model: "m", writtenAt } })
    );
    const { service, runDefaultTask } = setup();
    expect((await service.explain({ relationId: ids.relation }))?.text).toContain("qualifies");
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid output once, then fails visibly", async () => {
    const repaired = setup(["n1 supports <b>n2</b>.", "n1 and n2 agree."]);
    expect((await repaired.service.explain({ relationId: ids.relation }))?.text).toContain("agree");
    expect(repaired.runDefaultTask).toHaveBeenCalledTimes(2);
    expect(repaired.runDefaultTask.mock.calls[1]![1]).toContain(
      "The previous answer was not a valid"
    );
    expect(repaired.runDefaultTask.mock.calls[1]![2]).toMatchObject({ attempt: 1 });
    const failing = setup(["x".repeat(301), "<b>n1</b>"]);
    await expect(failing.service.explain({ relationId: ids.relation })).rejects.toThrow(
      "notePage.explain.errors.invalid"
    );
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("fails visibly without a writer model", async () => {
    const { service } = setup([]);
    await expect(service.explain({ relationId: ids.relation })).rejects.toThrow(
      "errors.ai.noCompatibleModel"
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("explains nothing for a missing or hidden relation", async () => {
    const { service, runDefaultTask } = setup();
    repository.readContext.mockResolvedValueOnce(null);
    expect(await service.explain({ relationId: ids.relation })).toBeNull();
    // A relation the Note page does not list (removed by the owner, or between notes that are no
    // longer current) is not explained.
    repository.readContext.mockResolvedValueOnce(context({ status: "rejected", listed: false }));
    expect(await service.explain({ relationId: ids.relation })).toBeNull();
    repository.readContext.mockResolvedValueOnce(
      context({ b: { ...context().b, status: "archived" } })
    );
    expect(await service.explain({ relationId: ids.relation })).toBeNull();
    expect(runDefaultTask).not.toHaveBeenCalled();
    repository.save.mockResolvedValueOnce(null);
    expect(await service.explain({ relationId: ids.relation })).toBeNull();
  });

  it("explains human-protected notes like any other: an explanation edits neither note", async () => {
    const { service } = setup();
    await service.explain({ relationId: ids.relation });
    expect(Object.keys(repository)).toEqual(["readContext", "save"]);
  });

  it("runs one request per relation at a time", async () => {
    let finish!: (value: unknown) => void;
    const { service, runDefaultTask } = setup();
    runDefaultTask.mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)) as never
    );
    const first = service.explain({ relationId: ids.relation });
    const second = service.explain({ relationId: ids.relation });
    await vi.waitFor(() => expect(runDefaultTask).toHaveBeenCalledTimes(1));
    finish(execution("n1 and n2 agree."));
    expect(await second).toEqual(await first);
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("cancels the request when the card closes; the next open starts again", async () => {
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
    await vi.waitFor(() => expect(received).toBeDefined());
    expect(service.cancel({ relationId: ids.relation })).toBe(true);
    await expect(pending).rejects.toThrow("canceled");
    expect(received?.aborted).toBe(true);
    expect(service.cancel({ relationId: ids.relation })).toBe(false);
    expect((await service.explain({ relationId: ids.relation }))?.text).toContain("qualifies");
  });

  it("rewrites an explanation cached in another content language, and stores the new one", async () => {
    repository.readContext.mockResolvedValue(
      context({
        stored: {
          text: "Cached in English.",
          inputHash: relationExplanationPlan({ ...context(), language: "en" }).inputHash,
          model: "earlier-model",
          writtenAt
        }
      })
    );
    const { service, runDefaultTask } = setup();
    const result = await service.explain({ relationId: ids.relation });
    expect(result?.text).toContain("qualifies");
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "pt-BR",
        inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash
      })
    );
    // The same cached text counts again where it was written: English reads it without AI.
    const english = setup(undefined, async () => "en");
    expect((await english.service.explain({ relationId: ids.relation }))?.text).toBe(
      "Cached in English."
    );
    expect(english.runDefaultTask).not.toHaveBeenCalled();
  });

  it("asks the audit for the sources that exist: a deleted home source is not linked", async () => {
    repository.readContext.mockResolvedValue(
      context({ a: { ...context().a, homeSourceId: null } })
    );
    const { service, runDefaultTask } = setup(["n1 and n2 agree.", "n1 and n2 agree."]);
    await service.explain({ relationId: ids.relation });
    expect(runDefaultTask.mock.calls[0]![2]).toMatchObject({ sourceItemIds: [ids.sourceB] });
    repository.readContext.mockResolvedValue(
      context({
        a: { ...context().a, homeSourceId: null },
        b: { ...context().b, homeSourceId: null }
      })
    );
    await service.explain({ relationId: ids.relation });
    expect(runDefaultTask.mock.calls[1]![2]).toMatchObject({ sourceItemIds: [] });
  });

  it("keeps content tokens like N400 and repairs an answer too long once its references are stored", async () => {
    const content = setup(["n1 reports the N400 effect that n2 extends."]);
    const result = await content.service.explain({ relationId: ids.relation });
    expect(content.runDefaultTask).toHaveBeenCalledTimes(1);
    expect(result?.text).toBe(
      `<note-ref id="${ids.b}" /> reports the N400 effect that <note-ref id="${ids.a}" /> extends.`
    );
    // 299 characters of aliases pass the model's limit and expand past the 4000 of the column.
    const long = setup([Array(100).fill("n1").join(" "), "n1 and n2 agree."]);
    expect((await long.service.explain({ relationId: ids.relation }))?.text).toContain("agree");
    expect(long.runDefaultTask).toHaveBeenCalledTimes(2);
    const text = repository.save.mock.calls.at(-1)![0].text as string;
    expect(text.length).toBeLessThanOrEqual(relationExplanationLimits.storedCharacters);
    const never = setup([Array(100).fill("n1").join(" "), Array(100).fill("n2").join(" ")]);
    repository.save.mockClear();
    await expect(never.service.explain({ relationId: ids.relation })).rejects.toThrow(
      "notePage.explain.errors.invalid"
    );
    expect(repository.save).not.toHaveBeenCalled();
  });

  describe("the active deadline", () => {
    afterEach(() => vi.useRealTimers());

    /** A model call that waits for its signal, as a provider call does. */
    const hang = (seen: { signal?: AbortSignal }) =>
      ((...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          const signal = args[3] as AbortSignal;
          seen.signal = signal;
          signal.addEventListener("abort", () => reject(signal.reason));
        })) as never;

    it("runs the model under an active deadline: the queue pauses the clock, then the time is up", async () => {
      vi.useFakeTimers();
      const { service, runDefaultTask } = setup();
      const seen: { signal?: AbortSignal } = {};
      runDefaultTask.mockImplementationOnce(hang(seen));
      const pending = service.explain({ relationId: ids.relation });
      const outcome = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(1);
      // The raw controller signal would have no deadline: the queue could not stop the clock.
      const deadline = ActiveDeadline.of(seen.signal);
      expect(deadline).toBeInstanceOf(ActiveDeadline);
      deadline!.pause();
      await vi.advanceTimersByTimeAsync(relationExplanationLimits.timeoutMs * 2);
      expect(seen.signal?.aborted).toBe(false);
      deadline!.resume();
      await vi.advanceTimersByTimeAsync(relationExplanationLimits.timeoutMs - 1_000);
      expect(seen.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1_001);
      await outcome;
      expect(seen.signal?.aborted).toBe(true);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("shares one deadline between the first call and the repair, and clears its timer", async () => {
      vi.useFakeTimers();
      const { service, runDefaultTask } = setup();
      const seen: { signal?: AbortSignal } = {};
      let answerFirst!: () => void;
      runDefaultTask.mockImplementationOnce(
        (() =>
          new Promise((resolve) => {
            answerFirst = () => resolve(execution("n1 supports <b>n2</b>."));
          })) as never
      );
      runDefaultTask.mockImplementationOnce(hang(seen));
      const pending = service.explain({ relationId: ids.relation });
      const outcome = expect(pending).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(relationExplanationLimits.timeoutMs - 1_000);
      answerFirst();
      await vi.advanceTimersByTimeAsync(1);
      // The repair runs under the deadline of the first call: about a second of the 120 is left.
      const first = ActiveDeadline.of(runDefaultTask.mock.calls[0]![3] as AbortSignal);
      expect(first).toBeInstanceOf(ActiveDeadline);
      expect(ActiveDeadline.of(seen.signal)).toBe(first);
      await vi.advanceTimersByTimeAsync(990);
      expect(seen.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      await outcome;
      expect(repository.save).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("releases the deadline timer once the explanation is stored", async () => {
      vi.useFakeTimers();
      const { service } = setup();
      await service.explain({ relationId: ids.relation });
      expect(repository.save).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("cancels during the repair call: nothing is stored and both calls shared the signal", async () => {
    const { service, runDefaultTask } = setup();
    const seen: { signal?: AbortSignal } = {};
    runDefaultTask.mockResolvedValueOnce(execution("n1 supports <b>n2</b>.") as never);
    runDefaultTask.mockImplementationOnce(
      ((...args: unknown[]) =>
        new Promise((_resolve, reject) => {
          seen.signal = args[3] as AbortSignal;
          seen.signal.addEventListener("abort", () => reject(seen.signal!.reason));
        })) as never
    );
    const pending = service.explain({ relationId: ids.relation });
    const outcome = expect(pending).rejects.toThrow("canceled");
    await vi.waitFor(() => expect(seen.signal).toBeDefined());
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    expect(runDefaultTask.mock.calls[1]![2]).toMatchObject({ attempt: 1 });
    expect(runDefaultTask.mock.calls[0]![3]).toBe(seen.signal);
    expect(service.cancel({ relationId: ids.relation })).toBe(true);
    await outcome;
    expect(seen.signal?.aborted).toBe(true);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("stores nothing when the card closes after the model answered, before the save", async () => {
    const { service, runDefaultTask } = setup();
    runDefaultTask.mockImplementationOnce((async () => {
      service.cancel({ relationId: ids.relation });
      return execution("n1 and n2 agree.");
    }) as never);
    await expect(service.explain({ relationId: ids.relation })).rejects.toThrow("canceled");
    expect(repository.save).not.toHaveBeenCalled();
    // The next open starts again and stores.
    expect((await service.explain({ relationId: ids.relation }))?.text).toContain("qualifies");
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("never calls the model for a card closed while the context was being read", async () => {
    let release!: (language: string) => void;
    const { service, runDefaultTask } = setup(
      undefined,
      () => new Promise<string>((resolve) => (release = resolve))
    );
    const pending = service.explain({ relationId: ids.relation });
    const outcome = expect(pending).rejects.toThrow("canceled");
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(service.cancel({ relationId: ids.relation })).toBe(true);
    release("pt-BR");
    await outcome;
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("refuses malformed requests and an unavailable database", async () => {
    const { service } = setup();
    expect(() => service.explain({ relationId: "nope" })).toThrow();
    expect(() => service.cancel({})).toThrow();
    const offline = new RelationExplanationService({
      getPool: () => null,
      ai: { runDefaultTask: vi.fn() } as never,
      getContentLanguage: async () => "en"
    });
    await expect(offline.explain({ relationId: ids.relation })).rejects.toThrow(
      "objects.errors.unavailable"
    );
  });
});

describe("relation explanation IPC registration", () => {
  it("handles explain and cancel, validating the payload before the service", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const service = { explain: vi.fn(async () => null), cancel: vi.fn(() => true) };
    registerRelationExplanationIpc(ipc as unknown as IpcMain, service as never);
    const explain = handlers.get(ipcChannels.relationsExplain)!;
    const cancel = handlers.get(ipcChannels.relationsCancelExplain)!;
    expect(() => explain({}, { relationId: "x" })).toThrow();
    expect(() => cancel({}, {})).toThrow();
    expect(service.explain).not.toHaveBeenCalled();
    await explain({}, { relationId: ids.relation });
    expect(service.explain).toHaveBeenCalledWith({ relationId: ids.relation });
    expect(cancel({}, { relationId: ids.relation })).toBe(true);
  });
});
