import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { seededUnit } from "./fake-remote-core.js";
import { decideDrop, droppedBy, dropStepLabels, type AppliedDropStep } from "./soak-budget.js";
import type { EditWaveOrder, SoakProfile } from "./soak-plan.js";
import { expandWindows, type SoakWindowSpec } from "./soak-plan-f4.js";
import {
  NdjsonFile,
  soakFiles,
  soakRunFormat,
  taskRunRecordSchema,
  soakSampleSchema,
  type JobDoneRecord,
  type JobFailureRecord,
  type OutcomeRecord,
  type SoakActionKind,
  type SoakEvent,
  type SoakEventSink,
  type SoakMeta,
  type SoakSample,
  type TaskRunRecord
} from "./soak-records.js";
import type { CapSnapshot } from "./soak-token-cap.js";
import { windowTransitions, type WindowRunner, type WindowTransition } from "./soak-windows.js";

/**
 * The soak driver (F3 T62, spec 5.9): a timeline of the things an owner does over a day, played
 * through the real services by the ports below, with a collector that writes, every minute, what
 * the report needs. The driver holds no service of its own: `soak-ports.ts` builds the ports from
 * the app's services, and tests give it fakes and a fake clock. Every random choice (the jitter of
 * the helper kills, which article, which question) is a function of the plan's seed.
 */

/** Details an action reports about itself: counts, outcomes, error classes; never content. */
export type ActionDetail = Record<string, string | number | boolean | null>;

/** A port's failure that still reports facts about the action (how long it ran, how far it got). */
export class SoakActionFailure extends Error {
  public readonly detail: ActionDetail;

  public constructor(message: string, detail: ActionDetail, options?: ErrorOptions) {
    super(message, options);
    this.name = "SoakActionFailure";
    this.detail = detail;
  }
}

export interface SoakClock {
  now(): number;
  /** Waits; resolves early (without error) when `signal` aborts. */
  sleep(milliseconds: number, signal: AbortSignal): Promise<void>;
}

export const realClock: SoakClock = {
  now: () => Date.now(),
  sleep: (milliseconds, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, Math.max(0, milliseconds));
      function done() {
        signal.removeEventListener("abort", done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener("abort", done, { once: true });
    })
};

/** What the F4 profile adds to the driver: the windows, the token cap and the spend it projects from. */
export interface SoakF4Runtime {
  /** Starts and ends the windows, and ticks them every sample interval. */
  windows: WindowRunner;
  /** The harness token cap's snapshot (its spend is the one the drop steps project from). */
  cap: { snapshot(): CapSnapshot };
  /** The explanation backfill's daily allowance, lowered by drop step 3 (read at its next pass). */
  setBackfillCap?: (calls: number) => void;
  /** A DEV command that lowers the harness cap: its tokens, or null when none was given. */
  readCapCommand?: () => Promise<number | null>;
  lowerCap?: (capTokens: number) => boolean;
  /** A call was refused at the hard cap: the remote leg is over and the run reads inconclusive. */
  isExhausted?: () => boolean;
}

