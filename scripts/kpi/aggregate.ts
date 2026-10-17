import { share, sumReported, summarize, tally, toSeconds, type Distribution } from "./stats.js";
import { treeShape, type TreeShape } from "./tree.js";

/**
 * Pure aggregation of raw database rows into KPI figures. Nothing here touches the database or
 * returns identifiers or text content: only counts, durations, tokens and shares.
 */

// --- Ingestion stages ------------------------------------------------------------------------

export interface StageRow {
  readonly stage: string;
  readonly status: string;
  /** The stage was completed from an earlier run's artifacts and did not execute. */
  readonly reused: boolean;
  /** Milliseconds from the first start to completion; null when either end is missing. */
  readonly wallMs: number | null;
  /** Milliseconds of the latest attempt; null on databases without attempt columns. */
  readonly attemptMs: number | null;
  /** Number of attempts; null on databases without the attempts column. */
  readonly attempts: number | null;
}

export interface StageKpi {
  readonly stage: string;
  readonly rows: number;
  /** Completed after executing (reused artifacts excluded). */
  readonly executed: number;
  readonly reused: number;
  readonly skipped: number;
  readonly failed: number;
  readonly canceled: number;
  /** Pending, running or waiting. */
  readonly open: number;
  /** Rows with more than one attempt; null when attempts were not recorded. */
  readonly retried: number | null;
  /** Executed stages whose start or end was not recorded, so no duration exists. */
  readonly durationUnknown: number;
  readonly wallSeconds: Distribution | null;
  readonly attemptSeconds: Distribution | null;
}

export const pipelineStageOrder: readonly string[] = [
  "conversion",
  "structureDetection",
  "structureReview",
  "materialization",
  "chunking",
  "summarization",
  "aggregateSummarization",
  "embedding",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "sourceMatching",
  "organizeKnowledge",
  "obsidianProjection"
];

export function aggregateStages(rows: readonly StageRow[]): StageKpi[] {
  const byStage = new Map<string, StageRow[]>();
  for (const row of rows) {
    const list = byStage.get(row.stage);
    if (list) list.push(row);
    else byStage.set(row.stage, [row]);
  }
  const rank = (stage: string) => {
    const index = pipelineStageOrder.indexOf(stage);
    return index === -1 ? pipelineStageOrder.length : index;
  };
  return [...byStage.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([stage, list]) => {
      const executedRows = list.filter((row) => row.status === "completed" && !row.reused);
      const known = (value: number | null) => value !== null && value >= 0;
      return {
        stage,
        rows: list.length,
        executed: executedRows.length,
        reused: list.filter((row) => row.status === "completed" && row.reused).length,
        skipped: list.filter((row) => row.status === "skipped").length,
        failed: list.filter((row) => row.status === "failed").length,
        canceled: list.filter((row) => row.status === "canceled").length,
        open: list.filter(
          (row) => !["completed", "skipped", "failed", "canceled"].includes(row.status)
        ).length,
        retried: list.some((row) => row.attempts !== null)
          ? list.filter((row) => (row.attempts ?? 0) > 1).length
          : null,
        durationUnknown: executedRows.filter((row) => !known(row.wallMs)).length,
        wallSeconds: toSeconds(
          summarize(executedRows.map((row) => (known(row.wallMs) ? row.wallMs : null)))
        ),
        attemptSeconds: toSeconds(
          summarize(executedRows.map((row) => (known(row.attemptMs) ? row.attemptMs : null)))
        )
      };
    });
}

export interface RunRow {
  readonly status: string;
  /** Milliseconds from creation to start. */
  readonly queueMs: number | null;
  /** Milliseconds from start to completion. */
  readonly wallMs: number | null;
}

export interface RunKpi {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  readonly queueSeconds: Distribution | null;
  /** Succeeded runs only. */
  readonly wallSeconds: Distribution | null;
}

