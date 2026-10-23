import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiTaskRequest, AiTaskResult } from "@app/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { manifestSchema, parseItemLines } from "./replay-records.ts";
import {
  buildPlan,
  loadEntries,
  parseOptions,
  projectHours,
  renderPlan,
  resolveArm,
  runCommand,
  type Dependencies,
  type Options,
  type OpenedWriter
} from "./writer-replay.ts";
import {
  confirmationBody,
  everyContract,
  graphAnswer,
  graphBody,
  namesAnswer,
  notesAnswer,
  overviewAnswer,
  recorded,
  summaryAnswer,
  summaryBody,
  typingAnswer,
  writeCassette
} from "./test-fixtures.ts";
import { renderPrompt } from "../../apps/desktop/src/main/services/prompt-runtime.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bench-replay-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("parsing options", () => {
  it("defaults to every contract, the recorded prompts and a cassette under the data root", () => {
    const options = parseOptions(["plan", "--data-root", "/data/.cache"]);
    expect(options).toMatchObject({
      command: "plan",
      dataRoot: "/data/.cache",
      cassette: "/data/.cache/golden/cassettes/golden-small-f2",
      promptSource: "recorded",
      limit: null,
      perContract: null,
      helperPath: "/data/native/mlx-helper/.build/release/memora-mlx-helper",
      schema: false,
      resume: false,
      warmup: true,
      sampleIntervalMs: 1_000
    });
    expect(options.contracts).toHaveLength(7);
  });

  it("reads a run's options", () => {
    const options = parseOptions(
      [
        "run",
        "--arm",
        "m9b4",
        "--contracts",
        "graph,notes",
        "--limit",
        "5",
        "--per-contract",
        "2",
        "--prompts",
        "current",
        "--schema",
        "--seed",
        "7",
        "--param",
        "temperature=0.2",
        "--param",
        "reasoningLevel=off",
        "--owner",
        "T69-m9b4",
        "--no-warmup",
        "--resume"
      ],
      { MEMORA_BENCH_DATA_ROOT: "/env/.cache", MEMORA_MLX_HELPER_PATH: " /helper " }
    );
    expect(options).toMatchObject({
      command: "run",
      dataRoot: "/env/.cache",
      arm: "m9b4",
      contracts: ["graph", "notes"],
      limit: 5,
      perContract: 2,
      promptSource: "current",
      schema: true,
      seed: 7,
      params: { temperature: 0.2, reasoningLevel: "off" },
      owner: "T69-m9b4",
      warmup: false,
      resume: true,
      helperPath: "/helper"
    });
    expect(parseOptions(["run", "--helper-path", "/given/helper"]).helperPath).toBe(
      "/given/helper"
    );
  });

  it("refuses what it cannot read", () => {
    expect(() => parseOptions([])).toThrow(/Unknown command/u);
    expect(() => parseOptions(["run", "--contracts", "nope"])).toThrow(/Unknown contract/u);
    expect(() => parseOptions(["run", "--prompts", "other"])).toThrow(/--prompts/u);
    expect(() => parseOptions(["run", "--runtime", "onnx"])).toThrow(/--runtime/u);
    expect(() => parseOptions(["run", "--limit=-1"])).toThrow(/whole number/u);
    expect(() => parseOptions(["run", "--limit", "1.5"])).toThrow(/whole number/u);
    expect(() => parseOptions(["run", "--param", "temperature"])).toThrow(/key=value/u);
  });
});

