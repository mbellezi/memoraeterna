import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { shownNoteRelationSql, type PgPool } from "@app/db";

import {
  explainProbeKnob,
  explainProbeOpensKnob,
  explainProbeRequested,
  measureExplanations,
  nearestRank,
  pickRelationsToOpen,
  readExplainProbeKnob,
  runExplainProbe,
  summarizeLatencies,
  type ExplainProbeMeter
} from "./explain-probe.js";

const workspaceRoot = resolve("/workspace/memora");
const dev = { isPackaged: false, workspaceRoot };
const knob = (value: string, extra: Record<string, string> = {}) => ({
  [explainProbeKnob]: value,
  ...extra
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("the explanation probe knob", () => {
  it("is off when unset and reads the report path and the number of opens", () => {
    expect(readExplainProbeKnob({}, dev)).toBeNull();
    expect(readExplainProbeKnob(knob("  "), dev)).toBeNull();
    expect(readExplainProbeKnob(knob(".cache/f3/t59/probe.json"), dev)).toEqual({
      reportPath: join(workspaceRoot, ".cache/f3/t59/probe.json"),
      opens: 10
    });
    expect(
      readExplainProbeKnob(knob(".cache/probe.json", { [explainProbeOpensKnob]: "25" }), dev)?.opens
    ).toBe(25);
  });

  it("is refused in a packaged build", () => {
    expect(() =>
      readExplainProbeKnob(knob(".cache/probe.json"), { ...dev, isPackaged: true })
    ).toThrow("MEMORA_DEV_EXPLAIN_PROBE is refused in packaged builds");
  });

  it("is refused with a cassette, a fake remote or another measurement run", () => {
    for (const name of [
      "MEMORA_AI_CASSETTE",
      "MEMORA_GOLDEN_RUN",
      "MEMORA_FAKE_REMOTE",
      "MEMORA_DEV_LANE_PROBE",
      "MEMORA_TYPER_CHECK"
    ])
      expect(() => readExplainProbeKnob(knob(".cache/probe.json", { [name]: "x" }), dev)).toThrow(
        `refused with ${name}`
      );
  });

  it("is refused for a report outside .cache or that is not a JSON file", () => {
    for (const value of [
      "probe.json",
      "../outside/probe.json",
      "/etc/probe.json",
      ".cache/probe.txt",
      ".cache",
      ".cache/../src/probe.json",
      "1"
    ])
      expect(() => readExplainProbeKnob(knob(value), dev)).toThrow("must name a .json report");
  });

  it("is refused for a number of opens that is not 1 to 50", () => {
    for (const opens of ["0", "51", "ten", "2.5", "-1"])
      expect(() =>
        readExplainProbeKnob(knob(".cache/probe.json", { [explainProbeOpensKnob]: opens }), dev)
      ).toThrow("whole number from 1 to 50");
  });

  it("is requested only by a knob that is accepted, so a refused one leaves the app as it was", () => {
    expect(explainProbeRequested(knob(".cache/probe.json"), dev)).toBe(true);
    expect(explainProbeRequested({}, dev)).toBe(false);
    expect(explainProbeRequested(knob(".cache/probe.json"), { ...dev, isPackaged: true })).toBe(
      false
    );
    expect(explainProbeRequested(knob("probe.json"), dev)).toBe(false);
  });
});

describe("the latency summary", () => {
  it("takes the nearest rank, so ten opens give the 5th and the 10th value for p50 and p95", () => {
    const values = [900, 100, 300, 200, 1000, 700, 500, 400, 800, 600];
    expect(nearestRank(values, 0.5)).toBe(500);
    expect(nearestRank(values, 0.95)).toBe(1000);
    expect(summarizeLatencies(values)).toEqual({ count: 10, p50: 500, p95: 1000, max: 1000 });
    expect(summarizeLatencies([])).toEqual({ count: 0, p50: null, p95: null, max: null });
    expect(summarizeLatencies([12.6])).toEqual({ count: 1, p50: 13, p95: 13, max: 13 });
  });
});

describe("measuring the opens", () => {
  const meter = (): ExplainProbeMeter => ({
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    callsWithUnknownTokens: 0
  });

  it("times the first text and the whole explanation, and shows that a second open makes no call", async () => {
    let clock = 0;
    const now = () => clock;
    const counted = meter();
    const written = new Set<string>();
    const explain = vi.fn(async (relationId: string, onText: (text: string) => void) => {
      if (!written.has(relationId)) {
        counted.calls += 1;
        counted.inputTokens += 100;
        counted.outputTokens += 20;
        clock += 400;
        onText("");
        onText("The first note");
        clock += 600;
        onText("The first note supports the second.");
        written.add(relationId);
      }
      return {
        relationId,
        text: "The first note supports the second.",
        writtenBy: "writer",
        writtenAt: "2026-10-18T10:00:00.000Z"
      };
    });
    const result = await measureExplanations({
      relationIds: [id(1), id(2)],
      explain,
      meter: counted,
      now
    });
    expect(result.firstOpen.calls).toBe(2);
    expect(result.firstOpen.inputTokens).toBe(200);
    expect(result.firstOpen.outputTokens).toBe(40);
    expect(result.firstOpen.opens[0]).toMatchObject({
      outcome: "explained",
      streamed: true,
      messages: 2,
      firstDeltaMs: 400,
      totalMs: 1000,
      calls: 1
    });
    expect(result.firstOpen.firstDeltaMs).toMatchObject({ p50: 400, p95: 400 });
    expect(result.firstOpen.totalMs).toMatchObject({ p50: 1000, p95: 1000 });
    expect(result.firstOpen).toMatchObject({ explained: 2, vetoed: 0, streamed: 2 });
    // The second open reads the cache: no call, no stream.
    expect(result.secondOpenMakesNoCall).toBe(true);
    expect(result.secondOpen.calls).toBe(0);
    expect(
      result.secondOpen.opens.every((open) => !open.streamed && open.firstDeltaMs === null)
    ).toBe(true);
  });

  it("counts a veto, a gone relation and a failure, and goes on", async () => {
    const counted = meter();
    const explain = vi.fn(async (relationId: string) => {
      counted.calls += 1;
      if (relationId === id(1)) return { relationId, vetoed: true as const };
      if (relationId === id(2)) return null;
      throw new Error("errors.ai.noCompatibleModel");
    });
    const result = await measureExplanations({
      relationIds: [id(1), id(2), id(3)],
      explain,
      meter: counted
    });
    expect(result.firstOpen.opens.map((open) => open.outcome)).toEqual([
      "vetoed",
      "none",
      "failed"
    ]);
    expect(result.firstOpen.opens[2]).toMatchObject({ error: "errors.ai.noCompatibleModel" });
    expect(result.firstOpen.vetoed).toBe(1);
    // A second open that still asks the writer is not the bar.
    expect(result.secondOpenMakesNoCall).toBe(false);
  });
});

describe("choosing the relations to open", () => {
  it("reads shown relations without an explanation through the visibility predicates", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: id(1) }, { id: id(2) }] }));
    expect(await pickRelationsToOpen({ query } as never, 10)).toEqual([id(1), id(2)]);
    const [statement, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(values).toEqual([10]);
    expect(statement).toContain("x.relation_id is null");
    // What counts as shown is the visibility module's predicate, not a filter of the probe.
    expect(statement).toContain(shownNoteRelationSql("r", ["a", "b"]));
  });
});

