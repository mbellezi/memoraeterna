import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AtomicNoteMatchingSettingsSchema } from "@app/domain";
import type { AiCassetteStats } from "@app/ai";
import type { PgPool } from "@app/db";

import type { AiService } from "./ai-service.js";
import {
  exclusiveKnobs,
  maxCandidatesPerCall,
  maxConsecutiveCallErrors,
  maxNotePairs,
  noteCallRequest,
  notePairVerdictsFile,
  notePairsFormat,
  planCalls,
  prepareGoldenNotePairs,
  readGoldenNotePairsEnvironment,
  readNotePairsFile,
  runNotePairVerdicts,
  writeNotePairVerdicts,
  type NotePairsFile,
  type NotePairsFileContent
} from "./golden-note-pairs.js";
import { KnowledgeService } from "./knowledge-service.js";

// The product's note matching (KnowledgeService -> RelationMatcher, F3 T51) is run with its
// repositories mocked, as relations/relation-matcher.test.ts does, to capture the request its
// generative decider builds.
const mocks = vi.hoisted(() => ({
  notes: {
    findById: vi.fn(),
    findTextMatchingCandidates: vi.fn(),
    findVectorMatchingCandidates: vi.fn(),
    filterRetrievableCandidateIds: vi.fn(),
    scoreMatchingCandidates: vi.fn()
  },
  relations: { pairStatuses: vi.fn(), upsertDecided: vi.fn() },
  decisions: { findVerdicts: vi.fn(), findReverseVerdicts: vi.fn(), record: vi.fn() },
  aiConfig: { getDefaultTask: vi.fn() },
  graph: { findAtomicNoteCandidates: vi.fn() },
  embedding: { upsert: vi.fn(), findCurrentNoteVectors: vi.fn() },
  states: { read: vi.fn(), record: vi.fn() },
  runs: { start: vi.fn(), finish: vi.fn() },
  settings: { get: vi.fn() },
  run: vi.fn()
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createAtomicNoteRepository: () => mocks.notes,
  createAtomicNoteRelationRepository: () => mocks.relations,
  createRelationDecisionRepository: () => mocks.decisions,
  createAiConfigRepository: () => mocks.aiConfig,
  createKnowledgeGraphRepository: () => mocks.graph,
  createEmbeddingRepository: () => mocks.embedding,
  createNoteMatchStateRepository: () => mocks.states,
  createRelationMatchRunRepository: () => mocks.runs,
  createSettingsRepository: () => mocks.settings
}));

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-note-pairs-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const noteOf = (name: string) => ({ title: name, idea: `Idea ${name}` });

function content(
  pairs: Array<[string, string, string?]>,
  extraNotes: string[] = []
): NotePairsFileContent {
  const names = new Set([...pairs.flatMap(([a, b]) => [a, b]), ...extraNotes]);
  return {
    format: notePairsFormat,
    version: 1,
    notes: Object.fromEntries([...names].map((name) => [name, noteOf(name)])),
    pairs: pairs.map(([source, candidate, label]) => ({
      source,
      candidate,
      ...(label ? { label } : {})
    }))
  };
}

const fileOf = (parsed: NotePairsFileContent): NotePairsFile => ({
  path: join(directory, "pairs.json"),
  sha256: "a".repeat(64),
  content: parsed
});

/** One item of the decide-only contract: the candidate's number, a score 0-100 and the type. */
const item = (alias: number, score: number, relationType = "supports") => [
  alias,
  score,
  relationType
];

type Output = unknown | Error | null;
function fakeAi(outputs: Output[]) {
  const calls: Array<[string, string, Record<string, unknown>, unknown, unknown]> = [];
  const queue = [...outputs];
  return {
    calls,
    ai: {
      runDefaultTask: async (
        ...args: [string, string, Record<string, unknown>, unknown, unknown]
      ) => {
        calls.push(args);
        const next = queue.length ? queue.shift() : { results: [] };
        if (next instanceof Error) throw next;
        if (next === null) return null;
        return {
          taskType: "reranking",
          output: next,
          providerId: "openai-codex",
          modelId: "gpt-test",
          runtime: "remote",
          durationMs: 2500,
          inputTokens: 900,
          outputTokens: 60,
          tokenUsage: { reasoningTokens: 0 },
          costEstimate: null,
          profileId: "profile",
          aiTaskRunId: `run-${calls.length}`,
          outputLanguage: "en"
        };
      }
    } as unknown as Pick<AiService, "runDefaultTask">
  };
}