describe("the entries of a cassette", () => {
  async function cassette(): Promise<string> {
    const directory = join(root, "golden", "cassettes", "test");
    const calls = [
      ...everyContract(),
      // The recording's own repair of a confirmation, which is not replayed.
      recorded({
        taskType: "knowledge-graph-generation",
        body: confirmationBody() + renderPrompt("graph.entity_identity.repair"),
        output: "{}"
      }),
      // A writer call no contract reads, a legacy decider and a call a local model recorded.
      recorded({ taskType: "structured-output", body: "Do something else", output: "{}" }),
      recorded({ taskType: "reranking", body: "Decide whether ...", output: "{}" }),
      {
        ...recorded({ taskType: "summarization", body: summaryBody(), output: "x" }),
        runtime: "local" as const
      }
    ];
    await writeCassette(directory, calls);
    return directory;
  }

  it("counts what it replays, what it sets aside and what no contract reads", async () => {
    const { entries, census } = await loadEntries({
      cassette: await cassette(),
      contracts: ["summary", "notes", "graph", "confirmation", "topic-names", "overview", "typing"],
      limit: null,
      perContract: null
    });
    expect(entries).toHaveLength(7);
    expect(census).toMatchObject({
      calls: 9,
      other: 1,
      recordedRepairs: { confirmation: 1 },
      unreconstructable: {},
      items: {
        summary: 1,
        notes: 1,
        graph: 1,
        confirmation: 1,
        "topic-names": 1,
        overview: 1,
        typing: 1
      }
    });
  });

  it("selects the contracts asked for, a number per contract and a number overall", async () => {
    const cassetteDirectory = await cassette();
    const all = [
      "summary",
      "notes",
      "graph",
      "confirmation",
      "topic-names",
      "overview",
      "typing"
    ] as const;
    const base = { cassette: cassetteDirectory, limit: null, perContract: null };
    expect(
      (await loadEntries({ ...base, contracts: ["graph", "notes"] })).entries
        .map((e) => e.item.contract)
        .sort()
    ).toEqual(["graph", "notes"]);
    expect((await loadEntries({ ...base, contracts: [...all], limit: 3 })).entries).toHaveLength(3);
    expect(
      (await loadEntries({ ...base, contracts: [...all], perContract: 1 })).entries
    ).toHaveLength(7);
    expect(
      (await loadEntries({ ...base, contracts: ["graph"], perContract: 0 })).entries
    ).toHaveLength(0);
  });

  it("plans a run without a model: the recording's own record and the hours at assumed rates", async () => {
    const plan = await buildPlan({
      cassette: await cassette(),
      contracts: ["summary", "notes", "graph", "confirmation", "topic-names", "overview", "typing"],
      limit: null,
      perContract: null,
      promptSource: "recorded",
      arm: "m9b4"
    });
    expect(plan.selected).toMatchObject({ graph: 1, notes: 1 });
    expect(plan.recordedTokens).toEqual({ input: 7_000, output: 2_100 });
    expect(plan.recordedBaseline.graph).toEqual({
      items: 1,
      noRepair: 1,
      firstPassClean: 1,
      repairCalls: 0,
      salvagedItems: 0,
      ok: 1
    });
    expect(plan.projections).toHaveLength(1);
    expect(plan.projections[0]!.arm).toBe("m9b4");
    const text = renderPlan(plan);
    expect(text).toContain("Recorded repairs (not replayed)");
    expect(text).toContain("m9b4:");
  });

  it("projects hours from the recorded tokens and an arm's assumed rates", async () => {
    const { entries } = await loadEntries({
      cassette: await cassette(),
      contracts: ["graph"],
      limit: null,
      perContract: null
    });
    const hours = projectHours(entries, {
      assumed: { decodeTps: 100, prefillTps: 1_000, source: "test" }
    });
    expect(hours).toBeCloseTo(((1_000 / 1_000 + 300 / 100) * 1.1) / 3_600, 10);
  });
});

describe("choosing the arm", () => {
  const base = parseOptions(["run", "--data-root", "/data/.cache"]);

  it("finds an installed or downloaded arm's folder under the data root", () => {
    expect(resolveArm({ ...base, arm: "gemma4-26b-a4b" }).modelDir).toBe(
      "/data/.cache/models/gemma-4-26b-a4b-it-4bit-mlx"
    );
    expect(resolveArm({ ...base, arm: "m9b4", modelDir: "/elsewhere" }).modelDir).toBe(
      "/elsewhere"
    );
  });

  it("makes an arm of any folder, and refuses an unknown or incomplete one", () => {
    expect(
      resolveArm({ ...base, arm: "custom", modelDir: "/m.gguf", runtime: "gguf", label: "x" }).arm
    ).toMatchObject({
      runtime: "gguf",
      label: "x"
    });
    expect(() => resolveArm({ ...base, arm: "custom" })).toThrow(/--model-dir/u);
    expect(() => resolveArm({ ...base, arm: "nope" })).toThrow(/--arm/u);
    expect(() => resolveArm(base)).toThrow(/--arm/u);
  });
});

/** The answer a fake writer gives to a prompt, by what it asks. */
function answerFor(input: string): string {
  if (input.includes("Reply with the single word OK.")) return "OK";
  if (input.includes("Generate independent atomic knowledge notes")) return notesAnswer;
  if (input.includes("Extract knowledge graph elements")) return graphAnswer;
  if (input.includes("Match entities only"))
    return JSON.stringify({
      matches: [
        ["r1", "c1"],
        ["r2", null]
      ]
    });
  if (input.includes("Name the numbered topics")) return namesAnswer;
  if (input.includes("Write a short overview")) return overviewAnswer;
  if (input.includes("Classify how each pair")) return typingAnswer;
  if (input.includes("Summarize this source")) return summaryAnswer;
  throw new Error(`no answer for ${input.slice(0, 40)}`);
}

