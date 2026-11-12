import { describe, expect, it } from "vitest";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";

import { jobRecordSchema, type JobRecord } from "../../../shared/ipc";
import { monitoringRowSchema, type MonitoringPage } from "../../../shared/monitoring";
import {
  callLogState,
  callPageMax,
  callPageSize,
  callRowsOf,
  errorText,
  formatDuration,
  formatWhen,
  nextCallLimit,
  tokensOf,
  whenParts
} from "./call-log-model";
import {
  canConfirmPrune,
  defaultPruneForm,
  pruneRequestOf,
  pruneStageOf,
  type PruneForm
} from "./prune-model";
import {
  diagnosticsState,
  jobTypeKeyOf,
  knownJobTypes,
  taskHistoryState,
  taskRowsOf
} from "./task-history-model";

const en = createTranslator("en");
const ptBR = createTranslator("pt-BR");
const now = new Date(2026, 10, 12, 12, 0, 0);

const row = (over: Record<string, unknown> = {}) =>
  monitoringRowSchema.parse({
    id: "50000000-0000-4000-8000-000000000001",
    kind: "ai",
    operation: "write-fast",
    taskType: "write-fast",
    stage: "run",
    context: {},
    sources: [],
    provider: "openai",
    modelId: "gpt-5.6-luna",
    runtime: "remote",
    profileId: null,
    aiTaskRunId: null,
    status: "succeeded",
    startedAt: new Date(2026, 10, 12, 10, 42).toISOString(),
    finishedAt: null,
    durationMs: 1240,
    tokenUsage: { totalTokens: 1840 },
    costEstimate: null,
    debugRecorded: false,
    hasPayload: false,
    error: null,
    ...over
  });
const page = (rows: ReturnType<typeof row>[], count = rows.length): MonitoringPage => ({
  rows,
  totals: {
    count,
    failed: 0,
    running: 0,
    tokens: null,
    inputTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    cachedInputTokens: null,
    costEstimate: null,
    missingUsage: 0,
    missingCost: 0
  }
});

describe("the call log", () => {
  it("says a duration in the unit it is read in", () => {
    expect(formatDuration(38, "en")).toBe("38 ms");
    expect(formatDuration(1240, "en")).toBe("1.2 s");
    expect(formatDuration(1240, "pt-BR")).toBe("1,2 s");
    expect(formatDuration(134_000, "en")).toBe("2 min 14 s");
    expect(formatDuration(120_000, "en")).toBe("2 min");
    expect(formatDuration(null, "en")).toBeNull();
  });

  it("says when: a time today, yesterday with its time, else a date", () => {
    const at = (day: number, hour = 10, month = 10, year = 2026) =>
      new Date(year, month, day, hour, 42);
    expect(formatWhen(en, at(12), now)).toMatch(/10:42/u);
    expect(formatWhen(en, at(11), now)).toBe(`yesterday ${formatWhen(en, at(12), now)}`);
    expect(formatWhen(ptBR, at(11), now).startsWith("ontem ")).toBe(true);
    const older = formatWhen(en, at(3), now);
    expect(older).toContain("3");
    expect(older).toMatch(/10:42/u);
    expect(formatWhen(en, at(3, 10, 5, 2025), now)).toContain("2025");
  });

  it("splits a moment into its time and its day, in the person's language", () => {
    const at = (day: number, hour = 10) => new Date(2026, 10, day, hour, 42);
    const plain = (parts: { time: string; day: string | null }) => ({
      ...parts,
      time: parts.time.replace(/\s/gu, " ")
    });
    expect(plain(whenParts(en, at(12), now))).toEqual({ time: "10:42 AM", day: null });
    expect(plain(whenParts(en, at(11, 14), now))).toEqual({ time: "02:42 PM", day: "yesterday" });
    expect(whenParts(ptBR, at(11), now)).toEqual({ time: "10:42", day: "ontem" });
    expect(whenParts(en, at(3), now).day).toContain("3");
  });

  it("reads the total of tokens, or the sum of input and output, or nothing", () => {
    expect(tokensOf({ tokenUsage: { totalTokens: 10, inputTokens: 1 } })).toBe(10);
    expect(tokensOf({ tokenUsage: { inputTokens: 4, outputTokens: 6 } })).toBe(10);
    expect(tokensOf({ tokenUsage: {} })).toBeNull();
  });

  it("turns rows into what the table shows: the job, the model, the result in words, the reason it failed", () => {
    const failed = row({
      id: "50000000-0000-4000-8000-000000000002",
      status: "failed",
      durationMs: null,
      tokenUsage: {},
      error: "errors.common.timeout"
    });
    const [ok, bad] = callRowsOf(page([row(), failed]), ptBR, now);
    expect(ok).toMatchObject({
      job: "write-fast",
      model: "gpt-5.6-luna",
      duration: "1,2 s",
      tokens: "1.840",
      resultLabel: "Concluída",
      error: null
    });
    expect(bad).toMatchObject({ duration: null, tokens: null, resultLabel: "Falhou" });
    expect(bad?.error).toBe("A operação excedeu o tempo limite.");
  });

  it("says an error that is not a message key as it is", () => {
    expect(errorText(en, "connection reset")).toBe("connection reset");
    expect(errorText(en, "errors.unknown.nothing")).toBe("errors.unknown.nothing");
    expect(errorText(en, null)).toBeNull();
  });

  it("is loading, error, empty only when the log itself is empty, and success otherwise", () => {
    expect(callLogState({ status: "loading" }, "all")).toBe("loading");
    expect(callLogState({ status: "error" }, "all")).toBe("error");
    expect(callLogState({ status: "ready", value: page([]) }, "all")).toBe("empty");
    expect(callLogState({ status: "ready", value: page([]) }, "failed")).toBe("success");
    expect(callLogState({ status: "ready", value: page([row()]) }, "all")).toBe("success");
  });

  it("offers more calls 25 at a time until the page limit or the end of the log", () => {
    expect(nextCallLimit(callPageSize, 1284)).toBe(50);
    expect(nextCallLimit(75, 1284)).toBe(callPageMax);
    expect(nextCallLimit(callPageMax, 1284)).toBeNull();
    expect(nextCallLimit(callPageSize, 20)).toBeNull();
    expect(nextCallLimit(50, 50)).toBeNull();
  });
});