export function aggregateRuns(rows: readonly RunRow[]): RunKpi {
  const nonNegative = (value: number | null) => (value !== null && value >= 0 ? value : null);
  return {
    total: rows.length,
    byStatus: tally(rows, (row) => row.status),
    queueSeconds: toSeconds(summarize(rows.map((row) => nonNegative(row.queueMs)))),
    wallSeconds: toSeconds(
      summarize(
        rows.filter((row) => row.status === "succeeded").map((row) => nonNegative(row.wallMs))
      )
    )
  };
}

// --- AI usage --------------------------------------------------------------------------------

export interface AiRunRow {
  readonly task: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly queueMs: number | null;
  /** Zero-based retry index (0 = first try) when reported. */
  readonly attempt: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cost: number | null;
  /** Operation name from the monitoring table, when the call has a monitoring record. */
  readonly operation: string | null;
  readonly noteId: string | null;
  readonly sourceId: string | null;
  /** The scheduler's columns (migration 0057); absent or null on rows written before it. */
  readonly lane?: string | null;
  readonly workloadClass?: string | null;
  readonly deadlineMs?: number | null;
  readonly deadlineOutcome?: string | null;
  /** Lane re-waits between attempts, excluded from the deadline. */
  readonly requeueMs?: number | null;
  readonly isRepair?: boolean | null;
}

export interface TokenTotal {
  readonly sum: number;
  /** Calls that reported the figure; the rest are unknown, not zero. */
  readonly reportedCalls: number;
}

export interface AiGroup {
  readonly calls: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly canceled: number;
  readonly inputTokens: TokenTotal;
  readonly outputTokens: TokenTotal;
  readonly reasoningTokens: TokenTotal;
  /** Succeeded calls only. */
  readonly durationSeconds: Distribution | null;
  /** Calls with a measured queue wait. */
  readonly queueSeconds: Distribution | null;
  /** Calls that reported a retry index, and how many of them were retries or repairs. */
  readonly retries: { readonly reportedCalls: number; readonly retryCalls: number };
  /** Calls that reported a cost estimate; the rest are unknown, not free. */
  readonly cost: { readonly sum: number; readonly knownCalls: number };
}

export interface AiRouteGroup extends AiGroup {
  readonly task: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime: string;
}

/** The calls of one lane kind and workload class (F3 D29-D31). */
export interface AiLaneGroup {
  /** `local`, `remote: <provider>`, or `unknown` for rows written before the lane scheduler. */
  readonly lane: string;
  readonly workloadClass: string;
  readonly calls: number;
  readonly failedOrCanceled: number;
  readonly queueSeconds: Distribution | null;
  /** Lane re-waits after retry backoffs, of the calls that recorded them. */
  readonly requeueSeconds: Distribution | null;
  /** Calls that recorded a deadline. */
  readonly withDeadline: number;
  /** Calls a deadline ended (`deadline_outcome = aborted`). */
  readonly deadlineAborted: number;
  /** Calls that ran more than 2 s past their deadline, lane re-waits excluded (exit X6). */
  readonly pastDeadline: number;
  readonly repairs: number;
}

export interface AiKpi {
  readonly total: AiGroup;
  readonly byTask: ReadonlyArray<AiGroup & { readonly task: string }>;
  readonly byRoute: readonly AiRouteGroup[];
  readonly byLane: readonly AiLaneGroup[];
}

/** Grace a call has past its deadline before it counts as past deadline (F3 D2, X6). */
const pastDeadlineGraceMs = 2_000;

function laneName(row: AiRunRow): string {
  if (row.lane === "local") return "local";
  if (row.lane?.startsWith("remote:")) return `remote: ${row.provider}`;
  return "unknown";
}

function isPastDeadline(row: AiRunRow): boolean {
  const deadline = nonNegative(row.deadlineMs ?? null);
  const duration = nonNegative(row.durationMs);
  if (deadline === null || duration === null) return false;
  return duration - (nonNegative(row.requeueMs ?? null) ?? 0) > deadline + pastDeadlineGraceMs;
}