describe("running the probe from the app", () => {
  let directory = "";
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = "";
  });

  const quiet = { info: vi.fn(), error: vi.fn() };

  it("writes its report under .cache and returns done", async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-explain-probe-"));
    // The relation is picked, then found gone by the service that reads it: nothing is asked of the
    // writer, and the second open makes no call either.
    const query = vi.fn(async (statement: string) => ({
      rows: statement.includes("order by md5") ? [{ id: id(1) }] : []
    }));
    const pool = { query } as unknown as PgPool;
    const runDefaultTask = vi.fn(async () => null);
    const outcome = await runExplainProbe({
      env: knob(".cache/f3/t59/probe.json", { [explainProbeOpensKnob]: "1" }),
      isPackaged: false,
      workspaceRoot: directory,
      pool,
      ai: { runDefaultTask } as never,
      getContentLanguage: async () => "en",
      resolveWriter: async () => ({ promptRevision: "prompt-3", model: "model-a" }),
      logger: quiet,
      now: () => new Date("2026-10-18T10:00:00.000Z")
    });
    expect(outcome).toBe("done");
    expect(runDefaultTask).not.toHaveBeenCalled();
    const report = JSON.parse(await readFile(join(directory, ".cache/f3/t59/probe.json"), "utf8"));
    expect(report).toMatchObject({
      format: "explain-probe-v1",
      generatedAt: "2026-10-18T10:00:00.000Z",
      opens: 1,
      writer: { promptRevision: "prompt-3", model: "model-a" },
      secondOpenMakesNoCall: true
    });
    expect(report.firstOpen.opens).toMatchObject([{ relationId: id(1), outcome: "none" }]);
    expect(report.error).toBeUndefined();
  });

  it("is off without the knob and refuses when packaged, sending nothing", async () => {
    const runDefaultTask = vi.fn();
    const base = {
      workspaceRoot,
      pool: { query: vi.fn() } as unknown as PgPool,
      ai: { runDefaultTask } as never,
      getContentLanguage: async () => "en",
      resolveWriter: async () => null,
      logger: quiet
    };
    expect(await runExplainProbe({ ...base, env: {}, isPackaged: false })).toBe("off");
    expect(
      await runExplainProbe({ ...base, env: knob(".cache/probe.json"), isPackaged: true })
    ).toBe("refused");
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining("refused in packaged builds"));
    expect(runDefaultTask).not.toHaveBeenCalled();
  });
});
