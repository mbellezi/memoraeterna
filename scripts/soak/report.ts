/**
 * The report of a soak run (F3 T62 harness, T64r report; spec 5.9 and gate P of 7.2). It reads the
 * run directory the driver wrote (`meta.json`, `events.ndjson`, `samples.ndjson`,
 * `task-runs.ndjson`), never the database, and produces the X6 table, the audit of non-injected
 * failures, every wedged event, and, with `--presoak`, the assertion that each injected fault kind
 * ended the way the remote deadlines say.
 *
 *   npm run soak:report -- .cache/f3/soak/<run> [--presoak] [--explanations <file.json>]
 *
 * A run of the 7-day Hybrid soak (F4 T89; its meta has an `f4` section) adds E1-E5, the injection
 * ledger, the token budget and the load ledger (`report-f4.ts`), and with `--count-local-writer` the
 * repair rate counts every structured call of the local writer (C4's re-run), not only the others.
 *
 * Exit code 0 when every check passes, 2 when some need a person's judgement (the report says
 * which), 1 when one fails or the run cannot be read. Writes `report.md` and `report.json` into the
 * run directory (or where `--out` and `--json` say).
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { defaultAiRuntimeConfig } from "../../packages/ai/src/remote-execution.ts";
import { defaultAiLaneRuntimeConfig } from "../../packages/ai/src/runtime-config.ts";
import { gateSAssertions, f4Report, predicateVersions, type F4Report } from "./report-f4.ts";
import {
  parseNdjson,
  soakEventSchema,
  soakFiles,
  soakMetaSchema,
  soakSampleSchema,
  taskRunRecordSchema,
  type ActionRecord,
  type ExchangeRecord,
  type JobFailureEvent,
  type LocalFaultRecord,
  type SoakEvent,
  type SoakMeta,
  type SoakSample,
  type TaskRunRecord,
  type WindowRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";

export interface LoadedRun {
  meta: SoakMeta;
  events: SoakEvent[];
  samples: SoakSample[];
  rows: TaskRunRecord[];
  /** Lines that could not be read, by file. */
  invalid: Record<string, number>;
}

export type CheckStatus = "pass" | "fail" | "review" | "n/a";

export interface Check {
  id: string;
  title: string;
  bar: string;
  status: CheckStatus;
  value: string;
  /** What to look at, in plain lines (at most a few dozen). */
  details: string[];
}

export interface PresoakAssertion {
  kind: string;
  provider: string;
  occurrences: number;
  expectedOutcome: "met" | "aborted";
  attempt: string;
  call: string;
  status: CheckStatus;
}

export interface SoakReport {
  run: string;
  profile: string;
  generatedAt: string;
  verdict: "pass" | "review" | "fail";
  window: { startedAt: string; endedAt: string | null; endReason: string | null; hours: number };
  counts: {
    taskRuns: number;
    /** Audit rows that started before the run began (the collector reads from a little before it): left out. */
    beforeStart: number;
    failedJobs: number;
    events: number;
    samples: number;
    actions: Record<string, Record<string, number>>;
    invalid: Record<string, number>;
  };
  checks: Check[];
  /** The F4 lines of a 7-day run (E1-E5 and the ledgers); null for F3's runs. */
  f4: F4Report | null;
  /** The relations configuration the run kept (discovery neighbours, judge mode). */
  relations: string | null;
  /** The version of each rule evaluated, so a number is tied to the predicate that made it. */
  predicates: Record<string, number>;
  /** The repair rate counted every structured call of the local writer (C4's re-run). */
  countedLocalWriter: boolean;
  presoak: PresoakAssertion[] | null;
  tables: {
    calls: Array<Record<string, string | number>>;
    p0: Array<Record<string, string | number>>;
    resources: Array<Record<string, string | number>>;
  };
  failureAudit: Array<Record<string, string | number | null>>;
  wedged: string[];
}

const minute = 60_000;
const hour = 60 * minute;
const toMs = (iso: string) => Date.parse(iso);
const rowStart = (row: TaskRunRecord) => toMs(row.startedAt);
const rowEnd = (row: TaskRunRecord) =>
  row.finishedAt ? toMs(row.finishedAt) : rowStart(row) + row.durationMs;

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

/** Generative calls that ask for structured output: what D35's repair rate is a share of. */
const structuredTasks = new Set([
  "structured-output",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "entity-extraction",
  "claim-extraction"
]);
export function isStructuredGenerative(row: TaskRunRecord): boolean {
  if (row.taskType === "embedding") return false;
  // A reranking row that records a schema mode is a generative model judging with a structured
  // verdict (the source judge on the writer); a dedicated cross-encoder ranker records none.
  if (row.taskType === "reranking") return row.schemaMode !== null;
  return (
    structuredTasks.has(row.taskType) ||
    row.schemaMode === "strict" ||
    row.schemaMode === "json" ||
    row.schemaMode === "grammar"
  );
}

/** The remote total deadline of each class (the defaults; a remote call is never x3). */
const remoteTotals: Record<string, number> = defaultAiRuntimeConfig.deadlines.totalMs;

/** Where the fake providers listened and which lane their calls took. */
function providerLanes(meta: SoakMeta): Map<string, string> {
  return new Map(
    meta.providers.flatMap((provider) =>
      provider.providerConfigId
        ? [[provider.provider, `remote:${provider.providerConfigId}`] as const]
        : []
    )
  );
}

const exchangesOf = (events: readonly SoakEvent[]) =>
  events.filter((event): event is ExchangeRecord => event.type === "exchange");
const windowsOf = (events: readonly SoakEvent[]) =>
  events.filter((event): event is WindowRecord => event.type === "window");
const localsOf = (events: readonly SoakEvent[]) =>
  events.filter((event): event is LocalFaultRecord => event.type === "local");
const jobFailuresOf = (events: readonly SoakEvent[]) =>
  events.filter((event): event is JobFailureEvent => event.type === "job_failure");
const actionsOf = (events: readonly SoakEvent[]) =>
  events.filter((event): event is ActionRecord => event.type === "action");

/** The marker an injected error carries in the audit (soak-local-faults.ts). */
const injectedMarker = "soak-injected";
/** A repair follows an injected malformed answer this soon. */
const repairWindowMs = 3 * minute;

/**
 * The calls an injected fault explains: the rows that overlap an injected exchange or window of the
 * provider on their lane, a local fault on the local lane, a repair right after an injected
 * malformed answer, and rows whose error names the marker.
 */
export function injectedRows(run: LoadedRun): Map<string, string> {
  const lanes = providerLanes(run.meta);
  const reasons = new Map<string, string>();
  const injected = exchangesOf(run.events).filter((exchange) => exchange.injected);
  const windows = windowsOf(run.events);
  // A fault that took effect: a helper that was killed, a batch that was aborted in the middle.
  const locals = localsOf(run.events).filter(
    (fault) =>
      (fault.kind === "mlx_kill" && fault.detail.killed === true) ||
      (fault.kind === "gguf_abort" && fault.detail.stage === "fired")
  );
  const grace = 1_000;
  for (const row of run.rows) {
    const start = rowStart(row) - grace;
    const end = rowEnd(row) + grace;
    if (row.error?.includes(injectedMarker)) {
      reasons.set(row.id, "injected error");
      continue;
    }
    // The harness token cap refused the call (the gate S window): the harness's doing, not the product's.
    if (row.error?.includes("soak-harness-cap")) {
      reasons.set(row.id, "harness cap");
      continue;
    }
    if (row.lane?.startsWith("remote:")) {
      const provider = [...lanes].find(([, lane]) => lane === row.lane)?.[0];
      const hit = injected.find(
        (exchange) =>
          exchange.provider === provider &&
          toMs(exchange.startedAt) <= end &&
          toMs(exchange.endedAt) >= start
      );
      if (hit) {
        reasons.set(row.id, hit.kind);
        continue;
      }
      const window = windows.find(
        (entry) =>
          entry.provider === provider &&
          toMs(entry.startedAt) <= end &&
          toMs(entry.endedAt) >= start
      );
      if (window) {
        reasons.set(row.id, window.kind);
        continue;
      }
      if (row.isRepair || (row.attempt ?? 0) >= 1) {
        const malformed = injected.find(
          (exchange) =>
            exchange.provider === provider &&
            exchange.kind === "malformed" &&
            toMs(exchange.endedAt) <= rowStart(row) + grace &&
            rowStart(row) - toMs(exchange.endedAt) <= repairWindowMs
        );
        if (malformed) reasons.set(row.id, "malformed");
      }
    } else if (row.lane === "local") {
      const fault = locals.find((entry) => {
        const at = toMs(entry.at);
        return at >= start && at <= end + (entry.kind === "mlx_kill" ? 30_000 : 0);
      });
      if (fault) reasons.set(row.id, fault.kind);
    }
  }
  return reasons;
}

