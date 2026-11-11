/**
 * The reported lines of the dedicated E1 contention run (F4 D38b, owner 2026-11-11): the edit-wave
 * ledger, the run's conditions (autonomy Off and the power pin in every sample, no truncated
 * sample, the collector's time, payload and database growth), the D12 line (completed Codex
 * exchanges and remote rows with tokens, refusals apart), the set-aside age by blocker and the idle
 * slots beside due work. None is the bar: E1's own line (`report-f4.ts` `e1Check`) is. A line that
 * needs a person reads REVIEW; none of them is a stop check (their titles never match the
 * watchdog's stop regex).
 */
import { workerOfJob } from "../../apps/desktop/src/main/services/dev/soak-workers.ts";
import type {
  ActionRecord,
  ExchangeRecord,
  JobDoneRecord,
  SoakSample,
  TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import { e1FullDayShare, type E1Result } from "./report-f4.ts";
import type { Check, CheckStatus, LoadedRun } from "./report.ts";

const minute = 60_000;
const day = 24 * 60 * minute;
const toMs = (iso: string) => Date.parse(iso);

/** A set-aside older than this, by any blocker but the run's own Off, needs a look (D38b). */
export const e1SetAsideReviewMinutes = 45;
/** The blocker the run holds on purpose: a link row set aside under Off is expected. */
export const e1OwnBlocker = "paused.autonomy_off";
/** Thresholds of the reported lines (D38b section 9). */
export const e1PayloadReviewBytes = 4 * 1_048_576;
export const e1DbGrowthReviewBytesPerDay = 15 * 1_073_741_824;
export const e1IdleWithDueReviewSamples = 3;

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

const sortedSamples = (run: LoadedRun): SoakSample[] =>
  run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at));

const isDue = (job: SoakSample["jobs"][number], at: number) =>
  job.status === "queued" && job.runAfter <= at && !job.blockedClass;

const relationsJob = (job: Pick<SoakSample["jobs"][number], "type" | "lane">) =>
  workerOfJob(job) === "relations";

const blockerKey = (job: SoakSample["jobs"][number]) =>
  `${job.blockedClass ?? "?"}.${job.blockedReason ?? "?"}`;

/** The error key a refused remote call carries (`gardener.blocked.<class>.<reason>`), or its text. */
export function refusalKey(error: string | null): string {
  if (!error) return "(no error)";
  const blocked = /gardener\.blocked\.[a-z_]+\.[a-z_]+/u.exec(error);
  return blocked ? blocked[0] : error.replace(/\s+/gu, " ").slice(0, 60);
}