const stats = (overrides: Partial<AiCassetteStats> = {}): AiCassetteStats => ({
  mode: "record",
  directory: "/cassette",
  served: 0,
  recorded: 0,
  misses: 0,
  byTask: {},
  liveTokens: 0,
  maxLiveTokens: 100_000,
  missDetails: [],
  ...overrides
});

describe("the pair list", () => {
  const valid = content([
    ["a", "b", "first"],
    ["a", "c"]
  ]);

  async function write(value: unknown): Promise<string> {
    const path = join(directory, "pairs.json");
    await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  }

  it("is read with the hash of its bytes", async () => {
    const file = await readNotePairsFile(await write(valid));
    expect(file.content.pairs).toHaveLength(2);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("takes a note without a title, which the prompt then shows empty", async () => {
    const untitled = { ...valid, notes: { ...valid.notes, b: { title: "", idea: "An idea." } } };
    const file = await readNotePairsFile(await write(untitled));
    const call = planCalls(file.content)[0]!;
    const request = noteCallRequest(file.content, call, call.candidates, 0, 4096, "en");
    expect(request.input).toContain("Title: \nMain idea: An idea.");
  });

  it("is refused when it cannot be read, parsed or is not a pair list", async () => {
    await expect(readNotePairsFile(join(directory, "missing.json"))).rejects.toThrow("cannot read");
    await expect(readNotePairsFile(await write("{"))).rejects.toThrow("not valid JSON");
    await expect(readNotePairsFile(await write({ pairs: [] }))).rejects.toThrow(notePairsFormat);
    const tooMany = content(
      Array.from({ length: maxNotePairs + 1 }, (_, index) => ["a", `n${index}`] as [string, string])
    );
    await expect(readNotePairsFile(await write(tooMany))).rejects.toThrow(String(maxNotePairs));
  });

  it("refuses a pair of a note it has no text for, of a note with itself, and a pair listed twice", async () => {
    const unknown = { ...valid, pairs: [{ source: "a", candidate: "ghost" }] };
    await expect(readNotePairsFile(await write(unknown))).rejects.toThrow(
      '"ghost" is not in notes'
    );
    await expect(readNotePairsFile(await write(content([["a", "a"]])))).rejects.toThrow(
      "not judged against itself"
    );
    await expect(
      readNotePairsFile(
        await write(
          content([
            ["a", "b"],
            ["a", "b"]
          ])
        )
      )
    ).rejects.toThrow("listed twice");
  });
});

describe("the calls", () => {
  it("group the pairs by source note and number the candidates in content order, never by id or file order", () => {
    const parsed = content([
      ["s1", "zebra"],
      ["s2", "mango"],
      ["s1", "apple"],
      ["s1", "mango"]
    ]);
    const plan = planCalls(parsed);
    expect(plan.map((call) => call.source)).toEqual(["s1", "s2"]);
    expect(plan[0]!.candidates.map(({ key, alias, pair }) => [key, alias, pair])).toEqual([
      ["apple", 1, 2],
      ["mango", 2, 3],
      ["zebra", 3, 0]
    ]);
    expect(plan[1]!.candidates.map((candidate) => candidate.alias)).toEqual([1]);
    // Reordering the file moves nothing in the prompt.
    const shuffled = planCalls({ ...parsed, pairs: [...parsed.pairs].reverse() });
    expect(shuffled.find((call) => call.source === "s1")!.candidates.map((c) => c.key)).toEqual([
      "apple",
      "mango",
      "zebra"
    ]);
  });

  it("split a source with more than the call budget into calls of that many", () => {
    const names = Array.from(
      { length: maxCandidatesPerCall + 5 },
      (_, index) => `n${String(index).padStart(2, "0")}`
    );
    const plan = planCalls(content(names.map((name) => ["s", name] as [string, string])));
    expect(plan.map((call) => call.candidates.length)).toEqual([maxCandidatesPerCall, 5]);
    expect(plan[1]!.candidates.map((candidate) => candidate.alias)).toEqual([1, 2, 3, 4, 5]);
    expect(plan.map((call) => call.index)).toEqual([0, 1]);
  });
});

describe("the verdicts", () => {
  const baseInput = (parsed: NotePairsFileContent, ai: ReturnType<typeof fakeAi>["ai"]) => ({
    file: fileOf(parsed),
    ai,
    maxRerankOutputTokens: 4096,
    contentLanguage: "en",
    cassette: null,
    now: () => new Date("2026-10-17T12:00:00.000Z")
  });

  it("read one call per source with the production parser and report every pair", async () => {
    const { ai, calls } = fakeAi([
      { results: [item(1, 85, "extends"), item(2, 10, "supports")] },
      { results: [item(1, 70, "supports")] }
    ]);
    const report = await runNotePairVerdicts(
      baseInput(
        content([
          ["s1", "b", "pair one"],
          ["s2", "c"],
          ["s1", "a"]
        ]),
        ai
      )
    );
    expect(calls).toHaveLength(2);
    expect(report).toMatchObject({
      format: "memora-golden-note-pair-verdicts",
      state: "finished",
      status: "completed",
      contract: "atomic-note-matching-v9",
      pairsFile: { notes: 5, pairs: 3, calls: 2 },
      totals: { pairs: 3, decided: 3, undecided: 0, calls: 2, repairs: 0, inputTokens: 1800 }
    });
    // s1's candidates in content order: a (1), b (2).
    expect(
      report.pairs.map((pair) => [pair.source, pair.candidate, pair.alias, pair.score])
    ).toEqual([
      ["s1", "b", 2, 10],
      ["s2", "c", 1, 70],
      ["s1", "a", 1, 85]
    ]);
    expect(report.pairs[2]).toMatchObject({ relationType: "extends", attempt: 0, label: null });
    expect(report.pairs[0]!.label).toBe("pair one");
    expect(report.calls[0]!.attempts[0]).toMatchObject({
      attempt: 0,
      aliases: [1, 2],
      decided: [1, 2],
      retry: [],
      replayed: false
    });
  });

  it("ask once more for the numbers the first answer left out, with their own numbers", async () => {
    const { ai, calls } = fakeAi([
      { results: [item(1, 90), [2, 200, "supports"]] },
      { results: [item(2, 40, "clarifies")] }
    ]);
    const report = await runNotePairVerdicts(
      baseInput(
        content([
          ["s", "a"],
          ["s", "b"]
        ]),
        ai
      )
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]![2]).toMatchObject({ operation: "note_matching_reranking_repair", attempt: 1 });
    expect(calls[1]![1]).toContain("[2]\nTitle: b");
    expect(calls[1]![1]).not.toContain("[1]\nTitle: a");
    expect(report.pairs.map((pair) => [pair.status, pair.score, pair.attempt])).toEqual([
      ["decided", 90, 0],
      ["decided", 40, 1]
    ]);
    expect(report.totals).toMatchObject({ repairs: 1, decidedByRepair: 1, calls: 2 });
  });

  it("keep what the first answer decided when the repair call fails", async () => {
    const { ai } = fakeAi([{ results: [item(1, 90)] }, new Error("provider down")]);
    const report = await runNotePairVerdicts(
      baseInput(
        content([
          ["s", "a"],
          ["s", "b"]
        ]),
        ai
      )
    );
    expect(report.pairs.map((pair) => [pair.status, pair.score])).toEqual([
      ["decided", 90],
      ["undecided", null]
    ]);
    expect(report.pairs[1]!.reason).toBe("the repair call failed: provider down");
    expect(report.calls[0]).toMatchObject({
      status: "judged",
      reason: "the repair call failed: provider down"
    });
    expect(report.calls[0]!.attempts).toHaveLength(1);
    expect(report.status).toBe("completed_with_failures");
  });

  it("leave a pair undecided after the repair and say the run completed with failures", async () => {
    const { ai } = fakeAi([{ results: [item(1, 90)] }, { results: [] }]);
    const report = await runNotePairVerdicts(
      baseInput(
        content([
          ["s", "a"],
          ["s", "b"]
        ]),
        ai
      )
    );
    expect(report.pairs.map((pair) => pair.status)).toEqual(["decided", "undecided"]);
    expect(report.status).toBe("completed_with_failures");
    expect(report.totals).toMatchObject({ decided: 1, undecided: 1 });
  });

  it("stop after repeated failed calls and report the rest as skipped", async () => {
    const failures = Array.from(
      { length: maxConsecutiveCallErrors },
      () => new Error("provider down")
    );
    const names = ["s1", "s2", "s3", "s4", "s5"];
    const { ai, calls } = fakeAi(failures);
    const report = await runNotePairVerdicts(
      baseInput(content(names.map((name) => [name, "t"] as [string, string])), ai)
    );
    expect(calls).toHaveLength(maxConsecutiveCallErrors);
    expect(report.pairs.map((pair) => pair.status)).toEqual([
      "error",
      "error",
      "error",
      "skipped",
      "skipped"
    ]);
    expect(report.pairs[0]!.reason).toBe("provider down");
    expect(report.status).toBe("completed_with_failures");
    expect(report.calls.slice(3).every((call) => call.status === "skipped")).toBe(true);
  });

  it("stop when a call misses the replay cassette or the live token cap is reached", async () => {
    let current = stats({ mode: "replay", maxLiveTokens: null });
    const replay = fakeAi([{ results: [item(1, 50)] }, { results: [item(1, 50)] }]);
    const diverged = await runNotePairVerdicts({
      ...baseInput(
        content([
          ["s1", "a"],
          ["s2", "a"]
        ]),
        replay.ai
      ),
      cassette: {
        stats: () => {
          const before = current;
          current = { ...current, misses: current.misses + 1 };
          return before;
        }
      }
    });
    expect(replay.calls).toHaveLength(1);
    expect(diverged.status).toBe("diverged");
    expect(diverged.pairs.map((pair) => pair.status)).toEqual(["decided", "skipped"]);

    const capped = fakeAi([{ results: [item(1, 50)] }, { results: [item(1, 50)] }]);
    let liveTokens = 0;
    const limited = await runNotePairVerdicts({
      ...baseInput(
        content([
          ["s1", "a"],
          ["s2", "a"]
        ]),
        capped.ai
      ),
      cassette: {
        stats: () => {
          liveTokens += 60_000;
          return stats({ liveTokens, maxLiveTokens: 100_000 });
        }
      }
    });
    expect(limited.status).toBe("token_limit");
    // The first call took the run past the cap: the second is not made.
    expect(capped.calls).toHaveLength(1);
    expect(limited.pairs.map((pair) => pair.status)).toEqual(["decided", "skipped"]);
  });

  it("report the fields the bake-off merge (scripts/relations/bakeoff-v9.ts) reads", async () => {
    const { ai } = fakeAi([{ results: [item(1, 85, "extends")] }]);
    const report = await runNotePairVerdicts(baseInput(content([["s", "a"]]), ai));
    expect(report).toMatchObject({
      format: "memora-golden-note-pair-verdicts",
      version: 1,
      state: "finished",
      contract: "atomic-note-matching-v9",
      pairsFile: { sha256: "a".repeat(64) },
      cassette: null
    });
    expect(report.pairs[0]).toEqual({
      index: 0,
      source: "s",
      candidate: "a",
      label: null,
      call: 0,
      alias: 1,
      status: "decided",
      score: 85,
      relationType: "extends",
      attempt: 0,
      aiTaskRunId: "run-1"
    });
    expect(Object.keys(report.totals)).toEqual(
      expect.arrayContaining(["pairs", "decided", "inputTokens", "outputTokens"])
    );
  });

  it("write the report atomically and nothing else", async () => {
    const { ai } = fakeAi([{ results: [item(1, 50)] }]);
    const report = await runNotePairVerdicts(baseInput(content([["s", "a"]]), ai));
    const path = await writeNotePairVerdicts(join(directory, "run"), report);
    expect(path).toBe(join(directory, "run", notePairVerdictsFile));
    expect(await readdir(join(directory, "run"))).toEqual([notePairVerdictsFile]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ state: "finished" });
  });
});

