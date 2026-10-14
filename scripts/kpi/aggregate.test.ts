import { describe, expect, it } from "vitest";

import {
  aggregateAi,
  aggregateAutomation,
  aggregateJobs,
  aggregateMatching,
  aggregateRuns,
  aggregateStages,
  aggregateWiki,
  errorReason,
  type AiRunRow,
  type StageRow,
  type WikiPageRow
} from "./aggregate.js";

const aiRow = (overrides: Partial<AiRunRow> = {}): AiRunRow => ({
  task: "reranking",
  provider: "openai-codex",
  model: "gpt-5.6-luna",
  runtime: "remote",
  status: "succeeded",
  durationMs: 1000,
  queueMs: null,
  attempt: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cost: null,
  operation: null,
  noteId: null,
  sourceId: null,
  ...overrides
});

const stageRow = (overrides: Partial<StageRow> = {}): StageRow => ({
  stage: "summarization",
  status: "completed",
  reused: false,
  wallMs: 2000,
  attemptMs: null,
  attempts: null,
  ...overrides
});

describe("aggregateStages", () => {
  it("separates executed, reused, skipped and failed stages and times only executed ones", () => {
    const [summary] = aggregateStages([
      stageRow({ wallMs: 1000 }),
      stageRow({ wallMs: 3000 }),
      stageRow({ reused: true, wallMs: 99_000 }),
      stageRow({ status: "skipped", wallMs: null }),
      stageRow({ status: "failed", wallMs: null }),
      stageRow({ status: "running", wallMs: null }),
      stageRow({ wallMs: null })
    ]);
    expect(summary).toMatchObject({
      stage: "summarization",
      rows: 7,
      executed: 3,
      reused: 1,
      skipped: 1,
      failed: 1,
      canceled: 0,
      open: 1,
      durationUnknown: 1,
      retried: null
    });
    expect(summary?.wallSeconds).toMatchObject({ n: 2, p50: 2, max: 3 });
    expect(summary?.attemptSeconds).toBeNull();
  });

  it("reports attempt time and retries when the attempt columns exist", () => {
    const [summary] = aggregateStages([
      stageRow({ wallMs: 9000, attemptMs: 4000, attempts: 2 }),
      stageRow({ wallMs: 1000, attemptMs: 1000, attempts: 1 })
    ]);
    expect(summary?.retried).toBe(1);
    expect(summary?.attemptSeconds).toMatchObject({ n: 2, min: 1, max: 4 });
  });

  it("ignores negative durations from clock anomalies", () => {
    const [summary] = aggregateStages([stageRow({ wallMs: -5 })]);
    expect(summary?.wallSeconds).toBeNull();
    expect(summary?.durationUnknown).toBe(1);
  });

  it("orders known pipeline stages first, in pipeline order", () => {
    const stages = aggregateStages([
      stageRow({ stage: "zzz" }),
      stageRow({ stage: "knowledgeGraph" }),
      stageRow({ stage: "chunking" }),
      stageRow({ stage: "aaa" })
    ]).map((entry) => entry.stage);
    expect(stages).toEqual(["chunking", "knowledgeGraph", "aaa", "zzz"]);
  });
});

describe("aggregateRuns", () => {
  it("measures queue wait for all runs and wall time for succeeded runs only", () => {
    const runs = aggregateRuns([
      { status: "succeeded", queueMs: 2000, wallMs: 10_000 },
      { status: "succeeded", queueMs: 4000, wallMs: 30_000 },
      { status: "failed", queueMs: 1000, wallMs: 500 },
      { status: "pending", queueMs: null, wallMs: null }
    ]);
    expect(runs.total).toBe(4);
    expect(runs.byStatus).toEqual({ succeeded: 2, failed: 1, pending: 1 });
    expect(runs.queueSeconds).toMatchObject({ n: 3, p50: 2 });
    expect(runs.wallSeconds).toMatchObject({ n: 2, min: 10, max: 30 });
  });
});

