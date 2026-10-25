import { describe, expect, it, vi } from "vitest";
import { SourceRelationSettingsSchema, relationsConfig } from "@app/domain";

import { readGoldenRunEnvironment } from "./golden-runner.js";
import {
  StrictProbeRefusal,
  readStrictProbePlan,
  runStrictProbe,
  strictProbeDefaults,
  type StrictProbeDeps
} from "./strict-probe.js";
import { topicNamingOutputContract } from "./topic-tree/topic-prompts.js";

/**
 * The strict-output probe (owner, 10-25; STRICTP): its knob, its route check before any call, the
 * product's own builders and contracts for each part, and a report of counts read back from the
 * audit rows of each part.
 */

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const roots = [
  { id: id(1), title: "Forgetting curve", type: "web_page" },
  { id: id(2), title: "Memory and Language", type: "web_page" },
  { id: id(3), title: "The Tell-Tale Heart", type: "web_page" }
];
const notesOf = (root: number) => [
  { id: id(100 + root * 10), title: `Idea ${root}a`, idea: `The first idea of source ${root}.` },
  { id: id(101 + root * 10), title: `Idea ${root}b`, idea: `The second idea of source ${root}.` }
];
const chunkOf = (root: number) => ({ id: id(200 + root), content: `Passage of source ${root}.` });
const auditRow = {
  runtime: "remote",
  schemaMode: "strict",
  isRepair: false,
  status: "succeeded",
  replayed: false,
  calls: 2,
  inputTokens: 900,
  outputTokens: 120
};

function fakePool() {
  const statements: string[] = [];
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    statements.push(text);
    if (text.includes("from ai_task_runs")) return { rows: [auditRow] };
    if (text.includes("parent_source_item_id is null") && !text.includes("with recursive"))
      return { rows: [...roots].reverse() };
    const root = roots.findIndex((candidate) => candidate.id === values[0]) + 1;
    if (text.includes("from atomic_notes n")) return { rows: root ? notesOf(root) : [] };
    if (text.includes("join documents d"))
      return {
        rows: root ? [{ documentId: id(300 + root), title: `Source ${root}`, language: "en" }] : []
      };
    if (text.includes("from chunks where document_id")) {
      const document = Number(String(values[0]).slice(-3)) - 300;
      return { rows: [chunkOf(document)] };
    }
    // The pair runner's reads: no passage, so a pair is skipped without a call.
    return { rows: [] };
  });
  return { pool: { query } as unknown as StrictProbeDeps["pool"], statements };
}

const execution = (output: unknown) => ({
  output: JSON.stringify(output),
  providerId: "openai-codex",
  modelId: "writer",
  runtime: "remote",
  profileId: id(900),
  aiTaskRunId: id(901),
  durationMs: 1
});

function deps(locality: "remote" | "local" = "remote") {
  const { pool, statements } = fakePool();
  const runDefaultTask = vi.fn<
    (task: string, prompt: string, context?: Record<string, unknown>) => Promise<unknown>
  >(async (task, prompt) => {
    if (task === "atomic-note-generation") {
      const cited = /\[([0-9a-f-]{36})\]/u.exec(prompt)![1];
      return execution({
        notes: [
          {
            title: "A note",
            bodyMarkdown: "Body.",
            ideaStatement: "One idea.",
            language: null,
            evidenceChunkIds: [cited]
          }
        ]
      });
    }
    // The prompt's own example names T1 too: each alias once, in order.
    const aliases = [...new Set([...prompt.matchAll(/"alias":\s*"(T\d+)"/gu)].map((m) => m[1]))];
    return execution({
      topics: aliases.map((alias, index) => ({
        alias,
        title: ["Forgetting research", "Language and memory", "Guilt in fiction"][index],
        description: "Notes about one subject of the library.",
        aliases: [],
        language: "en"
      }))
    });
  });
  const ai = {
    runDefaultTask,
    taskRouteLocality: vi.fn(async () => locality)
  } as unknown as StrictProbeDeps["ai"];
  const ask = vi.fn(async () => ({}) as never);
  const probe: StrictProbeDeps = {
    pool,
    ai,
    consultation: { ask },
    settings: {
      contentLanguage: "en",
      sourceRelationSettings: SourceRelationSettingsSchema.parse({})
    },
    relations: relationsConfig,
    cassette: null,
    pairs: null
  };
  return { probe, runDefaultTask, ask, statements, taskRouteLocality: ai.taskRouteLocality };
}

