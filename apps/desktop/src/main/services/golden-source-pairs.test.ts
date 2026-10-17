import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceRelationSettingsSchema, relationsConfig } from "@app/domain";
import type { PgPool, SourceRelationChunk, SourceRelationNote } from "@app/db";
import type { AiCassetteStats } from "@app/ai";

import { goldenManifestSchema, type GoldenManifest } from "./golden-runner.js";
import {
  createSourcePairReader,
  listLibraryRoots,
  maxConsecutiveCallErrors,
  maxSourcePairs,
  missingManifestRoots,
  readSourcePairsFile,
  resolveSourcePairRoot,
  runSourcePairVerdicts,
  sourcePairVerdictsFile,
  writeSourcePairVerdicts,
  type SourcePair,
  type SourcePairReader,
  type SourcePairRoot,
  type SourcePairVerdictsInput
} from "./golden-source-pairs.js";
import { joinPrompts } from "./prompt-runtime.js";
import {
  sourceDecisionMaxOutputTokens,
  sourceDecisionPrompt,
  sourcePairContext,
  sourceRelationPromptVersion
} from "./source-relation-processing.js";

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "memora-source-pairs-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

const chunk = (
  id: string,
  rootId: string,
  overrides: Partial<SourceRelationChunk> = {}
): SourceRelationChunk => ({
  id,
  sourceItemId: rootId.replace("root-", "src-"),
  documentId: `doc-${id}`,
  sourceSpanId: null,
  content: `Passage ${id} about retrieval and durable learning.`,
  contentHash: `hash-${id}`,
  title: rootId.replace("root-", "Source "),
  summary: null,
  rootId,
  rootTitle: rootId.replace("root-", "Work "),
  chunkIndex: 0,
  ...overrides
});
const a1 = chunk("a1", "root-A");
const a2 = chunk("a2", "root-A", { chunkIndex: 1 });
const b1 = chunk("b1", "root-B");
const note: SourceRelationNote = {
  id: "note-relation",
  type: "supports",
  sourceNoteId: "note-a",
  targetNoteId: "note-b",
  sourceIdea: "Retrieval strengthens memory.",
  targetIdea: "Testing strengthens memory.",
  sourceChunkId: "a1",
  targetChunkId: "b1",
  sourceItemId: "src-A",
  targetSourceItemId: "src-B",
  fingerprint: "fp"
};

const roots: SourcePairRoot[] = [
  { id: "root-A", title: "Work A", type: "StandaloneArticle" },
  { id: "root-B", title: "Work B", type: "StandaloneArticle" },
  { id: "root-C", title: "Work Ç", type: "Book" },
  { id: "root-D1", title: "Twin", type: "StandaloneArticle" },
  { id: "root-D2", title: "Twin", type: "StandaloneArticle" }
];
const manifest = {
  name: "test",
  sources: [
    { key: "key-a", kind: "document", import: "file", title: "Work A" },
    { key: "key-b", kind: "document", import: "file", title: "Work B" },
    {
      key: "book-c",
      kind: "container",
      title: "Work Ç",
      children: [{ key: "book-c-01", kind: "document", import: "file", title: "Chapter" }]
    },
    { key: "key-missing", kind: "document", import: "file", title: "Not in the library" }
  ]
} as unknown as GoldenManifest;

const settings = SourceRelationSettingsSchema.parse({ minImportance: 0.85, minConfidence: 0.8 });
/** A v5 verdict item: [from, to, type, importance, confidence, [from chunks], [to chunks]]. */
const item = (...overrides: Array<[number, unknown]>): unknown[] => {
  const base: unknown[] = ["s1", "s2", "supports", 90, 90, ["c1"], ["c2"]];
  for (const [index, value] of overrides) base[index] = value;
  return base;
};

function fakeReader(input: { chunks?: SourceRelationChunk[]; notes?: SourceRelationNote[] } = {}) {
  return {
    pairNotes: vi.fn(async () => input.notes ?? [note]),
    pairChunks: vi.fn(async () => input.chunks ?? [a1, b1]),
    existing: vi.fn(async () => [])
  };
}

