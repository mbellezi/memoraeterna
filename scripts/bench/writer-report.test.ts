import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { CallRecord, ItemRecord, RunManifest } from "./replay-records.ts";
import {
  readRun,
  renderReport,
  spikeBars,
  summarizeContract,
  summarizeRun
} from "./writer-report.ts";

function call(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    attempt: 0,
    operation: "graph_atomic_notes",
    isRepair: false,
    inputChars: 4_000,
    parameters: { maxTokens: 1000 },
    output: "{}",
    error: null,
    inputTokens: 1_000,
    outputTokens: 200,
    wallMs: 10_000,
    ttftMs: 1_000,
    prefillTps: 1_000,
    decodeTps: 20,
    schemaMode: "none",
    schemaOffered: false,
    peakHelperRssMiB: 10_240,
    peakHelperFootprintMiB: 12_288,
    peakSwapUsedMiB: 300,
    minMemoryLevel: 55,
    ...overrides
  };
}

function item(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    schemaVersion: 1,
    key: Math.random().toString(16).slice(2).padEnd(64, "0"),
    contract: "graph",
    fidelity: "product-flow",
    taskType: "knowledge-graph-generation",
    operation: "graph_atomic_notes",
    language: "en",
    promptSource: "recorded",
    promptDrift: false,
    recorded: {
      providerId: "openai-codex",
      modelId: "gpt",
      inputTokens: 1_000,
      outputTokens: 400,
      durationMs: 4_000
    },
    baseline: { ok: true, error: null, repairCalls: 0, salvagedItems: 0, firstPassClean: true },
    calls: [call()],
    outcome: { ok: true, error: null, salvagedItems: 0 },
    firstPassClean: true,
    repairCalls: 0,
    yield: { entityRecall: 0.9, relationRecall: 0.8 },
    startedAt: "2026-10-23T12:00:00.000Z",
    wallMs: 10_500,
    ...overrides
  };
}

function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    schemaVersion: 1,
    task: "T69",
    runId: "m9b4-recorded-1",
    startedAt: "2026-10-23T12:00:00.000Z",
    finishedAt: "2026-10-23T18:00:00.000Z",
    arm: {
      id: "m9b4",
      label: "Qwen3.5-9B 4-bit",
      runtime: "mlx",
      catalogId: "mlx-qwen3.5-9b-4bit",
      modelDir: "/m",
      parameterSource: "catalog"
    },
    helper: { path: "/h", sha256: "44d081e0ce0b8fd4".padEnd(64, "0"), capabilities: ["cancel"] },
    cassette: { directory: "/c", items: 4 },
    selection: { contracts: ["graph"], limit: null, promptSource: "recorded" },
    parameters: {},
    seed: 1,
    schema: { requested: false, supported: false },
    machine: {},
    warmup: { loadMs: 8_000, warmMs: 400 },
    swapBeforeMiB: 100,
    swapAfterMiB: 120,
    lock: { path: "/lock", owner: "T69" },
    ...overrides
  };
}

describe("summarizing a contract", () => {
  const records = [
    item(),
    item({
      firstPassClean: false,
      repairCalls: 1,
      calls: [call(), call({ attempt: 1, isRepair: true, decodeTps: 10, wallMs: 20_000 })],
      baseline: { ok: true, error: null, repairCalls: 0, salvagedItems: 2, firstPassClean: false },
      yield: { entityRecall: 0.5, relationRecall: 0.4 }
    }),
    item({
      firstPassClean: false,
      outcome: {
        ok: false,
        error: "knowledge_graph_output_invalid:nothing_valid",
        salvagedItems: 0
      },
      calls: [
        call({
          error: "Error: deadline",
          output: "",
          decodeTps: null,
          ttftMs: null,
          wallMs: 350_000
        })
      ],
      yield: null
    })
  ];

  it("counts calls, repairs, errors and validity", () => {
    const summary = summarizeContract("graph", records);
    expect(summary).toMatchObject({
      items: 3,
      calls: 4,
      repairCalls: 1,
      callErrors: 1,
      noRepair: 1,
      firstPassClean: 1,
      finalOk: 2,
      recordedNoRepair: 3,
      recordedFirstPassClean: 2,
      recordedSalvagedItems: 2,
      errors: { "knowledge_graph_output_invalid:nothing_valid": 1 },
      schemaModes: { none: 3 }
    });
  });

  it("reads speed from the calls that answered, and memory from all", () => {
    const summary = summarizeContract("graph", records);
    expect(summary.decodeTpsP50).toBe(20);
    expect(summary.decodeTpsP05).toBe(10);
    expect(summary.ttftMsP50).toBe(1_000);
    expect(summary.wallMsP50).toBe(10_000);
    expect(summary.wallHours).toBeCloseTo((10_000 + 10_000 + 20_000 + 350_000) / 3_600_000, 10);
    expect(summary.peakHelperRssMiB).toBe(10_240);
    expect(summary.peakHelperFootprintMiB).toBe(12_288);
    expect(summary.minMemoryLevel).toBe(55);
  });

  it("means the yield over the items that have one", () => {
    const yielded = summarizeContract("graph", records).yield;
    expect(yielded.entityRecall).toBeCloseTo(0.7, 10);
    expect(yielded.relationRecall).toBeCloseTo(0.6, 10);
  });

  it("compares output tokens with the recorded answers on the items that have both counts", () => {
    const missing = item({ calls: [call({ outputTokens: null })] });
    expect(summarizeContract("graph", records.slice(0, 1)).outputTokenRatio).toBe(0.5);
    expect(summarizeContract("graph", [...records.slice(0, 1), missing]).outputTokenRatio).toBe(
      0.5
    );
    expect(summarizeContract("graph", [missing]).outputTokenRatio).toBeNull();
  });
});

