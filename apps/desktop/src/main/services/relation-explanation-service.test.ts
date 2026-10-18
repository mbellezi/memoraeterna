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

/** The text of an explanation; the test fails for a veto or nothing. */
const textOf = (outcome: unknown): string => {
  if (typeof outcome !== "object" || outcome === null || !("text" in outcome))
    throw new Error("The relation was not explained.");
  return String(outcome.text);
};

const context = (
  overrides: Partial<RelationExplanationContext> = {}
): RelationExplanationContext => ({
  relationId: ids.relation,
  type: "supports",
  status: "pending_review",
  semanticSourceId: ids.b,
  listed: true,
  vetoable: true,
  withdrawn: false,
  vetoSource: null,
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
      priority: "P0",
      workloadClass: "write-fast",
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
    expect(textOf(await service.explain({ relationId: ids.relation }))).toContain("qualifies");
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("repairs invalid output once, then fails visibly", async () => {
    const repaired = setup(["n1 supports <b>n2</b>.", "n1 and n2 agree."]);
    expect(textOf(await repaired.service.explain({ relationId: ids.relation }))).toContain("agree");
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
    expect(textOf(await service.explain({ relationId: ids.relation }))).toContain("qualifies");
  });

  describe("cancelling by request", () => {
    const requestA = "00000000-0000-4000-8000-0000000000a1";
    const requestB = "00000000-0000-4000-8000-0000000000b1";

    /** A model call that waits for its signal or for `finish`. */
    const pending = () => {
      const call: { finish?: (value: unknown) => void; signal?: AbortSignal } = {};
      const hold = ((...args: unknown[]) =>
        new Promise((resolve, reject) => {
          call.finish = resolve;
          call.signal = args[3] as AbortSignal;
          call.signal.addEventListener("abort", () => reject(call.signal!.reason));
        })) as never;
      return { call, hold };
    };

    it("stops only the card that closed while another card waits for the same request", async () => {
      const { service, runDefaultTask } = setup();
      const { call, hold } = pending();
      runDefaultTask.mockImplementationOnce(hold);
      const texts: string[] = [];
      const first = service.explain({ relationId: ids.relation, requestId: requestA }, (text) =>
        texts.push(`a:${text}`)
      );
      const second = service.explain({ relationId: ids.relation, requestId: requestB }, (text) =>
        texts.push(`b:${text}`)
      );
      expect(second).toBe(first);
      await vi.waitFor(() => expect(call.signal).toBeDefined());
      expect(service.cancel({ relationId: ids.relation, requestId: requestA })).toBe(true);
      // The request goes on for the card that is still waiting, and A hears nothing more of it.
      expect(call.signal!.aborted).toBe(false);
      call.finish!(execution("n1 and n2 agree."));
      expect(textOf(await second)).toContain("agree");
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
      expect(texts.every((text) => !text.startsWith("a:"))).toBe(true);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it("aborts the request when the last card closes, and ignores a request that is not waiting", async () => {
      const { service, runDefaultTask } = setup();
      const { call, hold } = pending();
      runDefaultTask.mockImplementationOnce(hold);
      const first = service.explain({ relationId: ids.relation, requestId: requestA });
      const outcome = expect(first).rejects.toThrow("canceled");
      service.explain({ relationId: ids.relation, requestId: requestB }).catch(() => undefined);
      await vi.waitFor(() => expect(call.signal).toBeDefined());
      // A request the service does not know cancels nothing, not even a request that is running.
      expect(
        service.cancel({
          relationId: ids.relation,
          requestId: "00000000-0000-4000-8000-0000000000c1"
        })
      ).toBe(false);
      expect(call.signal!.aborted).toBe(false);
      expect(service.cancel({ relationId: ids.relation, requestId: requestA })).toBe(true);
      expect(call.signal!.aborted).toBe(false);
      expect(service.cancel({ relationId: ids.relation, requestId: requestB })).toBe(true);
      await outcome;
      expect(call.signal!.aborted).toBe(true);
      expect(service.cancel({ relationId: ids.relation, requestId: requestB })).toBe(false);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("lets a cancel without a request stop the request for every card", async () => {
      const { service, runDefaultTask } = setup();
      const { call, hold } = pending();
      runDefaultTask.mockImplementationOnce(hold);
      const first = service.explain({ relationId: ids.relation, requestId: requestA });
      const outcome = expect(first).rejects.toThrow("canceled");
      service.explain({ relationId: ids.relation }).catch(() => undefined);
      await vi.waitFor(() => expect(call.signal).toBeDefined());
      expect(service.cancel({ relationId: ids.relation })).toBe(true);
      await outcome;
      expect(call.signal!.aborted).toBe(true);
    });
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
    expect(textOf(result)).toContain("qualifies");
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        language: "pt-BR",
        inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash
      })
    );
    // The same cached text counts again where it was written: English reads it without AI.
    const english = setup(undefined, async () => "en");
    expect(textOf(await english.service.explain({ relationId: ids.relation }))).toBe(
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
    expect(textOf(result)).toBe(
      `<note-ref id="${ids.b}" /> reports the N400 effect that <note-ref id="${ids.a}" /> extends.`
    );
    // 299 characters of aliases pass the model's limit and expand past the 4000 of the column.
    const long = setup([Array(100).fill("n1").join(" "), "n1 and n2 agree."]);
    expect(textOf(await long.service.explain({ relationId: ids.relation }))).toContain("agree");
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
    expect(textOf(await service.explain({ relationId: ids.relation }))).toContain("qualifies");
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
    // Without a request ID there is nobody to stream to.
    expect(service.explain).toHaveBeenCalledWith({ relationId: ids.relation }, undefined);
    expect(cancel({}, { relationId: ids.relation })).toBe(true);
  });

  it("streams the text to the window that asked, on the delta channel, for the request's ID", async () => {
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    const ipc = { handle: (channel: string, handler: never) => handlers.set(channel, handler) };
    const sent: Array<[string, unknown]> = [];
    const sender = {
      isDestroyed: () => false,
      send: (...args: [string, unknown]) => sent.push(args)
    };
    const service = {
      explain: vi.fn(async (_input: unknown, onText?: (text: string) => void) => {
        onText?.("The first note");
        return null;
      })
    };
    registerRelationExplanationIpc(ipc as unknown as IpcMain, service as never);
    const requestId = "00000000-0000-4000-8000-0000000000c1";
    await handlers.get(ipcChannels.relationsExplain)!(
      { sender },
      { relationId: ids.relation, requestId }
    );
    expect(sent).toEqual([
      [
        ipcChannels.relationExplanationDelta,
        { requestId, relationId: ids.relation, text: "The first note" }
      ]
    ]);
    // A window that was destroyed meanwhile receives nothing, and nothing throws.
    sent.length = 0;
    sender.isDestroyed = () => true;
    await handlers.get(ipcChannels.relationsExplain)!(
      { sender },
      { relationId: ids.relation, requestId }
    );
    expect(sent).toEqual([]);
  });
});

describe("streamed explanations and the NOT_RELATED veto", () => {
  type Delta = { kind: "text"; delta: string; restart?: boolean };
  type Streaming = (...args: unknown[]) => Promise<ReturnType<typeof execution> | null>;

  /** A clock that moves 100 ms on every reading, so each piece of text leaves at once. */
  const stepClock = () => {
    let now = 0;
    return {
      now: () => (now += 100),
      setTimeout: () => null,
      clearTimeout: () => undefined
    };
  };

  const build = (
    run: (
      deliver: (...pieces: string[]) => void,
      call: number,
      signal: AbortSignal
    ) => Promise<unknown> | unknown,
    extra: Partial<ConstructorParameters<typeof RelationExplanationService>[0]> = {}
  ) => {
    const texts: string[] = [];
    let calls = 0;
    const runDefaultTask = vi.fn<Streaming>(async (...args: unknown[]) => {
      const logContext = args[2] as { onTextDelta?: (event: Delta) => void };
      const call = calls++;
      const output = await run(
        (...pieces) => pieces.forEach((delta) => logContext.onTextDelta?.({ kind: "text", delta })),
        call,
        args[3] as AbortSignal
      );
      return output === null ? null : execution(output);
    });
    const withdraw = vi.fn(async () => ({ noteIds: [ids.a, ids.b] }));
    const relationsChanged = vi.fn();
    const service = new RelationExplanationService({
      getPool: () => ({}) as PgPool,
      ai: { runDefaultTask } as never,
      getContentLanguage: async () => "pt-BR",
      clock: stepClock(),
      withdraw,
      relationsChanged,
      ...extra
    });
    return {
      service,
      runDefaultTask,
      texts,
      withdraw,
      relationsChanged,
      explain: () => service.explain({ relationId: ids.relation }, (text) => texts.push(text))
    };
  };
  const ref = (id: string) => `<note-ref id="${id}" />`;

  it("shows the text as it is written, with every alias a reference, then returns the validated text", async () => {
    const answer = "Retrieval cues the n1 idea that n2 extends it, with feedback.";
    const { explain, texts } = build((deliver) => {
      deliver("Retrieval c", "ues the n", "1 idea that n", "2 extends", " it, with feedback.");
      return answer;
    });
    const result = await explain();
    // The decided subject (b) is n1.
    const final = `Retrieval cues the ${ref(ids.b)} idea that ${ref(ids.a)} extends it, with feedback.`;
    expect(textOf(result)).toBe(final);
    expect(texts.length).toBeGreaterThan(2);
    // Every piece extends the one before, and none shows an alias, half of one or a half tag.
    texts.forEach((text, index) => {
      if (index > 0) expect(text.startsWith(texts[index - 1]!)).toBe(true);
      expect(text).not.toMatch(/(?<![\p{L}\p{N}_])n[12]?$/u);
      expect(text.split("<note-ref").length).toBe(text.split("/>").length);
    });
    expect(texts.at(-1)).toBe(final);
  });

  it("holds an alias split across pieces until it resolves, and shows content that only looks like one", async () => {
    const { explain, texts } = build((deliver) => {
      deliver(
        "Both notes agree that n",
        "1 and n",
        "2 describe it, while the N400 and n",
        "12 differ."
      );
      return "Both notes agree that n1 and n2 describe it, while the N400 and n12 differ.";
    });
    await explain();
    // The half-written alias waits: it is neither shown as "n" nor lost.
    expect(texts.slice(0, 2)).toEqual([
      "Both notes agree that ",
      `Both notes agree that ${ref(ids.b)} and `
    ]);
    expect(texts.every((text) => !/\bn[12]?$/u.test(text))).toBe(true);
    expect(texts.at(-1)).toContain("the N400 and n12 differ.");
  });

  it("buffers the first 16 characters and shows nothing before then", async () => {
    const short = build((deliver) => {
      deliver("n1 ech", "oes n2.");
      return "n1 echoes n2.";
    });
    expect(textOf(await short.explain())).toBe(`${ref(ids.b)} echoes ${ref(ids.a)}.`);
    expect(short.texts).toEqual([]);
    const long = build((deliver) => {
      deliver("Both notes", " say it", " twice.");
      return "Both notes say it twice.";
    });
    await long.explain();
    // 10 characters, then 17: the first piece to show is the second.
    expect(long.texts[0]).toBe("Both notes say it");
  });

  it("answers the veto for a NOT_RELATED answer, shows none of it and writes an event", async () => {
    const { explain, texts, withdraw, relationsChanged } = build((deliver) => {
      deliver("NOT_", "RELATED");
      return "NOT_RELATED";
    });
    expect(await explain()).toEqual({ relationId: ids.relation, vetoed: true });
    expect(texts).toEqual([]);
    // The home sources of both notes, for the promotion of the source relations built from it.
    expect(withdraw).toHaveBeenCalledWith(expect.anything(), ids.relation, [
      ids.sourceA,
      ids.sourceB
    ]);
    expect(relationsChanged).toHaveBeenCalledWith([ids.a, ids.b]);
    // The verdict is cached under the key of the inputs, as the sentinel and never as text; the
    // relation is withdrawn after it is cached.
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith({
      relationId: ids.relation,
      text: "NOT_RELATED",
      inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash,
      promptVersion: relationExplanationPromptVersion,
      provider: "openai-codex",
      model: "writer-model",
      runtime: "remote",
      aiTaskRunId: ids.run,
      language: "pt-BR"
    });
    expect(repository.save.mock.invocationCallOrder[0]!).toBeLessThan(
      withdraw.mock.invocationCallOrder[0]!
    );
  });

  it("never shows an answer that begins with the sentinel, and repairs it", async () => {
    const { explain, texts, runDefaultTask, withdraw } = build((deliver, call) => {
      if (call > 0) return "n1 and n2 agree.";
      deliver("NOT_RELATED because", " the two notes only share a word.");
      return "NOT_RELATED because the two notes only share a word.";
    });
    expect(textOf(await explain())).toContain("agree");
    expect(texts).toEqual([]);
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("recognizes the sentinel through quotes and a full stop, and takes it from the repair too", async () => {
    const quoted = build(() => '"NOT_RELATED".');
    expect(await quoted.explain()).toEqual({ relationId: ids.relation, vetoed: true });
    const repaired = build((_deliver, call) => (call === 0 ? "n1 <b>n2</b>" : " not_related "));
    expect(await repaired.explain()).toEqual({ relationId: ids.relation, vetoed: true });
    expect(repaired.runDefaultTask).toHaveBeenCalledTimes(2);
    // Only the verdict is cached, never the sentinel as an explanation of anything else.
    expect(repository.save.mock.calls.map(([saved]) => saved.text)).toEqual([
      "NOT_RELATED",
      "NOT_RELATED"
    ]);
  });

  it("takes the sentinel in other spellings as the verdict, and sends a translated one to the repair", async () => {
    for (const answer of ["NOT RELATED", "Not related.", "not-related"]) {
      repository.save.mockClear();
      const spelled = build(() => answer);
      expect(await spelled.explain(), answer).toEqual({ relationId: ids.relation, vetoed: true });
      expect(spelled.runDefaultTask).toHaveBeenCalledTimes(1);
      expect(repository.save.mock.calls.map(([saved]) => saved.text)).toEqual(["NOT_RELATED"]);
    }
    // A translated answer is no explanation and no verdict: the repair asks again, and a writer
    // that now answers the sentinel withdraws the relation; one that explains is cached as text.
    for (const translated of ["Não relacionado.", "No relacionado", "Non lié."]) {
      repository.save.mockClear();
      const repaired = build((_deliver, call) => (call === 0 ? translated : "NOT_RELATED"));
      expect(await repaired.explain(), translated).toEqual({
        relationId: ids.relation,
        vetoed: true
      });
      expect(repaired.runDefaultTask).toHaveBeenCalledTimes(2);
      expect(repository.save.mock.calls.map(([saved]) => saved.text)).toEqual(["NOT_RELATED"]);
    }
    repository.save.mockClear();
    const failing = build(() => "Não relacionado.");
    await expect(failing.explain()).rejects.toThrow("notePage.explain.errors.invalid");
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("replaces a streamed text that fails validation with the repair, which is not streamed", async () => {
    const { explain, texts, runDefaultTask } = build((deliver, call) => {
      if (call > 0) return "n1 and n2 agree.";
      deliver("The first note supports ", "<b>the second</b>.");
      return "The first note supports <b>the second</b>.";
    });
    const result = await explain();
    expect(textOf(result)).toBe(`${ref(ids.b)} and ${ref(ids.a)} agree.`);
    // The preview stops before the tag, goes back to writing when it is refused, and is replaced.
    expect(texts).toEqual(["The first note supports ", ""]);
    expect(runDefaultTask.mock.calls[0]![2]).toHaveProperty("onTextDelta");
    expect(runDefaultTask.mock.calls[1]![2]).not.toHaveProperty("onTextDelta");
    expect(repository.save).toHaveBeenCalledTimes(1);
  });

  it("starts the preview again when a retried attempt restarts the answer", async () => {
    const texts: string[] = [];
    const runDefaultTask = vi.fn<Streaming>(async (...args: unknown[]) => {
      const logContext = args[2] as { onTextDelta: (event: Delta) => void };
      logContext.onTextDelta({ kind: "text", delta: "The first attempt wr" });
      logContext.onTextDelta({
        kind: "text",
        delta: "The second attempt writes it ",
        restart: true
      });
      logContext.onTextDelta({ kind: "text", delta: "again." });
      return execution("The second attempt writes it again.");
    });
    const service = new RelationExplanationService({
      getPool: () => ({}) as PgPool,
      ai: { runDefaultTask } as never,
      getContentLanguage: async () => "pt-BR",
      clock: stepClock()
    });
    await service.explain({ relationId: ids.relation }, (text) => texts.push(text));
    expect(texts).toEqual([
      "The first attempt wr",
      "The second attempt writes it ",
      "The second attempt writes it again."
    ]);
  });

  it("sends at most one message per 50 ms and the last text after the window", async () => {
    vi.useFakeTimers();
    try {
      const texts: string[] = [];
      let deliver!: (delta: string) => void;
      let finish!: () => void;
      const runDefaultTask = vi.fn<Streaming>(async (...args: unknown[]) => {
        const logContext = args[2] as { onTextDelta: (event: Delta) => void };
        deliver = (delta) => logContext.onTextDelta({ kind: "text", delta });
        await new Promise<void>((resolve) => (finish = resolve));
        return execution("A sentence that is being written");
      });
      const service = new RelationExplanationService({
        getPool: () => ({}) as PgPool,
        ai: { runDefaultTask } as never,
        getContentLanguage: async () => "pt-BR"
      });
      const pending = service.explain({ relationId: ids.relation }, (text) => texts.push(text));
      await vi.advanceTimersByTimeAsync(0);
      // The first text leaves at once; the pieces inside the window wait for it to close.
      deliver("A sentence that is");
      expect(texts).toEqual(["A sentence that is"]);
      await vi.advanceTimersByTimeAsync(10);
      deliver(" being");
      await vi.advanceTimersByTimeAsync(10);
      deliver(" written");
      expect(texts).toEqual(["A sentence that is"]);
      await vi.advanceTimersByTimeAsync(40);
      expect(texts).toEqual(["A sentence that is", "A sentence that is being written"]);
      finish();
      await pending;
      // The timer is released with the request.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes no call and streams nothing for a cached explanation", async () => {
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
    const { explain, texts, runDefaultTask } = build(() => "n1 and n2 agree.");
    expect(textOf(await explain())).toBe("Cached.");
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(texts).toEqual([]);
  });

  it("serves a second card of the same relation from the request in flight", async () => {
    let finish!: () => void;
    const first: string[] = [];
    const second: string[] = [];
    const { service, runDefaultTask } = build(async (deliver) => {
      deliver("The first note ", "supports the second");
      await new Promise<void>((resolve) => (finish = resolve));
      return "n1 supports n2";
    });
    const one = service.explain({ relationId: ids.relation }, (text) => first.push(text));
    await vi.waitFor(() => expect(first.length).toBeGreaterThan(0));
    // The joining card sees the text so far at once, and the same final result.
    const two = service.explain({ relationId: ids.relation }, (text) => second.push(text));
    expect(second).toEqual([first.at(-1)]);
    finish();
    expect(await two).toEqual(await one);
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
  });

  it("caches nothing and stops the preview when the card closes mid-stream", async () => {
    const texts: string[] = [];
    let late!: (...pieces: string[]) => void;
    const { service } = build(
      (deliver, _call, signal) =>
        new Promise((_resolve, reject) => {
          deliver("The first note supports ");
          late = deliver;
          signal.addEventListener("abort", () => reject(signal.reason));
        })
    );
    const pending = service.explain({ relationId: ids.relation }, (text) => texts.push(text));
    const outcome = expect(pending).rejects.toThrow("canceled");
    await vi.waitFor(() => expect(texts).toEqual(["The first note supports "]));
    expect(service.cancel({ relationId: ids.relation })).toBe(true);
    late("and the rest of the sentence.");
    await outcome;
    expect(texts).toEqual(["The first note supports "]);
    expect(repository.save).not.toHaveBeenCalled();
  });

  it("leaves a relation with a human verdict alone: nothing is withdrawn, the verdict is cached", async () => {
    repository.readContext.mockResolvedValue(context({ vetoable: false, status: "accepted" }));
    const { explain, withdraw, relationsChanged } = build(() => "NOT_RELATED");
    // Neither a veto nor an explanation: the card says no explanation is available.
    expect(await explain()).toEqual({ relationId: ids.relation, unrelated: true });
    expect(withdraw).not.toHaveBeenCalled();
    expect(relationsChanged).not.toHaveBeenCalled();
    expect(repository.save).toHaveBeenCalledTimes(1);
    expect(repository.save).toHaveBeenCalledWith(
      expect.objectContaining({
        relationId: ids.relation,
        text: "NOT_RELATED",
        inputHash: relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash
      })
    );
  });

  describe("the writer's verdict cached under the key", () => {
    const key = relationExplanationPlan({ ...context(), language: "pt-BR" }).inputHash;
    const verdict = (inputHash = key) => ({
      text: "NOT_RELATED",
      inputHash,
      model: "writer-model",
      writtenAt
    });

    it("answers a kept relation again with no call, from a new service as after a restart", async () => {
      // The first open: the writer answers, the verdict is saved...
      repository.readContext.mockResolvedValue(context({ vetoable: false, status: "accepted" }));
      const first = build(() => "NOT_RELATED");
      expect(await first.explain()).toEqual({ relationId: ids.relation, unrelated: true });
      const saved = repository.save.mock.calls[0]![0];
      expect(first.runDefaultTask).toHaveBeenCalledTimes(1);
      // ...and the second open, which reads what was saved, makes no call and writes nothing.
      repository.save.mockClear();
      repository.readContext.mockResolvedValue(
        context({
          vetoable: false,
          status: "accepted",
          stored: { text: saved.text, inputHash: saved.inputHash, model: saved.model, writtenAt }
        })
      );
      for (let open = 0; open < 3; open += 1) {
        const restarted = build(() => "NOT_RELATED");
        expect(await restarted.explain()).toEqual({ relationId: ids.relation, unrelated: true });
        expect(restarted.runDefaultTask).not.toHaveBeenCalled();
        expect(restarted.withdraw).not.toHaveBeenCalled();
        expect(restarted.relationsChanged).not.toHaveBeenCalled();
        expect(restarted.texts).toEqual([]);
      }
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("answers a relation the typer withdrew with the veto again, with no call and no second veto", async () => {
      repository.readContext.mockResolvedValue(
        context({ vetoable: false, withdrawn: true, vetoSource: "typer", stored: verdict() })
      );
      const { explain, runDefaultTask, withdraw, relationsChanged } = build(() => "NOT_RELATED");
      expect(await explain()).toEqual({ relationId: ids.relation, vetoed: true });
      expect(runDefaultTask).not.toHaveBeenCalled();
      expect(withdraw).not.toHaveBeenCalled();
      expect(relationsChanged).not.toHaveBeenCalled();
    });

    it("answers a relation the owner kept while the writer answered as it is now, not as it was withdrawn", async () => {
      // Read withdrawn by the typer when the request started...
      repository.readContext.mockResolvedValueOnce(
        context({ vetoable: false, withdrawn: true, vetoSource: "typer" })
      );
      // ...kept by the owner by the time the writer says NOT_RELATED.
      repository.readContext.mockResolvedValueOnce(
        context({ vetoable: false, withdrawn: false, status: "accepted" })
      );
      const { explain, withdraw, relationsChanged } = build(() => "NOT_RELATED");
      expect(await explain()).toEqual({ relationId: ids.relation, unrelated: true });
      expect(withdraw).not.toHaveBeenCalled();
      expect(relationsChanged).not.toHaveBeenCalled();
      expect(repository.readContext).toHaveBeenCalledTimes(2);
    });

    it("withdraws a relation nobody has decided since, with no call: a verdict cached but not applied", async () => {
      repository.readContext.mockResolvedValue(context({ stored: verdict() }));
      const { explain, runDefaultTask, withdraw, relationsChanged } = build(() => "NOT_RELATED");
      expect(await explain()).toEqual({ relationId: ids.relation, vetoed: true });
      expect(runDefaultTask).not.toHaveBeenCalled();
      expect(withdraw).toHaveBeenCalledTimes(1);
      expect(relationsChanged).toHaveBeenCalledWith([ids.a, ids.b]);
      expect(repository.save).not.toHaveBeenCalled();
    });

    it("asks the writer again once the facts, the language or the writer changed", async () => {
      repository.readContext.mockResolvedValue(
        context({ vetoable: false, status: "accepted", stored: verdict("stale") })
      );
      const facts = build(() => "n1 and n2 agree.");
      expect(textOf(await facts.explain())).toContain("agree");
      expect(facts.runDefaultTask).toHaveBeenCalledTimes(1);
      // The verdict of another content language is not the verdict for this one.
      const english = relationExplanationPlan({ ...context(), language: "en" }).inputHash;
      repository.readContext.mockResolvedValue(
        context({ vetoable: false, status: "accepted", stored: verdict(english) })
      );
      const language = build(() => "n1 and n2 agree.");
      expect(textOf(await language.explain())).toContain("agree");
      expect(language.runDefaultTask).toHaveBeenCalledTimes(1);
      // Nor is the verdict of another model or prompt revision, when the writer is known.
      const writer = { promptRevision: "prompt-3", model: "model-a" };
      const keyOf = (who: typeof writer) =>
        relationExplanationPlan({ ...context(), language: "pt-BR", writer: who }).inputHash;
      repository.readContext.mockResolvedValue(
        context({
          vetoable: false,
          status: "accepted",
          stored: verdict(keyOf({ ...writer, model: "model-b" }))
        })
      );
      const other = build(() => "n1 and n2 agree.", { resolveWriter: async () => writer });
      expect(textOf(await other.explain())).toContain("agree");
      expect(other.runDefaultTask).toHaveBeenCalledTimes(1);
      // The verdict of this very writer is answered with no call.
      repository.readContext.mockResolvedValue(
        context({ vetoable: false, status: "accepted", stored: verdict(keyOf(writer)) })
      );
      const same = build(() => "n1 and n2 agree.", { resolveWriter: async () => writer });
      expect(await same.explain()).toEqual({ relationId: ids.relation, unrelated: true });
      expect(same.runDefaultTask).not.toHaveBeenCalled();
    });

    it("replaces a cached explanation with the verdict, and the verdict with a new explanation", async () => {
      repository.readContext.mockResolvedValue(
        context({
          vetoable: false,
          status: "accepted",
          stored: { text: "Old text.", inputHash: "stale", model: "m", writtenAt }
        })
      );
      const { explain } = build(() => "NOT_RELATED");
      expect(await explain()).toEqual({ relationId: ids.relation, unrelated: true });
      expect(repository.save.mock.calls.map(([saved]) => saved.text)).toEqual(["NOT_RELATED"]);
    });

    it("explains nothing when the relation is gone as the verdict is cached", async () => {
      repository.save.mockResolvedValueOnce(null);
      const { explain, withdraw } = build(() => "NOT_RELATED");
      expect(await explain()).toBeNull();
      expect(withdraw).not.toHaveBeenCalled();
    });
  });

  it("answers the veto again, with no call, for a relation the writer already withdrew", async () => {
    repository.readContext.mockResolvedValue(
      context({ vetoable: false, withdrawn: true, vetoSource: "explainer" })
    );
    const { explain, runDefaultTask, withdraw } = build(() => "n1 and n2 agree.");
    expect(await explain()).toEqual({ relationId: ids.relation, vetoed: true });
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(withdraw).not.toHaveBeenCalled();
  });

  it("explains a relation the typer withdrew, and does not withdraw it twice", async () => {
    repository.readContext.mockResolvedValue(
      context({ vetoable: false, withdrawn: true, vetoSource: "typer" })
    );
    const explained = build(() => "n1 and n2 agree.");
    expect(textOf(await explained.explain())).toContain("agree");
    const unrelated = build(() => "NOT_RELATED");
    expect(await unrelated.explain()).toEqual({ relationId: ids.relation, vetoed: true });
    expect(unrelated.withdraw).not.toHaveBeenCalled();
    // The verdict is cached, so a withdrawn relation listed again asks nobody.
    expect(repository.save.mock.calls.map(([saved]) => saved.text)).toContain("NOT_RELATED");
  });

  it("asks again what the relation is when someone else decided it while the writer answered", async () => {
    const decided = build(() => "NOT_RELATED", { withdraw: async () => null });
    repository.readContext
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(context({ vetoable: false, status: "accepted" }));
    expect(await decided.explain()).toEqual({ relationId: ids.relation, unrelated: true });
    const raced = build(() => "NOT_RELATED", { withdraw: async () => null });
    repository.readContext
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(context({ vetoable: false, withdrawn: true, vetoSource: "typer" }));
    expect(await raced.explain()).toEqual({ relationId: ids.relation, vetoed: true });
    // Removed by the owner meanwhile: there is nothing left to say.
    const removed = build(() => "NOT_RELATED", { withdraw: async () => null });
    repository.readContext
      .mockResolvedValueOnce(context())
      .mockResolvedValueOnce(context({ vetoable: false, status: "rejected", listed: false }));
    expect(await removed.explain()).toBeNull();
  });

  describe("the writer in the cache key", () => {
    const writer = { promptRevision: "prompt-3", model: "model-a" };
    const keyOf = (who: typeof writer) =>
      relationExplanationPlan({ ...context(), language: "pt-BR", writer: who }).inputHash;
    const stored = (inputHash: string) =>
      context({ stored: { text: "Cached.", inputHash, model: "model-a", writtenAt } });

    it("stores the key with the writer, and reuses it with no call only for the same writer", async () => {
      const first = build(() => "n1 and n2 agree.", { resolveWriter: async () => writer });
      await first.explain();
      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ inputHash: keyOf(writer) })
      );
      repository.readContext.mockResolvedValue(stored(keyOf(writer)));
      const same = build(() => "n1 and n2 agree.", { resolveWriter: async () => writer });
      expect(textOf(await same.explain())).toBe("Cached.");
      expect(same.runDefaultTask).not.toHaveBeenCalled();
      for (const other of [
        { ...writer, model: "model-b" },
        { ...writer, promptRevision: "prompt-4" }
      ]) {
        const changed = build(() => "n1 and n2 agree.", { resolveWriter: async () => other });
        expect(textOf(await changed.explain())).toContain("agree");
        expect(changed.runDefaultTask).toHaveBeenCalledTimes(1);
      }
    });

    it("rewrites an explanation of the previous key version, which had no writer", async () => {
      repository.readContext.mockResolvedValue(stored("a".repeat(64)));
      const { explain, runDefaultTask } = build(() => "n1 and n2 agree.", {
        resolveWriter: async () => writer
      });
      await explain();
      expect(runDefaultTask).toHaveBeenCalledTimes(1);
    });

    it("without a writer model returns an explanation of the same facts and otherwise fails visibly", async () => {
      repository.readContext.mockResolvedValue(stored(keyOf(writer)));
      const cached = build(() => "n1 and n2 agree.", { resolveWriter: async () => null });
      // The facts of the stored key are those of a writer-less plan.
      expect(textOf(await cached.explain())).toBe("Cached.");
      expect(cached.runDefaultTask).not.toHaveBeenCalled();
      repository.readContext.mockResolvedValue(context());
      const none = build(() => "n1 and n2 agree.", { resolveWriter: async () => null });
      await expect(none.explain()).rejects.toThrow("errors.ai.noCompatibleModel");
      expect(none.runDefaultTask).not.toHaveBeenCalled();
    });
  });
});
