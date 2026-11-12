import { jobRecordSchema, type JobRecord } from "../../../shared/ipc";
import { monitoringRowSchema, type MonitoringRow } from "../../../shared/monitoring";
import { screenTranslator } from "../../workspace/screen-locale";
import type { ScreenModule } from "../../workspace/surfaces";
import { SettingsSurface } from "../SettingsSurface";
import { appSettings, describeEntries } from "../sections/advanced/advanced.screen";
import { useAppSettings } from "../sections/advanced/use-app-settings";
import { useSettings } from "../settings-context";
import { groupLabelOf, groupsOf } from "../settings-model";
import { DiagnosticsGroup } from "./DiagnosticsGroup";

/** Settings fills the content area of the window: the rail's width stands empty beside it. */
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

/** What Settings reads before any page opens; the pages' own reads are what each state changes. */
const settings = {
  "settings.describe": { entries: describeEntries() },
  "settings.getApp": appSettings
};

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    ...settings,
    "monitoring.list": (query?: { status?: string }) => {
      const rows =
        query?.status === "failed" ? calls.filter((row) => row.status === "failed") : calls;
      return { rows, totals: totals(rows) };
    },
    "jobs.list": jobs
  },
  empty: { ...settings, "monitoring.list": emptyPage, "jobs.list": [] },
  // Loading and failure belong to the pages: Settings itself has its values, the pages wait or fail.
  loading: settings,
  error: settings
};

/** The Diagnostics group of Advanced as the app shows it, with both pages open. */
function DiagnosticsBody() {
  const { t: translate, section } = useSettings();
  const app = useAppSettings();
  const entries = groupsOf(section).find(({ group }) => group === "diagnostics")?.entries ?? [];
  return (
    <section aria-labelledby="settings-group-advanced-diagnostics">
      <h3
        id="settings-group-advanced-diagnostics"
        className="m-0 mt-8 text-sm font-semibold text-foreground"
      >
        {groupLabelOf(translate, section, "diagnostics")}
      </h3>
      <p className="m-0 mt-1 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
        {translate("settingsAdvanced.groups.diagnosticsIntro")}
      </p>
      <DiagnosticsGroup entries={entries} saveApp={app.save} openPages />
    </section>
  );
}

export function render() {
  return (
    <div className="h-screen bg-background text-foreground">
      <SettingsSurface
        t={t}
        surface={surface}
        initialSection="advanced"
        sections={{ advanced: { id: "advanced", Section: DiagnosticsBody } }}
      />
    </div>
  );
}
