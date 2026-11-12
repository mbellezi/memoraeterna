import { jobRecordSchema, type JobRecord } from "../../../shared/ipc";
import { monitoringRowSchema, type MonitoringRow } from "../../../shared/monitoring";
import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { DiagnosticsSurface } from "./DiagnosticsSurface";

/** The Diagnostics pages fill the Settings content area: the rail and the section column stand empty. */
export const fullWindow = true;

export const surface = "settings-diagnostics";

const t = screenTranslator();

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();
const id = (n: number, prefix = "5"): string =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const call = (
  n: number,
  minutes: number,
  taskType: string,
  modelId: string,
  durationMs: number | null,
  tokens: number | null,
  status: MonitoringRow["status"] = "succeeded",
  error: string | null = null
): MonitoringRow =>
  monitoringRowSchema.parse({
    id: id(n),
    kind: "ai",
    operation: taskType,
    taskType,
    stage: "run",
    context: {},
    sources: [],
    provider: modelId.startsWith("gpt") ? "openai" : "local",
    modelId,
    runtime: modelId.startsWith("gpt") ? "remote" : "mlx",
    profileId: null,
    aiTaskRunId: null,
    status,
    startedAt: minutesAgo(minutes),
    finishedAt: durationMs === null ? null : minutesAgo(minutes),
    durationMs,
    tokenUsage: tokens === null ? {} : { totalTokens: tokens },
    costEstimate: null,
    debugRecorded: false,
    hasPayload: false,
    error
  });

const calls: MonitoringRow[] = [
  call(1, 3, "write-fast", "gpt-5.6-luna", 1_240, 1_840),
  call(2, 4, "embed", "Qwen3-Embedding-0.6B", 38, 512),
  call(3, 4, "decide", "Qwen3-Reranker-0.6B", 96, 2_048),
  call(4, 8, "write-quality", "gpt-5.6-luna", 6_810, 9_112),
  call(
    5,
    9,
    "answer",
    "gpt-5.6-luna",
    null,
    null,
    "failed",
    "errors.relations.decisions.breakerOpen"
  ),
  call(6, 31, "judge", "gpt-5.6-luna", 3_140, 4_406),
  call(7, 33, "embed", "Qwen3-Embedding-0.6B", 41, 480),
  call(8, 36, "write-fast", "gpt-5.6-luna", 980, 1_520),
  call(9, 60 * 26, "write-fast", "gpt-5.6-luna", 1_100, 1_760),
  call(10, 60 * 27, "embed", "Qwen3-Embedding-0.6B", 40, 505)
];

const totals = (rows: readonly MonitoringRow[]) => ({
  count: rows.length === 0 ? 0 : 1_284,
  failed: rows.filter((row) => row.status === "failed").length,
  running: 0,
  tokens: rows.length === 0 ? null : 412_000,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  cachedInputTokens: null,
  missingUsage: 0,
  costEstimate: null,
  missingCost: 0
});

const job = (
  n: number,
  type: string,
  status: JobRecord["status"],
  minutes: number,
  lastedSeconds: number,
  title: string | null,
  error: string | null = null
): JobRecord =>
  jobRecordSchema.parse({
    id: id(n, "6"),
    type,
    status,
    progress: status === "succeeded" ? 1 : 0.4,
    attempts: 1,
    maxAttempts: 3,
    canCancel: false,
    canRetry: status === "failed",
    error,
    errorHistory: error
      ? [{ message: error, stage: "run", attempt: 1, occurredAt: minutesAgo(minutes) }]
      : [],
    createdAt: minutesAgo(minutes + lastedSeconds / 60),
    updatedAt: minutesAgo(minutes),
    aiExecution: null,
    source: title ? { id: id(n, "7"), title, type: "WebArticle", origin: "file" } : null
  });

const jobs: JobRecord[] = [
  job(1, "knowledge-graph-generation", "succeeded", 12, 134, "Streets for People"),
  job(2, "atomic-note-matching", "succeeded", 40, 48, null),
  job(3, "topic-name", "succeeded", 62, 12, null),
  job(4, "summarization", "failed", 95, 3, "Protected scan.pdf", "errors.common.timeout"),
  job(5, "topic-rebalance", "canceled", 60 * 22, 5, null)
];

const emptyPage = { rows: [], totals: totals([]) };

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "monitoring.list": (query?: { status?: string }) => {
      const rows =
        query?.status === "failed" ? calls.filter((row) => row.status === "failed") : calls;
      return { rows, totals: totals(rows) };
    },
    "jobs.list": jobs
  },
  empty: { "monitoring.list": emptyPage, "jobs.list": [] }
};

export function render() {
  return (
    <div className="h-screen overflow-auto bg-background text-foreground">
      <DiagnosticsSurface t={t} />
    </div>
  );
}
