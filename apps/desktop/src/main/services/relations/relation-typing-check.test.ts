import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  maxTyperCheckPairs,
  readTyperCheckEnvironment,
  readTyperCheckPairs,
  runTyperCheckFromEnvironment,
  runTyperPositionCheck,
  summarizeTyperCheck,
  TyperCheckPairsFileSchema,
  typerCheckBars,
  type TyperCheckPair,
  type TyperCheckPairResult,
  type TyperCheckReading
} from "./relation-typing-check.js";
import type { RelationTypingDeps, TyperRoute } from "./relation-typing.js";

const remote: TyperRoute = {
  lane: "remote",
  provider: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  parameters: {}
};

/** `n` panel pairs; the subject alternates, so the notes' order never predicts it. */
function panelPairs(count: number): TyperCheckPair[] {
  return Array.from({ length: count }, (_, index) => {
    const n = String(index).padStart(3, "0");
    return {
      id: `q-${n}`,
      a: `Note A${n}\nClaim A${n}`,
      b: `Note B${n}\nClaim B${n}`,
      type: "supports",
      subject: index % 2 === 0 ? "a" : "b"
    } as TyperCheckPair;
  });
}

/** A writer that names the panel's subject whatever the order: the unbiased reference. */
function steadyAi(pairs: readonly TyperCheckPair[]) {
  const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
    const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{
      p: string;
      a: string;
      b: string;
    }>;
    return execution({
      pairs: wire.map((entry) => {
        // The panel's subject, read from the texts: A-notes are the panel's a.
        const shown = entry.a.startsWith("Note A") ? "a" : "b";
        const id = /(?:A|B)(\d{3})/u.exec(entry.a)![1]!;
        const panel = pairs.find((pair) => pair.id === `q-${id}`)!.subject;
        return { p: entry.p, t: "supports", d: panel === shown ? "ab" : "ba" };
      })
    });
  });
  return { runDefaultTask };
}

/** A writer with a position bias: it always says the note shown first is the subject. */
function biasedAi() {
  const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
    const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{ p: string }>;
    return execution({ pairs: wire.map((entry) => ({ p: entry.p, t: "supports", d: "ab" })) });
  });
  return { runDefaultTask };
}

function execution(output: unknown) {
  return {
    taskType: "structured-output" as const,
    output,
    providerId: "openai-codex" as const,
    modelId: "gpt-test",
    runtime: "remote" as const,
    durationMs: 1,
    inputTokens: 1000,
    outputTokens: 100,
    profileId: randomUUID(),
    aiTaskRunId: randomUUID(),
    outputLanguage: "en"
  };
}

const deps = (ai: { runDefaultTask: unknown }): Omit<RelationTypingDeps, "store"> => ({
  ai: ai as RelationTypingDeps["ai"],
  resolveRoute: async () => remote
});