/** The check of calls past their deadline: audit rows, then the lane watchdog on the samples. */
function pastDeadlineCheck(run: LoadedRun): { check: Check; wedged: string[] } {
  const past = run.rows.filter(
    (row) =>
      row.deadlineMs !== null && row.durationMs - (row.requeueMs ?? 0) > row.deadlineMs + 2_000
  );
  const noDeadline = run.rows.filter(
    (row) => row.deadlineMs === null || row.deadlineOutcome === "none"
  );
  const finishes = new Map<string, number[]>();
  const maxDeadline = new Map<string, number>();
  for (const row of run.rows) {
    const lane = row.lane ?? "local";
    finishes.set(lane, [...(finishes.get(lane) ?? []), rowEnd(row)]);
    maxDeadline.set(lane, Math.max(maxDeadline.get(lane) ?? 0, row.deadlineMs ?? 0));
  }
  const watchdog: string[] = [];
  const wedged: string[] = [];
  const sampleIntervalMs = run.meta.sampleIntervalMs;
  const byLane = new Map<string, Array<{ at: number; running: number; held: number }>>();
  for (const sample of run.samples)
    for (const lane of sample.lanes)
      byLane.set(lane.lane, [
        ...(byLane.get(lane.lane) ?? []),
        { at: toMs(sample.at), running: lane.running, held: lane.held }
      ]);
  for (const [lane, points] of byLane) {
    const limit = (maxDeadline.get(lane) || 350_000) + 2_000 + sampleIntervalMs;
    const done = (finishes.get(lane) ?? []).toSorted((a, b) => a - b);
    let busySince: number | null = null;
    let flagged = false;
    let heldSince: number | null = null;
    for (const point of points) {
      if (point.running > 0) {
        busySince ??= point.at;
        const last = Math.max(busySince, ...done.filter((time) => time <= point.at).slice(-1));
        if (!flagged && point.at - last > limit) {
          flagged = true;
          watchdog.push(
            `${lane}: busy from ${new Date(last).toISOString()} with no call ending for ${Math.round((point.at - last) / 1000)} s (> ${Math.round(limit / 1000)} s)`
          );
        }
      } else {
        busySince = null;
        flagged = false;
      }
      if (point.held > 0) heldSince ??= point.at;
      else if (heldSince !== null) {
        wedged.push(
          `${lane}: a slot was held from ${new Date(heldSince).toISOString()} to ${new Date(point.at).toISOString()} (a wedged runtime)`
        );
        heldSince = null;
      }
    }
    if (heldSince !== null)
      wedged.push(
        `${lane}: a slot was held from ${new Date(heldSince).toISOString()} to the end of the run`
      );
  }
  const failing = past.length + watchdog.length;
  return {
    wedged,
    check: {
      id: "past-deadline",
      title: "Calls past deadline",
      bar: "0 (duration_ms - requeue_ms > deadline_ms + 2,000, or the watchdog)",
      status: failing > 0 ? "fail" : noDeadline.length > 0 ? "review" : "pass",
      value: `${past.length} audited, ${watchdog.length} by the watchdog, ${noDeadline.length} without a deadline (of ${run.rows.length} calls)`,
      details: [
        ...past
          .slice(0, 12)
          .map(
            (row) =>
              `${row.lane ?? "?"} ${row.workloadClass ?? "?"} ${row.taskType}: ${row.durationMs - (row.requeueMs ?? 0)} ms for a ${row.deadlineMs} ms deadline at ${row.startedAt}`
          ),
        ...watchdog.slice(0, 12),
        ...noDeadline
          .slice(0, 5)
          .map((row) => `no deadline recorded: ${row.taskType} at ${row.startedAt} (${row.status})`)
      ]
    }
  };
}

/**
 * Decision 31a (plan section 2, 2026-10-18): the repair bar sets aside every structured call of the
 * local writer, because the MLX writer has no schema enforcement and returns invalid structured
 * output in 8-19 % of its calls (F4 builds JSON-constrained decoding in the helper). The predicate:
 * a call on the local lane (a row without a lane is a local one), run by the MLX runtime, whose
 * request did not state an enforced schema mode (`strict`, `json` or `grammar`, which a constrained
 * helper will record). Remote providers and the GGUF runtime (a grammar) stay counted.
 */
export function isUnconstrainedLocalWriterCall(row: TaskRunRecord): boolean {
  return (
    (row.lane ?? "local") === "local" &&
    row.runtime === "mlx" &&
    (row.schemaMode === null || row.schemaMode === "none")
  );
}

function repairsCheck(
  run: LoadedRun,
  injected: Map<string, string>,
  countLocalWriter = false
): Check {
  const all = run.rows.filter((row) => isStructuredGenerative(row) && !injected.has(row.id));
  // C4's re-run counts every structured call of the local writer (decision 31a set them aside in F3).
  const apart = countLocalWriter ? [] : all.filter(isUnconstrainedLocalWriterCall);
  const calls = countLocalWriter ? all : all.filter((row) => !isUnconstrainedLocalWriterCall(row));
  // C4: no structured call of the local writer may run unconstrained (schema mode `none`).
  const unconstrained = countLocalWriter ? all.filter(isUnconstrainedLocalWriterCall) : [];
  const repairs = calls.filter((row) => row.isRepair);
  const apartRepairs = apart.filter((row) => row.isRepair);
  const share = (count: number, of: number) => (of === 0 ? 0 : count / of);
  const rate = share(repairs.length, calls.length);
  const classes = [...new Set(all.map((row) => row.workloadClass ?? "?"))].sort();
  const bar = 0.02;
  const status: CheckStatus =
    calls.length === 0 ? "review" : rate <= bar && unconstrained.length === 0 ? "pass" : "fail";
  const pct = (value: number) => `${(value * 100).toFixed(2)} %`;
  const count = (rows: TaskRunRecord[], workloadClass?: string) => {
    const inClass =
      workloadClass === undefined
        ? rows
        : rows.filter((row) => (row.workloadClass ?? "?") === workloadClass);
    const repaired = inClass.filter((row) => row.isRepair).length;
    return `${repaired} of ${inClass.length} = ${pct(share(repaired, inClass.length))}`;
  };
  return {
    id: "repairs",
    title: "Repairs (D35) over non-injected structured generative calls",
    bar: countLocalWriter
      ? "<= 2 % of the non-injected structured calls, every local-writer row counted (C4), and 0 local-writer structured rows in schema mode none"
      : "<= 2 % of the structured calls that count; decision 31a sets aside the local MLX writer's (lane local, runtime mlx, no enforced schema mode), reported apart",
    status,
    value: countLocalWriter
      ? `${count(calls)} counted, the local writer's included; ${unconstrained.length} local-writer structured row(s) in mode none`
      : `${count(calls)} counted; set aside by decision 31a: ${apart.length} local writer call(s), ${apartRepairs.length} repair(s) = ${pct(share(apartRepairs.length, apart.length))} (information)`,
    details: [
      ...(unconstrained.length > 0
        ? [
            `${unconstrained.length} structured call(s) of the local writer ran without an enforced schema mode: C4 needs 0`
          ]
        : []),
      ...classes.map((workloadClass) => {
        const counted = calls.filter((row) => (row.workloadClass ?? "?") === workloadClass);
        const aside = apart.filter((row) => (row.workloadClass ?? "?") === workloadClass);
        return `${workloadClass}: counted ${count(counted)}; set aside ${count(aside)}`;
      }),
      `all structured calls, set-aside ones included: ${count(all)} (information)`,
      ...(calls.length === 0
        ? [
            "No structured call outside the local MLX writer ran: nothing counts against the bar. A person decides whether that is enough."
          ]
        : [])
    ]
  };
}