describe("aggregateAi", () => {
  const rows = [
    aiRow({
      inputTokens: 100,
      outputTokens: 40,
      reasoningTokens: 10,
      durationMs: 2000,
      queueMs: 500,
      attempt: 0
    }),
    aiRow({
      inputTokens: 300,
      outputTokens: 60,
      reasoningTokens: null,
      durationMs: 4000,
      queueMs: 1500,
      attempt: 1
    }),
    aiRow({ status: "failed", durationMs: 0, inputTokens: null }),
    aiRow({
      task: "embedding",
      provider: "local",
      model: "qwen3",
      runtime: "gguf",
      cost: 0,
      durationMs: 100
    })
  ];

  it("totals tokens that were reported and says how many calls reported them", () => {
    const { total } = aggregateAi(rows);
    expect(total.calls).toBe(4);
    expect(total.succeeded).toBe(3);
    expect(total.failed).toBe(1);
    expect(total.inputTokens).toEqual({ sum: 400, reportedCalls: 2 });
    expect(total.outputTokens).toEqual({ sum: 100, reportedCalls: 2 });
    expect(total.reasoningTokens).toEqual({ sum: 10, reportedCalls: 1 });
  });

  it("summarizes the duration of succeeded calls only and the queue wait of measured ones", () => {
    const { total } = aggregateAi(rows);
    expect(total.durationSeconds).toMatchObject({ n: 3, min: 0.1, max: 4 });
    expect(total.queueSeconds).toMatchObject({ n: 2, p50: 1 });
  });

  it("counts retries among the calls that reported a retry index", () => {
    expect(aggregateAi(rows).total.retries).toEqual({ reportedCalls: 2, retryCalls: 1 });
  });

  it("keeps unknown costs unknown, separate from a known cost of zero", () => {
    expect(aggregateAi(rows).total.cost).toEqual({ sum: 0, knownCalls: 1 });
  });

  it("groups by task and by route, busiest first", () => {
    const result = aggregateAi(rows);
    expect(result.byTask.map((group) => [group.task, group.calls])).toEqual([
      ["reranking", 3],
      ["embedding", 1]
    ]);
    expect(
      result.byRoute.map((group) => `${group.task}/${group.provider}/${group.runtime}`)
    ).toEqual(["reranking/openai-codex/remote", "embedding/local/gguf"]);
  });
});

describe("aggregateMatching", () => {
  const note = (noteId: string, durationMs: number, overrides: Partial<AiRunRow> = {}) =>
    aiRow({ operation: "note_matching_reranking", noteId, durationMs, ...overrides });
  const pair = (sourceId: string, durationMs: number, attempt: number | null) =>
    aiRow({ operation: "source_relation_matching", sourceId, durationMs, attempt });

  it("computes seconds per note over all passes and per call", () => {
    const { noteMatching } = aggregateMatching(
      [
        note("n1", 10_000),
        note("n1", 14_000),
        note("n2", 12_000),
        note("n3", 5_000, { status: "failed" })
      ],
      []
    );
    expect(noteMatching).toMatchObject({
      calls: 4,
      failed: 1,
      distinctTargets: 3,
      secondsPerTarget: 12
    });
    expect(noteMatching?.callsPerTarget).toBeCloseTo(4 / 3, 10);
    expect(noteMatching?.callSeconds).toMatchObject({ n: 3, p50: 12 });
  });

  it("reports source pair calls and their repairs", () => {
    const { sourceMatching } = aggregateMatching(
      [pair("s1", 2000, 0), pair("s1", 4000, 1), pair("s2", 3000, 0)],
      []
    );
    expect(sourceMatching).toMatchObject({ calls: 3, distinctTargets: 2 });
    expect(sourceMatching?.retries).toEqual({ reportedCalls: 3, retryCalls: 1 });
    expect(sourceMatching?.callSeconds?.p50).toBe(3);
  });

  it("keeps reranking calls without a monitoring record separate and ignores other tasks", () => {
    const result = aggregateMatching(
      [
        aiRow({ durationMs: 8000 }),
        aiRow({ task: "embedding", operation: "note_matching_reranking" })
      ],
      []
    );
    expect(result.noteMatching).toBeNull();
    expect(result.sourceMatching).toBeNull();
    expect(result.unclassifiedReranking).toMatchObject({
      calls: 1,
      distinctTargets: null,
      secondsPerTarget: null
    });
  });

  it("summarizes succeeded operation spans per operation", () => {
    const result = aggregateMatching(
      [],
      [
        { operation: "atomic-note-matching", status: "succeeded", durationMs: 30_000 },
        { operation: "atomic-note-matching", status: "succeeded", durationMs: 50_000 },
        { operation: "atomic-note-matching", status: "failed", durationMs: 1 },
        { operation: "other", status: "succeeded", durationMs: 1 }
      ]
    );
    expect(result.operationSeconds["atomic-note-matching"]).toMatchObject({ n: 2, p50: 40 });
    expect(result.operationSeconds["source-matching"]).toBeNull();
    expect(result.operationSeconds).not.toHaveProperty("other");
  });
});

