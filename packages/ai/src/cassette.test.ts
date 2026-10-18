import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AiCassette,
  AiCassetteError,
  AiCassetteMissError,
  AiModelRegistry,
  aiCassetteReplayedUsageKey,
  aiCassetteRequestKey,
  canonicalJson,
  resolveAiCassetteConfig,
  setAiAdapterDecorator,
  type AiModelAdapter,
  type AiModelDescriptor,
  type AiTaskRequest,
  type AiTaskResult
} from "./index.js";

const chunkA = "11111111-1111-4111-8111-111111111111";
const chunkB = "22222222-2222-4222-8222-222222222222";
const chunkC = "33333333-3333-4333-8333-333333333333";
const chunkD = "44444444-4444-4444-8444-444444444444";

const descriptor: AiModelDescriptor = {
  providerId: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  capabilities: ["atomic-note-generation", "structured-output", "streaming"],
  parameterCapabilities: {},
  limits: {},
  requirements: { network: true }
};

function noteRequest(ids: [string, string], overrides: Partial<AiTaskRequest> = {}) {
  return {
    taskType: "atomic-note-generation",
    input: `Extract notes.\n[${ids[0]}]\nFirst chunk.\n\n[${ids[1]}]\nSecond chunk.`,
    modelId: "gpt-test",
    requiredCapabilities: ["atomic-note-generation"],
    parameters: { reasoningLevel: "low", maxTokens: 2000 },
    metadata: { applicationInstruction: "Return JSON only." },
    ...overrides
  } satisfies AiTaskRequest;
}

class FakeAdapter implements AiModelAdapter {
  public calls = 0;
  public loads = 0;
  public constructor(
    private readonly respond: (request: AiTaskRequest) => unknown,
    private readonly description: AiModelDescriptor = descriptor
  ) {}
  public describe() {
    return this.description;
  }
  public canHandle() {
    return true;
  }
  public isLoaded() {
    return false;
  }
  public async ensureLoaded() {
    this.loads += 1;
  }
  public async run(request: AiTaskRequest): Promise<AiTaskResult> {
    this.calls += 1;
    return {
      taskType: request.taskType,
      output: this.respond(request),
      providerId: this.description.providerId,
      modelId: this.description.modelId,
      runtime: this.description.runtime,
      durationMs: 1234,
      inputTokens: 100 + this.calls,
      outputTokens: 20,
      costEstimate: 0.25,
      tokenUsage: { inputTokens: 100 + this.calls, outputTokens: 20, reasoningTokens: 5 }
    };
  }
  public async runStreaming(
    request: AiTaskRequest,
    _signal: AbortSignal | undefined,
    onProgress: (event: { progress: number }) => void
  ): Promise<AiTaskResult> {
    onProgress({ progress: 0.5 });
    return this.run(request);
  }
}

const noLiveCalls = () => {
  throw new Error("the provider must not be called");
};

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-cassette-"));
});
afterEach(async () => {
  setAiAdapterDecorator(null);
  await rm(directory, { recursive: true, force: true });
});