/** Jobs: running without any change for twice the longest class deadline, stuck for an hour, held up by an unrelated job. */
function jobChecks(run: LoadedRun, explanations: Record<string, string>): Check[] {
  const longest = Math.max(350_000, ...run.rows.map((row) => row.deadlineMs ?? 0));
  const inactivityLimit = 2 * longest;
  const stuckLimit = hour;
  const blockedAfter = 15 * minute;
  const inactive = new Map<string, string>();
  const stuck = new Map<string, string>();
  const waiting = new Map<string, number>();
  const blocked = new Map<string, string>();
  const samples = run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at));
  for (const sample of samples) {
    const at = toMs(sample.at);
    const runningTypes = new Set(
      sample.jobs.filter((job) => job.status === "running").map((job) => job.type)
    );
    for (const job of sample.jobs) {
      const idle = at - job.updatedAt;
      if (job.status === "running" && idle > inactivityLimit && !inactive.has(job.id))
        inactive.set(
          job.id,
          `${job.type} (${job.lane}) unchanged for ${Math.round(idle / 1000)} s at ${sample.at}`
        );
      // A job a blocker set aside (F4 D5) waits for its blocker, not for a worker.
      const due = job.status === "queued" && job.runAfter <= at && !job.blockedClass;
      const eligible = job.status === "running" || due;
      if (eligible && idle > stuckLimit && !stuck.has(job.id))
        stuck.set(
          job.id,
          `${job.type} (${job.lane}, ${job.status}) unchanged for ${Math.round(idle / minute)} min at ${sample.at}`
        );
      if (due) {
        const since = waiting.get(job.id) ?? at;
        waiting.set(job.id, since);
        // Held up with nothing of its own kind running: the light lane's workers run one job each,
        // the heavy lane runs one job at a time by design and is left out.
        if (
          job.lane === "light" &&
          at - since > blockedAfter &&
          !runningTypes.has(job.type) &&
          !blocked.has(job.id)
        )
          blocked.set(
            job.id,
            `${job.type} (light) eligible since ${new Date(since).toISOString()}, queued ${Math.round((at - since) / minute)} min with no job of its type running; running then: ${[...runningTypes].join(", ") || "nothing"}`
          );
      } else waiting.delete(job.id);
    }
  }
  const unexplained = [...blocked].filter(([id]) => !explanations[id]);
  const list = (entries: Map<string, string>) =>
    [...entries].slice(0, 12).map(([id, text]) => `${id.slice(0, 8)} ${text}`);
  return [
    {
      id: "jobs-inactive",
      title: "Jobs running past twice their class deadline",
      bar: "0 (a running job unchanged for 2 x the longest class deadline)",
      status: inactive.size === 0 ? "pass" : "review",
      value: `${inactive.size} (limit ${Math.round(inactivityLimit / 1000)} s)`,
      details: list(inactive)
    },
    {
      id: "jobs-stuck",
      title: "Jobs stuck over 1 h",
      bar: "0 (an eligible job unchanged for an hour)",
      status: stuck.size === 0 ? "pass" : "fail",
      value: `${stuck.size}`,
      details: list(stuck)
    },
    {
      id: "jobs-blocked",
      title: "Jobs blocked by an unrelated job",
      bar: "0 unexplained (candidates are listed for the failure audit)",
      status: blocked.size === 0 ? "pass" : unexplained.length === 0 ? "pass" : "review",
      value: `${blocked.size} candidate(s), ${blocked.size - unexplained.length} explained`,
      details: list(new Map(unexplained))
    }
  ];
}

function swapCheck(run: LoadedRun): {
  check: Check;
  resources: Array<Record<string, string | number>>;
} {
  const warmEnd = toMs(run.meta.startedAt) + run.meta.warmupMs;
  const readable = run.samples.filter((sample) => sample.pageouts !== null);
  const afterWarm = readable.filter((sample) => toMs(sample.at) >= warmEnd);
  const first = afterWarm[0];
  const last = afterWarm.at(-1);
  const pageSize = last?.pageSizeBytes ?? 16_384;
  const megabytes =
    first && last && first !== last
      ? ((last.pageouts! - first.pageouts!) * pageSize) / 1_048_576
      : null;
  const helperRss = run.samples.flatMap((sample) =>
    sample.helper?.rssMb ? [sample.helper.rssMb] : []
  );
  const appRss = run.samples.map((sample) => sample.appRssMb);
  const lag = run.samples.flatMap((sample) =>
    sample.eventLoopLagP99Ms === null ? [] : [sample.eventLoopLagP99Ms]
  );
  const waits = run.samples.map((sample) => sample.dbPool?.waiting ?? 0);
  return {
    check: {
      id: "swap",
      title: "Swap",
      bar: "pageouts <= 50 MB over the run after warm-up",
      status: megabytes === null ? "review" : megabytes <= 50 ? "pass" : "fail",
      value:
        megabytes === null
          ? "pageouts were not readable after warm-up"
          : `${megabytes.toFixed(1)} MB of pageouts after warm-up`,
      details: []
    },
    resources: [
      {
        metric: "helper RSS (MB)",
        p50: percentile(helperRss, 0.5) ?? "-",
        p95: percentile(helperRss, 0.95) ?? "-",
        max: helperRss.length ? Math.max(...helperRss) : "-"
      },
      {
        metric: "app RSS (MB)",
        p50: percentile(appRss, 0.5) ?? "-",
        p95: percentile(appRss, 0.95) ?? "-",
        max: appRss.length ? Math.max(...appRss) : "-"
      },
      {
        metric: "event-loop lag p99 (ms)",
        p50: percentile(lag, 0.5) ?? "-",
        p95: percentile(lag, 0.95) ?? "-",
        max: lag.length ? Math.max(...lag) : "-"
      },
      {
        metric: "database pool waiting",
        p50: percentile(waits, 0.5) ?? "-",
        p95: percentile(waits, 0.95) ?? "-",
        max: waits.length ? Math.max(...waits) : "-"
      }
    ]
  };
}

/**
 * The windows in which a lane admitted nothing because a 429 asked it to wait, merged, per lane.
 * The scheduler pauses a lane until the Retry-After, at most `maxPauseMs` (spec D29).
 */
function retryAfterPauses(run: LoadedRun): Map<string, Array<[number, number]>> {
  const lanes = providerLanes(run.meta);
  const found = new Map<string, Array<[number, number]>>();
  for (const exchange of exchangesOf(run.events)) {
    const lane = lanes.get(exchange.provider);
    if (!lane || exchange.status !== 429 || exchange.retryAfterSeconds === null) continue;
    const from = toMs(exchange.endedAt);
    const window: [number, number] = [
      from,
      from +
        Math.min(exchange.retryAfterSeconds * 1_000, defaultAiLaneRuntimeConfig.lanes.maxPauseMs)
    ];
    found.set(lane, [...(found.get(lane) ?? []), window]);
  }
  const merged = new Map<string, Array<[number, number]>>();
  for (const [lane, windows] of found) {
    const out: Array<[number, number]> = [];
    for (const window of windows.toSorted((a, b) => a[0] - b[0])) {
      const last = out.at(-1);
      if (last && window[0] <= last[1]) last[1] = Math.max(last[1], window[1]);
      else out.push([...window]);
    }
    merged.set(lane, out);
  }
  return merged;
}

const overlapMs = (from: number, to: number, windows: ReadonlyArray<[number, number]>) =>
  windows.reduce(
    (sum, [start, end]) => sum + Math.max(0, Math.min(to, end) - Math.max(from, start)),
    0
  );

export interface P0Wait {
  row: TaskRunRecord;
  lane: string;
  /** From the head of the lane's P0 queue to the start, without the lane's Retry-After pauses. */
  waitMs: number;
}

/**
 * How long each P0 call waited as the spec defines it (3.1): P0 is served first and FIFO, and
 * nothing preempts a running call, so a P0 call waits behind the P0 calls admitted before it
 * (their own wait counts for them) and then for a slot: at most one in-flight bounded call. Per
 * lane, the call is admitted at `start - queueMs`; it is at the head once the last P0 admitted
 * before it has started (or at its admission, if that was later); the lane's Retry-After pauses
 * are no wait of the scheduler's. The raw `queueMs` includes both of those.
 */
export function p0Waits(run: LoadedRun): P0Wait[] {
  const pauses = retryAfterPauses(run);
  const byLane = new Map<string, Array<{ row: TaskRunRecord; admission: number; start: number }>>();
  for (const row of run.rows) {
    if (row.priority !== 0 || row.queueMs === null) continue;
    const lane = row.lane ?? "local";
    const start = rowStart(row);
    const entries = byLane.get(lane) ?? [];
    entries.push({ row, admission: start - row.queueMs, start });
    byLane.set(lane, entries);
  }
  const waits: P0Wait[] = [];
  for (const [lane, entries] of byLane) {
    let startedBefore = Number.NEGATIVE_INFINITY;
    for (const entry of entries.toSorted(
      (a, b) => a.admission - b.admission || a.start - b.start
    )) {
      const head = Math.min(entry.start, Math.max(entry.admission, startedBefore));
      waits.push({
        row: entry.row,
        lane,
        waitMs: Math.max(
          0,
          entry.start - head - overlapMs(head, entry.start, pauses.get(lane) ?? [])
        )
      });
      startedBefore = Math.max(startedBefore, entry.start);
    }
  }
  return waits;
}