describe("the request", () => {
  const writerRoute = {
    profileId: "profile",
    provider: "openai-codex",
    baseUrl: null,
    modelId: "model",
    runtime: "remote",
    repository: null,
    revision: null,
    quantization: null,
    localModelId: null,
    requiredCapabilities: ["text-generation", "structured-output"],
    parameters: {},
    modelDefaultParameters: {}
  };
  /**
   * The profiles whose note matching still runs the generative v9 decider (Q17, D16): a profile
   * with no preset whose `reranking` route holds its pre-F3 writer (the derived mode), and the
   * Cloud preset with no ranker, whose generative-decide `op:` routes hold the remote writer.
   */
  const profiles: Record<string, { mode: string | null; routes: Record<string, unknown> }> = {
    "a profile with no preset": { mode: null, routes: { reranking: writerRoute } },
    "the Cloud preset without a ranker": {
      mode: "ranker-else-generative",
      routes: {
        "op:note_matching_reranking": writerRoute,
        "op:note_matching_reranking_repair": writerRoute,
        reranking: writerRoute
      }
    }
  };

  /** The decider calls the product's note matching makes for a source note with three candidates. */
  async function matcherCalls(
    profile: { mode: string | null; routes: Record<string, unknown> },
    outputs: unknown[]
  ) {
    vi.resetAllMocks();
    const note = (id: string) => ({
      id,
      title: id,
      ideaStatement: `Idea ${id}`,
      bodyMarkdown: `Body ${id}`,
      metadata: {},
      createdFromSourceItemId: `source-${id}`,
      status: "pending_review",
      supersessionStatus: "current"
    });
    const notes = new Map(["source", "a", "b", "c"].map((id) => [id, note(id)]));
    const candidates = ["a", "b", "c"].map((id) => ({
      note: notes.get(id)!,
      textScore: 1,
      vectorScore: 1,
      hasVector: true
    }));
    mocks.notes.findById.mockImplementation(async (id: string) => notes.get(id) ?? null);
    mocks.notes.findTextMatchingCandidates.mockResolvedValue(candidates);
    mocks.notes.findVectorMatchingCandidates.mockResolvedValue(candidates);
    mocks.notes.filterRetrievableCandidateIds.mockResolvedValue(new Set());
    mocks.notes.scoreMatchingCandidates.mockResolvedValue(candidates);
    mocks.graph.findAtomicNoteCandidates.mockResolvedValue([]);
    mocks.relations.pairStatuses.mockResolvedValue(new Map());
    mocks.relations.upsertDecided.mockResolvedValue({ change: "created" });
    mocks.decisions.findVerdicts.mockResolvedValue(new Map());
    mocks.decisions.findReverseVerdicts.mockResolvedValue(new Map());
    mocks.embedding.findCurrentNoteVectors.mockResolvedValue(new Map());
    mocks.states.read.mockResolvedValue(new Map());
    mocks.runs.start.mockResolvedValue({ id: "match-run" });
    mocks.settings.get.mockResolvedValue(profile.mode);
    mocks.aiConfig.getDefaultTask.mockImplementation(
      async (task: string, _profile: unknown, keys: string[] = [task]) =>
        keys.map((key) => profile.routes[key]).find(Boolean) ?? null
    );
    const queue = [...outputs];
    mocks.run.mockImplementation(async (task) =>
      task === "embedding"
        ? {
            output: Array.from({ length: 256 }, () => 0.1),
            profileId: "profile",
            modelId: "model",
            providerId: "provider",
            runtime: "remote",
            aiTaskRunId: "embed"
          }
        : {
            output: queue.shift(),
            profileId: "profile",
            modelId: "model",
            providerId: "provider",
            runtime: "remote",
            aiTaskRunId: "run"
          }
    );
    const result = await new KnowledgeService({
      getPool: () => ({}) as PgPool,
      aiService: { runDefaultTask: mocks.run } as unknown as AiService,
      userDataPath: "/tmp/test",
      getStorageSettings: async () => ({}) as never,
      getUploadedFilesBasePath: async () => null,
      getAtomicNoteMatchingSettings: async () => AtomicNoteMatchingSettingsSchema.parse({})
    }).matchAtomicNotes(["source"]);
    // The generative decider answered, not a ranker, and nothing was skipped.
    expect(result).toMatchObject({ decider: "generative", decided: 1 });
    expect(result.skipped).toBeUndefined();
    return mocks.run.mock.calls.filter(([task]) => task !== "embedding");
  }

  /**
   * What decides the answer and the route that gives it: the task, the prompt, the operation and
   * the stated class (the route keys, the decide deadline and the lean decide shape, D16 and D34),
   * the contract, the retry index and the budget; and the lane priority.
   */
  const requestOf = (call: unknown[]) => {
    const context = call[2] as Record<string, unknown>;
    return {
      task: call[0],
      input: call[1],
      operation: context.operation,
      workloadClass: context.workloadClass,
      priority: context.priority,
      budgetClass: context.budgetClass,
      promptVersion: context.promptVersion,
      attempt: context.attempt,
      limits: call[4]
    };
  };

  it.each(Object.entries(profiles))(
    "is the request the matcher builds, for the first answer and for the repair, on %s",
    async (_name, profile) => {
      const matcher = await matcherCalls(profile, [
        { results: [item(1, 10), item(2, 70)] },
        { results: [item(3, 95, "extends")] }
      ]);
      expect(matcher).toHaveLength(2);
      const { ai, calls } = fakeAi([
        { results: [item(1, 10), item(2, 70)] },
        { results: [item(3, 95, "extends")] }
      ]);
      await runNotePairVerdicts({
        file: fileOf(
          content([
            ["source", "a"],
            ["source", "b"],
            ["source", "c"]
          ])
        ),
        ai,
        maxRerankOutputTokens: AtomicNoteMatchingSettingsSchema.parse({}).maxRerankOutputTokens,
        contentLanguage: "en",
        cassette: null
      });
      expect(calls).toHaveLength(2);
      expect(calls.map(requestOf)).toEqual(matcher.map(requestOf));
      expect(requestOf(calls[0]!)).toMatchObject({
        task: "reranking",
        operation: "note_matching_reranking",
        workloadClass: "decide",
        priority: "P2",
        promptVersion: "atomic-note-matching-v9",
        attempt: 0
      });
      expect(requestOf(calls[1]!)).toMatchObject({
        operation: "note_matching_reranking_repair",
        workloadClass: "decide",
        attempt: 1
      });
      // The repair asks only for the number the first answer left out.
      expect(calls[1]![1]).toContain("[3]\nTitle: c");
      expect(calls[1]![1]).not.toContain("Title: a");
    }
  );
});

