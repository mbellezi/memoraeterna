import { describe, expect, it } from "vitest";

import {
  analyzePlan,
  armsInStatement,
  latencyReport,
  seqScanRowLimit,
  summarizeExplain,
  type ExplainedArm,
  type PlanNode
} from "./omni-bench-lib.js";
import type { OmniQuery } from "./omni-queries.js";

const query = (kind: OmniQuery["kind"], text: string): OmniQuery => ({
  kind,
  id: `${kind}-${text}`,
  title: text,
  query: text
});

describe("latencyReport", () => {
  it("takes the nearest-rank p50 and p95 of every run: 1..100 gives 50 and 95", () => {
    const runsMs = Array.from({ length: 100 }, (_, index) => index + 1);
    const report = latencyReport([{ query: query("note", "ab"), runsMs: runsMs.toReversed() }]);
    expect(report.all).toMatchObject({ count: 100, p50: 50, p95: 95, p99: 99, min: 1, max: 100 });
    expect(report.all.mean).toBeCloseTo(50.5);
  });

  it("ranks 20 runs at the 19th (ceil(0.95 * 20)) and a single run at itself", () => {
    const twenty = Array.from({ length: 20 }, (_, index) => (index + 1) * 10);
    expect(latencyReport([{ query: query("note", "ab"), runsMs: twenty }]).all.p95).toBe(190);
    expect(latencyReport([{ query: query("note", "ab"), runsMs: [7] }]).all.p95).toBe(7);
  });

  it("pools the runs of all queries for p95 and keeps the median of each query for the other figure", () => {
    const report = latencyReport([
      { query: query("note", "aa"), runsMs: [1, 1, 1, 1, 100] },
      { query: query("topic", "bb"), runsMs: [2, 2, 2, 2, 2] }
    ]);
    expect(report.all.count).toBe(10);
    expect(report.all.p95).toBe(100);
    expect(report.medianPerQuery.count).toBe(2);
    expect(report.medianPerQuery.p95).toBe(2);
    expect(report.medianPerQuery.p50).toBe(1);
  });

  it("splits by kind and by query length and lists the slowest by median", () => {
    const report = latencyReport(
      [
        { query: query("note", "abc"), runsMs: [10, 10, 10] },
        { query: query("topic", "abcd"), runsMs: [30, 30, 30] },
        { query: query("topic", "abcde"), runsMs: [20, 20, 20] }
      ],
      2
    );
    expect(report.byKind.note?.p95).toBe(10);
    expect(report.byKind.topic).toMatchObject({ count: 6, p95: 30 });
    expect(Object.keys(report.byLength)).toEqual(["3", "4", "5"]);
    expect(report.slowest).toEqual([
      { kind: "topic", query: "abcd", medianMs: 30 },
      { kind: "topic", query: "abcde", medianMs: 20 }
    ]);
  });

  it("reports NaN for nothing timed rather than a zero", () => {
    expect(latencyReport([]).all.p95).toBeNaN();
  });
});

const arms: ExplainedArm[] = [
  { arm: "title_trgm", table: "atomic_notes", index: "atomic_notes_title_trgm_idx" },
  { arm: "fts", table: "atomic_notes", index: "atomic_notes_search_tsv_idx" },
  { arm: "title_trgm", table: "questions", index: "questions_text_trgm_idx" }
];
const rows = new Map([
  ["atomic_notes", 30_000],
  ["questions", 12],
  ["documents", 40_000]
]);
const bitmap = (table: string, index: string): PlanNode => ({
  "Node Type": "Bitmap Heap Scan",
  "Relation Name": table,
  Plans: [{ "Node Type": "Bitmap Index Scan", "Index Name": index }]
});
const append = (...plans: PlanNode[]): PlanNode => ({ "Node Type": "Append", Plans: plans });
const notes = [
  bitmap("atomic_notes", "atomic_notes_title_trgm_idx"),
  bitmap("atomic_notes", "atomic_notes_search_tsv_idx")
] as const;

