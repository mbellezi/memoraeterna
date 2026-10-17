import { describe, expect, it } from "vitest";

import {
  fuseRankings,
  mean,
  overlapAtK,
  percentile,
  summarize,
  summarizePlan,
  textPlanProblems,
  vectorPlanProblems
} from "./retrieval-plan.js";
import type { PlanNode } from "./retrieval-plan.js";

const node = (type: string, fields: Partial<PlanNode> = {}, ...children: PlanNode[]): PlanNode => ({
  "Node Type": type,
  ...fields,
  ...(children.length ? { Plans: children } : {})
});

const textPlan = node(
  "Limit",
  {},
  node(
    "Sort",
    {},
    node(
      "Bitmap Heap Scan",
      { "Relation Name": "atomic_notes" },
      node(
        "BitmapOr",
        {},
        node("Bitmap Index Scan", { "Index Name": "atomic_notes_search_tsv_idx" }),
        node("Bitmap Index Scan", { "Index Name": "atomic_notes_title_trgm_idx" })
      )
    )
  )
);

const vectorPlan = node(
  "Limit",
  {},
  node(
    "Nested Loop",
    {},
    node("Index Scan", {
      "Relation Name": "embeddings_768",
      "Index Name": "embeddings_768_note_hnsw_idx"
    }),
    node("Index Scan", { "Relation Name": "atomic_notes", "Index Name": "atomic_notes_pkey" })
  )
);

const large = { rows: 30_000, minRows: 5_000 };

describe("reading a plan", () => {
  it("lists the index scans and the sequential scans of every node", () => {
    expect(summarizePlan(textPlan)).toEqual({
      indexScans: ["atomic_notes_search_tsv_idx", "atomic_notes_title_trgm_idx"],
      seqScans: [],
      scans: [
        "Bitmap Index Scan using atomic_notes_search_tsv_idx",
        "Bitmap Index Scan using atomic_notes_title_trgm_idx"
      ]
    });
    expect(summarizePlan(node("Seq Scan", { "Relation Name": "embeddings_768" })).seqScans).toEqual(
      ["embeddings_768"]
    );
  });

  it("passes the text query that reaches atomic_notes through both GIN indexes", () => {
    expect(textPlanProblems(summarizePlan(textPlan), large)).toEqual([]);
  });

  it("fails a text query that misses an index or reads atomic_notes sequentially", () => {
    const sequential = node("Seq Scan", { "Relation Name": "atomic_notes" });
    expect(textPlanProblems(summarizePlan(sequential), large)).toEqual([
      "no scan of atomic_notes_search_tsv_idx",
      "no scan of atomic_notes_title_trgm_idx",
      "sequential scan of atomic_notes"
    ]);
  });

  it("passes the vector query ordered by the partial HNSW index of its table", () => {
    expect(vectorPlanProblems(summarizePlan(vectorPlan), 768, large)).toEqual([]);
  });

  it("accepts the global HNSW index where the planner prices it like the partial one", () => {
    const global = node("Index Scan", {
      "Relation Name": "embeddings_768",
      "Index Name": "embeddings_768_embedding_hnsw_idx"
    });
    expect(vectorPlanProblems(summarizePlan(global), 768, large)).toEqual([]);
  });

  it("fails a vector query that used no HNSW index or read a table sequentially", () => {
    const btree = node("Index Scan", {
      "Relation Name": "embeddings_768",
      "Index Name": "embeddings_768_target_model_uidx"
    });
    expect(vectorPlanProblems(summarizePlan(btree), 768, large)).toEqual([
      "no scan of embeddings_768_note_hnsw_idx"
    ]);
    const sequential = node(
      "Nested Loop",
      {},
      node("Seq Scan", { "Relation Name": "embeddings_768" }),
      node("Seq Scan", { "Relation Name": "atomic_notes" })
    );
    expect(vectorPlanProblems(summarizePlan(sequential), 768, large)).toEqual([
      "no scan of embeddings_768_note_hnsw_idx",
      "sequential scan of embeddings_768",
      "sequential scan of atomic_notes"
    ]);
  });

  it("reports but does not gate a table too small for an index to pay", () => {
    const small = { rows: 138, minRows: 5_000 };
    const sequential = node("Seq Scan", { "Relation Name": "atomic_notes" });
    expect(textPlanProblems(summarizePlan(sequential), small)).toEqual([]);
    expect(vectorPlanProblems(summarizePlan(sequential), 768, small)).toEqual([]);
  });
});

describe("statistics", () => {
  it("takes nearest-rank percentiles", () => {
    const sorted = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(sorted, 0.5)).toBe(50);
    expect(percentile(sorted, 0.95)).toBe(95);
    expect(percentile(sorted, 1)).toBe(100);
    expect(percentile([], 0.5)).toBeNaN();
    expect(summarize([3, 1, 2])).toEqual({ count: 3, p50: 2, p95: 3, p99: 3, max: 3 });
    expect(mean([1, 2, 3])).toBe(2);
    expect(mean([])).toBeNaN();
  });

  it("measures the share of the reference top k the candidate also holds", () => {
    expect(overlapAtK(["a", "b", "c"], ["a", "b", "c"], 3)).toBe(1);
    expect(overlapAtK(["a", "x", "y"], ["a", "b", "c"], 3)).toBeCloseTo(1 / 3);
    // Only the first k of each list count.
    expect(overlapAtK(["x", "y", "a"], ["a", "b", "c"], 2)).toBe(0);
    expect(overlapAtK([], [], 5)).toBe(1);
  });

  it("fuses rankings by reciprocal rank", () => {
    expect(
      fuseRankings(
        [
          ["a", "b", "c"],
          ["b", "a", "d"]
        ],
        60
      )
    ).toEqual(["a", "b", "c", "d"]);
    // A note both lists rank high beats one only a single list ranks first.
    expect(
      fuseRankings(
        [
          ["x", "a"],
          ["y", "a"]
        ],
        60
      )[0]
    ).toBe("a");
  });
});