describe("AI cassette configuration", () => {
  const base = { isPackaged: false, baseDirectory: "/repo" };

  it("is off unless a mode is requested", () => {
    expect(resolveAiCassetteConfig({}, base)).toBeNull();
    expect(resolveAiCassetteConfig({ MEMORA_AI_CASSETTE: " off " }, base)).toBeNull();
    expect(
      resolveAiCassetteConfig({ MEMORA_AI_CASSETTE: "off" }, { ...base, isPackaged: true })
    ).toBeNull();
  });

  it("resolves the directory against the repository root", () => {
    expect(
      resolveAiCassetteConfig(
        { MEMORA_AI_CASSETTE: "replay", MEMORA_AI_CASSETTE_DIR: ".cache/golden/cassettes/a" },
        base
      )
    ).toEqual({ mode: "replay", directory: "/repo/.cache/golden/cassettes/a" });
  });

  it("rejects unknown modes and a missing directory", () => {
    expect(() => resolveAiCassetteConfig({ MEMORA_AI_CASSETTE: "replay-live" }, base)).toThrow(
      expect.objectContaining({ code: "invalid_mode" })
    );
    expect(() => resolveAiCassetteConfig({ MEMORA_AI_CASSETTE: "record" }, base)).toThrow(
      expect.objectContaining({ code: "missing_directory" })
    );
  });

  it("keeps cassettes inside the git-ignored .cache folder", () => {
    for (const directory of [
      "/tmp/cassette",
      "../outside",
      ".cache",
      ".cache/../scripts/golden",
      "/repo/.cache-other/a",
      "docs/cassette"
    ])
      expect(
        () =>
          resolveAiCassetteConfig(
            { MEMORA_AI_CASSETTE: "record", MEMORA_AI_CASSETTE_DIR: directory },
            base
          ),
        directory
      ).toThrow(expect.objectContaining({ code: "directory_outside_cache" }));
    expect(
      resolveAiCassetteConfig(
        { MEMORA_AI_CASSETTE: "record", MEMORA_AI_CASSETTE_DIR: "/repo/.cache/golden/a" },
        base
      )
    ).toEqual({ mode: "record", directory: "/repo/.cache/golden/a" });
  });

  it("refuses cassettes in packaged builds", () => {
    for (const mode of ["record", "replay"])
      expect(() =>
        resolveAiCassetteConfig(
          { MEMORA_AI_CASSETTE: mode, MEMORA_AI_CASSETTE_DIR: "/tmp/cassette" },
          { ...base, isPackaged: true }
        )
      ).toThrow(expect.objectContaining({ code: "packaged_build" }));
  });
});

describe("AI cassette keys", () => {
  it("are stable for the same request whatever the key order of its objects", () => {
    const request = noteRequest([chunkA, chunkB]);
    const reordered = {
      metadata: { applicationInstruction: "Return JSON only." },
      parameters: { maxTokens: 2000, reasoningLevel: "low" },
      requiredCapabilities: ["atomic-note-generation"],
      modelId: "gpt-test",
      input: request.input,
      taskType: "atomic-note-generation"
    } satisfies AiTaskRequest;
    const key = aiCassetteRequestKey(descriptor, request);
    expect(key.key).toMatch(/^[0-9a-f]{64}$/);
    expect(aiCassetteRequestKey(descriptor, reordered).key).toBe(key.key);
    expect(aiCassetteRequestKey(descriptor, request).key).toBe(key.key);
  });

  it("replace database IDs by their position so new IDs keep the key", () => {
    const first = aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkB]));
    const second = aiCassetteRequestKey(descriptor, noteRequest([chunkC, chunkD]));
    expect(second.key).toBe(first.key);
    expect(first.ids).toEqual([chunkA, chunkB]);
    expect(second.ids).toEqual([chunkC, chunkD]);
    expect(first.canonical).not.toContain(chunkA);
    // The same ID twice is a different request shape from two distinct IDs.
    expect(aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkA])).key).not.toBe(first.key);
  });

  it("change with the model identity, parameters, input, instruction or schema", () => {
    const base = aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkB])).key;
    const variants = [
      aiCassetteRequestKey(
        { ...descriptor, modelId: "gpt-other" },
        noteRequest([chunkA, chunkB], { modelId: "gpt-other" })
      ),
      aiCassetteRequestKey(
        { ...descriptor, requirements: { revision: "abc" } },
        noteRequest([chunkA, chunkB])
      ),
      aiCassetteRequestKey(
        descriptor,
        noteRequest([chunkA, chunkB], { parameters: { reasoningLevel: "high", maxTokens: 2000 } })
      ),
      aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkB], { input: "Other input" })),
      aiCassetteRequestKey(
        descriptor,
        noteRequest([chunkA, chunkB], { metadata: { applicationInstruction: "Be brief." } })
      ),
      aiCassetteRequestKey(
        descriptor,
        noteRequest([chunkA, chunkB], {
          metadata: {
            applicationInstruction: "Return JSON only.",
            outputSchema: { type: "object" }
          }
        })
      ),
      aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkB], { taskType: "summarization" }))
    ].map((variant) => variant.key);
    expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
  });

  it("ignore the profile, required capabilities, purpose metadata and local paths", () => {
    const local: AiModelDescriptor = {
      ...descriptor,
      providerId: "local-gguf",
      runtime: "local",
      requirements: { adapter: "node-llama-cpp", modelPath: "/Users/a/model.gguf" }
    };
    const request = noteRequest([chunkA, chunkB]);
    const key = aiCassetteRequestKey(local, request).key;
    expect(
      aiCassetteRequestKey(
        { ...local, requirements: { adapter: "node-llama-cpp", modelPath: "/other/model.gguf" } },
        {
          ...request,
          profileId: chunkC,
          requiredCapabilities: [],
          metadata: { ...request.metadata, purpose: "local-model-test" }
        }
      ).key
    ).toBe(key);
  });

  it("serialize canonically and refuse values JSON cannot represent", () => {
    expect(canonicalJson({ b: [1, "x", null], a: { d: true, c: undefined } })).toBe(
      '{"a":{"d":true},"b":[1,"x",null]}'
    );
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(AiCassetteError);
  });
});