/** What the driver asks of the app. Each port reports its facts, or throws to fail its action. */
export interface SoakPorts {
  /** A public corpus article through the real ingestion path; `exhausted` when the corpus has no more. */
  importArticle(index: number): Promise<ActionDetail & { exhausted?: boolean }>;
  /** An Ask question over the library. */
  ask(index: number): Promise<ActionDetail>;
  /** An explanation opened through the service, `count` of them at once. */
  explain(count: number, index: number): Promise<ActionDetail>;
  /** A human edit of a note. */
  editNote(index: number): Promise<ActionDetail>;
  /** A source deleted and imported again as a new version. */
  reimportSource(index: number): Promise<ActionDetail>;
  /** An article imported whose typing fails deterministically. */
  importTypingFaultSource(index: number): Promise<ActionDetail>;
  /** SIGKILL of the MLX helper; `killed` is false when none was running. */
  killMlxHelper(): Promise<{ killed: boolean; detail: ActionDetail }>;
  /** Arms the abort of the next GGUF embedding batch. */
  armGgufAbort(): Promise<ActionDetail>;
  /** What the collector reads now (lanes, jobs, helper, memory, loop lag, pool). */
  sample(): Promise<Omit<SoakSample, "at" | "elapsedMs">>;
  /** The audit rows of calls that ended since `sinceMs` (epoch), a little before it to be safe. */
  taskRuns(sinceMs: number): Promise<TaskRunRecord[]>;
  /** The jobs that ended `failed` since `sinceMs` (epoch), a little before it to be safe. */
  failedJobs(sinceMs: number): Promise<JobFailureRecord[]>;
  /** The orchestrator asked to stop (a STOP file in the run directory). */
  stopRequested(): Promise<boolean>;
  /** F4: a topic page opened (view history recorded, the overview written or patched at P0 when stale). */
  openTopic?(index: number): Promise<ActionDetail>;
  /** F4: AUDIT lints, notes embedded again and a rolling re-placement batch (the burst's local work). */
  contentionBurst?(index: number, reembeds: number): Promise<ActionDetail>;
  /** F4: one human edit of a note in the `rootIndex`-th root (the burst's six edits land in six roots). */
  editBurstNote?(index: number, rootIndex: number): Promise<ActionDetail>;
  /**
   * F4 D38b: an edit wave, every current note (up to `notes`) edited once through the knowledge
   * service with the wave's revision marker, in the order given.
   */
  editWave?(index: number, spec: { notes: number; order: EditWaveOrder }): Promise<ActionDetail>;
  /** F4: jobs that reached a final state since `sinceMs`, for E3. */
  finishedJobs?(sinceMs: number): Promise<JobDoneRecord[]>;
  /** F4: (kind, subject) outcome rows that changed since `sinceMs`, for E2. */
  outcomeChanges?(sinceMs: number): Promise<OutcomeRecord[]>;
}

export interface TimelineEntry {
  /** Milliseconds from the start of the run. */
  atMs: number;
  kind: SoakActionKind | "mlx_kill" | "gguf_abort";
  index: number;
}

const minute = 60_000;

/**
 * Every action of the run in time order. Recurring actions repeat from their offset; the helper
 * kills carry a seeded jitter; a probe follows each outage of the Codex-wire fake, long enough after
 * its end for the circuit breaker to try again.
 */