type Output = unknown | Error;
function fakeAi(outputs: Output[]) {
  const calls: Array<[string, string, Record<string, unknown>, unknown, unknown]> = [];
  let runs = 0;
  const queue = [...outputs];
  return {
    calls,
    ai: {
      runDefaultTask: async (
        ...args: [string, string, Record<string, unknown>, unknown, unknown]
      ) => {
        calls.push(args);
        const next = queue.length ? queue.shift() : { relations: [] };
        if (next instanceof Error) throw next;
        runs++;
        return {
          taskType: "reranking",
          output: next,
          providerId: "openai-codex",
          modelId: "gpt-test",
          runtime: "remote",
          durationMs: 2500,
          inputTokens: 1500,
          outputTokens: 120,
          tokenUsage: { reasoningTokens: 90 },
          profileId: "profile",
          aiTaskRunId: `run-${runs}`,
          outputLanguage: "en"
        };
      }
    } as unknown as SourcePairVerdictsInput["ai"]
  };
}

function run(
  pairs: SourcePair[],
  overrides: Partial<SourcePairVerdictsInput> & {
    outputs?: Output[];
    reader?: SourcePairReader;
  } = {}
) {
  const { outputs = [], reader = fakeReader(), ...rest } = overrides;
  const ai = fakeAi(outputs);
  return {
    ai,
    reader,
    report: runSourcePairVerdicts({
      mode: "verdict_only",
      file: { path: "/pairs.json", sha256: "0".repeat(64), pairs },
      manifest,
      roots,
      reader,
      ai: ai.ai,
      settings,
      contentLanguage: "en",
      cassette: null,
      ...rest
    })
  };
}
const pair = (left = "key-a", right = "key-b", label?: string): SourcePair => ({
  left,
  right,
  ...(label ? { label } : {})
});

describe("source pair list file", () => {
  const write = async (content: unknown) => {
    const path = join(directory, "pairs.json");
    await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
    return path;
  };

  it("reads a list of pairs with an optional label and fingerprints the file", async () => {
    const path = await write([
      { left: " key-a ", right: "Work B", label: "first" },
      { left: "key-b", right: "key-a" }
    ]);
    const file = await readSourcePairsFile(path);
    expect(file.pairs).toEqual([
      { left: "key-a", right: "Work B", label: "first" },
      { left: "key-b", right: "key-a" }
    ]);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file.path).toBe(path);
  });

  it("refuses anything that is not a list of {left, right, label?}, naming the problem", async () => {
    await expect(readSourcePairsFile(join(directory, "missing.json"))).rejects.toThrow(
      "cannot read"
    );
    await expect(readSourcePairsFile(await write("not json"))).rejects.toThrow("not valid JSON");
    for (const bad of [
      {},
      [],
      [{ left: "a" }],
      [{ left: "a", right: "  " }],
      [{ left: "a", right: "b", lable: "typo" }],
      [{ left: "a", right: "b", label: 3 }],
      Array.from({ length: maxSourcePairs + 1 }, () => ({ left: "a", right: "b" }))
    ])
      await expect(readSourcePairsFile(await write(bad))).rejects.toThrow(
        "MEMORA_GOLDEN_SOURCE_PAIRS"
      );
  });
});