describe("summarizing a run and rendering it", () => {
  const records = [
    item(),
    item({ contract: "notes", operation: "atomic_note_generation", yield: { countRatio: 1.2 } }),
    item({ contract: "notes", operation: "atomic_note_generation", yield: { countRatio: 0.8 } })
  ];

  it("splits the contracts, keeps the overall row and the swap growth", () => {
    const run = summarizeRun(manifest(), records);
    expect(run.byContract.map((row) => row.contract)).toEqual(
      ["notes", "graph"].sort(
        (a, b) => ["notes", "graph"].indexOf(a) - ["notes", "graph"].indexOf(b)
      )
    );
    expect(run.overall.contract).toBe("all");
    expect(run).toMatchObject({
      items: 3,
      planned: 4,
      swapGrowthMiB: 200,
      loadMs: 8_000,
      arm: "m9b4"
    });
  });

  it("renders the tables, with the bars beside the numbers", () => {
    const text = renderReport([summarizeRun(manifest(), records)]);
    expect(text).toContain("## Runs");
    expect(text).toContain("| Qwen3.5-9B 4-bit | m9b4-recorded-1 | recorded | no / no | 3 of 4 |");
    expect(text).toContain("## Structure: first answer, repairs and final validity");
    expect(text).toContain(
      "| m9b4 | all | 3 | 100.0% | 100.0% | 100.0% | 100.0% | 0 | 0.0% (meets bar) | 100.0% | 0 (0) |"
    );
    expect(text).toContain("## Speed and memory");
    expect(text).toContain("20.0 / 20.0");
    expect(text).toContain("12.0 / 10.0");
    expect(text).toContain("## Yield against the recorded Codex answer");
    expect(text).toContain("countRatio 1.00");
    expect(text).toContain("20.0 tok/s (meets bar)");
    expect(text).toContain("200 MiB (meets bar)");
    expect(text).toContain("80.0% (misses bar)");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("marks a repair share, a decode speed and a swap growth that miss their bars", () => {
    const slow = summarizeRun(manifest({ swapBeforeMiB: 0 }), [
      item({
        repairCalls: 1,
        firstPassClean: false,
        calls: [
          call({ decodeTps: 5, peakSwapUsedMiB: 900 }),
          call({ attempt: 1, isRepair: true, decodeTps: 5 })
        ]
      })
    ]);
    const text = renderReport([slow]);
    expect(text).toContain("5.0 tok/s (misses bar)");
    expect(text).toContain("50.0% (misses bar)");
    expect(text).toContain("900 MiB (misses bar)");
    expect(spikeBars.swapGrowthMiB).toBe(256);
  });

  it("sets a run with the schema beside the run of the same arm without it", () => {
    const plain = summarizeRun(manifest(), [
      item({ calls: [call({ decodeTps: 20 })] }),
      item({
        calls: [call({ decodeTps: 20 }), call({ attempt: 1, isRepair: true })],
        repairCalls: 1
      })
    ]);
    const withSchema = summarizeRun(
      manifest({
        runId: "m9b4-recorded-schema-1",
        schema: { requested: true, supported: true }
      }),
      [
        item({
          calls: [
            call({
              decodeTps: 18,
              schemaMode: "grammar",
              schemaOffered: true,
              grammarCompileMs: 0.4
            })
          ]
        })
      ]
    );
    const text = renderReport([plain, withSchema]);
    expect(text).toContain("## With and without the output schema");
    expect(text).toContain(
      "| m9b4 | graph | 20.0 → 18.0 (0.90x) | 50.0% → 100.0% | 33.3% → 0.0% |"
    );
    expect(text).toContain("grammar 1 | 0.40 |");
    expect(renderReport([plain])).not.toContain("With and without");
    expect(renderReport([withSchema])).not.toContain("With and without");
  });

  it("renders a run with nothing in it", () => {
    const text = renderReport([summarizeRun(manifest(), [])]);
    expect(text).toContain("0 of 4");
    expect(text).toContain("n/a");
  });
});

describe("reading a run folder", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "bench-report-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("reads the manifest and the items, dropping a torn last line", async () => {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
    await writeFile(
      join(directory, "items.ndjson"),
      `${JSON.stringify(item())}\n${JSON.stringify(item())}\n{"schemaVersion":1,"ke`
    );
    const run = await readRun(directory);
    expect(run.records).toHaveLength(2);
    expect(run.manifest.runId).toBe("m9b4-recorded-1");
  });

  it("stops at a bad line that is not the last", async () => {
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
    await writeFile(join(directory, "items.ndjson"), `{"bad":true}\n${JSON.stringify(item())}\n`);
    await expect(readRun(directory)).rejects.toThrow();
  });

  it("reads a run that stopped before its first item", async () => {
    await writeFile(join(directory, "manifest.json"), JSON.stringify(manifest()));
    expect((await readRun(directory)).records).toEqual([]);
  });

  it("refuses a folder with no manifest", async () => {
    await expect(readRun(directory)).rejects.toThrow();
  });
});