describe("the position-bias check", () => {
  it("types 60 pairs in both orders in 6 calls and finds an unbiased writer consistent", async () => {
    const pairs = panelPairs(60);
    const ai = steadyAi(pairs);
    const run = await runTyperPositionCheck(deps(ai), pairs);
    expect(run.calls).toBe(6);
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(6);
    expect(run.inputTokens).toBe(6000);
    expect(run.aiTaskRunIds).toHaveLength(6);
    expect(run.typerKey).toMatch(/^[0-9a-f]{64}$/);
    expect(run.summary).toMatchObject({
      pairs: 60,
      typings: 120,
      directionAccuracy: 1,
      directionAccuracyByOrder: [1, 1],
      swapConsistency: 1,
      typeSwapConsistency: 1,
      verdictSwapConsistency: 1,
      typeAgreement: 1,
      vetoes: 0,
      untyped: 0,
      meetsBars: { directionAccuracy: true, swapConsistency: true }
    });
    // The two orders show opposite notes first.
    for (const result of run.results)
      expect(result.readings[0].shownFirst).not.toBe(result.readings[1]?.shownFirst);
  });

  it("types in content order only when asked: one call per batch, no swap numbers", async () => {
    const pairs = panelPairs(60);
    const ai = steadyAi(pairs);
    const run = await runTyperPositionCheck(deps(ai), pairs, { orders: "content" });
    expect(run.calls).toBe(3);
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(3);
    for (const result of run.results) expect(result.readings).toHaveLength(1);
    expect(run.summary).toMatchObject({
      pairs: 60,
      typings: 60,
      directionAccuracy: 1,
      directionAccuracyByOrder: [1, null],
      swapConsistency: null,
      typeSwapConsistency: null,
      verdictSwapConsistency: null,
      meetsBars: null
    });
  });

  it("measures a writer that always names the note shown first: half right, never consistent", async () => {
    const run = await runTyperPositionCheck(deps(biasedAi()), panelPairs(60));
    expect(run.summary.directionAccuracy).toBe(0.5);
    expect(run.summary.swapConsistency).toBe(0);
    expect(run.summary.verdictSwapConsistency).toBe(0);
    expect(run.summary.typeSwapConsistency).toBe(1);
    expect(run.summary.firstPositionShare).toBe(1);
    expect(run.summary.panelFirstPositionShare).toBe(0.5);
    expect(run.summary.meetsBars).toEqual({ directionAccuracy: false, swapConsistency: false });
  });

  it("runs the product's typing step: no cache, accept band, the write-fast class", async () => {
    const pairs = panelPairs(3);
    const ai = steadyAi(pairs);
    await runTyperPositionCheck(deps(ai), pairs, { priority: "P0" });
    const [, , context] = ai.runDefaultTask.mock.calls[0]! as unknown as [
      string,
      string,
      Record<string, unknown>
    ];
    expect(context).toMatchObject({
      operation: "relation_typing",
      workloadClass: "write-fast",
      priority: "P0"
    });
    expect(ai.runDefaultTask).toHaveBeenCalledTimes(2);
  });

  it("counts a veto or no answer as a miss", async () => {
    const pairs = panelPairs(2);
    const ai = {
      runDefaultTask: vi.fn(async (_task: string, prompt: string) => {
        const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{
          p: string;
          a: string;
        }>;
        // The first pair is vetoed; the second is never answered.
        return execution({
          pairs: wire
            .filter((entry) => entry.a.includes("000"))
            .map((entry) => ({ p: entry.p, t: "none", d: "none" }))
        });
      })
    };
    const run = await runTyperPositionCheck(deps(ai), pairs);
    expect(run.summary.vetoes).toBe(2);
    expect(run.summary.untyped).toBe(2);
    expect(run.summary.directionAccuracy).toBe(0);
    expect(run.summary.swapConsistency).toBe(0);
    // The unanswered pair was asked again once in each order, and no more.
    expect(run.calls).toBe(4);
  });
});

describe("the summary", () => {
  const reading = (
    shownFirst: "a" | "b",
    type: TyperCheckReading["type"],
    subject: TyperCheckReading["subject"]
  ): TyperCheckReading => ({
    shownFirst,
    verdict: type === null ? "untyped" : "typed",
    type,
    subject
  });
  const result = (
    id: string,
    panelSubject: "a" | "b",
    first: TyperCheckReading,
    second: TyperCheckReading
  ): TyperCheckPairResult => ({
    id,
    panel: { type: "supports", subject: panelSubject },
    readings: [first, second]
  });

  it("reads accuracy, agreement and swap consistency apart", () => {
    const summary = summarizeTyperCheck([
      result("1", "a", reading("a", "supports", "a"), reading("b", "supports", "a")),
      result("2", "b", reading("a", "supports", "b"), reading("b", "extends", "b")),
      result("3", "a", reading("a", "supports", "a"), reading("b", "supports", "b")),
      result("4", "b", reading("b", null, null), reading("a", "supports", "b"))
    ]);
    // Correct readings: 1:2, 2:2, 3:1, 4:1 of 8.
    expect(summary.directionAccuracy).toBe(6 / 8);
    expect(summary.directionAccuracyByOrder).toEqual([3 / 4, 3 / 4]);
    // The directed readings are 7 and 6 of them are correct.
    expect(summary.directionAccuracyWhenDirected).toBe(6 / 7);
    expect(summary.typeAgreement).toBe(6 / 8);
    expect(summary.swapConsistency).toBe(2 / 4);
    expect(summary.typeSwapConsistency).toBe(2 / 4);
    expect(summary.verdictSwapConsistency).toBe(1 / 4);
    expect(summary.untyped).toBe(1);
    expect(summary.meetsBars).toEqual({ directionAccuracy: false, swapConsistency: false });
  });

  it("states the bars gate F reads and reports nothing for no pair", () => {
    expect(typerCheckBars).toEqual({ directionAccuracy: 0.85, swapConsistency: 0.9 });
    expect(summarizeTyperCheck([])).toMatchObject({
      pairs: 0,
      directionAccuracy: null,
      swapConsistency: null,
      meetsBars: null
    });
  });
});