describe("source pair resolution", () => {
  it("finds a root by top-level manifest key, through the entry's title", () => {
    expect(resolveSourcePairRoot("key-a", manifest, roots)).toEqual({
      ok: true,
      root: roots[0],
      by: "manifestKey"
    });
    // A book is named by its container key.
    expect(resolveSourcePairRoot("book-c", manifest, roots)).toMatchObject({
      ok: true,
      root: { id: "root-C" }
    });
  });

  it("finds a root by exact title, comparing Unicode in one normal form", () => {
    expect(resolveSourcePairRoot("Work B", manifest, roots)).toEqual({
      ok: true,
      root: roots[1],
      by: "title"
    });
    // "Ç" typed as C plus a combining cedilla is the same title.
    expect(resolveSourcePairRoot("Work Ç", manifest, roots)).toMatchObject({
      ok: true,
      root: { id: "root-C" }
    });
    expect(resolveSourcePairRoot("  Work A  ", manifest, roots)).toMatchObject({ ok: true });
  });

  it("lets a manifest key win over a title and never matches part of a title", () => {
    const clash = [{ id: "root-X", title: "key-a", type: "StandaloneArticle" }, ...roots];
    expect(resolveSourcePairRoot("key-a", manifest, clash)).toMatchObject({
      ok: true,
      root: { id: "root-A" },
      by: "manifestKey"
    });
    expect(resolveSourcePairRoot("Work", manifest, roots)).toMatchObject({ ok: false });
  });

  it("reports what it could not resolve instead of guessing", () => {
    expect(resolveSourcePairRoot("key-missing", manifest, roots)).toEqual({
      ok: false,
      reason:
        'no root source of the library matches manifest key "key-missing" (title "Not in the library")'
    });
    expect(resolveSourcePairRoot("Nothing like it", manifest, roots)).toEqual({
      ok: false,
      reason: 'no root source of the library matches title "Nothing like it"'
    });
    expect(resolveSourcePairRoot("Twin", manifest, roots)).toEqual({
      ok: false,
      reason: '2 root sources share title "Twin"'
    });
    expect(resolveSourcePairRoot("book-c-01", manifest, roots)).toEqual({
      ok: false,
      reason: '"book-c-01" is a chapter of "book-c", not a root source; name the book'
    });
  });

  it("lists the manifest roots the library lacks, by key", () => {
    expect(missingManifestRoots(manifest, roots)).toEqual(["key-missing"]);
    expect(missingManifestRoots({ sources: manifest.sources.slice(0, 3) }, roots)).toEqual([]);
  });

  it("reads the root sources of the library with a plain select", async () => {
    const query = vi.fn(async () => ({
      rows: [{ id: "r1", title: "T", type: "Book" }]
    }));
    expect(await listLibraryRoots({ query } as never)).toEqual([
      { id: "r1", title: "T", type: "Book" }
    ]);
    expect(String(query.mock.calls[0]).trim()).toMatch(/^select /);
  });
});