export function buildTimeline(profile: SoakProfile): TimelineEntry[] {
  const total = profile.durationHours * 60 * minute;
  const entries: TimelineEntry[] = [];
  const dayMs = 24 * 60 * minute;
  const every = (
    kind: TimelineEntry["kind"],
    spec: { everyMinutes: number; offsetMinutes?: number; days?: "all" | "odd" | "even" },
    jitterFor?: (index: number) => number
  ) => {
    for (let index = 0; ; index++) {
      const atMs =
        (spec.offsetMinutes ?? 0) * minute +
        index * spec.everyMinutes * minute +
        (jitterFor?.(index) ?? 0);
      if (atMs >= total) break;
      // Day 1 is the first 24 h of the run.
      const day = Math.floor(atMs / dayMs) + 1;
      if ((spec.days === "odd" && day % 2 === 0) || (spec.days === "even" && day % 2 === 1))
        continue;
      if (atMs >= 0) entries.push({ atMs: Math.round(atMs), kind, index });
    }
  };
  const driver = profile.driver;
  every("article", driver.article);
  every("ask", driver.ask);
  every("explain", driver.explain);
  every("explain_burst", driver.explainBurst);
  every("note_edit", driver.noteEdit);
  every("source_reimport", driver.sourceReimport);
  every("typing_fault", driver.typingFault);
  if (driver.topicOpen) every("topic_open", driver.topicOpen);
  if (driver.contentionBurst) {
    const burst = driver.contentionBurst;
    every("contention_burst", burst);
    // The burst's edits come one every few minutes after it, each in a root of its own.
    for (let index = 0; ; index++) {
      const atMs = (burst.offsetMinutes + index * burst.everyMinutes) * minute;
      if (atMs >= total) break;
      for (let edit = 0; edit < burst.edits; edit++)
        entries.push({
          atMs: Math.round(atMs + edit * burst.editSpacingMinutes * minute),
          kind: "burst_edit",
          index: index * burst.edits + edit
        });
    }
  }
  if (driver.editWave) {
    // D38b: a wave every `everyMinutes` (fractional), none after `untilMinutes` or the run's end.
    const wave = driver.editWave;
    const lastMs = Math.min(total - 1, (wave.untilMinutes ?? Number.POSITIVE_INFINITY) * minute);
    for (let index = 0; ; index++) {
      const atMs = (wave.offsetMinutes + index * wave.everyMinutes) * minute;
      if (atMs > lastMs) break;
      entries.push({ atMs: Math.round(atMs), kind: "edit_wave", index });
    }
  }
  const kill = profile.local.mlxKill;
  if (kill.atMinutes) {
    // D38b: kills at the listed plan minutes (inside a wave's ranker phase), numbered from 1.
    kill.atMinutes.forEach((at, position) => {
      const atMs = Math.round(at * minute);
      if (atMs < total) entries.push({ atMs, kind: "mlx_kill", index: position + 1 });
    });
  } else if (kill.everyMinutes !== undefined) {
    // The first kill comes after one period, never at the start: the helper has to be running.
    for (let index = 1; ; index++) {
      const jitter =
        (2 * seededUnit(profile.seed, "mlx-kill", index) - 1) * kill.jitterMinutes * minute;
      const atMs = Math.round(index * kill.everyMinutes * minute + jitter);
      if (atMs >= total) break;
      entries.push({ atMs, kind: "mlx_kill", index });
    }
  }
  const abort = profile.local.ggufAbort;
  for (let index = 1; ; index++) {
    // 17 minutes off the hour, so it never lands on a helper kill or an article.
    const atMs = Math.round(index * abort.everyMinutes * minute + 17 * minute);
    if (atMs >= total) break;
    entries.push({ atMs, kind: "gguf_abort", index });
  }
  const outages = (profile.remote?.codexWire.faults.windows ?? []).filter(
    (window) => window.kind === "outage"
  );
  for (const [index, window] of outages.entries()) {
    const atMs = Math.round(
      (window.startMinute + window.durationMinutes) * minute + driver.postOutageProbeSeconds * 1000
    );
    if (atMs < total) entries.push({ atMs, kind: "post_outage_probe", index });
  }
  const order = (entry: TimelineEntry) =>
    [
      "article",
      "typing_fault",
      "source_reimport",
      "note_edit",
      "ask",
      "explain",
      "explain_burst",
      "post_outage_probe",
      "topic_open",
      "contention_burst",
      "burst_edit",
      "edit_wave",
      "mlx_kill",
      "gguf_abort"
    ].indexOf(entry.kind);
  return entries.toSorted((a, b) => a.atMs - b.atMs || order(a) - order(b) || a.index - b.index);
}

const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 400);

export type SoakEndReason = NonNullable<SoakMeta["endReason"]>;

export interface SoakRunOptions {
  profile: SoakProfile;
  profileName: string;
  /** The run directory (`.cache/f3/soak/<run>/`, F4: `<data root>/f4/soak/<run>/`). */
  directory: string;
  run: string;
  ports: SoakPorts;
  sink: SoakEventSink & { flush?(): Promise<void> };
  clock?: SoakClock;
  /** Aborts the run from outside (a signal): it ends as `signal`. */
  signal?: AbortSignal;
  meta: Pick<SoakMeta, "host" | "catalogHeader" | "bounds" | "providers"> &
    Partial<Pick<SoakMeta, "relations" | "dataRoot" | "realWriter" | "decisions" | "f4">>;
  logger?: Pick<Console, "info" | "error">;
  /** How long to wait for actions still running at the end. */
  settleMs?: number;
  /** The F4 parts; required for a profile with an `f4` section. */
  f4?: SoakF4Runtime;
}

export interface SoakOutcome {
  reason: SoakEndReason;
  actions: number;
  failed: number;
  skipped: number;
  samples: number;
  taskRuns: number;
  failedJobs: number;
}