describe("AI cassette record and replay", () => {
  it("records a call and replays it offline with the recorded usage, mapped to new IDs", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    const live = new FakeAdapter((request) =>
      JSON.stringify({
        notes: [
          { title: "Note", evidenceChunkIds: [/[0-9a-f-]{36}/.exec(String(request.input))![0]] }
        ]
      })
    );
    const recorded = await recorder.wrap(live).run(noteRequest([chunkA, chunkB]));
    expect(live.calls).toBe(1);
    expect(recorded.output).toContain(chunkA);
    expect(recorder.stats()).toMatchObject({ recorded: 1, served: 0, misses: 0 });

    const entries = await readdir(join(directory, "entries"), { recursive: true });
    const entryFile = entries.find((name) => name.endsWith(".json"))!;
    const stored = await readFile(join(directory, "entries", entryFile), "utf8");
    expect(stored).not.toContain(chunkA);

    const replayer = new AiCassette({ mode: "replay", directory });
    const offline = new FakeAdapter(noLiveCalls);
    const replayed = await replayer.wrap(offline).run(noteRequest([chunkC, chunkD]));
    expect(offline.calls).toBe(0);
    expect(replayed.output).toBe(
      JSON.stringify({ notes: [{ title: "Note", evidenceChunkIds: [chunkC] }] })
    );
    expect(replayed).toMatchObject({
      providerId: "openai-codex",
      modelId: "gpt-test",
      runtime: "remote",
      inputTokens: 101,
      outputTokens: 20
    });
    expect(replayed.tokenUsage).toEqual({
      inputTokens: 101,
      outputTokens: 20,
      reasoningTokens: 5,
      [aiCassetteReplayedUsageKey]: 1
    });
    expect(replayed.durationMs).toBeLessThan(1234);
    // The recorded cost stays in the cassette; a replay spends nothing, so it reports no cost.
    expect(replayed.costEstimate).toBeUndefined();
    expect(JSON.parse(stored).responses[0].costEstimate).toBe(0.25);
    expect(replayer.stats()).toMatchObject({
      mode: "replay",
      served: 1,
      byTask: { "atomic-note-generation": { served: 1, recorded: 0, misses: 0 } }
    });
  });

  it("replays repeated identical calls in recorded order and misses beyond them", async () => {
    let answer = 0;
    const recorder = new AiCassette({ mode: "record", directory });
    const live = recorder.wrap(new FakeAdapter(() => `answer ${++answer}`));
    const request = noteRequest([chunkA, chunkB]);
    expect((await live.run(request)).output).toBe("answer 1");
    expect((await live.run(request)).output).toBe("answer 2");

    const replay = new AiCassette({ mode: "replay", directory }).wrap(new FakeAdapter(noLiveCalls));
    expect((await replay.run(request)).output).toBe("answer 1");
    expect((await replay.run(request)).output).toBe("answer 2");
    await expect(replay.run(request)).rejects.toBeInstanceOf(AiCassetteMissError);
  });

  it("serves already recorded calls when recording resumes, calling only new ones", async () => {
    const first = new AiCassette({ mode: "record", directory });
    await first.wrap(new FakeAdapter(() => "kept")).run(noteRequest([chunkA, chunkB]));

    const resumed = new AiCassette({ mode: "record", directory });
    const live = new FakeAdapter(() => "fresh");
    const adapter = resumed.wrap(live);
    expect((await adapter.run(noteRequest([chunkC, chunkD]))).output).toBe("kept");
    expect((await adapter.run(noteRequest([chunkA, chunkB], { input: "new" }))).output).toBe(
      "fresh"
    );
    expect(live.calls).toBe(1);
    expect(resumed.stats()).toMatchObject({ served: 1, recorded: 1 });
  });

  it("fails loudly on a replay miss, never calls the provider and saves the request", async () => {
    new AiCassette({ mode: "record", directory });
    const cassette = new AiCassette({ mode: "replay", directory });
    const offline = new FakeAdapter(noLiveCalls);
    const error = await cassette
      .wrap(offline)
      .run(noteRequest([chunkA, chunkB]))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiCassetteMissError);
    expect(offline.calls).toBe(0);
    const miss = error as AiCassetteMissError;
    expect(miss.message).toContain("atomic-note-generation");
    const saved = JSON.parse(await readFile(miss.requestPath, "utf8"));
    expect(saved).toMatchObject({ key: miss.key, occurrence: 0, recorded: 0 });
    expect(JSON.stringify(saved.request)).toContain("⟦id:1⟧");
    expect(cassette.stats()).toMatchObject({ misses: 1, missDetails: [{ key: miss.key }] });
  });

  it("stops live calls at the live remote token cap without calling the provider", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    const first = recorder.wrap(new FakeAdapter(() => "one"));
    await first.run(noteRequest([chunkA, chunkB], { input: "one" }));
    await first.run(noteRequest([chunkA, chunkB], { input: "two" }));

    const resumed = new AiCassette({ mode: "record", directory });
    resumed.limitLiveTokens(100);
    const live = new FakeAdapter(() => "fresh");
    const adapter = resumed.wrap(live);
    // Calls already recorded are served and cost nothing, whatever the cap.
    expect((await adapter.run(noteRequest([chunkA, chunkB], { input: "one" }))).output).toBe("one");
    expect(resumed.stats()).toMatchObject({ liveTokens: 0, maxLiveTokens: 100, served: 1 });
    // The cap is checked before a live call, so the call that crosses it still completes.
    await adapter.run(noteRequest([chunkA, chunkB], { input: "three" }));
    expect(resumed.stats().liveTokens).toBe(121);
    await expect(
      adapter.run(noteRequest([chunkA, chunkB], { input: "four" }))
    ).rejects.toMatchObject({ code: "token_limit" });
    expect(live.calls).toBe(1);
    expect(resumed.stats()).toMatchObject({ recorded: 1, served: 1, misses: 0 });

    resumed.limitLiveTokens(null);
    await adapter.run(noteRequest([chunkA, chunkB], { input: "four" }));
    expect(live.calls).toBe(2);
    expect(() => resumed.limitLiveTokens(0)).toThrow(AiCassetteError);
  });

  it("counts only remote tokens against the live cap", async () => {
    const cassette = new AiCassette({ mode: "record", directory });
    cassette.limitLiveTokens(50);
    const adapter = cassette.wrap(
      new FakeAdapter(() => "local answer", { ...descriptor, runtime: "local" })
    );
    for (const input of ["a", "b", "c"])
      await adapter.run(noteRequest([chunkA, chunkB], { input }));
    expect(cassette.stats()).toMatchObject({ liveTokens: 0, recorded: 3 });
  });

  it("counts the Decisions API's tokens apart: its spend has a cap of its own", async () => {
    const cassette = new AiCassette({ mode: "record", directory });
    cassette.limitLiveTokens(50);
    const decisions = cassette.wrap(
      new FakeAdapter(() => "probabilities", { ...descriptor, providerId: "openai-decisions" })
    );
    for (const input of ["a", "b", "c", "d"])
      await decisions.run(noteRequest([chunkA, chunkB], { input }));
    // Four requests of about 100 input tokens each cross a cap of 50 if they were the writer's.
    expect(cassette.stats()).toMatchObject({ liveTokens: 0, recorded: 4 });
    expect(cassette.stats().liveDecisionsTokens).toBeGreaterThan(400);
    const codex = cassette.wrap(new FakeAdapter(() => "typed"));
    await codex.run(noteRequest([chunkA, chunkB], { input: "typing" }));
    expect(cassette.stats().liveTokens).toBeGreaterThan(100);
    await expect(
      codex.run(noteRequest([chunkA, chunkB], { input: "more typing" }))
    ).rejects.toMatchObject({ code: "token_limit" });
  });

  it("refuses to replay a directory that holds no cassette", () => {
    expect(() => new AiCassette({ mode: "replay", directory })).toThrow(
      expect.objectContaining({ code: "not_a_cassette" })
    );
  });

  it("reports corrupt entries instead of calling the provider", async () => {
    new AiCassette({ mode: "record", directory });
    const { key } = aiCassetteRequestKey(descriptor, noteRequest([chunkA, chunkB]));
    const path = join(directory, "entries", key.slice(0, 2));
    await import("node:fs/promises").then(({ mkdir }) => mkdir(path, { recursive: true }));
    await writeFile(join(path, `${key}.json`), JSON.stringify({ format: "other" }));
    const offline = new FakeAdapter(noLiveCalls);
    await expect(
      new AiCassette({ mode: "replay", directory }).wrap(offline).run(noteRequest([chunkA, chunkB]))
    ).rejects.toMatchObject({ code: "corrupt_entry" });
    expect(offline.calls).toBe(0);
  });

  it("streams replayed results and never loads a local model during replay", async () => {
    const recorder = new AiCassette({ mode: "record", directory });
    const progress: number[] = [];
    await recorder.wrap(new FakeAdapter(() => "streamed")).runStreaming!(
      noteRequest([chunkA, chunkB]),
      undefined,
      (event) => event.kind !== "text" && progress.push(event.progress)
    );
    expect(progress).toEqual([0.5]);

    const offline = new FakeAdapter(noLiveCalls);
    const replay = new AiCassette({ mode: "replay", directory }).wrap(offline);
    expect(replay.isLoaded?.()).toBe(true);
    await replay.ensureLoaded?.();
    expect(offline.loads).toBe(0);
    const replayedProgress: number[] = [];
    const result = await replay.runStreaming!(
      noteRequest([chunkA, chunkB]),
      undefined,
      (event) => event.kind !== "text" && replayedProgress.push(event.progress)
    );
    expect(result.output).toBe("streamed");
    expect(replayedProgress).toEqual([1]);
  });

  it("wraps every adapter registered while a decorator is installed", async () => {
    const cassette = new AiCassette({ mode: "record", directory });
    setAiAdapterDecorator((adapter) => cassette.wrap(adapter));
    const registry = new AiModelRegistry();
    const live = new FakeAdapter(() => "via registry");
    registry.register(live);
    const result = await registry.run(noteRequest([chunkA, chunkB])).result;
    expect(result.output).toBe("via registry");
    expect(cassette.stats().recorded).toBe(1);
    expect(cassette.wrap(registry.resolve({ requiredCapabilities: [] }))).toBe(
      registry.resolve({ requiredCapabilities: [] })
    );

    setAiAdapterDecorator(null);
    const plain = new AiModelRegistry();
    plain.register(live);
    expect(plain.resolve({ requiredCapabilities: [] })).toBe(live);
  });
});