describe("source pair verdicts", () => {
  it("sends the decider the matcher's request for the pair and reads its verdict", async () => {
    const reader = fakeReader();
    const { ai, report } = run([pair("key-a", "key-b", "spike pair 1")], {
      reader,
      outputs: [{ relations: [item([3, 92], [4, 85])] }]
    });
    const result = await report;
    // The request is built by the matcher's own functions from the same reads.
    const context = (await sourcePairContext(reader, "root-A", "root-B", [note], settings))!;
    const expectedPrompt = joinPrompts(
      sourceDecisionPrompt(context, 2, settings.includeWeakTypes, settings.summaryMaxCharacters),
      ""
    );
    expect(ai.calls).toHaveLength(1);
    const [task, input, callContext, signal, limits] = ai.calls[0]!;
    expect(task).toBe("reranking");
    expect(input).toBe(expectedPrompt);
    expect(signal).toBeUndefined();
    expect(limits).toEqual({ maxOutputTokens: sourceDecisionMaxOutputTokens(settings, 2) });
    expect(callContext).toEqual({
      operation: "source_relation_matching",
      stage: "sourceMatching",
      workloadClass: "decide",
      priority: "P2",
      origin: "golden_source_pairs",
      contentLanguage: "en",
      promptVersion: sourceRelationPromptVersion,
      sourceItemIds: ["root-A", "root-B", "src-A", "src-B"],
      attempt: 0
    });
    expect(reader.pairNotes).toHaveBeenCalledWith(
      "root-A",
      "root-B",
      relationsConfig.sourceJudge.noteRelationsPerPair
    );
    expect(reader.pairChunks).toHaveBeenCalledWith(
      "root-A",
      "root-B",
      ["a1", "b1"],
      settings.evidenceChunksPerSource
    );
    expect(result.contract).toBe("source-relations-v5");
  });

  it("reports every raw item with scores, type, evidence aliases and what the floors do to it", async () => {
    const reader = fakeReader({ chunks: [a1, a2, b1] });
    const { report } = run([pair("key-a", "key-b", "pair")], {
      reader,
      outputs: [
        {
          relations: [
            item([3, 92], [4, 85], [6, ["c3"]]),
            item([2, "contrasts"], [3, 70], [4, 90], [5, ["c1", "c2"]], [6, ["c3"]]),
            item([2, "extends"], [3, 80], [4, 90], [6, ["c3"]])
          ]
        }
      ]
    });
    const result = await report;
    const entry = result.pairs[0]!;
    expect(entry).toMatchObject({
      index: 0,
      label: "pair",
      left: "key-a",
      right: "key-b",
      status: "judged",
      verdict: "related",
      proposals: 2,
      roots: {
        left: { id: "root-A", title: "Work A", by: "manifestKey" },
        right: { id: "root-B", title: "Work B", by: "manifestKey" }
      }
    });
    expect(entry.items).toEqual([
      {
        attempt: 0,
        from: "s1",
        to: "s2",
        fromRoot: "left",
        toRoot: "right",
        type: "supports",
        importance: 92,
        confidence: 85,
        fromChunks: ["c1"],
        toChunks: ["c3"],
        passesFloors: true,
        outcome: "kept"
      },
      expect.objectContaining({
        type: "contrasts",
        importance: 70,
        confidence: 90,
        fromChunks: ["c1", "c2"],
        passesFloors: false,
        outcome: "over_allowance"
      }),
      expect.objectContaining({ type: "extends", passesFloors: false, outcome: "below_floors" })
    ]);
    expect(entry.kept).toEqual([
      expect.objectContaining({
        type: "supports",
        importance: 92,
        confidence: 85,
        from: "s1",
        to: "s2"
      })
    ]);
    expect(entry.request).toMatchObject({
      allowance: 2,
      noteRelations: 1,
      sources: [
        { alias: "s1", rootAlias: "w1", root: "left", sourceItemId: "src-A", title: "Source A" },
        { alias: "s2", rootAlias: "w2", root: "right", sourceItemId: "src-B", title: "Source B" }
      ],
      chunks: [
        { alias: "c1", source: "s1", chunkId: "a1", chunkIndex: 0 },
        { alias: "c2", source: "s1", chunkId: "a2", chunkIndex: 1 },
        { alias: "c3", source: "s2", chunkId: "b1", chunkIndex: 0 }
      ]
    });
    expect(entry.attempts).toEqual([
      expect.objectContaining({
        attempt: 0,
        durationMs: 2500,
        inputTokens: 1500,
        outputTokens: 120,
        tokenUsage: { reasoningTokens: 90 },
        costEstimate: null,
        aiTaskRunId: "run-1",
        replayed: false,
        providerId: "openai-codex",
        modelId: "gpt-test",
        runtime: "remote",
        answered: true,
        invalidItems: 0,
        items: 3
      })
    ]);
    expect(entry.attempts[0]!.output).toEqual({ relations: expect.any(Array) });
    expect(result.totals).toMatchObject({
      pairs: 1,
      judged: 1,
      related: 1,
      calls: 1,
      repairs: 0,
      items: 3,
      keptItems: 1,
      belowFloorItems: 1,
      overAllowanceItems: 1,
      inputTokens: 1500,
      outputTokens: 120,
      providerMs: 2500
    });
    expect(result).toMatchObject({
      format: "memora-golden-source-pair-verdicts",
      version: 1,
      state: "finished",
      status: "completed",
      mode: "verdict_only",
      settings: { minImportance: 0.85, minConfidence: 0.8 },
      pairsFile: { path: "/pairs.json", pairs: 1 }
    });
  });

  it("answers not_related for an empty answer and reports the relations already saved apart", async () => {
    const reader = fakeReader();
    reader.existing.mockResolvedValue([
      {
        id: "r1",
        sourceItemId: "src-B",
        targetSourceItemId: "src-A",
        relationType: "supports",
        sourceIdea: null,
        targetIdea: null,
        status: "rejected"
      }
    ] as never);
    const { report } = run([pair()], { reader, outputs: [{ relations: [] }] });
    const entry = (await report).pairs[0]!;
    expect(entry).toMatchObject({ status: "judged", verdict: "not_related", items: [], kept: [] });
    // A saved relation neither reaches the prompt nor decides the outcome of the verdict.
    expect(entry.existingRelations).toEqual([
      { type: "supports", status: "rejected", fromRoot: "right" }
    ]);
  });

  it("asks one repair for malformed items and keeps the valid ones of the first answer", async () => {
    const { ai, report } = run([pair()], {
      outputs: [
        { relations: [item([3, 91], [4, 90]), ["s1", "s2", "supports", "high"]] },
        { relations: [] }
      ]
    });
    const result = await report;
    expect(ai.calls).toHaveLength(2);
    expect(ai.calls[1]![2]).toMatchObject({ attempt: 1, operation: "source_relation_matching" });
    expect(ai.calls[1]![1].startsWith(ai.calls[0]![1])).toBe(true);
    const entry = result.pairs[0]!;
    expect(entry.attempts.map((attempt) => [attempt.attempt, attempt.invalidItems])).toEqual([
      [0, 1],
      [1, 0]
    ]);
    expect(entry.items).toHaveLength(1);
    expect(entry).toMatchObject({ status: "judged", verdict: "related" });
    expect(result.totals).toMatchObject({
      calls: 2,
      repairs: 1,
      invalidItems: 1,
      inputTokens: 3000
    });
  });

  it("reports a pair whose answers keep nothing and never settle as invalid output", async () => {
    const { report } = run([pair()], { outputs: ["not an envelope", "still not"] });
    const result = await report;
    expect(result.pairs[0]).toMatchObject({ status: "invalid_output", verdict: null });
    expect(result.status).toBe("completed_with_failures");
  });

  it("marks calls served from the cassette, whose timing is no measurement", async () => {
    const ai = fakeAi([{ relations: [] }]);
    const original = ai.ai.runDefaultTask;
    ai.ai.runDefaultTask = (async (...args: Parameters<typeof original>) => ({
      ...(await original(...args))!,
      tokenUsage: { "cassette.replayed": 1 }
    })) as typeof original;
    const result = await runSourcePairVerdicts({
      mode: "after_batch",
      file: { path: "/p.json", sha256: "0".repeat(64), pairs: [pair()] },
      manifest,
      roots,
      reader: fakeReader(),
      ai: ai.ai,
      settings,
      contentLanguage: "pt-BR",
      cassette: null
    });
    expect(result.mode).toBe("after_batch");
    expect(result.pairs[0]!.attempts[0]!.replayed).toBe(true);
    expect(result.totals.replayedCalls).toBe(1);
    expect(ai.calls[0]![2]).toMatchObject({ contentLanguage: "pt-BR" });
  });

  it("reports pairs it cannot resolve and refuses same-root pairs, never failing the run", async () => {
    const { ai, report } = run(
      [
        pair("key-a", "key-missing"),
        pair("Work A", "key-a"),
        pair("Twin", "key-b"),
        pair("book-c-01", "key-a"),
        pair("key-a", "key-b")
      ],
      { outputs: [{ relations: [] }] }
    );
    const result = await report;
    expect(result.pairs.map((entry) => entry.status)).toEqual([
      "unresolved",
      "same_root",
      "unresolved",
      "unresolved",
      "judged"
    ]);
    expect(result.pairs[0]!.reason).toContain("right: no root source of the library matches");
    expect(result.pairs[1]!.reason).toContain("same root source");
    expect(result.pairs[2]!.reason).toContain("left: 2 root sources share");
    expect(result.pairs[3]!.reason).toContain("chapter");
    // Only the resolvable, distinct pair reached the decider.
    expect(ai.calls).toHaveLength(1);
    expect(result.status).toBe("completed");
    expect(result.totals).toMatchObject({ pairs: 5, judged: 1, unresolved: 3, sameRoot: 1 });
  });

  it("skips a pair with fewer than two evidence passages, as the matcher does", async () => {
    const { ai, report } = run([pair()], { reader: fakeReader({ chunks: [a1] }) });
    const result = await report;
    expect(result.pairs[0]).toMatchObject({ status: "no_evidence", attempts: [] });
    expect(ai.calls).toEqual([]);
  });

  it("records a failed call and goes on, and stops calling after repeated failures", async () => {
    const failure = new Error("errors.ai.timeout");
    const some = run([pair(), pair("key-b", "key-a"), pair()], {
      outputs: [failure, { relations: [] }, { relations: [] }]
    });
    const mixed = await some.report;
    expect(mixed.pairs.map((entry) => entry.status)).toEqual(["error", "judged", "judged"]);
    expect(mixed.pairs[0]).toMatchObject({ reason: "errors.ai.timeout", attempts: [] });
    expect(mixed.status).toBe("completed_with_failures");

    const many = run(
      Array.from({ length: maxConsecutiveCallErrors + 2 }, () => pair()),
      { outputs: Array.from({ length: 10 }, () => failure) }
    );
    const stopped = await many.report;
    expect(many.ai.calls).toHaveLength(maxConsecutiveCallErrors);
    expect(stopped.pairs.map((entry) => entry.status)).toEqual([
      ...Array.from({ length: maxConsecutiveCallErrors }, () => "error"),
      "skipped",
      "skipped"
    ]);
    expect(stopped.status).toBe("completed_with_failures");
    expect(stopped.stopReason).toContain("failed in a row");
  });

  const cassetteAt = (stats: Partial<AiCassetteStats>) => ({
    stats: () =>
      ({
        mode: "record",
        directory: "/c",
        served: 0,
        recorded: 0,
        misses: 0,
        liveTokens: 0,
        maxLiveTokens: null,
        byTask: {},
        missDetails: [],
        ...stats
      }) as AiCassetteStats
  });

  it("stops at the first replay miss and at the live token cap, reporting the rest as skipped", async () => {
    let misses = 0;
    const replay = run([pair(), pair(), pair()], {
      outputs: [new Error("cassette miss"), { relations: [] }],
      cassette: {
        stats: () => cassetteAt({ mode: "replay", misses }).stats()
      }
    });
    // The first call misses the cassette (the counter moves while the call runs).
    const original = replay.ai.ai.runDefaultTask;
    replay.ai.ai.runDefaultTask = (async (...args: Parameters<typeof original>) => {
      misses++;
      return original(...args);
    }) as typeof original;
    const diverged = await replay.report;
    expect(diverged.status).toBe("diverged");
    expect(diverged.pairs.map((entry) => entry.status)).toEqual(["error", "skipped", "skipped"]);
    expect(replay.ai.calls).toHaveLength(1);

    const capped = run([pair(), pair()], {
      outputs: [{ relations: [] }],
      cassette: cassetteAt({ liveTokens: 1620, maxLiveTokens: 1500 })
    });
    const limited = await capped.report;
    expect(limited.status).toBe("token_limit");
    expect(limited.pairs.map((entry) => entry.status)).toEqual(["judged", "skipped"]);
    expect(limited.stopReason).toContain("MEMORA_GOLDEN_MAX_TOKENS");
    expect(limited.cassette).toMatchObject({ mode: "record", directory: "/c" });
  });

  it("publishes the report after every pair and writes it atomically next to the summary", async () => {
    const states: string[] = [];
    const { report } = run([pair(), pair("key-b", "key-a")], {
      outputs: [{ relations: [] }, { relations: [] }],
      onUpdate: async (current) => {
        states.push(`${current.state}:${current.pairs.length}`);
        await writeSourcePairVerdicts(directory, current);
      }
    });
    await report;
    expect(states).toEqual(["running:1", "running:2", "finished:2"]);
    expect(await readdir(directory)).toEqual([sourcePairVerdictsFile]);
    const written = JSON.parse(await readFile(join(directory, sourcePairVerdictsFile), "utf8"));
    expect(written).toMatchObject({ state: "finished", status: "completed", totals: { pairs: 2 } });
    expect(written.pairs).toHaveLength(2);
  });
});