describe("armsInStatement", () => {
  const known: ExplainedArm[] = [
    { arm: "title_trgm", table: "topics", index: "topics_title_trgm" },
    { arm: "fts", table: "topics", index: "topics_search_tsv" },
    { arm: "fts", table: "atomic_notes", index: "atomic_notes_search_tsv" }
  ];

  it("keeps only the arms the statement holds, so a no-word query is not failed for an FTS index", () => {
    expect(armsInStatement(known, [{ arm: "title_trgm", table: "topics" }])).toEqual([known[0]]);
    expect(
      armsInStatement(known, [
        { arm: "title_trgm", table: "topics" },
        { arm: "fts", table: "atomic_notes" }
      ])
    ).toEqual([known[0], known[2]]);
    expect(armsInStatement(known, [])).toEqual([]);
  });
});

describe("analyzePlan", () => {
  it("passes when every large arm uses its index and a small table is scanned", () => {
    const plan = append(...notes, { "Node Type": "Seq Scan", "Relation Name": "questions" });
    const analysis = analyzePlan(plan, rows, arms);
    expect(analysis.failures).toEqual([]);
    expect(analysis.arms.map((arm) => arm.status)).toEqual(["index", "index", "small-table"]);
    expect(analysis.seqScans).toEqual([{ table: "questions", rows: 12 }]);
    expect(analysis.indexes).toEqual([
      "atomic_notes_search_tsv_idx",
      "atomic_notes_title_trgm_idx"
    ]);
  });

  it("fails a Seq Scan of a table of 10,000 rows or more, also deep in a subplan", () => {
    const plan = append(...notes, {
      "Node Type": "Nested Loop",
      Plans: [{ "Node Type": "Parallel Seq Scan", "Relation Name": "documents" }]
    });
    expect(analyzePlan(plan, rows, arms).failures).toEqual(["Seq Scan on documents (40,000 rows)"]);
  });

  it("fails an arm scanned in sequence: the table is large and its index is not named", () => {
    const plan = append(notes[0], { "Node Type": "Seq Scan", "Relation Name": "atomic_notes" });
    const analysis = analyzePlan(plan, rows, arms);
    expect(analysis.arms[1]).toMatchObject({ status: "seq-scan", table: "atomic_notes" });
    expect(analysis.failures).toEqual(["Seq Scan on atomic_notes (30,000 rows)"]);
  });

  it("fails a large arm whose index the plan never names even without a scan", () => {
    const analysis = analyzePlan(append(notes[0]), rows, arms);
    expect(analysis.arms[1]!.status).toBe("index-unused");
    expect(analysis.failures).toEqual([
      "fts on atomic_notes does not use atomic_notes_search_tsv_idx"
    ]);
  });

  it("puts the limit at exactly 10,000 rows", () => {
    const plan: PlanNode = { "Node Type": "Seq Scan", "Relation Name": "entities" };
    expect(analyzePlan(plan, new Map([["entities", seqScanRowLimit - 1]]), []).failures).toEqual(
      []
    );
    expect(analyzePlan(plan, new Map([["entities", seqScanRowLimit]]), []).failures).toEqual([
      "Seq Scan on entities (10,000 rows)"
    ]);
  });
});

describe("summarizeExplain", () => {
  const good = append(...notes, { "Node Type": "Seq Scan", "Relation Name": "questions" });
  const bad = append(notes[0]);

  it("counts each arm's statuses over the queries and lists each failure once with its first query", () => {
    const summary = summarizeExplain([
      { query: "ab", analysis: analyzePlan(good, rows, arms) },
      { query: "abc", analysis: analyzePlan(bad, rows, arms) },
      { query: "abcd", analysis: analyzePlan(bad, rows, arms) }
    ]);
    expect(summary.explained).toBe(3);
    expect(summary.passed).toBe(false);
    expect(summary.failures).toEqual([
      {
        reason: "fts on atomic_notes does not use atomic_notes_search_tsv_idx",
        queries: 2,
        example: "abc",
        examples: ["abc", "abcd"]
      }
    ]);
    const fts = summary.arms.find((arm) => arm.arm === "fts")!;
    expect(fts.counts).toEqual({ index: 1, "small-table": 0, "seq-scan": 0, "index-unused": 2 });
    expect(fts.firstFailure).toBe("abc");
  });

  it("passes only when something was explained and nothing failed", () => {
    expect(
      summarizeExplain([{ query: "ab", analysis: analyzePlan(good, rows, arms) }]).passed
    ).toBe(true);
    expect(summarizeExplain([]).passed).toBe(false);
  });
});
