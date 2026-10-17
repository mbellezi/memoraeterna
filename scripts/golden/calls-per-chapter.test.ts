import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  classify,
  readGoldenSummary,
  referenceChapterChunks,
  runCallsPerChapter,
  summarizeCallsPerChapter
} from "./calls-per-chapter.ts";
import { cacheRoot } from "./test-world.ts";

/** The golden F1a run (decision R9's baseline): 495 generative calls over 197 chunks. */
const f1aCalls = [
  { taskType: "atomic-note-generation", calls: 29, replayed: 29 },
  { taskType: "embedding", calls: 1569, replayed: 434 },
  { taskType: "knowledge-graph-generation", calls: 230, replayed: 0 },
  { taskType: "reranking", calls: 195, replayed: 41 },
  { taskType: "summarization", calls: 41, replayed: 41 }
];

describe("calls per chapter", () => {
  let directory = "";
  let summaryFile = "";
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-calls-"));
    summaryFile = join(directory, "summary.json");
    await writeFile(
      summaryFile,
      JSON.stringify({
        format: "memora-golden-run",
        version: 1,
        ai: f1aCalls,
        outputs: { chunks: { count: 197, sha256: "x" } }
      })
    );
  });
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("counts the golden F1a summary as 2.51 generative calls per chunk, 75.4 per 30-chunk chapter", async () => {
    const { counts, chunks } = await readGoldenSummary(summaryFile);
    const summary = summarizeCallsPerChapter(counts, chunks);
    expect(chunks).toBe(197);
    expect(summary.generative.calls).toBe(495);
    expect(summary.generative.perChunk).toBeCloseTo(2.51, 2);
    expect(summary.generative.perChapter).toBeCloseTo(75.4, 1);
    expect(summary.excluded.calls).toBe(1569);
    expect(summary.topic.calls).toBe(0);
    expect(summary.chapterChunks).toBe(referenceChapterChunks);
  });

  const stored = join(cacheRoot, "golden/runs/2026-10-15T00-47-40-446Z/summary.json");
  it.skipIf(!existsSync(stored))("reads the same figure from the stored F1a run", async () => {
    const { counts, chunks } = await readGoldenSummary(stored);
    const summary = summarizeCallsPerChapter(counts, chunks);
    expect(summary.generative.perChunk!.toFixed(2)).toBe("2.51");
  });

  it("splits by operation: generative, topic (apart) and excluded", () => {
    expect(classify({ operation: "note_matching_reranking", task: "reranking" })).toBe(
      "generative"
    );
    expect(classify({ operation: "source_relation_matching", task: "reranking" })).toBe(
      "generative"
    );
    expect(classify({ operation: "topic_gate", task: "reranking" })).toBe("excluded");
    expect(classify({ operation: "topic_name", task: "text-generation" })).toBe("topic");
    expect(classify({ operation: "note_matching_embedding", task: "embedding" })).toBe("excluded");
    expect(classify({ operation: "ask", task: "text-generation" })).toBe("excluded");
    expect(classify({ operation: null, task: "embedding" })).toBe("excluded");
    expect(classify({ operation: null, task: "knowledge-graph-generation" })).toBe("generative");

    const summary = summarizeCallsPerChapter(
      [
        {
          operation: "graph_atomic_notes",
          task: "knowledge-graph-generation",
          calls: 40,
          replayed: 40
        },
        { operation: "graph_atomic_notes_repair", task: "knowledge-graph-generation", calls: 10 },
        { operation: "topic_name", task: "text-generation", calls: 6 },
        { operation: "topic_gate", task: "reranking", calls: 80 },
        {
          operation: "graph_atomic_notes",
          task: "knowledge-graph-generation",
          calls: 5,
          replayed: 0
        }
      ],
      60,
      30
    );
    expect(summary.generative).toEqual({ calls: 55, perChunk: 55 / 60, perChapter: 27.5 });
    expect(summary.topic).toEqual({ calls: 6, perChunk: 0.1, perChapter: 3 });
    expect(summary.excluded.calls).toBe(80);
    const merged = summary.rows.find((row) => row.key === "graph_atomic_notes")!;
    expect(merged).toMatchObject({ calls: 45, replayed: 40 });
    // A group with one unknown replay count has an unknown total.
    expect(
      summary.rows.find((row) => row.key === "graph_atomic_notes_repair")!.replayed
    ).toBeNull();
  });

  it("leaves the rates unknown without a chunk count", () => {
    const summary = summarizeCallsPerChapter(
      [{ operation: null, task: "summarization", calls: 3 }],
      null
    );
    expect(summary.generative).toEqual({ calls: 3, perChunk: null, perChapter: null });
  });

  it("runs from the command line and writes the Markdown and the JSON", async () => {
    const out = join(directory, "report.md");
    const json = join(directory, "report.json");
    expect(await runCallsPerChapter(["--summary", summaryFile, "--out", out, "--json", json])).toBe(
      null
    );
    expect(await readFile(out, "utf8")).toContain(
      "| **Generative total** | | 495 | | 2.51 | 75.4 |"
    );
    expect(JSON.parse(await readFile(json, "utf8")).generative.calls).toBe(495);

    const operations = join(directory, "operations.json");
    await writeFile(
      operations,
      JSON.stringify({
        chunks: 30,
        operations: [
          { operation: "graph_atomic_notes", task: "knowledge-graph-generation", calls: 35 }
        ]
      })
    );
    expect(await runCallsPerChapter(["--operations", operations])).toContain(
      "| 35 | | 1.17 | 35.0 |"
    );
  });

  it("asks for exactly one input and a chunk count", async () => {
    await expect(runCallsPerChapter([])).rejects.toThrow(
      "exactly one of --summary and --operations"
    );
    const operations = join(directory, "list.json");
    await writeFile(operations, JSON.stringify([{ task: "summarization", calls: 2 }]));
    await expect(runCallsPerChapter(["--operations", operations])).rejects.toThrow(
      "--chunks is required"
    );
    expect(await runCallsPerChapter(["--operations", operations, "--chunks", "4"])).toContain(
      "0.50"
    );
    await expect(runCallsPerChapter(["--summary", summaryFile, "--chapter", "0"])).rejects.toThrow(
      "positive integer"
    );
    expect(await runCallsPerChapter(["--help"])).toContain("Usage:");
  });
});