/** One row a wave of the ledger: what it edited, what MATCH and the link jobs did, its exposure. */
export function e1WaveLedger(
  run: LoadedRun,
  exposure: Pick<E1Result, "perSample">
): Array<Record<string, string | number>> {
  const start = toMs(run.meta.startedAt);
  const end = run.meta.endedAt
    ? toMs(run.meta.endedAt)
    : toMs(sortedSamples(run).at(-1)?.at ?? run.meta.startedAt);
  const waves = run.events
    .filter((event): event is ActionRecord => event.type === "action" && event.kind === "edit_wave")
    .toSorted((a, b) => a.index - b.index);
  const samples = sortedSamples(run);
  const done = run.events.filter((event): event is JobDoneRecord => event.type === "job_done");
  const rankerRows = run.rows.filter((row) => row.taskType === "reranking" && row.lane === "local");
  return waves.map((wave, position) => {
    const from = toMs(wave.scheduledAt);
    const to = position + 1 < waves.length ? toMs(waves[position + 1]!.scheduledAt) : end;
    const inSpan = (iso: string | null) => iso !== null && toMs(iso) >= from && toMs(iso) < to;
    const span = samples.filter((sample) => toMs(sample.at) >= from && toMs(sample.at) < to);
    const matches = done.filter((job) => job.jobType === "relation-match" && inSpan(job.createdAt));
    const status = (name: string) => matches.filter((job) => job.resultStatus === name).length;
    const links = done.filter((job) => job.jobType === "relation-link" && inSpan(job.finishedAt));
    const setAside = new Set(
      span.flatMap((sample) =>
        sample.jobs
          .filter((job) => job.type === "relation-link" && job.blockedClass)
          .map((job) => job.id)
      )
    );
    const firstDue = span.find((sample) =>
      sample.jobs.some((job) => job.type === "relation-match" && isDue(job, toMs(sample.at)))
    );
    // Busy: a relations job running or due. A queued row not yet due (a link run the D26 cap
    // re-queued for the next local day) is no drain work.
    const busy = span.filter((sample) =>
      sample.jobs.some(
        (job) => relationsJob(job) && (job.status === "running" || isDue(job, toMs(sample.at)))
      )
    );
    const drainEnd = busy.at(-1);
    const calls = rankerRows.filter((row) => inSpan(row.startedAt)).map((row) => row.durationMs);
    const counter = (sample: SoakSample | undefined) => sample?.relationCalls?.calls ?? "-";
    const changeSets =
      span.length > 1 &&
      typeof span.at(-1)!.changeSets === "number" &&
      typeof span[0]!.changeSets === "number"
        ? span.at(-1)!.changeSets! - span[0]!.changeSets!
        : "-";
    const sums = exposure.perSample
      .filter((entry) => entry.at >= from && entry.at < to)
      .reduce(
        (total, entry) => ({
          scoped: total.scoped + entry.scoped,
          registered: total.registered + entry.registered,
          withoutLink: total.withoutLink + entry.scopedWithoutLink
        }),
        { scoped: 0, registered: 0, withoutLink: 0 }
      );
    const pinned = span.every(
      (sample) => sample.power?.overridden === true && !sample.power.active
    );
    const detail = (name: string) => wave.detail[name] ?? "-";
    return {
      wave: wave.index,
      "plan min": Math.round(((from - start) / minute) * 100) / 100,
      status: wave.status,
      order: String(detail("order")),
      edited: detail("edited") as number | string,
      conflicts: detail("conflicts") as number | string,
      gone: detail("gone") as number | string,
      "issue s":
        typeof wave.detail.issueMs === "number" ? Math.round(wave.detail.issueMs / 100) / 10 : "-",
      "MATCH decided": status("completed") + status("no_change"),
      "MATCH skipped": status("skipped"),
      "MATCH other": matches.length - status("completed") - status("no_change") - status("skipped"),
      "ranker calls": calls.length,
      "ranker p50 ms": percentile(calls, 0.5) ?? "-",
      "ranker p95 ms": percentile(calls, 0.95) ?? "-",
      "first due min": firstDue ? Math.round(((toMs(firstDue.at) - from) / minute) * 10) / 10 : "-",
      "drain end min": drainEnd ? Math.round(((toMs(drainEnd.at) - from) / minute) * 10) / 10 : "-",
      "link runs": links.filter((job) => job.status === "succeeded").length,
      "link set-aside": setAside.size,
      "change-sets": changeSets,
      "D26 start": counter(span[0]),
      "D26 end": counter(span.at(-1)),
      scoped: sums.scoped,
      "scoped w/o link": sums.withoutLink,
      registered: sums.registered,
      "power pinned": span.length === 0 ? "-" : pinned ? "yes" : "no"
    };
  });
}