describe("source pair verdicts persist nothing", () => {
  it("reads through the three read queries only", () => {
    const reader = createSourcePairReader({ query: async () => ({ rows: [] }) } as never);
    expect(Object.keys(reader).sort()).toEqual(["existing", "pairChunks", "pairNotes"]);
  });

  it("runs only select statements against the database for a whole verdict", async () => {
    const statements: string[] = [];
    const pool = {
      query: async (sql: string) => {
        statements.push(sql);
        return { rows: [] };
      },
      connect: async () => {
        throw new Error("a verdict never opens a transaction");
      }
    };
    const reader = createSourcePairReader(pool as unknown as PgPool);
    await reader.pairNotes("root-A", "root-B", 6);
    await reader.pairChunks("root-A", "root-B", [], 3);
    await reader.existing("root-A", "root-B");
    await listLibraryRoots(pool as never);
    expect(statements.length).toBeGreaterThan(3);
    for (const statement of statements) {
      expect(statement.trim()).toMatch(/^(with|select)\b/i);
      expect(statement).not.toMatch(
        /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate)\b/i
      );
    }
  });

  it("keeps the repository's write paths out of the module", async () => {
    const source = await readFile(
      join(process.cwd(), "apps/desktop/src/main/services/golden-source-pairs.ts"),
      "utf8"
    );
    for (const write of ["commitDecision", "saveRun", "runState", ".review(", "persistRelation"])
      expect(source).not.toContain(write);
    expect(source).not.toMatch(/\b(insert\s+into|delete\s+from)\b/i);
  });
});

