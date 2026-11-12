import type { MessageKey, Translator } from "@app/i18n";

import type { MonitoringPage, MonitoringRow } from "../../../shared/monitoring";

/**
 * What the AI call log shows (F5 T165, docs/f5-decisions.md D17): the rows of `monitoring.list`
 * read-only, as a person reads them (when, job, model, time, tokens, result) and the state the
 * page is in. Pure, so the rules are tested without a renderer.
 */

export type CallFilter = "all" | "failed";
export type CallResult = MonitoringRow["status"];

export interface CallRowView {
  id: string;
  /** The start, in the person's words: a time today, "yesterday" and a time, or a date. */
  when: string;
  /** The same instant in full, for the hover. */
  whenFull: string;
  /** The job's technical name (the page says it is technical). */
  job: string;
  model: string | null;
  /** "38 ms", "1.2 s", "2 min 14 s"; null while it runs or when it was not measured. */
  duration: string | null;
  tokens: string | null;
  result: CallResult;
  resultLabel: string;
  /** The reason it failed, when it did. */
  error: string | null;
}

export const callPageSize = 25;
/** The largest page `monitoring.list` answers. */
export const callPageMax = 100;

/** The page size after "Show more", or null when the log is shown as far as it goes. */
export const nextCallLimit = (limit: number, total: number): number | null =>
  limit >= callPageMax || limit >= total ? null : Math.min(callPageMax, limit + callPageSize);

const resultKeys: Record<CallResult, MessageKey> = {
  succeeded: "diagnostics.callLog.results.succeeded",
  failed: "diagnostics.callLog.results.failed",
  running: "diagnostics.callLog.results.running",
  canceled: "diagnostics.callLog.results.canceled",
  interrupted: "diagnostics.callLog.results.interrupted"
};

/** A duration in the unit a person reads it in. */
export function formatDuration(ms: number | null, locale: string): string | null {
  if (ms === null) return null;
  const number = (value: number, digits: number) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(value);
  if (ms < 1_000) return `${number(Math.round(ms), 0)} ms`;
  if (ms < 60_000) return `${number(Math.round(ms / 100) / 10, 1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1_000);
  return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
}

const sameDay = (left: Date, right: Date): boolean =>
  left.getFullYear() === right.getFullYear() &&
  left.getMonth() === right.getMonth() &&
  left.getDate() === right.getDate();

/** "10:42" today, "yesterday 10:42", else "12 Oct 10:42" (the month in the person's language). */
export function formatWhen(t: Translator, at: Date, now: Date): string {
  const time = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit" }).format(at);
  if (sameDay(at, now)) return time;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(at, yesterday)) return t("diagnostics.when.yesterday", { values: { time } });
  const day = new Intl.DateTimeFormat(t.locale, {
    day: "numeric",
    month: "short",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" })
  }).format(at);
  return `${day} ${time}`;
}

export const formatFull = (locale: string, at: Date): string =>
  new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "medium" }).format(at);

/** The total a row reports, or the sum of its input and output; null when it reports neither. */
export function tokensOf(row: Pick<MonitoringRow, "tokenUsage">): number | null {
  const usage = row.tokenUsage;
  if (typeof usage.totalTokens === "number") return usage.totalTokens;
  const parts = [usage.inputTokens, usage.outputTokens].filter(
    (value): value is number => typeof value === "number"
  );
  return parts.length > 0 ? parts.reduce((sum, value) => sum + value, 0) : null;
}

export function callRowsOf(page: MonitoringPage, t: Translator, now: Date): CallRowView[] {
  return page.rows.map((row) => {
    const at = new Date(row.startedAt);
    const tokens = tokensOf(row);
    return {
      id: row.id,
      when: formatWhen(t, at, now),
      whenFull: formatFull(t.locale, at),
      job: row.taskType ?? row.operation,
      model: row.modelId,
      duration: formatDuration(row.durationMs, t.locale),
      tokens: tokens === null ? null : new Intl.NumberFormat(t.locale).format(tokens),
      result: row.status,
      resultLabel: t(resultKeys[row.status]),
      error:
        row.status === "failed" || row.status === "interrupted" ? errorText(t, row.error) : null
    };
  });
}

/**
 * The text of a stored error: a message key the catalog knows is said in the person's language,
 * anything else is shown as it is (a diagnostic page shows the raw text of an unknown failure).
 */
export function errorText(t: Translator, text: string | null): string | null {
  if (text === null) return null;
  if (/^[a-z][A-Za-z]*(\.[A-Za-z0-9_-]+)+$/u.test(text)) {
    const said = t(text as MessageKey);
    if (!said.startsWith("[[missing:")) return said;
  }
  return text;
}

export type PageRead<V> =
  { status: "loading" } | { status: "error" } | { status: "ready"; value: V };

/** Loading, error, empty (the log has no call; a filter that matches nothing is not empty) or success. */
export function callLogState(read: PageRead<MonitoringPage>, filter: CallFilter) {
  if (read.status !== "ready") return read.status;
  return read.value.rows.length === 0 && filter === "all" ? "empty" : "success";
}