describe("the probe's knob", () => {
  it("reads nothing when unset, the defaults for 1, and a list of parts", () => {
    expect(readStrictProbePlan({})).toBeNull();
    expect(readStrictProbePlan({ MEMORA_GOLDEN_STRICT_PROBE: "1" })).toEqual(strictProbeDefaults);
    expect(readStrictProbePlan({ MEMORA_GOLDEN_STRICT_PROBE: "asks=2, pairs=4" })).toEqual({
      asks: 2,
      names: 0,
      pairs: 4,
      notes: 0
    });
  });

  it.each(["asks", "asks=6", "names=-1", "asks=0,names=0", "votes=1"])("refuses %s", (raw) => {
    expect(() => readStrictProbePlan({ MEMORA_GOLDEN_STRICT_PROBE: raw })).toThrow(
      "MEMORA_GOLDEN_STRICT_PROBE must be 1 or a list"
    );
  });

  it("is a golden run's alternative to the manifest, and its pair list needs it", () => {
    const options = { isPackaged: false, workspaceRoot: "/repo" };
    const env = { MEMORA_GOLDEN_RUN: "scripts/golden/manifest.json" };
    expect(readGoldenRunEnvironment(env, options)).not.toHaveProperty("strictProbe");
    expect(
      readGoldenRunEnvironment(
        {
          ...env,
          MEMORA_GOLDEN_STRICT_PROBE: "1",
          MEMORA_GOLDEN_STRICT_PROBE_PAIRS: ".cache/pairs.json"
        },
        options
      )?.strictProbe
    ).toEqual({ plan: strictProbeDefaults, pairsPath: "/repo/.cache/pairs.json" });
    expect(() =>
      readGoldenRunEnvironment({ ...env, MEMORA_GOLDEN_STRICT_PROBE_PAIRS: "pairs.json" }, options)
    ).toThrow("only applies with MEMORA_GOLDEN_STRICT_PROBE");
    expect(() =>
      readGoldenRunEnvironment(
        { ...env, MEMORA_GOLDEN_STRICT_PROBE: "1", MEMORA_GOLDEN_SCHEMA_PROBE: "5" },
        options
      )
    ).toThrow("each run alone");
  });
});

describe("the probe's run", () => {
  it("asks nothing when a part's route does not run remotely", async () => {
    const { probe, runDefaultTask, ask, statements } = deps("local");
    await expect(runStrictProbe(strictProbeDefaults, probe)).rejects.toBeInstanceOf(
      StrictProbeRefusal
    );
    expect(runDefaultTask).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(statements).toEqual([]);
  });

  it("checks the route of each part by the keys its real call resolves", async () => {
    const { probe, taskRouteLocality } = deps();
    await runStrictProbe(strictProbeDefaults, probe);
    expect(taskRouteLocality).toHaveBeenCalledWith("structured-output", {
      operation: "wiki-consultation",
      workloadClass: "answer"
    });
    expect(taskRouteLocality).toHaveBeenCalledWith("structured-output", {
      operation: "topic_name",
      workloadClass: "write-fast"
    });
    expect(taskRouteLocality).toHaveBeenCalledWith("reranking", {
      operation: "source_relation_matching",
      workloadClass: "decide"
    });
    expect(taskRouteLocality).toHaveBeenCalledWith("atomic-note-generation", {
      operation: "atomic_note_generation",
      workloadClass: "write-quality"
    });
  });

  it("runs each part through the product's builders and contracts and reports counts only", async () => {
    const { probe, runDefaultTask, ask } = deps();
    const report = await runStrictProbe({ asks: 2, names: 1, pairs: 2, notes: 2 }, probe);
    // The Ask: the soak's question about the first roots in title order, through the Ask's service.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(
      ask.mock.calls.map((call) => (call as unknown as [{ question: string }])[0].question)
    ).toEqual([
      "What does the library say about Forgetting curve?",
      "What does the library say about Memory and Language?"
    ]);
    // Naming: one call for three topics, with the naming contract and a budget the user started.
    const naming = runDefaultTask.mock.calls.filter(([task]) => task === "structured-output");
    expect(naming).toHaveLength(1);
    expect(naming[0]![2]).toMatchObject({
      operation: "topic_name",
      workloadClass: "write-fast",
      budgetClass: "user",
      outputContract: topicNamingOutputContract,
      isRepair: false
    });
    expect(report.parts.names.outcomes).toEqual({ accepted: 3 });
    // Notes: the product path, so the strict terms, and a strict null language reads as absent.
    const notes = runDefaultTask.mock.calls.filter(([task]) => task === "atomic-note-generation");
    expect(notes).toHaveLength(2);
    const notesContract = notes[0]![2]?.outputContract as { strictContract?: unknown };
    expect(notesContract.strictContract).toBeDefined();
    expect(report.parts.notes).toMatchObject({ asked: 2, outcomes: { notes: 2 } });
    // The judge: adjacent roots in title order; with no passages the runner skips them uncalled.
    expect(report.parts.pairs).toMatchObject({ asked: 2, outcomes: { no_evidence: 2 } });
    expect(report.parts.asks).toMatchObject({ asked: 2, outcomes: { answered: 2 } });
    // Each part reads back its own audit rows; the totals add them up.
    expect(report.parts.asks.audit).toEqual([auditRow]);
    expect(report.totals).toEqual({
      liveRemoteCalls: 8,
      strictCalls: 8,
      repairCalls: 0,
      failedCalls: 0,
      servedCalls: 0
    });
    expect(JSON.stringify(report)).not.toContain("Passage of source");
  });

  it("counts a failed Ask by its code and goes on", async () => {
    const { probe, ask } = deps();
    ask.mockRejectedValueOnce(new Error("consultation.errors.invalid"));
    const report = await runStrictProbe({ asks: 2, names: 0, pairs: 0, notes: 0 }, probe);
    expect(report.parts.asks.outcomes).toEqual({
      "failed:consultation.errors.invalid": 1,
      answered: 1
    });
    expect(report.parts.names).toEqual({ asked: 0, outcomes: {}, audit: [] });
  });
});