function p0Check(run: LoadedRun): { check: Check; table: Array<Record<string, string | number>> } {
  // What one call can hold a lane for: its time on the lane, without the retry sleeps (they run
  // off the lane) and the re-waits for it.
  const longest = new Map<string, number>();
  for (const row of run.rows)
    longest.set(
      row.lane ?? "local",
      Math.max(
        longest.get(row.lane ?? "local") ?? 0,
        row.durationMs - (row.requeueMs ?? 0) - (row.retryWaitMs ?? 0)
      )
    );
  const table: Array<Record<string, string | number>> = [];
  const exceeding: string[] = [];
  const groups = new Map<string, P0Wait[]>();
  for (const wait of p0Waits(run)) {
    const key = `${wait.lane}|${wait.row.workloadClass ?? "?"}`;
    const group = groups.get(key) ?? [];
    group.push(wait);
    groups.set(key, group);
  }
  for (const [key, waited] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const [lane, workloadClass] = key.split("|") as [string, string];
    const waits = waited.map((entry) => entry.waitMs);
    const raw = waited.map((entry) => entry.row.queueMs!);
    const bound = (longest.get(lane) ?? 0) + 2_000;
    const worst = Math.max(...waits);
    table.push({
      lane,
      class: workloadClass,
      calls: waited.length,
      "p50 wait (ms)": percentile(waits, 0.5)!,
      "p95 wait (ms)": percentile(waits, 0.95)!,
      "p100 wait (ms)": worst,
      "raw queue p100 (ms)": Math.max(...raw),
      "bound (ms)": bound
    });
    if (worst > bound)
      exceeding.push(
        `${lane} ${workloadClass}: p100 ${worst} ms > ${bound} ms (raw queue p100 ${Math.max(...raw)} ms)`
      );
  }
  return {
    table,
    check: {
      id: "p0-wait",
      title: "P0 wait",
      bar: "<= one in-flight bounded call (p100 by class, from the head of the lane's P0 queue without Retry-After pauses; the bound is the longest call on the lane, of any priority, without retry sleeps, + 2 s)",
      status: table.length === 0 ? "review" : exceeding.length === 0 ? "pass" : "fail",
      value:
        table.length === 0
          ? "no P0 call was audited"
          : `${table.length} lane/class group(s), ${exceeding.length} over the bound`,
      details: exceeding
    }
  };
}

function breakerCheck(run: LoadedRun): Check {
  const lanes = providerLanes(run.meta);
  const outages = windowsOf(run.events).filter((window) => window.kind === "outage");
  if (outages.length === 0)
    return {
      id: "breaker",
      title: "Breaker",
      bar: "opens during the outage, closes within 1 min after it",
      status: "n/a",
      value: "no outage in this run",
      details: []
    };
  const transitions = run.events.filter(
    (event): event is Extract<SoakEvent, { type: "breaker" }> => event.type === "breaker"
  );
  const details: string[] = [];
  let status: CheckStatus = "pass";
  for (const outage of outages) {
    const lane = lanes.get(outage.provider);
    const from = toMs(outage.startedAt);
    const to = toMs(outage.endedAt);
    const mine = transitions.filter((event) => event.lane === lane);
    const opened = mine.find(
      (event) =>
        event.to === "open" && toMs(event.at) >= from - 1_000 && toMs(event.at) <= to + minute
    );
    const closed = opened
      ? mine.find((event) => event.to === "closed" && toMs(event.at) > toMs(opened.at))
      : undefined;
    if (!opened) {
      status = "fail";
      details.push(
        `${outage.provider}: the breaker did not open during the outage ${outage.startedAt} - ${outage.endedAt}`
      );
    } else if (!closed || toMs(closed.at) > to + minute) {
      status = "fail";
      details.push(
        `${outage.provider}: opened ${opened.at}, ${closed ? `closed ${closed.at}, ${Math.round((toMs(closed.at) - to) / 1000)} s after the outage` : "never closed"}`
      );
    } else {
      details.push(
        `${outage.provider}: opened ${opened.at}, closed ${closed.at}, ${Math.round((toMs(closed.at) - to) / 1000)} s after the outage ended`
      );
    }
  }
  return {
    id: "breaker",
    title: "Breaker",
    bar: "opens during the outage, closes within 1 min after it",
    status,
    value: `${outages.length} outage(s)`,
    details
  };
}

function helperCheck(run: LoadedRun): Check {
  const kills = localsOf(run.events).filter(
    (fault) => fault.kind === "mlx_kill" && fault.detail.killed === true
  );
  // A sample taken before the helper's first spawn reads 0; the first spawn is the start, not a restart.
  const spawns = run.samples.flatMap((sample) =>
    sample.helper && sample.helper.spawnCount > 0 ? [sample.helper.spawnCount] : []
  );
  if (spawns.length === 0)
    return {
      id: "helper-restarts",
      title: "Helper restarts",
      bar: "equal to the injected kills",
      status: "review",
      value: "the helper never ran",
      details: []
    };
  const restarts = spawns.at(-1)! - spawns[0]!;
  const lastKill = kills.at(-1);
  const nearEnd = lastKill
    ? toMs(run.meta.endedAt ?? lastKill.at) - toMs(lastKill.at) < 15 * minute
    : false;
  const status: CheckStatus =
    restarts === kills.length
      ? "pass"
      : restarts === kills.length - 1 && nearEnd
        ? "review"
        : "fail";
  return {
    id: "helper-restarts",
    title: "Helper restarts",
    bar: "equal to the injected kills",
    status,
    value: `${restarts} restart(s) for ${kills.length} injected kill(s)`,
    details:
      status === "review"
        ? [
            "The last kill came near the end: the helper may not have been needed again before the run ended."
          ]
        : []
  };
}

/** What a failed call's error text says about its class; `null` when nothing is recognised. */
export function classifyError(row: TaskRunRecord): string | null {
  return classifyErrorText(row.error, row.status);
}

/** The same reading for the error a failed job kept. */
function classifyErrorText(error: string | null, status: string): string | null {
  const text = error ?? "";
  // The caller's own cap ended the call (an Ask's budget, for one), not a provider deadline.
  if (status === "canceled" && /^The operation timed out\.?$/u.test(text.trim()))
    return "cancelled by caller deadline";
  if (/429|rate[ _]?limit|usage_limit/iu.test(text)) return "transient: rate limit";
  // The local helper died without answering, or the local model was busy (job-failure.ts).
  if (/errors\.localModels\.(?:runtimeFailed|modelBusy)/u.test(text))
    return "transient: local runtime";
  if (/\b5\d\d\b|overloaded|unavailable|server error/iu.test(text)) return "transient: server";
  if (/stalled|sent no data|did not respond|no answer text|deadline|timed? ?out/iu.test(text))
    return "transient: timeout";
  if (/ECONN|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket/iu.test(text))
    return "transient: network";
  if (/provider ?unavailable|circuit/iu.test(text)) return "transient: breaker";
  if (/context|exceed|too many tokens/iu.test(text)) return "permanent: context";
  if (/invalid|output_shape|nothing_valid|schema|json|parse|unparseable/iu.test(text))
    return "permanent: output";
  if (/401|403|credential|unauthorized|forbidden/iu.test(text)) return "permanent: auth";
  if (/abort|cancel/iu.test(text) || status === "canceled") return "cancelled";
  return null;
}

/** A failed job is explained by an injected fault that ended this soon before it. */
const jobFaultLinkMs = 30_000;

/**
 * The failed jobs an injected fault explains: those whose error names the marker, and those that
 * failed while, or right after, an injected call (`injectedRows`) that could be their own was
 * running: a call on the local lane, or a remote call that itself failed. A job holds no link to
 * its calls, so the time is what ties them; a remote call that got its answer in the end (a
 * retried 429, a slow answer) explains no failure.
 */
export function injectedJobFailures(
  run: LoadedRun,
  injected: Map<string, string>
): Map<string, string> {
  const reasons = new Map<string, string>();
  const calls = run.rows.filter(
    (row) =>
      injected.has(row.id) &&
      ((row.lane ?? "local") === "local" ||
        (row.lane?.startsWith("remote:") === true && row.status !== "succeeded"))
  );
  for (const job of jobFailuresOf(run.events)) {
    if (job.error?.includes(injectedMarker)) {
      reasons.set(job.id, "injected error");
      continue;
    }
    const failedAt = toMs(job.at);
    const hit = calls.find(
      (row) => rowStart(row) - 1_000 <= failedAt && failedAt <= rowEnd(row) + jobFaultLinkMs
    );
    if (hit) reasons.set(job.id, injected.get(hit.id)!);
  }
  return reasons;
}