describe("the spike pair files", () => {
  const read = async (name: string) =>
    JSON.parse(
      await readFile(
        join(process.cwd(), "scripts/golden/source-pairs", `spike-f3-${name}.json`),
        "utf8"
      )
    ) as SourcePair[];

  it("hold the 79 must-run pairs of the F3 spike, one file per library state", async () => {
    const files = Object.fromEntries(
      await Promise.all(
        ["fix3", "fix1", "old", "gold"].map(async (name) => [name, await read(name)] as const)
      )
    );
    expect(
      Object.fromEntries(Object.entries(files).map(([name, pairs]) => [name, pairs.length]))
    ).toEqual({
      fix3: 30,
      fix1: 18,
      old: 17,
      gold: 14
    });
    for (const [name, pairs] of Object.entries(files)) {
      const seen = new Set<string>();
      for (const entry of pairs) {
        // Each file passes the production validation; roots are named by manifest key, not by text.
        const path = join(directory, `${name}.json`);
        await writeFile(path, JSON.stringify([entry]));
        await readSourcePairsFile(path);
        expect(Object.keys(entry).sort()).toEqual(["label", "left", "right"]);
        expect(entry.left).not.toBe(entry.right);
        expect(entry.label).toMatch(new RegExp(`^${name}:`));
        const key = [entry.left, entry.right].sort().join("|");
        expect(seen.has(key), `${name}: duplicate pair ${key}`).toBe(false);
        seen.add(key);
      }
      expect(new Set(pairs.map((entry) => entry.label)).size).toBe(pairs.length);
    }
  });

  it("name golden roots that exist in the public manifest and fixture roots by their mf- key", async () => {
    const golden = goldenManifestSchema.parse(
      JSON.parse(await readFile(join(process.cwd(), "scripts/golden/manifest.json"), "utf8"))
    );
    const keys = new Set(golden.sources.map((source) => source.key));
    for (const entry of await read("gold")) {
      expect(keys.has(entry.left), entry.left).toBe(true);
      expect(keys.has(entry.right), entry.right).toBe(true);
    }
    for (const name of ["fix3", "fix1", "old"])
      for (const entry of await read(name)) {
        expect(entry.left).toMatch(/^mf-[a-z]\d+$/);
        expect(entry.right).toMatch(/^mf-[a-z]\d+$/);
      }
  });
});
