import type { AiTaskRequest, AiTaskResult } from "@app/ai";
import { describe, expect, it } from "vitest";

import { classifyRecordedCall, type SchemaSource } from "./contracts/index.ts";
import { arms } from "./replay-arms.ts";
import type { MemoryProbe } from "./replay-metrics.ts";
import {
  recordedBaseline,
  replayItem,
  replayItems,
  type ReplayEntry,
  type RunnerEnvironment,
  type RunnerSettings,
  type WriterHandle
} from "./replay-runner.ts";
import { itemRecordSchema } from "./replay-records.ts";
import {
  confirmationBody,
  graphAnswer,
  graphAnswerWithBadRelation,
  graphBody,
  notesAnswer,
  notesBody,
  overviewAnswer,
  overviewBody,
  recorded,
  summaryAnswer,
  summaryBody
} from "./test-fixtures.ts";

interface Step {
  output?: string;
  error?: Error;
  wallMs?: number;
  ttftMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  schemaMode?: "grammar" | "none";
}

function harness(script: Step[], options: { supportsSchema?: boolean } = {}) {
  let now = 1_000;
  const requests: AiTaskRequest[] = [];
  const writer: WriterHandle = {
    helperPid: () => 4242,
    supportsSchema: () => options.supportsSchema ?? false,
    async call(request, onText): Promise<AiTaskResult> {
      requests.push(request);
      const step = script[requests.length - 1];
      if (!step) throw new Error("no_step_scripted");
      const wall = step.wallMs ?? 1_000;
      if (step.error) {
        now += wall;
        throw step.error;
      }
      now += step.ttftMs ?? 0;
      onText("{");
      now += wall - (step.ttftMs ?? 0);
      return {
        taskType: request.taskType,
        output: step.output ?? "",
        providerId: "local-mlx",
        modelId: "writer",
        runtime: "local",
        durationMs: wall,
        ...(step.inputTokens !== undefined ? { inputTokens: step.inputTokens } : {}),
        ...(step.outputTokens !== undefined ? { outputTokens: step.outputTokens } : {}),
        ...(step.schemaMode ? { schemaMode: step.schemaMode } : {})
      };
    }
  };
  const probe: MemoryProbe = {
    sample: async () => ({
      helperRssMiB: 2_048,
      helperFootprintMiB: 2_500,
      helperFootprintPeakMiB: 3_000,
      swapUsedMiB: 100,
      memoryLevel: 70
    })
  };
  const environment: RunnerEnvironment = {
    writer,
    probe,
    clock: () => now,
    now: () => new Date("2026-10-23T12:00:00.000Z"),
    sampleIntervalMs: 60_000
  };
  return { environment, requests };
}

const settings: RunnerSettings = {
  arm: arms.m9b4!,
  promptSource: "recorded",
  seed: 11,
  schemaSource: null
};

function entryOf(taskType: string, body: string, output: string, language = "en"): ReplayEntry {
  const call = recorded({ taskType, body, output, language, inputTokens: 500, outputTokens: 200 });
  const classified = classifyRecordedCall(call);
  if (classified.kind !== "item") throw new Error("not an item");
  return { recorded: call, item: classified.item };
}