export function aiLaneGroups(rows: readonly AiRunRow[]): AiLaneGroup[] {
  return [...groupBy(rows, (row) => [laneName(row), row.workloadClass ?? "unknown"].join("\u0000"))]
    .map(([key, list]) => {
      const [lane, workloadClass] = key.split("\u0000") as [string, string];
      return {
        lane,
        workloadClass,
        calls: list.length,
        failedOrCanceled: list.filter((row) => row.status !== "succeeded").length,
        queueSeconds: toSeconds(summarize(list.map((row) => nonNegative(row.queueMs)))),
        requeueSeconds: toSeconds(summarize(list.map((row) => nonNegative(row.requeueMs ?? null)))),
        withDeadline: list.filter((row) => nonNegative(row.deadlineMs ?? null) !== null).length,
        deadlineAborted: list.filter((row) => row.deadlineOutcome === "aborted").length,
        pastDeadline: list.filter(isPastDeadline).length,
        repairs: list.filter((row) => row.isRepair === true).length
      };
    })
    .sort((a, b) => b.calls - a.calls || a.lane.localeCompare(b.lane));
}

const nonNegative = (value: number | null): number | null =>
  value !== null && Number.isFinite(value) && value >= 0 ? value : null;

export function aiGroup(rows: readonly AiRunRow[]): AiGroup {
  const succeeded = rows.filter((row) => row.status === "succeeded");
  const reportedAttempts = rows.filter((row) => row.attempt !== null);
  const cost = sumReported(rows.map((row) => nonNegative(row.cost)));
  const total = (pick: (row: AiRunRow) => number | null): TokenTotal => {
    const { sum, reported } = sumReported(rows.map((row) => nonNegative(pick(row))));
    return { sum, reportedCalls: reported };
  };
  return {
    calls: rows.length,
    succeeded: succeeded.length,
    failed: rows.filter((row) => row.status === "failed").length,
    canceled: rows.filter((row) => row.status === "canceled").length,
    inputTokens: total((row) => row.inputTokens),
    outputTokens: total((row) => row.outputTokens),
    reasoningTokens: total((row) => row.reasoningTokens),
    durationSeconds: toSeconds(summarize(succeeded.map((row) => nonNegative(row.durationMs)))),
    queueSeconds: toSeconds(summarize(rows.map((row) => nonNegative(row.queueMs)))),
    retries: {
      reportedCalls: reportedAttempts.length,
      retryCalls: reportedAttempts.filter((row) => (row.attempt ?? 0) > 0).length
    },
    cost: { sum: cost.sum, knownCalls: cost.reported }
  };
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const name = key(row);
    const list = groups.get(name);
    if (list) list.push(row);
    else groups.set(name, [row]);
  }
  return groups;
}

export function aggregateAi(rows: readonly AiRunRow[]): AiKpi {
  const byCallsDescending = <T extends { calls: number }>(a: T, b: T) => b.calls - a.calls;
  return {
    total: aiGroup(rows),
    byTask: [...groupBy(rows, (row) => row.task)]
      .map(([task, list]) => ({ task, ...aiGroup(list) }))
      .sort(byCallsDescending),
    byRoute: [
      ...groupBy(rows, (row) => [row.task, row.provider, row.model, row.runtime].join("\u0000"))
    ]
      .map(([, list]) => {
        const [first] = list as [AiRunRow, ...AiRunRow[]];
        return {
          task: first.task,
          provider: first.provider,
          model: first.model,
          runtime: first.runtime,
          ...aiGroup(list)
        };
      })
      .sort(byCallsDescending),
    byLane: aiLaneGroups(rows)
  };
}

// --- Matching --------------------------------------------------------------------------------

export const noteMatchingOperation = "note_matching_reranking";
export const sourceMatchingOperation = "source_relation_matching";

export interface OperationSpan {
  readonly operation: string;
  readonly status: string;
  readonly durationMs: number | null;
}