/** The fake provider each kind of action reaches (fake-remote-provider.ts, fake-codex-provider.ts). */
const actionProviders: Partial<Record<ActionRecord["kind"], string>> = {
  ask: "openai-compatible",
  explain: "codex-wire",
  explain_burst: "codex-wire",
  post_outage_probe: "codex-wire"
};
/** With the real writer (F4) an Ask and an explanation go to the real Codex lane. */
const realWriterActionProviders: Partial<Record<ActionRecord["kind"], string>> = {
  ask: "openai-codex",
  explain: "openai-codex",
  explain_burst: "openai-codex",
  post_outage_probe: "openai-codex",
  topic_open: "openai-codex",
  note_edit: "openai-codex",
  burst_edit: "openai-codex",
  article: "openai-codex",
  typing_fault: "openai-codex",
  source_reimport: "openai-codex"
};
/** Windows during which a failed action is the window's doing (the harness-cap refusal, a blocked lane). */
const failingWindowKinds = new Set([
  "harness_cap",
  "usage_limit",
  "refused",
  "enotfound",
  "unauthorized"
]);

/**
 * The driver's failed actions (an Ask, an explanation...) that no injected exchange explains. An
 * injected exchange explains a failed action only when it overlaps the action in time and sits on
 * the action's own fake (an Ask reaches the OpenAI-compatible one, an explanation the Codex-wire
 * one; an action of another kind has no remote provider of its own, so any fake may explain it),
 * and never an action whose port says it did not start its remote call: nothing it sent could meet
 * the fault. What remains is a failure of the product that the call and job audits may not show (an
 * Ask that ran out of time before its model call has no failed call).
 */
export function unexplainedActionFailures(run: LoadedRun): ActionRecord[] {
  const grace = 1_000;
  const injected = exchangesOf(run.events).filter((exchange) => exchange.injected);
  const providers = run.meta.realWriter ? realWriterActionProviders : actionProviders;
  // The windows that make calls fail by design, from the ground-truth records.
  const failing: Array<[number, number]> = [];
  const opened = new Map<string, number>();
  for (const event of run.events) {
    if (event.type !== "ground_truth" || !failingWindowKinds.has(event.kind)) continue;
    if (event.phase === "start") opened.set(event.id, toMs(event.at));
    else if (opened.has(event.id)) failing.push([opened.get(event.id)!, toMs(event.at)]);
  }
  for (const start of opened.values())
    if (!failing.some(([from]) => from === start)) failing.push([start, Number.POSITIVE_INFINITY]);
  return actionsOf(run.events).filter((action) => {
    if (action.status !== "failed") return false;
    const provider = providers[action.kind];
    const start = toMs(action.startedAt) - grace;
    const end = toMs(action.startedAt) + action.durationMs + grace;
    if (failing.some(([from, to]) => from <= end && to >= start)) return false;
    if (action.detail.remoteCallStarted === false) return true;
    return !injected.some(
      (exchange) =>
        (provider === undefined || exchange.provider === provider) &&
        toMs(exchange.startedAt) <= end &&
        toMs(exchange.endedAt) >= start
    );
  });
}

/** One failed action, with the facts its port recorded (how long it ran, how far it got). */
const actionLine = (action: ActionRecord) => {
  const facts = Object.entries(action.detail)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
  return `failed action ${action.kind} #${action.index} at ${action.startedAt} after ${action.durationMs} ms${facts ? ` (${facts})` : ""}: ${action.error ?? "no error kept"}`;
};

/** A failure to audit: a failed call or a failed job, read the same way. */
interface Failure {
  id: string;
  at: string;
  lane: string;
  class: string;
  task: string;
  status: string;
  deadline: string;
  classified: string | null;
  error: string;
}

function failureAudit(run: LoadedRun, injected: Map<string, string>, seed: number) {
  const calls = run.rows.filter((row) => row.status !== "succeeded" && !injected.has(row.id));
  const explained = injectedJobFailures(run, injected);
  const jobs = jobFailuresOf(run.events).filter((job) => !explained.has(job.id));
  const actions = unexplainedActionFailures(run);
  // Failed jobs the samples count that no record explains (a run that did not record them, or a
  // collector that missed one): a person reads the jobs table for them.
  const samples = run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at));
  const failedAtStart = samples[0]?.jobCounts.failed ?? 0;
  const failedAtEnd = samples.at(-1)?.jobCounts.failed ?? 0;
  const unrecorded = Math.max(0, failedAtEnd - failedAtStart - jobFailuresOf(run.events).length);
  const failures: Failure[] = [
    ...calls.map((row) => ({
      id: row.id,
      at: row.startedAt,
      lane: row.lane ?? "?",
      class: row.workloadClass ?? "?",
      task: row.taskType,
      status: row.status,
      deadline: row.deadlineOutcome ?? "-",
      classified: classifyError(row),
      error: (row.error ?? "").slice(0, 120)
    })),
    ...jobs.map((job) => ({
      id: job.id,
      at: job.at,
      lane: job.lane,
      class: "job",
      task: job.jobType,
      status: "failed",
      deadline: "-",
      classified: classifyErrorText(job.error, "failed"),
      error: (job.error ?? "").slice(0, 120)
    }))
  ];
  const picked = failures
    .toSorted((a, b) =>
      createHash("sha256")
        .update(`${seed}:${a.id}`)
        .digest("hex")
        .localeCompare(createHash("sha256").update(`${seed}:${b.id}`).digest("hex"))
    )
    .slice(0, 50)
    .toSorted((a, b) => toMs(a.at) - toMs(b.at));
  const rows = picked.map((failure) => ({
    at: failure.at,
    lane: failure.lane,
    class: failure.class,
    task: failure.task,
    status: failure.status,
    deadline: failure.deadline,
    "classified as": failure.classified ?? "unclassified",
    error: failure.error
  }));
  const unclassified = rows.filter((row) => row["classified as"] === "unclassified").length;
  const total = failures.length + unrecorded + actions.length;
  return {
    rows,
    total: failures.length,
    check: {
      id: "failure-handling",
      title: "Failure handling",
      bar: "every non-injected failure (call, job or driver action) classified correctly (audited sample of 50); every wedged event explained",
      status: total === 0 ? "pass" : "review",
      value: `${calls.length} non-injected failed call(s), ${jobs.length} non-injected failed job(s)${unrecorded > 0 ? `, ${unrecorded} more failed job(s) in the job counts with no record` : ""}, ${actions.length} failed driver action(s) with no injected fault; ${rows.length} in the audited sample, ${unclassified} unclassified by the error text`,
      details: [
        "The classification column is a first reading of the error text; a person confirms each row (T64r) and explains every wedged event.",
        ...actions.slice(0, 12).map(actionLine),
        ...(actions.length > 12
          ? [`${actions.length - 12} more failed driver action(s) with no injected fault.`]
          : []),
        ...jobs
          .slice(0, 12)
          .map(
            (job) =>
              `failed job ${job.id.slice(0, 8)} ${job.jobType} (${job.lane}) at ${job.at} after ${job.attempts} attempt(s): ${job.error ?? "no error kept"}`
          ),
        ...(explained.size > 0
          ? [`${explained.size} failed job(s) left out as explained by an injected fault.`]
          : []),
        ...(unrecorded > 0
          ? [
              `The job counts of the samples rose by ${unrecorded} more failed job(s) than the run recorded: read them from the jobs table.`
            ]
          : [])
      ]
    } satisfies Check
  };
}