describe("the pairs file", () => {
  const pair = panelPairs(1)[0]!;

  it("takes directed panel types with a subject, each id once", () => {
    expect(TyperCheckPairsFileSchema.safeParse({ pairs: [pair] }).success).toBe(true);
    expect(
      TyperCheckPairsFileSchema.safeParse({ pairs: [{ ...pair, type: "same_as" }] }).success
    ).toBe(false);
    expect(
      TyperCheckPairsFileSchema.safeParse({ pairs: [{ ...pair, subject: "both" }] }).success
    ).toBe(false);
    expect(TyperCheckPairsFileSchema.safeParse({ pairs: [pair, pair] }).success).toBe(false);
    expect(TyperCheckPairsFileSchema.safeParse({ pairs: [] }).success).toBe(false);
    expect(
      TyperCheckPairsFileSchema.safeParse({ pairs: panelPairs(maxTyperCheckPairs + 1) }).success
    ).toBe(false);
    expect(TyperCheckPairsFileSchema.safeParse({ pairs: [{ ...pair, why: "x" }] }).success).toBe(
      false
    );
  });
});

/** The AI configuration's writer route, as the route resolver reads it. */
const routePool = () => ({
  query: vi.fn(async () => ({
    rows: [
      {
        routeKey: "class:write-fast",
        profileId: randomUUID(),
        privacyMode: "allow_remote",
        providerConfigId: randomUUID(),
        localModelId: null,
        provider: "openai-codex",
        credentialRef: null,
        baseUrl: null,
        modelId: "gpt-test",
        runtime: "remote",
        managedPath: null,
        repository: null,
        revision: null,
        quantization: null,
        requiredCapabilities: ["structured-output"],
        parameters: {},
        modelDefaultParameters: {},
        providerMetadata: {},
        outputLanguage: "en"
      }
    ]
  }))
});