describe("replaying one item", () => {
  it("records the call, its speed and memory, the baseline and the yield", async () => {
    const { environment, requests } = harness([
      { output: notesAnswer, wallMs: 5_000, ttftMs: 1_000, inputTokens: 2_000, outputTokens: 101 }
    ]);
    const record = await replayItem(
      entryOf("atomic-note-generation", notesBody(), notesAnswer),
      environment,
      settings
    );
    expect(itemRecordSchema.parse(record)).toBeTruthy();
    expect(record).toMatchObject({
      contract: "notes",
      fidelity: "product-flow",
      promptSource: "recorded",
      promptDrift: false,
      firstPassClean: true,
      repairCalls: 0,
      outcome: { ok: true, error: null, salvagedItems: 0 },
      baseline: { ok: true, repairCalls: 0, salvagedItems: 0, firstPassClean: true },
      recorded: { providerId: "openai-codex", inputTokens: 500, outputTokens: 200 },
      yield: { countRatio: 1, evidenceCoverage: 1 }
    });
    expect(record.calls).toHaveLength(1);
    expect(record.calls[0]).toMatchObject({
      attempt: 0,
      isRepair: false,
      error: null,
      inputTokens: 2_000,
      outputTokens: 101,
      wallMs: 5_000,
      ttftMs: 1_000,
      prefillTps: 2_000,
      decodeTps: 25,
      schemaOffered: false,
      peakHelperRssMiB: 2_048,
      peakHelperFootprintMiB: 3_000,
      peakSwapUsedMiB: 100,
      minMemoryLevel: 70
    });
    expect(requests[0]).toMatchObject({
      taskType: "atomic-note-generation",
      operation: "atomic_note_generation"
    });
    expect(requests[0]!.parameters).toMatchObject({ seed: 11, temperature: 0.7 });
    expect(String(requests[0]!.input)).toContain(
      "Produce all natural-language response text in English"
    );
  });

  it("counts a repair, and a first answer that needed one is not clean", async () => {
    const { environment } = harness([{ output: "not json" }, { output: notesAnswer }]);
    const record = await replayItem(
      entryOf("atomic-note-generation", notesBody(), notesAnswer),
      environment,
      settings
    );
    expect(record.repairCalls).toBe(1);
    expect(record.firstPassClean).toBe(false);
    expect(record.outcome.ok).toBe(true);
    expect(record.calls.map((call) => [call.attempt, call.isRepair])).toEqual([
      [0, false],
      [1, true]
    ]);
  });

  it("is not clean when valid items were kept by salvage", async () => {
    const { environment } = harness([{ output: graphAnswerWithBadRelation }]);
    const record = await replayItem(
      entryOf("knowledge-graph-generation", graphBody(), graphAnswer),
      environment,
      settings
    );
    expect(record.outcome).toMatchObject({ ok: true });
    expect(record.outcome.salvagedItems).toBeGreaterThan(0);
    expect(record.firstPassClean).toBe(false);
    expect(record.repairCalls).toBe(0);
  });

  it("logs a failed call with its error and ends the item failed", async () => {
    const failure = Object.assign(new Error("deadline reached"), { code: "deadline" });
    const { environment } = harness([{ error: failure, wallMs: 350_000 }]);
    const record = await replayItem(
      entryOf("atomic-note-generation", notesBody(), notesAnswer),
      environment,
      settings
    );
    expect(record.outcome).toMatchObject({ ok: false, error: "Error:deadline" });
    expect(record.firstPassClean).toBe(false);
    expect(record.calls[0]).toMatchObject({
      error: "Error: deadline reached",
      output: "",
      wallMs: 350_000
    });
    expect(record.yield).toBeNull();
  });

  it("carries the caller's output allowance and workload class on the request", async () => {
    const { environment, requests } = harness([{ output: overviewAnswer }]);
    await replayItem(
      entryOf("structured-output", overviewBody(), overviewAnswer),
      environment,
      settings
    );
    expect(requests[0]).toMatchObject({ workloadClass: "write-fast", operation: "topic_overview" });
    expect(requests[0]!.parameters).toMatchObject({ maxTokens: 4096, reasoningLevel: "off" });
  });

  it("flags a prompt that differs from today's, and sends the one asked for", async () => {
    const old = graphBody().replace(
      "at most 12 entities and 12 relations",
      "at most 12 entities, 8 claims, and 12 relations"
    );
    const entry = entryOf("knowledge-graph-generation", old, graphAnswer);
    const recordedRun = harness([{ output: graphAnswer }]);
    const first = await replayItem(entry, recordedRun.environment, settings);
    expect(first.promptDrift).toBe(true);
    expect(String(recordedRun.requests[0]!.input)).toContain("8 claims");
    const currentRun = harness([{ output: graphAnswer }]);
    await replayItem(entry, currentRun.environment, { ...settings, promptSource: "current" });
    expect(String(currentRun.requests[0]!.input)).not.toContain("8 claims");
  });
});