/** The deadline bounds the fakes were checked against, and what the run saw of them. */
function remoteDeadlinesCheck(run: LoadedRun): Check {
  const exchanges = exchangesOf(run.events);
  const { firstByteMs, stallMs } = run.meta.bounds;
  const late = exchanges.filter((exchange) => exchange.kind === "late_first_byte");
  const stalled = exchanges.filter((exchange) => exchange.kind === "stall");
  const lateOk = late.filter(
    (exchange) =>
      exchange.outcome === "client_closed" &&
      exchange.closedAfterMs !== null &&
      exchange.closedAfterMs >= firstByteMs - 1_000 &&
      exchange.closedAfterMs <= firstByteMs + 3_000
  );
  const stallOk = stalled.filter(
    (exchange) =>
      exchange.outcome === "client_closed" &&
      exchange.closedAfterLastWriteMs !== null &&
      exchange.closedAfterLastWriteMs >= stallMs - 1_000 &&
      exchange.closedAfterLastWriteMs <= stallMs + 3_000
  );
  // The real writer's lane (F4): its calls run through the Codex adapter by construction.
  const realLane = run.meta.realWriter ? `remote:${run.meta.realWriter.providerConfigId}` : null;
  const codex = exchanges.filter(
    (exchange) =>
      (exchange.provider === "codex-wire" || exchange.provider === "openai-codex") &&
      exchange.kind === "none" &&
      exchange.outcome === "completed"
  );
  const codexRows = run.rows.filter(
    (row) =>
      row.provider === "openai-codex" &&
      row.lane?.startsWith("remote:") &&
      (realLane === null || row.lane === realLane || row.modelId.startsWith("dev-fake"))
  );
  const remoteRows = run.rows.filter(
    (row) => row.lane?.startsWith("remote:") && row.deadlineMs !== null
  );
  const times = remoteRows.filter(
    (row) => row.deadlineMs !== remoteTotals[row.workloadClass ?? ""]
  );
  const problems: string[] = [];
  if (late.length > 0 && lateOk.length < late.length)
    problems.push(
      `${late.length - lateOk.length} of ${late.length} late first bytes did not end at the ${firstByteMs} ms bound`
    );
  if (stalled.length > 0 && stallOk.length < stalled.length)
    problems.push(
      `${stalled.length - stallOk.length} of ${stalled.length} stalls did not end at the ${stallMs} ms bound`
    );
  if (codex.length === 0 || codexRows.length === 0)
    problems.push("no Codex-wire call ran through the Codex adapter");
  if (times.length > 0)
    problems.push(
      `${times.length} remote call(s) carry a total deadline that is not the remote one`
    );
  const unobserved = late.length === 0 || stalled.length === 0;
  return {
    id: "remote-deadlines",
    title: "Remote deadlines exercised (R6)",
    bar: "the injected first byte ends at the first-byte bound, the stall at the stall bound, Codex-wire calls ran through the Codex adapter, totals are the remote ones (no x3)",
    status: problems.length > 0 ? "fail" : unobserved ? "review" : "pass",
    value: `first byte: ${lateOk.length}/${late.length} at ${firstByteMs} ms; stall: ${stallOk.length}/${stalled.length} at ${stallMs} ms; Codex-wire calls ${codex.length} (${codexRows.length} audited); remote totals ${remoteRows.length - times.length}/${remoteRows.length}`,
    details: [
      ...problems,
      ...(unobserved && problems.length === 0
        ? ["A fault kind was never injected in this run: nothing to check for it."]
        : [])
    ]
  };
}

/** The pre-soak assertion (R6, gate P): each injected kind ended as the deadlines say. */
export function presoakAssertions(run: LoadedRun): PresoakAssertion[] {
  const lanes = providerLanes(run.meta);
  const { firstByteMs, stallMs } = run.meta.bounds;
  const exchanges = exchangesOf(run.events);
  const windows = windowsOf(run.events);
  const providers =
    [...lanes.keys()].length > 0 ? [...lanes.keys()] : ["openai-compatible", "codex-wire"];
  const rowsOn = (provider: string) => run.rows.filter((row) => row.lane === lanes.get(provider));
  const overlapping = (rows: TaskRunRecord[], from: number, to: number) =>
    rows.filter((row) => rowStart(row) - 1_000 <= to && rowEnd(row) + 1_000 >= from);
  const out: PresoakAssertion[] = [];
  const add = (
    kind: string,
    provider: string,
    occurrences: number,
    expectedOutcome: "met" | "aborted",
    attempt: string,
    call: string,
    pass: boolean
  ) =>
    out.push({
      kind,
      provider,
      occurrences,
      expectedOutcome,
      attempt,
      call,
      status: occurrences === 0 ? "fail" : pass ? "pass" : "fail"
    });
  for (const provider of providers) {
    const mine = exchanges.filter(
      (exchange) => exchange.provider === provider && exchange.injected
    );
    const rows = rowsOn(provider);
    const around = (kind: string) =>
      mine
        .filter((exchange) => exchange.kind === kind)
        .map((exchange) => ({
          exchange,
          rows: overlapping(rows, toMs(exchange.startedAt), toMs(exchange.endedAt))
        }));
    const rate = around("rate_limit");
    add(
      "rate_limit",
      provider,
      rate.length,
      "met",
      `${rate.filter((entry) => entry.exchange.status === 429 && entry.exchange.retryAfterSeconds !== null).length} answered 429 with Retry-After`,
      `${rate.filter((entry) => entry.rows.some((row) => row.deadlineOutcome === "met" && (row.status === "succeeded" || /429|rate/iu.test(row.error ?? "")))).length} call(s) ended met (retried, or transient 429)`,
      rate.length > 0 &&
        rate.every(
          (entry) => entry.exchange.status === 429 && entry.exchange.retryAfterSeconds !== null
        ) &&
        rate.some((entry) =>
          entry.rows.some(
            (row) =>
              row.deadlineOutcome === "met" &&
              (row.status === "succeeded" || /429|rate/iu.test(row.error ?? ""))
          )
        )
    );
    const unavailable = around("unavailable");
    add(
      "unavailable",
      provider,
      unavailable.length,
      "met",
      `${unavailable.filter((entry) => entry.exchange.status === 503).length} answered 503`,
      `${unavailable.filter((entry) => entry.rows.some((row) => row.deadlineOutcome === "met" && (row.status === "succeeded" || /503|overload|unavailable|server/iu.test(row.error ?? "")))).length} call(s) ended met`,
      unavailable.length > 0 &&
        unavailable.every((entry) => entry.exchange.status === 503) &&
        unavailable.some((entry) =>
          entry.rows.some(
            (row) =>
              row.deadlineOutcome === "met" &&
              (row.status === "succeeded" ||
                /503|overload|unavailable|server/iu.test(row.error ?? ""))
          )
        )
    );
    const stall = around("stall");
    const stalledAtBound = stall.filter(
      (entry) =>
        entry.exchange.outcome === "client_closed" &&
        entry.exchange.closedAfterLastWriteMs !== null &&
        Math.abs(entry.exchange.closedAfterLastWriteMs - stallMs) <= 3_000
    );
    const stalledCalls = stall.filter((entry) =>
      entry.rows.some(
        (row) => row.deadlineOutcome === "aborted" && /stalled/iu.test(row.error ?? "")
      )
    );
    add(
      "stall",
      provider,
      stall.length,
      "aborted",
      `${stalledAtBound.length} ended at the ${stallMs} ms stall bound`,
      `${stalledCalls.length} call(s) ended aborted with a stalled error`,
      stall.length > 0 && stalledAtBound.length === stall.length && stalledCalls.length > 0
    );
    const late = around("late_first_byte");
    const lateAtBound = late.filter(
      (entry) =>
        entry.exchange.outcome === "client_closed" &&
        entry.exchange.closedAfterMs !== null &&
        Math.abs(entry.exchange.closedAfterMs - firstByteMs) <= 3_000
    );
    const lateCalls = late.filter((entry) =>
      entry.rows.some(
        (row) =>
          row.deadlineOutcome === "aborted" &&
          /sent no data|did not respond|timeout/iu.test(row.error ?? "")
      )
    );
    add(
      "late_first_byte",
      provider,
      late.length,
      "aborted",
      `${lateAtBound.length} ended at the ${firstByteMs} ms first-byte bound`,
      `${lateCalls.length} call(s) ended aborted with a no-data error`,
      late.length > 0 && lateAtBound.length === late.length && lateCalls.length > 0
    );
    const malformed = around("malformed");
    const repaired = malformed.filter(
      (entry) =>
        rows.some(
          (row) =>
            (row.isRepair || (row.attempt ?? 0) >= 1) &&
            rowStart(row) >= toMs(entry.exchange.endedAt) - 1_000 &&
            rowStart(row) - toMs(entry.exchange.endedAt) <= repairWindowMs
        ) ||
        entry.rows.some(
          (row) =>
            row.status !== "succeeded" && /invalid|schema|json|output/iu.test(row.error ?? "")
        )
    );
    add(
      "malformed",
      provider,
      malformed.length,
      "met",
      `${malformed.filter((entry) => entry.exchange.status === 200).length} answered 200 with an answer the consumer refuses`,
      `${repaired.length} followed by a repair or an invalid-output failure`,
      malformed.length > 0 && repaired.length > 0
    );
  }
  for (const outage of windows.filter((window) => window.kind === "outage")) {
    const lane = lanes.get(outage.provider);
    const from = toMs(outage.startedAt);
    const to = toMs(outage.endedAt);
    const failedRows = overlapping(rowsOn(outage.provider), from, to).filter(
      (row) =>
        row.status !== "succeeded" &&
        /ECONN|fetch failed|network|socket|unavailable|circuit/iu.test(row.error ?? "")
    );
    const breaker = run.events.filter(
      (event): event is Extract<SoakEvent, { type: "breaker" }> =>
        event.type === "breaker" && event.lane === lane
    );
    const opened = breaker.find((event) => event.to === "open" && toMs(event.at) >= from - 1_000);
    const closed =
      opened && breaker.find((event) => event.to === "closed" && toMs(event.at) > toMs(opened.at));
    add(
      "outage",
      outage.provider,
      1,
      "met",
      `${failedRows.length} call(s) failed with a network error during the outage`,
      `breaker ${opened ? "opened" : "did not open"}, ${closed ? `closed ${Math.round((toMs(closed.at) - to) / 1000)} s after` : "did not close"}`,
      failedRows.length > 0 &&
        failedRows.every((row) => row.deadlineOutcome === "met") &&
        Boolean(opened) &&
        Boolean(closed) &&
        toMs(closed!.at) <= to + minute
    );
  }
  for (const slow of windows.filter((window) => window.kind === "slow")) {
    const inside = exchanges.filter(
      (exchange) => exchange.provider === slow.provider && exchange.kind === "slow"
    );
    const rows = overlapping(rowsOn(slow.provider), toMs(slow.startedAt), toMs(slow.endedAt));
    add(
      "slow",
      slow.provider,
      inside.length,
      "met",
      `${inside.length} answer(s) stretched ${slow.factor ?? 10}x`,
      `${rows.filter((row) => row.durationMs - (row.requeueMs ?? 0) <= (row.deadlineMs ?? Infinity) + 2_000).length} of ${rows.length} call(s) within their deadline`,
      inside.length > 0 &&
        rows.every(
          (row) => row.durationMs - (row.requeueMs ?? 0) <= (row.deadlineMs ?? Infinity) + 2_000
        )
    );
  }
  return out;
}