export interface MatchingGroup {
  readonly calls: number;
  readonly failed: number;
  /** Distinct notes (note matching) or distinct source roots (source matching) among the calls. */
  readonly distinctTargets: number | null;
  readonly callsPerTarget: number | null;
  /** Seconds of succeeded calls divided by distinct targets: all passes over the same target count. */
  readonly secondsPerTarget: number | null;
  readonly callSeconds: Distribution | null;
  readonly queueSeconds: Distribution | null;
  readonly retries: { readonly reportedCalls: number; readonly retryCalls: number };
}

export interface MatchingKpi {
  /** One reranking call per note: the v6 note-matching contract. */
  readonly noteMatching: MatchingGroup | null;
  /** One reranking call per source pair attempt. */
  readonly sourceMatching: MatchingGroup | null;
  /** Reranking calls that have no monitoring record, so their purpose is unknown. */
  readonly unclassifiedReranking: MatchingGroup | null;
  /** Wall-clock operation spans, recorded only while diagnostic mode is on. */
  readonly operationSeconds: Readonly<Record<string, Distribution | null>>;
}

function matchingGroup(
  rows: readonly AiRunRow[],
  target: (row: AiRunRow) => string | null
): MatchingGroup | null {
  if (rows.length === 0) return null;
  const aiTotals = aiGroup(rows);
  const targets = new Set(rows.map(target).filter((id): id is string => id !== null));
  const distinct = targets.size > 0 ? targets.size : null;
  const succeededSeconds = aiTotals.durationSeconds?.sum ?? 0;
  return {
    calls: rows.length,
    failed: aiTotals.failed,
    distinctTargets: distinct,
    callsPerTarget: distinct ? rows.length / distinct : null,
    secondsPerTarget: distinct ? succeededSeconds / distinct : null,
    callSeconds: aiTotals.durationSeconds,
    queueSeconds: aiTotals.queueSeconds,
    retries: aiTotals.retries
  };
}

export const matchingOperationSpans: readonly string[] = [
  "atomic-note-matching",
  "source-matching"
];

export function aggregateMatching(
  rows: readonly AiRunRow[],
  spans: readonly OperationSpan[]
): MatchingKpi {
  const reranking = rows.filter((row) => row.task === "reranking");
  const spanSeconds: Record<string, Distribution | null> = {};
  for (const operation of matchingOperationSpans) {
    spanSeconds[operation] = toSeconds(
      summarize(
        spans
          .filter((span) => span.operation === operation && span.status === "succeeded")
          .map((span) => nonNegative(span.durationMs))
      )
    );
  }
  return {
    noteMatching: matchingGroup(
      reranking.filter((row) => row.operation === noteMatchingOperation),
      (row) => row.noteId
    ),
    sourceMatching: matchingGroup(
      reranking.filter((row) => row.operation === sourceMatchingOperation),
      (row) => row.sourceId
    ),
    unclassifiedReranking: matchingGroup(
      reranking.filter((row) => row.operation === null),
      () => null
    ),
    operationSeconds: spanSeconds
  };
}

// --- Wiki structure --------------------------------------------------------------------------

export interface WikiPageRow {
  readonly id: string;
  readonly parentId: string | null;
  readonly archived: boolean;
  /** `ai_managed` or `human_managed`; null on databases that predate the column. */
  readonly management: string | null;
  readonly role: string | null;
  readonly kind: string;
}

export interface WikiKpi {
  readonly pages: number;
  readonly archivedPages: number;
  readonly byRole: ReadonlyArray<{
    readonly management: string;
    readonly role: string;
    readonly count: number;
  }>;
  /** Non-archived AI-managed pages without a parent. */
  readonly aiOrphanRoots: number;
  /** Non-archived human-managed pages without a parent (designed roots). */
  readonly humanRoots: number;
  readonly shape: TreeShape;
  /** Current notes and how many appear in a membership of a non-archived page. */
  readonly notes: {
    readonly current: number;
    readonly inMembership: number;
    readonly share: number | null;
  } | null;
  /** Sources and how many own a source TOC page. */
  readonly sources: {
    readonly total: number;
    readonly withToc: number;
    readonly share: number | null;
  } | null;
}