interface Harness {
  deps: Dependencies;
  events: string[];
  requests: AiTaskRequest[];
}

function harness(options: { supportsSchema?: boolean } = {}): Harness {
  const events: string[] = [];
  const requests: AiTaskRequest[] = [];
  let now = 0;
  const writer: OpenedWriter = {
    helperSha256: "ab".repeat(32),
    capabilities: options.supportsSchema ? ["cancel", "schema"] : ["cancel"],
    helperPid: () => 99,
    supportsSchema: () => options.supportsSchema ?? false,
    async call(request, onText): Promise<AiTaskResult> {
      requests.push(request);
      now += 500;
      onText("{");
      now += 500;
      return {
        taskType: request.taskType,
        output: answerFor(String(request.input)),
        providerId: "local-mlx",
        modelId: "writer",
        runtime: "local",
        durationMs: 1_000,
        inputTokens: 1_000,
        outputTokens: 100
      };
    },
    async dispose() {
      events.push("dispose");
    }
  };
  const deps: Dependencies = {
    async openWriter(arm, modelDir, helperPath) {
      events.push(`open ${arm.id} ${modelDir} ${helperPath ?? "none"}`);
      return writer;
    },
    async withLock(work) {
      events.push("lock");
      try {
        return await work();
      } finally {
        events.push("unlock");
      }
    },
    probe: {
      sample: async () => ({
        helperRssMiB: 4_096,
        helperFootprintMiB: 6_000,
        helperFootprintPeakMiB: 7_000,
        swapUsedMiB: 200,
        memoryLevel: 60
      })
    },
    machine: async () => ({ chip: "test chip" }),
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    clock: () => now,
    log: () => undefined
  };
  return { deps, events, requests };
}