function callsTable(run: LoadedRun) {
  const groups = new Map<string, TaskRunRecord[]>();
  for (const row of run.rows) {
    const key = `${row.lane ?? "?"}|${row.workloadClass ?? "?"}|${row.taskType}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rows]) => {
      const [lane, workloadClass, task] = key.split("|") as [string, string, string];
      const durations = rows.map((row) => row.durationMs - (row.requeueMs ?? 0));
      return {
        lane,
        class: workloadClass,
        task,
        calls: rows.length,
        failed: rows.filter((row) => row.status !== "succeeded").length,
        aborted: rows.filter((row) => row.deadlineOutcome === "aborted").length,
        repairs: rows.filter((row) => row.isRepair).length,
        "p50 (ms)": percentile(durations, 0.5)!,
        "p95 (ms)": percentile(durations, 0.95)!,
        "max (ms)": Math.max(...durations)
      };
    });
}

/** Analyses a loaded run into the report. */
export function analyzeRun(
  loaded: LoadedRun,
  options: {
    presoak?: boolean;
    explanations?: Record<string, string>;
    now?: Date;
    /** C4's re-run: count every structured call of the local writer in the repair rate. */
    countLocalWriter?: boolean;
  } = {}
): SoakReport {
  // The collector reads the audit from a little before the run began, and a call that was running
  // when it began is no part of it: both belong to what happened before.
  const runStart = toMs(loaded.meta.startedAt);
  const run: LoadedRun = {
    ...loaded,
    rows: loaded.rows.filter((row) => rowStart(row) >= runStart),
    events: loaded.events.filter(
      (event) => event.type !== "job_failure" || toMs(event.at) >= runStart
    )
  };
  const injected = injectedRows(run);
  const f4 = f4Report(run, { injected, injectedJobs: injectedJobFailures(run, injected) });
  const { check: past, wedged } = pastDeadlineCheck(run);
  const swap = swapCheck(run);
  const p0 = p0Check(run);
  const audit = failureAudit(run, injected, run.meta.seed);
  const checks: Check[] = [
    past,
    repairsCheck(run, injected, options.countLocalWriter === true),
    ...jobChecks(run, options.explanations ?? {}),
    swap.check,
    p0.check,
    breakerCheck(run),
    helperCheck(run),
    {
      ...audit.check,
      status: audit.check.status === "pass" && wedged.length === 0 ? "pass" : "review",
      details: [...audit.check.details, ...wedged.map((text) => `wedged: ${text}`)]
    },
    remoteDeadlinesCheck(run),
    ...(f4?.checks ?? [])
  ];
  const presoak = options.presoak
    ? [
        ...presoakAssertions(run),
        ...(f4
          ? gateSAssertions(run).map((entry): PresoakAssertion => ({
              kind: entry.kind,
              provider: "openai-codex",
              occurrences: entry.occurrences,
              expectedOutcome: "met",
              attempt: entry.detail,
              call: "",
              status: entry.status
            }))
          : [])
      ]
    : null;
  const header = run.events.length;
  const actions: Record<string, Record<string, number>> = {};
  for (const event of run.events)
    if (event.type === "action") {
      actions[event.kind] ??= {};
      actions[event.kind]![event.status] = (actions[event.kind]![event.status] ?? 0) + 1;
    }
  const statuses = [
    ...checks.map((check) => check.status),
    ...(presoak?.map((entry) => entry.status) ?? [])
  ];
  const startedAt = toMs(run.meta.startedAt);
  const endedAt = run.meta.endedAt
    ? toMs(run.meta.endedAt)
    : run.samples.length
      ? toMs(run.samples.at(-1)!.at)
      : startedAt;
  return {
    run: run.meta.run,
    profile: run.meta.profile,
    generatedAt: (options.now ?? new Date()).toISOString(),
    verdict: statuses.includes("fail") ? "fail" : statuses.includes("review") ? "review" : "pass",
    window: {
      startedAt: run.meta.startedAt,
      endedAt: run.meta.endedAt,
      endReason: run.meta.endReason,
      hours: Math.round(((endedAt - startedAt) / hour) * 100) / 100
    },
    counts: {
      taskRuns: run.rows.length,
      beforeStart: loaded.rows.length - run.rows.length,
      failedJobs: jobFailuresOf(run.events).length,
      events: header,
      samples: run.samples.length,
      actions,
      invalid: run.invalid
    },
    checks,
    f4,
    relations: f4?.relations ?? relationsOf(run),
    predicates: { ...predicateVersions },
    countedLocalWriter: options.countLocalWriter === true,
    presoak,
    tables: { calls: callsTable(run), p0: p0.table, resources: swap.resources },
    failureAudit: audit.rows,
    wedged
  };
}

/** The relations line of a run that records one (F3's runs do not). */
function relationsOf(run: LoadedRun): string | null {
  const relations = run.meta.relations;
  return relations
    ? `Relations configuration kept by the run: source discovery neighbours ${relations.discoveryNeighbours} (the knob that sets them is refused in a soak), judge decider mode ${relations.judgeMode ?? "not stored (the routes derive it)"}.`
    : null;
}

const cell = (value: string | number | null) =>
  String(value ?? "-")
    .replace(/\|/gu, "\\|")
    .replace(/\s+/gu, " ");
function table(rows: ReadonlyArray<Record<string, string | number | null>>): string[] {
  if (rows.length === 0) return ["_None._", ""];
  const header = Object.keys(rows[0]!);
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${header.map((key) => cell(row[key] ?? null)).join(" | ")} |`),
    ""
  ];
}

const mark: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  review: "REVIEW",
  "n/a": "n/a"
};

/** The Markdown of a report. */
export function renderReport(report: SoakReport): string {
  const lines = [
    `# Soak report: ${report.run}`,
    "",
    `Profile \`${report.profile}\`, ${report.window.hours} h (${report.window.startedAt} to ${report.window.endedAt ?? "not finished"}, ended by ${report.window.endReason ?? "nothing yet"}). Generated ${report.generatedAt}.`,
    "",
    `**Verdict: ${mark[report.verdict] === "PASS" ? "PASS" : report.verdict === "fail" ? "FAIL" : "REVIEW"}**`,
    "",
    ...(report.relations ? [report.relations, ""] : []),
    ...(report.f4
      ? [
          `Predicates evaluated: ${Object.entries(report.predicates)
            .map(([name, version]) => `${name} v${version}`)
            .join(
              ", "
            )}. Fault bodies injected at the fetch layer are synthetic shapes built from our parser's patterns (no real usage_limit_reached body is captured), not recordings.${
            report.countedLocalWriter ? " The repair rate counts every local-writer row (C4)." : ""
          }`,
          ""
        ]
      : []),
    `Audited calls ${report.counts.taskRuns}, events ${report.counts.events}, samples ${report.counts.samples}.` +
      (report.counts.beforeStart > 0
        ? ` ${report.counts.beforeStart} audit row(s) that started before the run were left out.`
        : "") +
      (Object.values(report.counts.invalid).some((count) => count > 0)
        ? ` Unreadable lines: ${JSON.stringify(report.counts.invalid)}.`
        : ""),
    "",
    "## X6",
    "",
    ...table(
      report.checks.map((check) => ({
        check: check.title,
        bar: check.bar,
        result: mark[check.status],
        value: check.value
      }))
    )
  ];
  for (const check of report.checks.filter((entry) => entry.details.length > 0)) {
    lines.push(`### ${check.title}`, "", ...check.details.map((detail) => `- ${detail}`), "");
  }
  if (report.f4) {
    lines.push(
      "## E1 contention exposure (lane-minutes a day)",
      "",
      ...table(report.f4.tables.exposure),
      "## E3 within 24 h, by kind and by blocker window",
      "",
      ...table(report.f4.tables.e3),
      "## Injection ledger (Codex lane)",
      "",
      ...table(report.f4.tables.injection),
      "## Codex tokens by day",
      "",
      ...table(report.f4.tables.tokens),
      "## Load ledger by day",
      "",
      ...table(report.f4.tables.load)
    );
  }
  if (report.presoak) {
    lines.push(
      "## Pre-soak assertion (R6, gate P)",
      "",
      "Each injected fault kind must end with its expected `deadline_outcome` and error class; otherwise the soak does not start.",
      "",
      ...table(
        report.presoak.map((entry) => ({
          kind: entry.kind,
          provider: entry.provider,
          occurrences: entry.occurrences,
          "expected outcome": entry.expectedOutcome,
          "per attempt": entry.attempt,
          "per call": entry.call,
          result: mark[entry.status]
        }))
      )
    );
  }
  lines.push(
    "## Actions",
    "",
    ...table(
      Object.entries(report.counts.actions).map(([kind, statuses]) => ({
        action: kind,
        ok: statuses.ok ?? 0,
        failed: statuses.failed ?? 0,
        skipped: statuses.skipped ?? 0
      }))
    ),
    "## Calls by lane, class and task",
    "",
    ...table(report.tables.calls),
    "## P0 wait",
    "",
    ...table(report.tables.p0),
    "## Resources",
    "",
    ...table(report.tables.resources),
    "## Audited sample of non-injected failures",
    "",
    ...table(report.failureAudit)
  );
  return lines.join("\n");
}