/** The checks of the reported lines, and the wave ledger. */
export function e1RunLines(
  run: LoadedRun,
  exposure: Pick<E1Result, "perSample" | "idleWithDue">
): { checks: Check[]; waves: Array<Record<string, string | number>> } {
  const samples = sortedSamples(run);
  const start = toMs(run.meta.startedAt);
  const waves = e1WaveLedger(run, exposure);

  // --- the run's conditions -----------------------------------------------------------------
  const notOff = samples.filter((sample) => sample.controls && sample.controls.autonomy !== "off");
  const notPinned = samples.filter(
    (sample) => !sample.power || sample.power.overridden !== true || sample.power.active
  );
  const truncated = samples.filter((sample) => (sample.jobsTruncated ?? 0) > 0);
  const lastAt = samples.length > 0 ? toMs(samples.at(-1)!.at) : start;
  const expectedSamples = Math.floor((lastAt - start) / run.meta.sampleIntervalMs) + 1;
  // The collector sleeps a full interval and then collects, so its whole loop overhead adds to the
  // spacing (collectMs times the sample only): a day short of its samples shows here first.
  const meanSpacingMs =
    samples.length > 1 ? (lastAt - toMs(samples[0]!.at)) / (samples.length - 1) : null;
  const perDay = meanSpacingMs === null ? null : Math.floor(day / meanSpacingMs);
  const neededPerDay = Math.ceil((day / run.meta.sampleIntervalMs) * e1FullDayShare);
  const collect = samples.flatMap((sample) =>
    typeof sample.collectMs === "number" ? [sample.collectMs] : []
  );
  const payloads = samples.flatMap((sample) =>
    sample.jobs.flatMap((job) => (typeof job.payloadBytes === "number" ? [job.payloadBytes] : []))
  );
  const largestPayload = payloads.length > 0 ? Math.max(...payloads) : null;
  const sized = samples.filter((sample) => typeof sample.dbBytes === "number");
  const growth =
    sized.length > 1
      ? ((sized.at(-1)!.dbBytes! - sized[0]!.dbBytes!) /
          Math.max(minute, toMs(sized.at(-1)!.at) - toMs(sized[0]!.at))) *
        day
      : null;
  const conditionProblems = [
    ...(notOff.length > 0 ? [`${notOff.length} sample(s) with autonomy other than Off`] : []),
    ...(notPinned.length > 0
      ? [`${notPinned.length} sample(s) without the idle power pin (overridden and not active)`]
      : []),
    ...(truncated.length > 0 ? [`${truncated.length} truncated sample(s)`] : []),
    ...(perDay !== null && perDay < neededPerDay
      ? [
          `the collector's mean spacing projects ${perDay} samples a day (< ${neededPerDay}): a full day would read "not exercised"`
        ]
      : []),
    ...(largestPayload !== null && largestPayload > e1PayloadReviewBytes
      ? [`a job payload of ${(largestPayload / 1_048_576).toFixed(1)} MB (> 4 MB)`]
      : []),
    ...(growth !== null && growth > e1DbGrowthReviewBytesPerDay
      ? [`database growth projected at ${(growth / 1_073_741_824).toFixed(1)} GB a day (> 15 GB)`]
      : [])
  ];
  const conditions: Check = {
    id: "e1-conditions",
    title: "E1 run conditions (D38b)",
    bar: "autonomy Off and the idle power pin in every sample, no truncated sample, a mean sample spacing that keeps a day's samples at the floor, payloads <= 4 MB, database growth <= 15 GB a day",
    status: samples.length === 0 ? "n/a" : conditionProblems.length > 0 ? "review" : "pass",
    value: `${samples.length} samples of ${expectedSamples} expected since the start (${Math.max(0, expectedSamples - samples.length)} missed), mean spacing ${meanSpacingMs === null ? "-" : `${(meanSpacingMs / 1000).toFixed(3)} s`}; collector p50 ${percentile(collect, 0.5) ?? "-"} / p95 ${percentile(collect, 0.95) ?? "-"} / max ${collect.length > 0 ? Math.max(...collect) : "-"} ms; largest payload ${largestPayload === null ? "-" : `${Math.round(largestPayload / 1024)} KB`}; database ${sized.length > 0 ? `${(sized.at(-1)!.dbBytes! / 1_073_741_824).toFixed(2)} GB` : "-"}, growth ${growth === null ? "-" : `${(growth / 1_073_741_824).toFixed(2)} GB a day`}`,
    details: conditionProblems
  };

  // --- D12: Codex spend under Off ------------------------------------------------------------
  const exchanges = run.events.filter(
    (event): event is ExchangeRecord => event.type === "exchange"
  );
  const forwarded = exchanges.filter(
    (exchange) => exchange.kind === "none" || exchange.kind === "stall"
  );
  const completed = forwarded.filter((exchange) => exchange.outcome === "completed");
  const remote = run.rows.filter(
    (row) => row.runtime === "remote" || row.lane?.startsWith("remote:")
  );
  const tokensOf = (row: TaskRunRecord) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  const spent = remote.filter((row) => tokensOf(row) > 0);
  const refused = remote.filter((row) => row.status !== "succeeded" && tokensOf(row) === 0);
  const byKey = new Map<string, number>();
  for (const row of refused)
    byKey.set(refusalKey(row.error), (byKey.get(refusalKey(row.error)) ?? 0) + 1);
  const d12Count = completed.length + spent.length;
  const d12: Check = {
    id: "e1-d12",
    title: "E1 run Codex spend under Off (D12)",
    bar: "0 completed Codex exchanges and 0 remote task-run rows with tokens (refusals at admission are listed apart, not counted)",
    status: d12Count > 0 || forwarded.length > completed.length ? "review" : "pass",
    value: `${completed.length} completed Codex exchange(s) (${forwarded.length} forwarded), ${spent.length} remote row(s) with ${spent.reduce((sum, row) => sum + tokensOf(row), 0)} tokens; ${refused.length} refused remote row(s)`,
    details: [...byKey]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([key, count]) => `refused (not spend): ${key} x${count}`),
    data: {
      completedExchanges: completed.length,
      rowsWithTokens: spent.length,
      refused: refused.length
    }
  };

  // --- set-aside age by blocker --------------------------------------------------------------
  const longest = new Map<string, { minutes: number; type: string }>();
  for (const sample of samples) {
    const at = toMs(sample.at);
    for (const job of sample.jobs) {
      if (!job.blockedClass || typeof job.blockedAt !== "number") continue;
      const age = (at - job.blockedAt) / minute;
      const key = blockerKey(job);
      if (age > (longest.get(key)?.minutes ?? -1))
        longest.set(key, { minutes: age, type: job.type });
    }
  }
  const stale = [...longest].filter(
    ([key, entry]) => key !== e1OwnBlocker && entry.minutes > e1SetAsideReviewMinutes
  );
  const setAside: Check = {
    id: "e1-set-aside",
    title: "E1 run set-aside age (D38b)",
    bar: `no row set aside by a blocker other than ${e1OwnBlocker} for more than ${e1SetAsideReviewMinutes} min (a release E1 cannot see)`,
    status: stale.length > 0 ? "review" : longest.size === 0 ? "n/a" : "pass",
    value:
      [...longest]
        .toSorted((a, b) => b[1].minutes - a[1].minutes)
        .map(([key, entry]) => `${key} ${entry.minutes.toFixed(1)} min (${entry.type})`)
        .join("; ") || "no row set aside",
    details: stale.map(
      ([key, entry]) =>
        `${entry.type} set aside by ${key} for ${entry.minutes.toFixed(1)} min (> ${e1SetAsideReviewMinutes})`
    )
  };

  // --- idle slots beside due work ------------------------------------------------------------
  const idle = Object.entries(exposure.idleWithDue);
  const longRuns = idle.filter(([, entry]) => entry.longest >= e1IdleWithDueReviewSamples);
  const idleCheck: Check = {
    id: "e1-idle-due",
    title: "E1 run idle slot beside due work (reported)",
    bar: `no worker keeps an idle slot beside a claimable due task for ${e1IdleWithDueReviewSamples} samples in a row (a partial stall the 15 min predicate cannot reach)`,
    status: longRuns.length > 0 ? "review" : "pass",
    value:
      idle
        .map(([worker, entry]) => `${worker} ${entry.samples} sample(s), longest ${entry.longest}`)
        .join("; ") || "none",
    details: []
  };

  // --- the waves -----------------------------------------------------------------------------
  const skipped = waves.filter((wave) => wave.status !== "ok");
  const conflicts = waves.filter(
    (wave) =>
      typeof wave.edited === "number" &&
      typeof wave.conflicts === "number" &&
      wave.conflicts > 0.05 * Math.max(1, wave.edited + wave.conflicts)
  );
  const overrun = waves.filter((wave, position) => {
    const next = waves[position + 1];
    return (
      next !== undefined &&
      typeof wave["drain end min"] === "number" &&
      typeof wave["plan min"] === "number" &&
      typeof next["plan min"] === "number" &&
      wave["plan min"] + wave["drain end min"] >= next["plan min"] - 1
    );
  });
  const waveStatus: CheckStatus =
    waves.length === 0
      ? "n/a"
      : skipped.length > 0 || conflicts.length > 0 || overrun.length > 0
        ? "review"
        : "pass";
  const busy = waves.flatMap((wave) =>
    typeof wave["drain end min"] === "number" ? [wave["drain end min"]] : []
  );
  const wavesCheck: Check = {
    id: "e1-waves",
    title: "E1 run edit waves (D38b)",
    bar: "every wave runs (none skipped or failed), conflicts <= 5 % of a wave's notes, each wave drains before the next starts",
    status: waveStatus,
    value: `${waves.length} wave(s), ${skipped.length} not ok; busy p50 ${percentile(busy, 0.5) ?? "-"} / max ${busy.length > 0 ? Math.max(...busy) : "-"} min; scoped exposure ${waves.reduce((sum, wave) => sum + (wave.scoped as number), 0)} lane-minutes in the waves`,
    details: [
      ...skipped.map((wave) => `wave ${wave.wave} ${wave.status}`),
      ...conflicts.map(
        (wave) => `wave ${wave.wave}: ${wave.conflicts} conflict(s) for ${wave.edited} edit(s)`
      ),
      ...overrun.map(
        (wave) =>
          `wave ${wave.wave} drained ${wave["drain end min"]} min after its start, into the next wave`
      )
    ]
  };
  return { checks: [conditions, d12, setAside, idleCheck, wavesCheck], waves };
}