describe("the knob", () => {
  const options = { isPackaged: false, workspaceRoot: "/workspace" };

  it("is absent when unset and reads the list, the cap and the exit switch when set", () => {
    expect(readGoldenNotePairsEnvironment({}, options)).toBeNull();
    expect(readGoldenNotePairsEnvironment({ MEMORA_GOLDEN_NOTE_PAIRS: "  " }, options)).toBeNull();
    expect(
      readGoldenNotePairsEnvironment(
        {
          MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json",
          MEMORA_GOLDEN_MAX_TOKENS: "150000",
          MEMORA_GOLDEN_EXIT: "1"
        },
        options
      )
    ).toEqual({ pairsPath: "/workspace/pairs.json", maxLiveTokens: 150_000, exitWhenDone: true });
    expect(() =>
      readGoldenNotePairsEnvironment(
        { MEMORA_GOLDEN_NOTE_PAIRS: "p.json", MEMORA_GOLDEN_MAX_TOKENS: "0" },
        options
      )
    ).toThrow("positive integer");
  });

  it("is refused in packaged builds", () => {
    expect(() =>
      readGoldenNotePairsEnvironment(
        { MEMORA_GOLDEN_NOTE_PAIRS: "p.json" },
        { isPackaged: true, workspaceRoot: "/w" }
      )
    ).toThrow("refused in packaged builds");
  });

  it.each(exclusiveKnobs)("is refused together with %s", (knob) => {
    expect(() =>
      readGoldenNotePairsEnvironment({ MEMORA_GOLDEN_NOTE_PAIRS: "p.json", [knob]: "1" }, options)
    ).toThrow(`cannot be combined with ${knob}`);
    // An empty value is no knob.
    expect(
      readGoldenNotePairsEnvironment({ MEMORA_GOLDEN_NOTE_PAIRS: "p.json", [knob]: "" }, options)
    ).not.toBeNull();
  });

  async function prepare(
    overrides: Partial<Parameters<typeof prepareGoldenNotePairs>[0]> = {},
    parsed: NotePairsFileContent = content([["s", "a"]])
  ) {
    await writeFile(join(directory, "pairs.json"), JSON.stringify(parsed));
    const limitLiveTokens = vi.fn();
    const quit = vi.fn();
    const ai = fakeAi([{ results: [item(1, 77, "extends")] }]);
    const events: string[] = [];
    const run = await prepareGoldenNotePairs({
      env: { MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json", MEMORA_GOLDEN_MAX_TOKENS: "50000" },
      isPackaged: false,
      workspaceRoot: directory,
      cassette: { stats: () => stats(), limitLiveTokens },
      ai: ai.ai,
      settings: {
        getApp: async () => ({
          contentLanguage: "pt-BR",
          atomicNoteMatchingSettings: AtomicNoteMatchingSettingsSchema.parse({
            maxRerankOutputTokens: 2048
          })
        })
      },
      quit,
      log: (event) => events.push(event),
      now: () => new Date("2026-10-17T12:30:45.123Z"),
      ...overrides
    });
    return { run, limitLiveTokens, quit, ai, events };
  }

  it("needs a cassette, and a cap on live tokens when it records", async () => {
    await expect(prepare({ cassette: null })).rejects.toThrow("needs MEMORA_AI_CASSETTE");
    await expect(prepare({ env: { MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json" } })).rejects.toThrow(
      "set MEMORA_GOLDEN_MAX_TOKENS"
    );
    await expect(prepare({ isPackaged: true })).rejects.toThrow("never runs in packaged builds");
    await expect(
      prepare({ env: { MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json", MEMORA_GOLDEN_RUN: "m.json" } })
    ).rejects.toThrow("cannot be combined with MEMORA_GOLDEN_RUN");
  });

  it("sets the cap, judges the pairs and persists nothing but the report", async () => {
    const { run, limitLiveTokens, quit, ai, events } = await prepare();
    expect(limitLiveTokens).toHaveBeenCalledWith(50_000);
    expect(events).toEqual(["prepared"]);
    expect(run).toMatchObject({ pairs: 1, calls: 1 });
    const report = await run.start();
    expect(report?.status).toBe("completed");
    expect(report?.pairs[0]).toMatchObject({ score: 77, relationType: "extends" });
    // The app's settings give the budget and the language; the call goes through the AI service only.
    expect(ai.calls).toHaveLength(1);
    expect(ai.calls[0]![4]).toEqual({ maxOutputTokens: 2048 });
    expect(ai.calls[0]![2]).toMatchObject({
      contentLanguage: "pt-BR",
      origin: "golden_note_pairs"
    });
    expect(quit).not.toHaveBeenCalled();
    // The only file the run wrote is the report, under .cache/golden/runs/<timestamp>/.
    const written = (await readdir(directory, { recursive: true })).filter((name) =>
      name.endsWith(".json")
    );
    expect(written.sort()).toEqual(
      [".cache/golden/runs/2026-10-17T12-30-45-123Z/note-pair-verdicts.json", "pairs.json"].sort()
    );
  });

  it("quits when it is done if the exit switch is on, also when the run fails", async () => {
    const done = await prepare({
      env: {
        MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json",
        MEMORA_GOLDEN_MAX_TOKENS: "50000",
        MEMORA_GOLDEN_EXIT: "1"
      }
    });
    await done.run.start();
    expect(done.quit).toHaveBeenCalledOnce();

    const failing = await prepare({
      env: {
        MEMORA_GOLDEN_NOTE_PAIRS: "pairs.json",
        MEMORA_GOLDEN_MAX_TOKENS: "50000",
        MEMORA_GOLDEN_EXIT: "1"
      },
      settings: {
        getApp: async () => {
          throw new Error("settings unavailable");
        }
      }
    });
    expect(await failing.run.start()).toBeNull();
    expect(failing.events).toContain("failed");
    expect(failing.quit).toHaveBeenCalledOnce();
  });

  it("reaches no database and no repository: the module imports none and takes no pool", async () => {
    const source = await readFile(join(import.meta.dirname, "golden-note-pairs.ts"), "utf8");
    const imports = [...source.matchAll(/^import[\s\S]*?from "([^"]+)";/gmu)].map((m) => m[1]!);
    expect(imports.filter((name) => name.includes("db") || name.includes("repositor"))).toEqual([]);
    expect(source).not.toMatch(/\bpool\b/iu);
    expect(source).not.toMatch(/\bquery\(/u);
  });
});