export function aggregateWiki(
  pages: readonly WikiPageRow[],
  notes: { current: number; inMembership: number } | null,
  sources: { total: number; withToc: number } | null
): WikiKpi {
  const live = pages.filter((page) => !page.archived);
  const roleCounts = new Map<string, { management: string; role: string; count: number }>();
  for (const page of live) {
    const management = page.management ?? "unknown";
    const role = page.role ?? page.kind;
    const key = `${management}\u0000${role}`;
    const entry = roleCounts.get(key);
    if (entry) entry.count += 1;
    else roleCounts.set(key, { management, role, count: 1 });
  }
  const isRoot = (page: WikiPageRow) => page.parentId === null;
  return {
    pages: live.length,
    archivedPages: pages.length - live.length,
    byRole: [...roleCounts.values()].sort(
      (a, b) =>
        b.count - a.count ||
        a.management.localeCompare(b.management) ||
        a.role.localeCompare(b.role)
    ),
    aiOrphanRoots: live.filter((page) => isRoot(page) && page.management === "ai_managed").length,
    humanRoots: live.filter((page) => isRoot(page) && page.management === "human_managed").length,
    shape: treeShape(live.map((page) => ({ id: page.id, parentId: page.parentId }))),
    notes: notes ? { ...notes, share: share(notes.inMembership, notes.current) } : null,
    sources: sources ? { ...sources, share: share(sources.withToc, sources.total) } : null
  };
}

// --- Maintenance, organization and jobs -------------------------------------------------------

const reasonPattern = /^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/;

/** Keeps machine-readable error codes and hides anything that could carry content. */
export function errorReason(error: string | null | undefined): string {
  const text = error?.trim();
  if (!text) return "unknown";
  return reasonPattern.test(text) ? text : "other";
}

export interface AutomationRunRow {
  readonly status: string;
  readonly reason: string | null;
}

export interface AutomationKpi {
  readonly total: number;
  readonly byStatus: Record<string, number>;
  /** Reasons of runs that ended failed or canceled, as machine-readable codes. */
  readonly blockedReasons: Record<string, number>;
  readonly awaitingReview: number;
}

export function aggregateAutomation(rows: readonly AutomationRunRow[]): AutomationKpi {
  const blocked = rows.filter((row) => row.status === "failed" || row.status === "canceled");
  return {
    total: rows.length,
    byStatus: tally(rows, (row) => row.status),
    blockedReasons: tally(blocked, (row) => errorReason(row.reason)),
    awaitingReview: rows.filter((row) => row.status === "awaiting_review").length
  };
}

export interface JobRow {
  readonly type: string;
  readonly status: string;
  readonly error: string | null;
  /** Milliseconds from creation to finish. */
  readonly latencyMs: number | null;
}

export interface JobsKpi {
  readonly total: number;
  readonly byTypeStatus: ReadonlyArray<{
    readonly type: string;
    readonly status: string;
    readonly count: number;
    readonly latencySeconds: Distribution | null;
  }>;
  readonly failures: ReadonlyArray<{
    readonly type: string;
    readonly reason: string;
    readonly count: number;
  }>;
}

export function aggregateJobs(rows: readonly JobRow[]): JobsKpi {
  const groups = groupBy(rows, (row) => `${row.type}\u0000${row.status}`);
  const failures = groupBy(
    rows.filter((row) => row.status === "failed"),
    (row) => `${row.type}\u0000${errorReason(row.error)}`
  );
  return {
    total: rows.length,
    byTypeStatus: [...groups.values()]
      .map((list) => {
        const [first] = list as [JobRow, ...JobRow[]];
        return {
          type: first.type,
          status: first.status,
          count: list.length,
          latencySeconds: toSeconds(summarize(list.map((row) => nonNegative(row.latencyMs))))
        };
      })
      .sort((a, b) => a.type.localeCompare(b.type) || a.status.localeCompare(b.status)),
    failures: [...failures.entries()]
      .map(([key, list]) => {
        const [type = "", reason = ""] = key.split("\u0000");
        return { type, reason, count: list.length };
      })
      .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type))
  };
}