describe("the output schema", () => {
  const source: SchemaSource = (_contract, answer) => ({
    name: answer.name,
    schema: { type: "object" },
    strict: true
  });

  it("is sent when the runtime takes one, for a contract that has one", async () => {
    const { environment, requests } = harness([{ output: overviewAnswer, schemaMode: "grammar" }], {
      supportsSchema: true
    });
    const record = await replayItem(
      entryOf("structured-output", overviewBody(), overviewAnswer),
      environment,
      {
        ...settings,
        schemaSource: source
      }
    );
    expect(requests[0]!.outputSchema).toEqual({
      name: "topic_overview",
      schema: { type: "object" },
      strict: true
    });
    expect(record.calls[0]).toMatchObject({ schemaOffered: true, schemaMode: "grammar" });
  });

  it("is not sent when the runtime does not announce it, and the call says so", async () => {
    const { environment, requests } = harness([{ output: overviewAnswer }]);
    const record = await replayItem(
      entryOf("structured-output", overviewBody(), overviewAnswer),
      environment,
      {
        ...settings,
        schemaSource: source
      }
    );
    expect(requests[0]!.outputSchema).toBeUndefined();
    expect(record.calls[0]).toMatchObject({ schemaOffered: false, schemaMode: null });
  });

  it("is not sent for a contract with no answer contract, or when the source has none", async () => {
    const summary = harness([{ output: summaryAnswer }], { supportsSchema: true });
    await replayItem(entryOf("summarization", summaryBody(), summaryAnswer), summary.environment, {
      ...settings,
      schemaSource: source
    });
    expect(summary.requests[0]!.outputSchema).toBeUndefined();
    const none = harness([{ output: overviewAnswer }], { supportsSchema: true });
    await replayItem(
      entryOf("structured-output", overviewBody(), overviewAnswer),
      none.environment,
      {
        ...settings,
        schemaSource: () => null
      }
    );
    expect(none.requests[0]!.outputSchema).toBeUndefined();
  });
});

describe("the recording under the product's flow", () => {
  it("is clean when the recorded answer needs nothing", async () => {
    const result = await recordedBaseline(
      entryOf("atomic-note-generation", notesBody(), notesAnswer),
      "recorded"
    );
    expect(result).toMatchObject({ firstPassClean: true, repairCalls: 0 });
    expect(result.outcome.ok).toBe(true);
  });

  it("counts the repair a flawed recorded answer would have asked for", async () => {
    const result = await recordedBaseline(
      entryOf("atomic-note-generation", notesBody(), "not json"),
      "recorded"
    );
    expect(result).toMatchObject({ firstPassClean: false, repairCalls: 1 });
    expect(result.outcome.ok).toBe(false);
  });

  it("counts the rows a recorded confirmation left undecided", async () => {
    const entry = entryOf(
      "knowledge-graph-generation",
      confirmationBody(),
      JSON.stringify({ matches: [["r1", "c1"]] })
    );
    expect(await recordedBaseline(entry, "recorded")).toMatchObject({
      firstPassClean: false,
      repairCalls: 1
    });
  });
});

describe("replaying a list", () => {
  const entries = () => [
    entryOf("summarization", summaryBody(), summaryAnswer),
    entryOf("atomic-note-generation", notesBody(), notesAnswer),
    entryOf("knowledge-graph-generation", graphBody(), graphAnswer)
  ];

  it("records each item as it ends and tells how far it is", async () => {
    const { environment } = harness([
      { output: summaryAnswer },
      { output: notesAnswer },
      { output: graphAnswer }
    ]);
    const seen: Array<[string, number, number]> = [];
    const result = await replayItems(entries(), environment, settings, {
      onRecord: (record, progress) => {
        seen.push([record.contract, progress.done, progress.total]);
      }
    });
    expect(result).toEqual({ replayed: 3, skipped: 0 });
    expect(seen).toEqual([
      ["summary", 1, 3],
      ["notes", 2, 3],
      ["graph", 3, 3]
    ]);
  });

  it("skips what a stopped run already did", async () => {
    const list = entries();
    const { environment, requests } = harness([{ output: notesAnswer }, { output: graphAnswer }]);
    const result = await replayItems(list, environment, settings, {
      done: new Set([list[0]!.recorded.key]),
      onRecord: () => undefined
    });
    expect(result).toEqual({ replayed: 2, skipped: 1 });
    expect(requests).toHaveLength(2);
  });

  it("stops at once when asked to", async () => {
    const { environment } = harness([{ output: summaryAnswer }]);
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    await expect(
      replayItems(entries(), environment, settings, {
        signal: controller.signal,
        onRecord: () => undefined
      })
    ).rejects.toThrow("stop");
  });
});