const job = (n: number, over: Record<string, unknown> = {}): JobRecord =>
  jobRecordSchema.parse({
    id: `60000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    type: "atomic-note-matching",
    status: "succeeded",
    progress: 1,
    attempts: 1,
    maxAttempts: 3,
    canCancel: false,
    canRetry: false,
    error: null,
    errorHistory: [],
    createdAt: new Date(2026, 10, 12, 10, 0, 0).toISOString(),
    updatedAt: new Date(2026, 10, 12, 10, 0, 48).toISOString(),
    aiExecution: null,
    ...over
  });

describe("the job history", () => {
  it("lists the finished runs only, newest first, with the source and how long it took", () => {
    const rows = taskRowsOf(
      [
        job(1, {
          updatedAt: new Date(2026, 10, 12, 9, 0, 48).toISOString(),
          createdAt: new Date(2026, 10, 12, 9, 0).toISOString()
        }),
        job(2, { status: "running", progress: 0.4 }),
        job(3, { status: "queued", progress: 0 }),
        job(4, {
          type: "summarization",
          status: "failed",
          error: "errors.common.timeout",
          source: {
            id: "70000000-0000-4000-8000-000000000004",
            title: "Streets for People",
            type: "WebArticle",
            origin: "file"
          }
        })
      ],
      en,
      now
    );
    expect(rows.map((entry) => entry.title)).toEqual(["Summary", "Connections between notes"]);
    expect(rows[0]).toMatchObject({
      outcome: "failed",
      outcomeLabel: "Failed",
      detail: "Streets for People",
      duration: "48 s"
    });
    expect(rows[0]?.error).toBe("The operation timed out.");
    expect(rows[1]).toMatchObject({ outcome: "succeeded", error: null });
  });

  it("leaves out the retired dispatchers, and a run that is still retrying is not history", () => {
    expect(
      taskRowsOf([job(1, { type: "organization" }), job(2, { type: "maintenance" })], en, now)
    ).toEqual([]);
  });

  it("is loading, error, empty (nothing finished) or success", () => {
    expect(taskHistoryState({ status: "loading" }, en, now)).toBe("loading");
    expect(taskHistoryState({ status: "error" }, en, now)).toBe("error");
    expect(taskHistoryState({ status: "ready", value: [] }, en, now)).toBe("empty");
    expect(
      taskHistoryState({ status: "ready", value: [job(1, { status: "running" })] }, en, now)
    ).toBe("empty");
    expect(taskHistoryState({ status: "ready", value: [job(1)] }, en, now)).toBe("success");
  });

  it("gives every job type a word in every language, and an unknown type the generic one", () => {
    expect(jobTypeKeyOf("something-new")).toBe("diagnostics.jobTypes.other");
    for (const type of knownJobTypes) {
      const key = jobTypeKeyOf(type);
      expect(key, type).not.toBe("diagnostics.jobTypes.other");
      for (const locale of supportedLanguageCodes)
        expect(createTranslator(locale)(key).startsWith("[[missing:"), `${locale} ${type}`).toBe(
          false
        );
    }
    // Every word the copy holds is used by a type (no copy without a reader).
    const used = new Set(knownJobTypes.map(jobTypeKeyOf).map((key) => key.split(".").at(-1)));
    expect(Object.keys(messages.en.diagnostics.jobTypes).sort()).toEqual([...used, "other"].sort());
  });

  it("puts the Diagnostics page in the state its pages say: waiting, failed, empty or something to show", () => {
    expect(diagnosticsState(["success", "loading"])).toBe("loading");
    expect(diagnosticsState(["error", "loading"])).toBe("loading");
    expect(diagnosticsState(["success", "error"])).toBe("error");
    expect(diagnosticsState(["empty", "empty"])).toBe("empty");
    expect(diagnosticsState(["empty", "success"])).toBe("success");
  });
});

describe("the confirmation before old records are deleted", () => {
  const form = (over: Partial<PruneForm> = {}): PruneForm => ({ ...defaultPruneForm, ...over });

  it("starts at 30 days of everything, and asks for a whole number from 1 to 3650", () => {
    expect(pruneRequestOf(form())).toEqual({ amount: 30, unit: "days", scope: "all" });
    expect(pruneRequestOf(form({ amount: " 12 ", unit: "months", scope: "payloads" }))).toEqual({
      amount: 12,
      unit: "months",
      scope: "payloads"
    });
    for (const amount of ["", "0", "-1", "3651", "1.5", "abc", "12345"])
      expect(pruneRequestOf(form({ amount })), amount).toBeNull();
  });

  it("is invalid until the form is a request, counting until the count answers, then ready or nothing", () => {
    expect(pruneStageOf(form({ amount: "" }), { status: "idle" })).toEqual({ kind: "invalid" });
    expect(pruneStageOf(form(), { status: "idle" })).toEqual({ kind: "counting" });
    expect(pruneStageOf(form(), { status: "counting" })).toEqual({ kind: "counting" });
    expect(pruneStageOf(form(), { status: "failed" })).toEqual({ kind: "failed" });
    expect(
      pruneStageOf(form(), { status: "counted", count: 0, cutoff: "2026-10-12T00:00:00.000Z" })
    ).toEqual({
      kind: "nothing"
    });
    expect(
      pruneStageOf(form(), { status: "counted", count: 12, cutoff: "2026-10-12T00:00:00.000Z" })
    ).toEqual({ kind: "ready", count: 12, cutoff: "2026-10-12T00:00:00.000Z" });
  });

  it("can be confirmed only when it was counted and something would go", () => {
    const counted = { status: "counted", count: 3, cutoff: "2026-10-12T00:00:00.000Z" } as const;
    expect(canConfirmPrune(pruneStageOf(form(), counted))).toBe(true);
    expect(canConfirmPrune(pruneStageOf(form(), { ...counted, count: 0 }))).toBe(false);
    expect(canConfirmPrune(pruneStageOf(form(), { status: "counting" }))).toBe(false);
    expect(canConfirmPrune(pruneStageOf(form(), { status: "failed" }))).toBe(false);
    // A form edited into something invalid cannot use the count of the form before it.
    expect(canConfirmPrune(pruneStageOf(form({ amount: "x" }), counted))).toBe(false);
  });
});