describe("the DEV knob", () => {
  it("is off without the variable, resolves a relative path, and is refused when packaged", () => {
    const options = { isPackaged: false, workspaceRoot: "/repo" };
    expect(readTyperCheckEnvironment({}, options)).toBeNull();
    expect(readTyperCheckEnvironment({ MEMORA_TYPER_CHECK: "  " }, options)).toBeNull();
    expect(
      readTyperCheckEnvironment({ MEMORA_TYPER_CHECK: ".cache/f3/pairs.json" }, options)
    ).toEqual({ pairsPath: "/repo/.cache/f3/pairs.json", promptCandidate: null, orders: "both" });
    expect(() =>
      readTyperCheckEnvironment(
        { MEMORA_TYPER_CHECK: "pairs.json" },
        { ...options, isPackaged: true }
      )
    ).toThrow("refused in packaged builds");
    expect(readTyperCheckEnvironment({}, { ...options, isPackaged: true })).toBeNull();
  });

  it("takes a catalog candidate of the typing prompt and the content order, DEV only", () => {
    const options = { isPackaged: false, workspaceRoot: "/repo" };
    const check = { MEMORA_TYPER_CHECK: "pairs.json" };
    expect(readTyperCheckEnvironment(check, options)).toEqual({
      pairsPath: "/repo/pairs.json",
      promptCandidate: null,
      orders: "both"
    });
    expect(
      readTyperCheckEnvironment(
        {
          ...check,
          MEMORA_TYPER_CHECK_PROMPT: "candidate-strict-related",
          MEMORA_TYPER_CHECK_ORDERS: "content"
        },
        options
      )
    ).toEqual({
      pairsPath: "/repo/pairs.json",
      promptCandidate: "candidate-strict-related",
      orders: "content"
    });
    // An unknown candidate or order is refused; the options alone do nothing.
    expect(() =>
      readTyperCheckEnvironment({ ...check, MEMORA_TYPER_CHECK_PROMPT: "shipped-1" }, options)
    ).toThrow("prompts.errors.unknown");
    expect(() =>
      readTyperCheckEnvironment({ ...check, MEMORA_TYPER_CHECK_ORDERS: "reversed" }, options)
    ).toThrow("both or content");
    expect(
      readTyperCheckEnvironment({ MEMORA_TYPER_CHECK_PROMPT: "candidate-strict-related" }, options)
    ).toBeNull();
    // Packaged builds refuse the options as they refuse the check.
    for (const env of [
      { MEMORA_TYPER_CHECK_PROMPT: "candidate-strict-related" },
      { MEMORA_TYPER_CHECK_ORDERS: "content" }
    ])
      expect(() => readTyperCheckEnvironment(env, { ...options, isPackaged: true })).toThrow(
        "refused in packaged builds"
      );
  });

  it("runs from a file, writes the report beside .cache/f3 and quits, whatever happens", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-typer-check-"));
    try {
      const pairs = panelPairs(4);
      const pairsPath = join(root, "pairs.json");
      await writeFile(pairsPath, JSON.stringify({ pairs }));
      expect(await readTyperCheckPairs(pairsPath)).toHaveLength(4);
      const ai = steadyAi(pairs);
      const quit = vi.fn();
      const log = vi.fn();
      const pool = routePool();
      await runTyperCheckFromEnvironment({
        environment: { pairsPath },
        workspaceRoot: root,
        pool: pool as never,
        ai: ai as never,
        readContentLanguage: async () => "en",
        quit,
        log,
        now: () => new Date("2026-10-18T10:00:00.000Z")
      });
      expect(quit).toHaveBeenCalledTimes(1);
      const report = JSON.parse(
        await readFile(
          join(root, ".cache/f3/typer-check/2026-10-18T10-00-00-000Z/typer-check.json"),
          "utf8"
        )
      );
      expect(report).toMatchObject({
        format: "memora-typer-position-check",
        route: { provider: "openai-codex", modelId: "gpt-test", lane: "remote" },
        calls: 2,
        summary: { pairs: 4, directionAccuracy: 1, swapConsistency: 1 }
      });

      const broken = vi.fn();
      await runTyperCheckFromEnvironment({
        environment: { pairsPath: join(root, "missing.json") },
        workspaceRoot: root,
        pool: pool as never,
        ai: ai as never,
        readContentLanguage: async () => "en",
        quit: broken,
        log
      });
      expect(broken).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith("failed", expect.any(Object));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("types with the candidate revision in content order and says so in the report", async () => {
    const root = await mkdtemp(join(tmpdir(), "memora-typer-check-"));
    try {
      const pairs = panelPairs(4);
      const pairsPath = join(root, "pairs.json");
      await writeFile(pairsPath, JSON.stringify({ pairs }));
      const run = async (
        environment: Parameters<typeof runTyperCheckFromEnvironment>[0]["environment"],
        at: string
      ) => {
        const ai = steadyAi(pairs);
        await runTyperCheckFromEnvironment({
          environment,
          workspaceRoot: root,
          pool: routePool() as never,
          ai: ai as never,
          readContentLanguage: async () => "en",
          quit: vi.fn(),
          log: vi.fn(),
          now: () => new Date(at)
        });
        const [, prompt] = ai.runDefaultTask.mock.calls[0]! as unknown as [string, string];
        const report = JSON.parse(
          await readFile(
            join(root, ".cache/f3/typer-check", at.replace(/[:.]/gu, "-"), "typer-check.json"),
            "utf8"
          )
        );
        return { prompt, report, calls: ai.runDefaultTask.mock.calls.length };
      };
      const active = await run({ pairsPath }, "2026-10-18T10:00:00.000Z");
      const strict = await run(
        { pairsPath, promptCandidate: "candidate-strict-related", orders: "content" },
        "2026-10-18T11:00:00.000Z"
      );
      const criterion = "the same mechanism, rule or phenomenon as the other";
      expect(active.prompt).not.toContain(criterion);
      expect(strict.prompt).toContain(criterion);
      expect(active.report).toMatchObject({
        orders: "both",
        prompt: {
          id: "relations.type",
          candidate: null,
          revisions: [{ id: "relations.type", revisionId: "shipped-1" }]
        }
      });
      expect(strict.report).toMatchObject({
        orders: "content",
        calls: 1,
        prompt: {
          id: "relations.type",
          candidate: "candidate-strict-related",
          revisions: [{ id: "relations.type", revisionId: "candidate-strict-related" }]
        },
        summary: { pairs: 4, typings: 4, swapConsistency: null }
      });
      expect(strict.calls).toBe(1);
      // The typer key follows the prompt: a candidate never shares a cached verdict.
      expect(strict.report.typerKey).not.toBe(active.report.typerKey);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