describe("running an arm", () => {
  async function setup(extra: Partial<Options> = {}): Promise<Options> {
    const cassette = join(root, "golden", "cassettes", "test");
    await writeCassette(cassette, everyContract());
    const modelDir = join(root, "models", "writer");
    await mkdir(modelDir, { recursive: true });
    return {
      ...parseOptions([
        "run",
        "--arm",
        "custom",
        "--data-root",
        root,
        "--run-id",
        "run-1",
        "--owner",
        "T69-test"
      ]),
      cassette,
      modelDir,
      helperPath: "/helper/memora-mlx-helper",
      ...extra
    };
  }

  it("holds the lock around the whole run and leaves a manifest, the items and a summary", async () => {
    const { deps, events, requests } = harness();
    const options = await setup({ seed: 5 });
    const result = await runCommand(options, deps);
    expect(result).toMatchObject({ replayed: 7, skipped: 0 });
    expect(events).toEqual([
      "lock",
      `open custom ${options.modelDir} /helper/memora-mlx-helper`,
      "dispose",
      "unlock"
    ]);
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"))
    );
    expect(manifest).toMatchObject({
      task: "T69",
      runId: "run-1",
      arm: { id: "custom", runtime: "mlx" },
      helper: { sha256: "ab".repeat(32), capabilities: ["cancel"] },
      cassette: { items: 7 },
      selection: { promptSource: "recorded" },
      seed: 5,
      schema: { requested: false, supported: false },
      warmup: { loadMs: 1_000, warmMs: 1_000 },
      swapBeforeMiB: 200,
      swapAfterMiB: 200,
      lock: { owner: "T69-test" }
    });
    expect(manifest.finishedAt).not.toBeNull();
    expect(manifest.lock.path).toBe(join(root, "f2", "LOCAL_MODEL_BUSY"));
    const items = parseItemLines(await readFile(join(result.directory, "items.ndjson"), "utf8"));
    expect(items.map((item) => item.contract)).toEqual([
      "summary",
      "notes",
      "graph",
      "confirmation",
      "topic-names",
      "overview",
      "typing"
    ]);
    expect(items.every((item) => item.outcome.ok)).toBe(true);
    const summary = JSON.parse(await readFile(join(result.directory, "summary.json"), "utf8")) as {
      items: number;
    };
    expect(summary.items).toBe(7);
    expect(requests).toHaveLength(9);
    expect(requests.slice(0, 2).map((request) => request.operation)).toEqual([
      "bench_warmup",
      "bench_warmup"
    ]);
    expect(
      requests.every(
        (request) => request.parameters.seed === undefined || request.parameters.seed === 5
      )
    ).toBe(true);
  });

  it("releases the lock and the writer when the run fails", async () => {
    const { deps, events } = harness();
    const options = await setup();
    const failing: Dependencies = {
      ...deps,
      async openWriter(arm, modelDir, helperPath) {
        const writer = await deps.openWriter(arm, modelDir, helperPath);
        return {
          ...writer,
          call: async () => {
            throw new Error("helper died");
          }
        };
      }
    };
    await expect(runCommand(options, failing)).rejects.toThrow("helper died");
    expect(events.at(-1)).toBe("unlock");
    expect(events).toContain("dispose");
  });

  it("refuses to run over an earlier run unless asked to resume, then skips what is done", async () => {
    const options = await setup({ warmup: false });
    const first = harness();
    await runCommand(options, first.deps);
    await expect(runCommand(options, harness().deps)).rejects.toThrow(/--resume/u);
    const again = harness();
    const result = await runCommand({ ...options, resume: true }, again.deps);
    expect(result).toMatchObject({ replayed: 0, skipped: 7 });
    expect(again.requests).toHaveLength(0);
  });

  it("will not resume a run with another prompt source, schema or seed than the one it holds", async () => {
    const options = await setup({ warmup: false, seed: 1 });
    await runCommand(options, harness().deps);
    await expect(
      runCommand({ ...options, resume: true, promptSource: "current" }, harness().deps)
    ).rejects.toThrow(/prompts/u);
    await expect(
      runCommand({ ...options, resume: true, schema: true, seed: 2 }, harness().deps)
    ).rejects.toThrow(/schema, seed/u);
    // The same options resume, and the run keeps the time it started.
    const before = JSON.parse(
      await readFile(join(root, "f4", "bench", "run-1", "manifest.json"), "utf8")
    ) as { startedAt: string };
    await runCommand({ ...options, resume: true }, harness().deps);
    const after = JSON.parse(
      await readFile(join(root, "f4", "bench", "run-1", "manifest.json"), "utf8")
    ) as { startedAt: string };
    expect(after.startedAt).toBe(before.startedAt);
  });

  it("runs again the item a stopped run was writing", async () => {
    const options = await setup({ warmup: false });
    const first = harness();
    const done = await runCommand(options, first.deps);
    const path = join(done.directory, "items.ndjson");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    await rm(path);
    await appendFile(path, `${lines.slice(0, 3).join("\n")}\n{"schemaVersion":1,"key":"torn`);
    const again = harness();
    const result = await runCommand({ ...options, resume: true }, again.deps);
    expect(result).toMatchObject({ replayed: 4, skipped: 3 });
  });

  it("sends the contract's schema to a runtime that announces one, with --schema", async () => {
    const { deps, requests } = harness({ supportsSchema: true });
    const result = await runCommand(await setup({ schema: true, warmup: false }), deps);
    const withSchema = requests.filter((request) => request.outputSchema !== undefined);
    expect(withSchema.map((request) => request.outputSchema!.name)).toContain("topic_overview");
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(result.directory, "manifest.json"), "utf8"))
    );
    expect(manifest.schema).toEqual({ requested: true, supported: true });
  });

  it("takes the schema from a module, so a grammar emitter plugs in without a code change", async () => {
    const module = join(root, "emitter.mjs");
    await writeFile(
      module,
      `export function schemaForContract(contract, answer) {
         return { name: contract.replace(/-/gu, "_") + "_grammar", schema: { type: "object" }, strict: false };
       }`
    );
    const { deps, requests } = harness({ supportsSchema: true });
    await runCommand(await setup({ schema: true, schemaModule: module, warmup: false }), deps);
    const names = requests.flatMap((request) =>
      request.outputSchema ? [request.outputSchema.name] : []
    );
    expect(names.sort()).toEqual(
      ["confirmation", "graph", "notes", "overview", "topic_names", "typing"]
        .map((name) => `${name}_grammar`)
        .sort()
    );
  });

  it("refuses a schema module with no emitter", async () => {
    const module = join(root, "empty.mjs");
    await writeFile(module, "export const unrelated = 1;");
    await expect(
      runCommand(await setup({ schema: true, schemaModule: module }), harness().deps)
    ).rejects.toThrow(/schemaForContract/u);
  });

  it("names a missing model folder and an empty selection", async () => {
    const options = await setup();
    await expect(
      runCommand({ ...options, modelDir: join(root, "nope") }, harness().deps)
    ).rejects.toThrow(/does not exist/u);
    await expect(runCommand({ ...options, contracts: [] }, harness().deps)).rejects.toThrow(
      /No call/u
    );
  });

  it("replays today's prompts when asked", async () => {
    const options = await setup({ warmup: false, contracts: ["graph"], promptSource: "current" });
    const { deps, requests } = harness();
    await runCommand(options, deps);
    expect(String(requests[0]!.input)).toContain(graphBody().slice(0, 200));
  });
});