/** Runs the timeline of the profile, collecting every sample interval, until its duration, a STOP or an abort. */
export async function runSoak(options: SoakRunOptions): Promise<SoakOutcome> {
  const { profile, ports, directory } = options;
  const clock = options.clock ?? realClock;
  const logger = options.logger ?? console;
  const durationMs = Math.round(profile.durationHours * 60 * minute);
  const sampleIntervalMs = Math.round(profile.sampleEveryMinutes * minute);
  const startedAtMs = clock.now();
  const stop = new AbortController();
  options.signal?.addEventListener("abort", () => stop.abort(), { once: true });
  let reason: SoakEndReason = "duration";
  const f4 = options.f4;
  if (profile.f4 && !f4)
    throw new Error("A plan profile with an f4 section needs the F4 parts of the driver.");
  const windowSpecs: SoakWindowSpec[] = profile.f4
    ? expandWindows(profile.f4, durationMs / minute)
    : [];
  /** The drop steps applied so far (F4 spec 5.4), never reverted, and when. */
  const applied: AppliedDropStep[] = (
    profile.f4 ? [...Array(profile.f4.codex.dropFromHour0)] : []
  ).map((_, at) => ({ step: at + 1, atMs: 0 }));
  const appliedSet = () => new Set(applied.map((entry) => entry.step));
  /** Tokens spent at the end of each completed hour, for the projection's measured ÷ planned ratio. */
  const spentAtHour: number[] = [];
  const meta = (endedAt: number | null): SoakMeta => ({
    format: soakRunFormat,
    version: 1,
    run: options.run,
    profile: options.profileName,
    seed: profile.seed,
    startedAt: new Date(startedAtMs).toISOString(),
    endedAt: endedAt === null ? null : new Date(endedAt).toISOString(),
    endReason: endedAt === null ? null : reason,
    durationMs,
    warmupMs: Math.round(profile.warmupMinutes * minute),
    sampleIntervalMs,
    ...options.meta,
    plan: profile
  });
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, soakFiles.meta), `${JSON.stringify(meta(null), null, 2)}\n`);

  const samples = new NdjsonFile<SoakSample>(join(directory, soakFiles.samples), (sample) =>
    soakSampleSchema.parse(sample)
  );
  const taskRuns = new NdjsonFile<TaskRunRecord>(join(directory, soakFiles.taskRuns), (row) =>
    taskRunRecordSchema.parse(row)
  );
  const counts = { actions: 0, failed: 0, skipped: 0, samples: 0, taskRuns: 0, failedJobs: 0 };
  const seen = new Set<string>();
  const seenJobs = new Set<string>();
  const seenFinished = new Set<string>();
  const seenOutcomes = new Set<string>();
  let cursor = startedAtMs;
  let jobCursor = startedAtMs;
  let finishedCursor = startedAtMs;
  let outcomeCursor = startedAtMs;
  let hoursChecked = 0;

  const iso = (ms: number) => new Date(ms).toISOString();
  const emit = (event: SoakEvent) => options.sink.append(event);

  // An audit row is read before its monitoring entry is linked to it (the entry finishes just after
  // the row is written), and its operation then reads null. The row waits this long for the link, so
  // the operation the report sets the source judge's rows apart by is not lost to that gap; the
  // final collection takes whatever is there.
  const operationGraceMs = 30_000;
  const collect = async (final = false) => {
    const at = clock.now();
    try {
      samples.append({
        ...(await ports.sample()),
        at: iso(at),
        elapsedMs: at - startedAtMs
      });
      counts.samples += 1;
    } catch (error) {
      logger.error(`SOAK sample failed: ${failureText(error)}`);
    }
    try {
      const rows = await ports.taskRuns(cursor - 2 * minute);
      for (const row of rows) {
        if (seen.has(row.id)) continue;
        if (
          !final &&
          row.operation === null &&
          row.finishedAt &&
          clock.now() - Date.parse(row.finishedAt) < operationGraceMs
        )
          continue;
        seen.add(row.id);
        taskRuns.append(row);
        counts.taskRuns += 1;
        if (row.finishedAt) cursor = Math.max(cursor, Date.parse(row.finishedAt));
      }
    } catch (error) {
      logger.error(`SOAK task-run dump failed: ${failureText(error)}`);
    }
    try {
      for (const job of await ports.failedJobs(jobCursor - 2 * minute)) {
        if (seenJobs.has(job.id)) continue;
        seenJobs.add(job.id);
        const failedAt = Date.parse(job.at);
        jobCursor = Math.max(jobCursor, failedAt);
        // Jobs that failed before the run began are the profile's, not the run's.
        if (failedAt < startedAtMs) continue;
        emit({ type: "job_failure", ...job });
        counts.failedJobs += 1;
      }
    } catch (error) {
      logger.error(`SOAK failed-job dump failed: ${failureText(error)}`);
    }
    if (!f4) return;
    try {
      for (const job of (await ports.finishedJobs?.(finishedCursor - 2 * minute)) ?? []) {
        if (seenFinished.has(job.id)) continue;
        seenFinished.add(job.id);
        finishedCursor = Math.max(finishedCursor, Date.parse(job.finishedAt ?? job.createdAt));
        emit(job);
      }
      for (const outcome of (await ports.outcomeChanges?.(outcomeCursor - 2 * minute)) ?? []) {
        const key = `${outcome.kind}\u0000${outcome.subjectKey}\u0000${outcome.at}`;
        if (seenOutcomes.has(key)) continue;
        seenOutcomes.add(key);
        outcomeCursor = Math.max(outcomeCursor, Date.parse(outcome.at));
        emit(outcome);
      }
    } catch (error) {
      logger.error(`SOAK job ledger dump failed: ${failureText(error)}`);
    }
    try {
      await f4.windows.tick();
    } catch (error) {
      logger.error(`SOAK window tick failed: ${failureText(error)}`);
    }
    try {
      const command = await f4.readCapCommand?.();
      if (command !== null && command !== undefined) f4.lowerCap?.(command);
    } catch (error) {
      logger.error(`SOAK cap command failed: ${failureText(error)}`);
    }
  };

  /**
   * The hourly check of the token budget (spec 5.4): the projection of the rest of the run from what
   * was measured, and the next drop step when spent plus projection passes the cap.
   */
  const hourly = (entries: readonly TimelineEntry[]) => {
    if (!profile.f4 || !f4) return;
    const elapsed = clock.now() - startedAtMs;
    const completed = Math.floor(elapsed / (60 * minute));
    while (hoursChecked < completed) {
      hoursChecked += 1;
      spentAtHour.push(f4.cap.snapshot().spentTokens);
    }
    const spent = f4.cap.snapshot();
    const actualByHour = spentAtHour.map((total, at) => total - (spentAtHour[at - 1] ?? 0));
    const decision = decideDrop({
      entries,
      plan: profile.f4,
      windows: windowSpecs,
      applied,
      nowMs: elapsed,
      spentTokens: spent.spentTokens,
      capTokens: spent.hardCapTokens,
      durationMs,
      actualByHour
    });
    if (decision.step !== null) {
      applied.push({ step: decision.step, atMs: elapsed });
      if (decision.step === 3) f4.setBackfillCap?.(10);
      emit({
        type: "drop_step",
        at: iso(clock.now()),
        step: decision.step,
        spentTokens: spent.spentTokens,
        projectedTokens: decision.projectedTokens,
        capTokens: spent.hardCapTokens,
        note: dropStepLabels[decision.step] ?? ""
      });
      logger.info(
        `SOAK drop step ${decision.step} (${dropStepLabels[decision.step]}): ${spent.spentTokens} spent + ${decision.projectedTokens} projected > cap ${spent.hardCapTokens}`
      );
    } else if (decision.overFloor) {
      logger.error(
        `SOAK projection ${spent.spentTokens} + ${decision.projectedTokens} passes the cap ${spent.hardCapTokens} with every drop step taken`
      );
    }
  };

  const running = new Map<string, Promise<void>>();
  const execute = async (entry: TimelineEntry) => {
    const scheduledAt = startedAtMs + entry.atMs;
    const begun = clock.now();
    const finish = (
      status: "ok" | "failed" | "skipped",
      detail: ActionDetail = {},
      error?: string
    ) => {
      counts.actions += 1;
      if (status === "failed") counts.failed += 1;
      if (status === "skipped") counts.skipped += 1;
      const kind = entry.kind;
      if (kind === "mlx_kill" || kind === "gguf_abort") {
        // Local faults have their own record, written by the fault itself when it takes effect.
        emit({
          type: "local",
          kind,
          at: iso(clock.now()),
          detail: { ...detail, status, ...(error ? { error } : {}) }
        });
        return;
      }
      emit({
        type: "action",
        kind,
        index: entry.index,
        scheduledAt: iso(scheduledAt),
        startedAt: iso(begun),
        durationMs: Math.max(0, clock.now() - begun),
        status,
        detail,
        ...(error ? { error } : {})
      });
    };
    try {
      switch (entry.kind) {
        case "article": {
          const { exhausted, ...detail } = await ports.importArticle(entry.index);
          finish(exhausted ? "skipped" : "ok", { ...detail, exhausted: exhausted === true });
          return;
        }
        case "ask":
          finish("ok", await ports.ask(entry.index));
          return;
        case "explain":
        case "post_outage_probe":
          finish("ok", await ports.explain(1, entry.index));
          return;
        case "explain_burst":
          finish("ok", await ports.explain(profile.driver.explainBurst.count, entry.index));
          return;
        case "note_edit":
          finish("ok", await ports.editNote(entry.index));
          return;
        case "source_reimport":
          finish("ok", await ports.reimportSource(entry.index));
          return;
        case "typing_fault":
          finish("ok", await ports.importTypingFaultSource(entry.index));
          return;
        case "mlx_kill": {
          const { killed, detail } = await ports.killMlxHelper();
          finish(killed ? "ok" : "skipped", { ...detail, killed });
          return;
        }
        case "gguf_abort":
          finish("ok", await ports.armGgufAbort());
          return;
        case "topic_open": {
          if (!ports.openTopic) throw new Error("This run has no topic-open port.");
          finish("ok", await ports.openTopic(entry.index));
          return;
        }
        case "contention_burst": {
          if (!ports.contentionBurst) throw new Error("This run has no contention-burst port.");
          finish(
            "ok",
            await ports.contentionBurst(entry.index, profile.driver.contentionBurst?.reembeds ?? 20)
          );
          return;
        }
        case "burst_edit": {
          if (!ports.editBurstNote) throw new Error("This run has no burst-edit port.");
          const edits = profile.driver.contentionBurst?.edits ?? 6;
          finish("ok", await ports.editBurstNote(entry.index, entry.index % edits));
          return;
        }
        case "edit_wave": {
          if (!ports.editWave) throw new Error("This run has no edit-wave port.");
          const wave = profile.driver.editWave;
          const order: EditWaveOrder =
            wave?.order === "by_root" || wave?.order === "interleaved"
              ? wave.order
              : entry.index % 2 === 0
                ? "by_root"
                : "interleaved";
          finish("ok", await ports.editWave(entry.index, { notes: wave?.notes ?? 1_000, order }));
          return;
        }
      }
    } catch (error) {
      logger.error(`SOAK ${entry.kind} #${entry.index} failed: ${failureText(error)}`);
      finish("failed", error instanceof SoakActionFailure ? error.detail : {}, failureText(error));
    }
  };

  const dispatch = (entry: TimelineEntry) => {
    const { kind } = entry;
    // A local fault is instantaneous; every other kind runs one action at a time, so a slow one
    // does not pile its successors up behind it.
    if (kind === "mlx_kill" || kind === "gguf_abort") {
      void execute(entry);
      return;
    }
    const dropped = droppedBy(entry, appliedSet());
    if (dropped !== null) {
      counts.actions += 1;
      counts.skipped += 1;
      emit({
        type: "action",
        kind,
        index: entry.index,
        scheduledAt: iso(startedAtMs + entry.atMs),
        startedAt: iso(clock.now()),
        durationMs: 0,
        status: "skipped",
        detail: { reason: `drop step ${dropped}` }
      });
      return;
    }
    // Edits of one burst may overlap their predecessors in a slow run: they are one action each.
    if (kind !== "burst_edit" && running.has(kind)) {
      counts.actions += 1;
      counts.skipped += 1;
      emit({
        type: "action",
        kind,
        index: entry.index,
        scheduledAt: iso(startedAtMs + entry.atMs),
        startedAt: iso(clock.now()),
        durationMs: 0,
        status: "skipped",
        detail: { reason: "previous action of the kind still running" }
      });
      return;
    }
    const key = kind === "burst_edit" ? `${kind}#${entry.index}` : kind;
    running.set(
      key,
      execute(entry).finally(() => running.delete(key))
    );
  };

  const actions = buildTimeline(profile);
  const collector = (async () => {
    while (!stop.signal.aborted) {
      await clock.sleep(sampleIntervalMs, stop.signal);
      if (stop.signal.aborted) break;
      await collect();
      hourly(actions);
      if (f4?.isExhausted?.()) {
        // The remote leg is over: the run is reported inconclusive, not passed.
        reason = "token_cap";
        stop.abort();
      } else if (await ports.stopRequested().catch(() => false)) {
        reason = "stop_file";
        stop.abort();
      }
    }
  })();

  logger.info(
    `SOAK start: profile ${options.profileName}, ${profile.durationHours} h, seed ${profile.seed}, run ${options.run}`
  );
  await collect();
  const transitions: WindowTransition[] = f4 ? windowTransitions(windowSpecs) : [];
  const schedule = [
    ...actions.map((entry) => ({ atMs: entry.atMs, entry, transition: null })),
    ...transitions.map((transition) => ({ atMs: transition.atMs, entry: null, transition }))
  ].toSorted((a, b) => a.atMs - b.atMs);
  for (const item of schedule) {
    await clock.sleep(startedAtMs + item.atMs - clock.now(), stop.signal);
    if (stop.signal.aborted) break;
    if (item.entry) dispatch(item.entry);
    else if (f4 && item.transition) {
      const { transition } = item;
      // A window's effect is awaited, so the next transition never overtakes it.
      await (
        transition.phase === "start"
          ? f4.windows.start(transition.window)
          : f4.windows.end(transition.window)
      ).catch((error: unknown) =>
        logger.error(
          `SOAK window ${transition.window.id} ${transition.phase} failed: ${failureText(error)}`
        )
      );
    }
  }
  // Windows still open when the run ends are lifted, so nothing is left switched on.
  if (f4)
    for (const id of f4.windows.open) {
      const window = windowSpecs.find((entry) => entry.id === id);
      if (window) await f4.windows.end(window).catch(() => undefined);
    }
  if (!stop.signal.aborted) await clock.sleep(startedAtMs + durationMs - clock.now(), stop.signal);
  if (options.signal?.aborted && reason === "duration") reason = "signal";
  stop.abort();
  await collector;
  // Let what is running finish (it is bounded by its own deadline), but not forever.
  // An app that is quitting does not wait ten minutes for them.
  const settleMs = options.signal?.aborted
    ? Math.min(options.settleMs ?? 10 * minute, 30_000)
    : (options.settleMs ?? 10 * minute);
  const settle = new AbortController();
  await Promise.race([Promise.all(running.values()), clock.sleep(settleMs, settle.signal)]);
  settle.abort();
  await collect(true);
  const endedAt = clock.now();
  await writeFile(join(directory, soakFiles.meta), `${JSON.stringify(meta(endedAt), null, 2)}\n`);
  await Promise.all([samples.flush(), taskRuns.flush(), options.sink.flush?.()]);
  logger.info(
    `SOAK end (${reason}): ${counts.actions} actions, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.taskRuns} audited calls, ${counts.failedJobs} failed jobs`
  );
  return { reason, ...counts };
}

/** `AI lane remote:<id>: circuit breaker open -> half_open (reason)`, as the AI service logs it. */
export function parseBreakerLog(
  line: string,
  at: number
): Extract<SoakEvent, { type: "breaker" }> | null {
  const match = /AI lane (\S+): circuit breaker (\w+) -> (\w+) \((.*)\)/u.exec(line);
  if (!match) return null;
  return {
    type: "breaker",
    at: new Date(at).toISOString(),
    lane: match[1]!,
    from: match[2]!,
    to: match[3]!,
    reason: match[4]!.slice(0, 200)
  };
}