/** Reads a run directory. */
export async function loadRun(directory: string): Promise<LoadedRun> {
  const read = async (name: string) => {
    try {
      return await readFile(join(directory, name), "utf8");
    } catch {
      return "";
    }
  };
  const metaText = await read(soakFiles.meta);
  if (metaText === "")
    throw new Error(`${join(directory, soakFiles.meta)} is missing: not a soak run.`);
  const events = parseNdjson(await read(soakFiles.events), soakEventSchema);
  const samples = parseNdjson(await read(soakFiles.samples), soakSampleSchema);
  const rows = parseNdjson(await read(soakFiles.taskRuns), taskRunRecordSchema);
  return {
    meta: soakMetaSchema.parse(JSON.parse(metaText)),
    events: events.records,
    samples: samples.records,
    rows: rows.records,
    invalid: { events: events.invalid, samples: samples.invalid, taskRuns: rows.invalid }
  };
}

export const soakReportUsage = `Usage: npx tsx scripts/soak/report.ts <run directory> [options]

  --status                Print a compact health check of a run in progress (nothing is written).
  --presoak               Also assert that each injected fault kind ended as expected (gate P, gate S).
  --count-local-writer    Count every structured call of the local writer in the repair rate (C4's re-run).
  --explanations <file>   JSON {"<job id>": "why it was not blocked by an unrelated job"} (T64r).
  --out <file.md>         Where to write the Markdown (default: <run>/report.md).
  --json <file.json>      Where to write the data (default: <run>/report.json).
  --help                  Show this text.

Exit code: 0 pass, 2 needs a person's judgement, 1 fail or unreadable.`;

/** The latest sample of a run in a few lines: what an hourly health check reads. */
export function statusDigest(run: LoadedRun, report: SoakReport): string[] {
  const last = run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at)).at(-1);
  if (!last) return ["No sample yet."];
  const at = toMs(last.at);
  const queued = last.jobs.filter(
    (job) => job.status === "queued" && job.runAfter <= at && !job.blockedClass
  );
  const oldest = queued.length ? Math.max(...queued.map((job) => at - job.updatedAt)) : 0;
  const warmEnd = toMs(run.meta.startedAt) + run.meta.warmupMs;
  const warm = run.samples.find((sample) => toMs(sample.at) >= warmEnd && sample.pageouts !== null);
  const pageoutMb =
    warm && last.pageouts !== null
      ? (((last.pageouts - warm.pageouts!) * (last.pageSizeBytes ?? 16_384)) / 1_048_576).toFixed(1)
      : "-";
  const actions = run.events.filter(
    (event) => event.type === "action" && event.status === "failed"
  );
  const f4Lines = run.meta.f4
    ? [
        `Status: ${last.status ? `${last.status.state} ${last.status.class ?? "-"}.${last.status.reason ?? "-"}` : "no status sample"}; harness cap ${last.cap ? `${last.cap.spentTokens}+${last.cap.reservedTokens} of ${last.cap.capTokens} tokens, ${last.cap.refusals} refusal(s)` : "-"}; Codex calls today ${last.budget ? `${last.budget.usedCalls}/${last.budget.capCalls}` : "-"}.`,
        `Workers: ${(last.workers ?? []).map((worker) => `${worker.worker}:${worker.state}${worker.why ? `(${worker.why})` : ""}`).join(" ") || "-"}; load ${last.load ? `${last.load.loadAverage[0]} (pressure ${last.load.memoryPressure ?? "-"})` : "-"}.`
      ]
    : [];
  return [
    `Latest sample ${last.at} (${(last.elapsedMs / hour).toFixed(2)} h in).`,
    ...f4Lines,
    `Lanes: ${last.lanes.map((lane) => `${lane.lane} running ${lane.running}/${lane.limit} waiting ${Object.values(lane.waiting).reduce((a, b) => a + b, 0)}${lane.breaker && lane.breaker !== "closed" ? ` breaker ${lane.breaker}` : ""}${lane.held ? ` HELD ${lane.held}` : ""}`).join("; ")}`,
    `Jobs: ${JSON.stringify(last.jobCounts)}; oldest eligible queued job unchanged for ${Math.round(oldest / minute)} min.`,
    `Helper: ${last.helper ? `pid ${last.helper.pid} rss ${last.helper.rssMb} MB spawns ${last.helper.spawnCount}` : "not running"}; app rss ${last.appRssMb} MB; pageouts since warm-up ${pageoutMb} MB; loop lag p99 ${last.eventLoopLagP99Ms ?? "-"} ms.`,
    `Audited calls ${report.counts.taskRuns}; failed driver actions ${actions.length}.`
  ];
}

export async function runSoakReport(
  argv: readonly string[]
): Promise<{ text: string; code: 0 | 1 | 2 }> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      status: { type: "boolean", default: false },
      presoak: { type: "boolean", default: false },
      "count-local-writer": { type: "boolean", default: false },
      explanations: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", default: false }
    }
  });
  if (values.help || positionals.length !== 1)
    return { text: soakReportUsage, code: values.help ? 0 : 1 };
  const directory = resolve(positionals[0]!);
  const run = await loadRun(directory);
  const explanations = values.explanations
    ? (JSON.parse(await readFile(resolve(values.explanations), "utf8")) as Record<string, string>)
    : {};
  const report = analyzeRun(run, {
    presoak: values.presoak,
    explanations,
    countLocalWriter: values["count-local-writer"]
  });
  if (values.status) {
    const lines = [
      `Soak ${report.run} (${report.profile}): ${report.verdict.toUpperCase()} so far`,
      ...statusDigest(run, report),
      ...report.checks
        .filter((check) => check.status === "fail" || check.status === "review")
        .map((check) => `${mark[check.status]} ${check.title}: ${check.value}`)
    ];
    return {
      text: lines.join("\n"),
      code: report.verdict === "fail" ? 1 : report.verdict === "review" ? 2 : 0
    };
  }
  const markdown = renderReport(report);
  await writeFile(resolve(values.out ?? join(directory, "report.md")), `${markdown}\n`);
  await writeFile(
    resolve(values.json ?? join(directory, "report.json")),
    `${JSON.stringify(report, null, 2)}\n`
  );
  const summary = report.checks.map(
    (check) => `${mark[check.status].padEnd(6)} ${check.title}: ${check.value}`
  );
  if (report.presoak)
    summary.push(
      ...report.presoak.map(
        (entry) =>
          `${mark[entry.status].padEnd(6)} pre-soak ${entry.provider} ${entry.kind}: ${entry.occurrences} occurrence(s)`
      )
    );
  return {
    text: [`Soak ${report.run}: ${report.verdict.toUpperCase()}`, ...summary].join("\n"),
    code: report.verdict === "pass" ? 0 : report.verdict === "review" ? 2 : 1
  };
}

if (import.meta.main) {
  try {
    const { text, code } = await runSoakReport(process.argv.slice(2));
    console.info(text);
    process.exitCode = code;
  } catch (error) {
    console.error(`[soak-report] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