describe("aggregateWiki", () => {
  const page = (
    id: string,
    parentId: string | null,
    overrides: Partial<WikiPageRow> = {}
  ): WikiPageRow => ({
    id,
    parentId,
    archived: false,
    management: "ai_managed",
    role: null,
    kind: "topic",
    ...overrides
  });

  it("counts AI orphan roots, designed roots and the tree shape of live pages", () => {
    const wiki = aggregateWiki(
      [
        page("area", null, { management: "human_managed", kind: "collection" }),
        page("orphan", null),
        page("child", "orphan"),
        page("grandchild", "child"),
        page("sibling", "orphan"),
        page("gone", null, { archived: true }),
        page("under-gone", "gone")
      ],
      { current: 4, inMembership: 3 },
      { total: 5, withToc: 1 }
    );
    expect(wiki).toMatchObject({
      pages: 6,
      archivedPages: 1,
      aiOrphanRoots: 1,
      humanRoots: 1
    });
    expect(wiki.shape).toMatchObject({
      roots: 3,
      danglingParents: 1,
      maxDepth: 2,
      internalNodes: 2,
      leaves: 4
    });
    expect(wiki.notes).toEqual({ current: 4, inMembership: 3, share: 0.75 });
    expect(wiki.sources).toEqual({ total: 5, withToc: 1, share: 0.2 });
  });

  it("groups live pages by management and role, using the kind when there is no role", () => {
    const wiki = aggregateWiki(
      [
        page("a", null, { role: "topic_toc" }),
        page("b", "a", { role: "topic_toc" }),
        page("c", "a"),
        page("d", null, { management: null })
      ],
      null,
      null
    );
    expect(wiki.byRole).toEqual([
      { management: "ai_managed", role: "topic_toc", count: 2 },
      { management: "ai_managed", role: "topic", count: 1 },
      { management: "unknown", role: "topic", count: 1 }
    ]);
    expect(wiki.notes).toBeNull();
    expect(wiki.sources).toBeNull();
  });

  it("leaves shares unknown when there is nothing to measure", () => {
    const wiki = aggregateWiki([], { current: 0, inMembership: 0 }, { total: 0, withToc: 0 });
    expect(wiki.notes?.share).toBeNull();
    expect(wiki.sources?.share).toBeNull();
  });
});

describe("errorReason", () => {
  it("keeps machine-readable codes and hides anything that could carry content", () => {
    expect(errorReason("organization.errors.invalid")).toBe("organization.errors.invalid");
    expect(errorReason("knowledge_graph_output_invalid:schema_validation")).toBe(
      "knowledge_graph_output_invalid:schema_validation"
    );
    expect(errorReason("Could not read /Users/someone/private note.md")).toBe("other");
    expect(errorReason("x".repeat(200))).toBe("other");
    expect(errorReason("  ")).toBe("unknown");
    expect(errorReason(null)).toBe("unknown");
  });
});

describe("aggregateAutomation", () => {
  it("counts runs by status and the reasons of failed or canceled ones", () => {
    const result = aggregateAutomation([
      { status: "applied", reason: null },
      { status: "failed", reason: "organization.errors.invalid" },
      { status: "failed", reason: "organization.errors.invalid" },
      { status: "failed", reason: "free text with a title in it" },
      { status: "canceled", reason: null },
      { status: "awaiting_review", reason: null }
    ]);
    expect(result.total).toBe(6);
    expect(result.byStatus).toEqual({ applied: 1, failed: 3, canceled: 1, awaiting_review: 1 });
    expect(result.blockedReasons).toEqual({
      "organization.errors.invalid": 2,
      other: 1,
      unknown: 1
    });
    expect(result.awaitingReview).toBe(1);
  });
});

describe("aggregateJobs", () => {
  it("groups by type and status with latency, and lists failure reasons", () => {
    const result = aggregateJobs([
      { type: "ingestion", status: "succeeded", error: null, latencyMs: 4000 },
      { type: "ingestion", status: "succeeded", error: null, latencyMs: 8000 },
      {
        type: "ingestion",
        status: "failed",
        error: "errors.matching.rerankingFailed",
        latencyMs: 100
      },
      {
        type: "ingestion",
        status: "failed",
        error: "errors.matching.rerankingFailed",
        latencyMs: 100
      },
      { type: "organization", status: "failed", error: "Some sentence", latencyMs: null },
      { type: "organization", status: "queued", error: null, latencyMs: null }
    ]);
    expect(result.total).toBe(6);
    expect(result.byTypeStatus.map((row) => `${row.type}/${row.status}:${row.count}`)).toEqual([
      "ingestion/failed:2",
      "ingestion/succeeded:2",
      "organization/failed:1",
      "organization/queued:1"
    ]);
    expect(result.byTypeStatus[1]?.latencySeconds).toMatchObject({ n: 2, p50: 6 });
    expect(result.byTypeStatus[2]?.latencySeconds).toBeNull();
    expect(result.failures).toEqual([
      { type: "ingestion", reason: "errors.matching.rerankingFailed", count: 2 },
      { type: "organization", reason: "other", count: 1 }
    ]);
  });
});
