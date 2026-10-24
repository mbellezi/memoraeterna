import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

/**
 * What a soak run writes into `.cache/f3/soak/<run>/` (F4: `<data root>/f4/soak/<run>/`) and what
 * `scripts/soak/report.ts` reads back
 * (F3 T62, spec 5.9). Everything is newline-delimited JSON except `meta.json`, so a 24 h run can be
 * read while it goes on and a crash loses at most the last line. The records carry counts, timings
 * and error classes; never prompts, answers or library text.
 */

export const soakRunFormat = "memora-soak-run";

/** The files of a run directory. */
export const soakFiles = {
  meta: "meta.json",
  events: "events.ndjson",
  samples: "samples.ndjson",
  taskRuns: "task-runs.ndjson",
  stop: "STOP"
} as const;

const iso = z.string().datetime();
const milliseconds = z.number().int().nonnegative();

/** What a fake remote provider injects into one request (the per-request fault kinds). */
export const remoteFaultKinds = [
  "rate_limit",
  "unavailable",
  "stall",
  "late_first_byte",
  "malformed"
] as const;
export type RemoteFaultKind = (typeof remoteFaultKinds)[number];

/**
 * What the fetch layer in front of the real Codex adapter injects (F4 T89): the per-request kinds of
 * `fetchFaultKinds` and the windows that answer every request (a usage limit, a refused connection,
 * an unknown host, a rejected sign-in). Only a `stall` forwards the request to the provider.
 */
export const injectedExchangeKinds = [
  "none",
  ...remoteFaultKinds,
  "slow",
  "unauthorized",
  "context_overflow",
  "usage_limit",
  "refused",
  "enotfound"
] as const;
export type InjectedExchangeKind = (typeof injectedExchangeKinds)[number];

/** The marker every injected exchange carries, in its record and in the error text a caller meets. */
export const injectedTag = "soak-injected";

/** Time windows of a fake: it refuses connections (`outage`) or answers 10x slower (`slow`). */
export const faultWindowKinds = ["outage", "slow"] as const;
export type FaultWindowKind = (typeof faultWindowKinds)[number];

/** Faults of the local side the driver injects. */
export const localFaultKinds = ["mlx_kill", "gguf_abort", "typing_failure"] as const;
export type LocalFaultKind = (typeof localFaultKinds)[number];

/** What the driver does on its timeline. */
export const soakActionKinds = [
  "article",
  "ask",
  "explain",
  "explain_burst",
  "note_edit",
  "source_reimport",
  "typing_fault",
  "post_outage_probe",
  "topic_open",
  "contention_burst",
  "burst_edit"
] as const;
export type SoakActionKind = (typeof soakActionKinds)[number];

/** One request a fake provider served: how it ended and which fault, if any, it carried. */
const exchangeRecord = z
  .object({
    type: z.literal("exchange"),
    provider: z.string().min(1),
    seq: z.number().int().positive(),
    startedAt: iso,
    endedAt: iso,
    /** `none`: served normally. */
    kind: z.enum(injectedExchangeKinds),
    injected: z.boolean(),
    status: z.number().int(),
    /** How the exchange ended: the body was written whole, the client left, or the fake was stopped. */
    outcome: z.enum(["completed", "client_closed", "server_stopped"]),
    /** From the request to the client leaving; null when the client did not leave. */
    closedAfterMs: milliseconds.nullable(),
    /** From the last body write (or the headers) to the client leaving; null when it did not leave. */
    closedAfterLastWriteMs: milliseconds.nullable(),
    retryAfterSeconds: z.number().int().nonnegative().nullable(),
    /** Total time the fake planned for the body (before any fault), for the latency check. */
    plannedMs: milliseconds.nullable(),
    /**
     * Fetch layer (F4): the bytes of the request body forwarded to the provider; 0 for every
     * injected exchange but a stall, which the report asserts.
     */
    forwardedBytes: milliseconds.optional(),
    /** The reply was built by the harness from our parser's patterns, not recorded from a provider. */
    synthetic: z.boolean().optional(),
    /** `soak-injected` on every exchange the fetch layer injected. */
    tag: z.literal(injectedTag).optional(),
    /** The window that caused it, when one did. */
    window: z.string().max(40).optional()
  })
  .strict();

/** A window of an outage or of slow answers on a fake. */
const windowRecord = z
  .object({
    type: z.literal("window"),
    provider: z.string().min(1),
    kind: z.enum(faultWindowKinds),
    startedAt: iso,
    endedAt: iso,
    factor: z.number().positive().nullable()
  })
  .strict();

/** A fault the driver injected on the local side. */
const localFaultRecord = z
  .object({
    type: z.literal("local"),
    kind: z.enum(localFaultKinds),
    at: iso,
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({})
  })
  .strict();

/** One thing the driver did, and how it went. */
const actionRecord = z
  .object({
    type: z.literal("action"),
    kind: z.enum(soakActionKinds),
    index: z.number().int().nonnegative(),
    scheduledAt: iso,
    startedAt: iso,
    durationMs: milliseconds,
    status: z.enum(["ok", "failed", "skipped"]),
    /** Plain facts about the action (counts, outcomes, error classes). */
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({}),
    error: z.string().max(400).optional()
  })
  .strict();

/** A ground-truth window starting or ending (F4): what the status sentence must show meanwhile. */
const groundTruthRecord = z
  .object({
    type: z.literal("ground_truth"),
    id: z.string().min(1).max(40),
    kind: z.string().min(1).max(40),
    phase: z.enum(["start", "end"]),
    at: iso,
    /** The status the product must show once `settleUntil` has passed; absent: nothing to check. */
    expect: z
      .object({ class: z.string().min(1).max(20), reason: z.string().min(1).max(64) })
      .strict()
      .optional(),
    /** The status gets until here to follow this transition. */
    settleUntil: iso,
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({})
  })
  .strict();

/** The harness token cap moving (F4): set, lowered, a call refused, or exhausted. */
const capRecord = z
  .object({
    type: z.literal("cap"),
    at: iso,
    action: z.enum(["set", "lower", "refused", "exhausted"]),
    capTokens: z.number().int().nonnegative(),
    spentTokens: z.number().int().nonnegative(),
    reservedTokens: z.number().int().nonnegative(),
    detail: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
      .default({})
  })
  .strict();

/** A pre-registered drop step applied (F4 spec 5.4): never reverted. */
const dropStepRecord = z
  .object({
    type: z.literal("drop_step"),
    at: iso,
    step: z.number().int().min(1).max(5),
    spentTokens: z.number().int().nonnegative(),
    projectedTokens: z.number().int().nonnegative(),
    capTokens: z.number().int().nonnegative(),
    note: z.string().max(200).optional()
  })
  .strict();

/** A job that reached a final state (F4 E3): the collector writes one record per terminal job. */
const jobDoneRecord = z
  .object({
    type: z.literal("job_done"),
    id: z.string().min(1),
    jobType: z.string().min(1),
    lane: z.string().min(1),
    status: z.enum(["succeeded", "failed", "canceled"]),
    /** `done`, `no_change` or `skipped` on a succeeded job; null before 0060 (legacy) and on the others. */
    outcome: z.string().nullable(),
    scopeKey: z.string().nullable(),
    subjectKey: z.string().nullable(),
    attempts: z.number().int().nonnegative(),
    createdAt: iso,
    finishedAt: iso.nullable(),
    quarantinedAt: iso.nullable(),
    /** The `result.status` the job kept (a pending review counts as completed). */
    resultStatus: z.string().max(60).nullable(),
    /** The content-only fingerprint the job ran with (E2's inputs are kind, subject and fingerprint). */
    inputFingerprint: z.string().max(200).nullable().optional(),
    /**
     * Why a canceled job was canceled (E3 counts only a supersession as completed): `merged` into a
     * queued duplicate (`result.mergedInto`, D7), `source_deleted` (its source is gone), else
     * `requested`. Null on the other statuses; absent in records written before it.
     */
    cancelCause: z.enum(["merged", "source_deleted", "requested"]).nullable().optional()
  })
  .strict();

/** A (kind, subject) outcome row that changed (F4 E2): consecutive failures and quarantine. */
const outcomeRecord = z
  .object({
    type: z.literal("outcome"),
    at: iso,
    kind: z.string().min(1),
    subjectKey: z.string().min(1),
    lastOutcome: z.string().min(1),
    lastFingerprint: z.string().nullable(),
    failedFingerprint: z.string().nullable(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastErrorClass: z.string().max(200).nullable(),
    quarantinedAt: iso.nullable()
  })
  .strict();

/** A circuit breaker moving, read from the AI service's log line. */
const breakerRecord = z
  .object({
    type: z.literal("breaker"),
    at: iso,
    lane: z.string().min(1),
    from: z.string().min(1),
    to: z.string().min(1),
    reason: z.string().max(200)
  })
  .strict();

/**
 * A job that ended `failed`, read from the jobs table by the collector. The audit rows only cover
 * AI calls: a job can fail with no failed call (an output refused after its repair, a worker that
 * crashed), and the failure audit needs it as well.
 */
export const jobFailureSchema = z
  .object({
    id: z.string().min(1),
    jobType: z.string().min(1),
    lane: z.string().min(1),
    /** When the job was marked failed. */
    at: iso,
    attempts: z.number().int().nonnegative(),
    /** The source the job works on, when its payload names one. */
    sourceItemId: z.string().nullable(),
    /** The error code or message the job kept, cut to 200 characters. */
    error: z.string().max(200).nullable()
  })
  .strict();
export type JobFailureRecord = z.infer<typeof jobFailureSchema>;

const jobFailureRecord = jobFailureSchema.extend({ type: z.literal("job_failure") }).strict();

export const jobDoneSchema = jobDoneRecord;
export const outcomeSchema = outcomeRecord;

export const soakEventSchema = z.discriminatedUnion("type", [
  exchangeRecord,
  windowRecord,
  localFaultRecord,
  actionRecord,
  breakerRecord,
  jobFailureRecord,
  groundTruthRecord,
  capRecord,
  dropStepRecord,
  jobDoneRecord,
  outcomeRecord
]);
export type SoakEvent = z.infer<typeof soakEventSchema>;
export type ExchangeRecord = z.infer<typeof exchangeRecord>;
export type WindowRecord = z.infer<typeof windowRecord>;
export type LocalFaultRecord = z.infer<typeof localFaultRecord>;
export type ActionRecord = z.infer<typeof actionRecord>;
export type BreakerRecord = z.infer<typeof breakerRecord>;
export type JobFailureEvent = z.infer<typeof jobFailureRecord>;
export type GroundTruthRecord = z.infer<typeof groundTruthRecord>;
export type CapRecord = z.infer<typeof capRecord>;
export type DropStepRecord = z.infer<typeof dropStepRecord>;
export type JobDoneRecord = z.infer<typeof jobDoneRecord>;
export type OutcomeRecord = z.infer<typeof outcomeRecord>;

const laneSample = z
  .object({
    lane: z.string(),
    limit: z.number(),
    running: z.number(),
    held: z.number(),
    waiting: z.object({ P0: z.number(), P1: z.number(), P2: z.number(), P3: z.number() }),
    rateLimits: z.number(),
    breaker: z.string().nullable(),
    /** Milliseconds the lane is paused by a rate limit (F4; absent from older samples). */
    pausedForMs: z.number().nullable().optional()
  })
  .strict();

/** One job worker at the sample (F4 E1): idle, executing a call, or holding a task that waits. */
export const workerStateSchema = z
  .object({
    worker: z.string().min(1),
    state: z.enum(["idle", "executing", "waiting"]),
    /** Why a held task is not executing: a pause, a lane permit, a retry backoff. */
    why: z.enum(["pause", "permit", "retry", "breaker"]).optional(),
    jobId: z.string().optional(),
    scopeKey: z.string().nullable().optional()
  })
  .strict();
export type WorkerState = z.infer<typeof workerStateSchema>;

const sampleDetail = {
  /** The Gardener's status sentence as the status service snapshots it (T86, spec 3.8). */
  status: z
    .object({
      state: z.string().min(1),
      class: z.string().optional(),
      reason: z.string().optional(),
      params: z.record(z.string(), z.unknown()).optional(),
      coverage: z.record(z.string(), z.number()).optional(),
      eta: z.unknown().optional(),
      action: z.string().optional(),
      /** The sentence is the generic one, not a (class, reason) key. */
      fallback: z.boolean().optional()
    })
    .strict()
    .nullable()
    .optional(),
  workers: z.array(workerStateSchema).optional(),
  /** The harness token cap (F4): cumulative Codex tokens, in-flight reservations, the cap itself. */
  cap: z
    .object({
      capTokens: z.number().int().nonnegative(),
      spentTokens: z.number().int().nonnegative(),
      reservedTokens: z.number().int().nonnegative(),
      calls: z.number().int().nonnegative(),
      refusals: z.number().int().nonnegative(),
      largestCallTokens: z.number().int().nonnegative()
    })
    .strict()
    .nullable()
    .optional(),
  /** The RemoteBudget's meters (money on priced routes, calls on the subscription route). */
  budget: z
    .object({
      moneyState: z.string(),
      spentUsd: z.number(),
      reservedUsd: z.number(),
      capUsd: z.number(),
      callsState: z.string(),
      usedCalls: z.number().int(),
      reservedCalls: z.number().int(),
      capCalls: z.number().int()
    })
    .strict()
    .nullable()
    .optional(),
  controls: z
    .object({
      autonomy: z.string(),
      paused: z.boolean(),
      onlyIdle: z.boolean(),
      onlyOnAc: z.boolean(),
      monthlyCapUsd: z.number()
    })
    .strict()
    .nullable()
    .optional(),
  power: z
    .object({
      active: z.boolean(),
      onBattery: z.boolean(),
      overridden: z.boolean(),
      /** PowerSignals' reading carries the idle time too (T75); the sample keeps it. */
      idleMs: z.number().nonnegative().optional()
    })
    .strict()
    .nullable()
    .optional(),
  /** Ungranted locks and how long the longest has waited (F4 E1's `pg_locks` arm). */
  lockWaits: z
    .object({ waiting: z.number().int().nonnegative(), longestMs: z.number().nonnegative() })
    .strict()
    .nullable()
    .optional(),
  /** The machine's load, for telling agent contention from a product defect (D2, D38). */
  load: z
    .object({
      loadAverage: z.tuple([z.number(), z.number(), z.number()]),
      memoryPressure: z.enum(["normal", "warn", "critical"]).nullable(),
      memoryFreePercent: z.number().nullable(),
      top: z.array(
        z
          .object({ command: z.string().max(80), cpuPercent: z.number(), rssMb: z.number() })
          .strict()
      )
    })
    .strict()
    .nullable()
    .optional()
};

const jobSample = z
  .object({
    id: z.string(),
    type: z.string(),
    lane: z.string(),
    status: z.string(),
    /** The source the job works on, when its payload names one. */
    sourceItemId: z.string().nullable(),
    attempts: z.number().int(),
    /** Epoch ms of the last change of the row (progress, claim, retry). */
    updatedAt: z.number(),
    runAfter: z.number(),
    lockedAt: z.number().nullable(),
    /** Epoch ms the job was created (F4 E3: a task still waiting after 24 h). */
    createdAt: z.number().optional(),
    /**
     * The job's scope (F4 D6) and the blocker that set it aside (D5, D7); E1 reads them. Absent
     * from samples recorded before 0060.
     */
    scopeKey: z.string().nullable().optional(),
    blockedClass: z.string().nullable().optional(),
    blockedReason: z.string().nullable().optional()
  })
  .strict();

/** What the collector reads every minute. */
export const soakSampleSchema = z
  .object({
    at: iso,
    elapsedMs: milliseconds,
    lanes: z.array(laneSample),
    /** Jobs that are queued or running at the sample, newest information only. */
    jobs: z.array(jobSample),
    jobCounts: z.record(z.string(), z.number().int()),
    helper: z
      .object({
        pid: z.number().int().nullable(),
        rssMb: z.number().nullable(),
        spawnCount: z.number().int()
      })
      .strict()
      .nullable(),
    appRssMb: z.number(),
    /** Cumulative pageouts of the machine (`vm_stat`), in pages; null when unreadable. */
    pageouts: z.number().nullable(),
    pageSizeBytes: z.number().int().nullable(),
    eventLoopLagP99Ms: z.number().nullable(),
    dbPool: z
      .object({ total: z.number(), idle: z.number(), waiting: z.number() })
      .strict()
      .nullable(),
    ...sampleDetail
  })
  .strict();
export type SoakSample = z.infer<typeof soakSampleSchema>;

/** The audit columns of `ai_task_runs` the report needs (0057 included), one per call. */
export const taskRunRecordSchema = z
  .object({
    id: z.string(),
    taskType: z.string(),
    provider: z.string(),
    modelId: z.string(),
    runtime: z.string(),
    workloadClass: z.string().nullable(),
    lane: z.string().nullable(),
    priority: z.number().int().nullable(),
    deadlineMs: z.number().int().nullable(),
    deadlineOutcome: z.string().nullable(),
    isRepair: z.boolean(),
    schemaMode: z.string().nullable(),
    retryWaitMs: z.number().int().nullable(),
    requeueMs: z.number().int().nullable(),
    queueMs: z.number().int().nullable(),
    durationMs: z.number().int(),
    attempt: z.number().int().nullable(),
    status: z.string(),
    /** The redacted error text, cut to 300 characters. */
    error: z.string().max(300).nullable(),
    startedAt: iso,
    finishedAt: iso.nullable(),
    /** The tokens the provider reported (F4 E4, the token budget); null when it reported none. */
    inputTokens: z.number().int().nonnegative().nullable().optional(),
    outputTokens: z.number().int().nonnegative().nullable().optional(),
    /** Who the call spent for (`user`, `background`, `interactive`); null on rows before 0061. */
    budgetClass: z.string().nullable().optional(),
    jobId: z.string().nullable().optional(),
    /** The US$ estimate the monthly ledger counts beyond the reported tokens (0061). */
    budgetEstimateUsd: z.number().nullable().optional()
  })
  .strict();
export type TaskRunRecord = z.infer<typeof taskRunRecordSchema>;

/** The run's identity and settings, written at the start and completed at the end. */
export const soakMetaSchema = z
  .object({
    format: z.literal(soakRunFormat),
    version: z.literal(1),
    run: z.string().min(1),
    profile: z.string().min(1),
    seed: z.number().int(),
    startedAt: iso,
    endedAt: iso.nullable(),
    endReason: z.enum(["duration", "stop_file", "signal", "error", "token_cap"]).nullable(),
    durationMs: z.number().int().positive(),
    warmupMs: milliseconds,
    sampleIntervalMs: z.number().int().positive(),
    host: z.object({ platform: z.string(), arch: z.string(), totalMemoryMb: z.number() }).strict(),
    /** The catalog-header catch-up policy the run kept (product behaviour: on). */
    catalogHeader: z.object({ refresh: z.string(), reason: z.string().nullable() }).strict(),
    /** The deadline bounds the fakes are checked against (the adapters' runtime configuration). */
    bounds: z
      .object({ connectMs: z.number(), firstByteMs: z.number(), stallMs: z.number() })
      .strict(),
    /** The fake providers: their name, the lane their calls take and where they listened. */
    providers: z.array(
      z
        .object({
          provider: z.string(),
          providerConfigId: z.string().nullable(),
          baseUrl: z.string()
        })
        .strict()
    ),
    /** The plan profile as the run used it. */
    plan: z.unknown(),
    /**
     * The relations configuration the run kept (F4 C2): the effective source discovery neighbours
     * (the knob that sets them is refused in a soak), the note decider's mode as stored (null: none
     * stored, the routes derive it) and the source judge's mode with its pair cap (F4 D21; absent
     * in runs recorded before it).
     */
    relations: z
      .object({
        discoveryNeighbours: z.number().int().min(1).max(2),
        judgeMode: z.string().nullable(),
        sourceJudge: z
          .object({
            mode: z.enum(["perRoot", "perPair"]),
            maxPairsPerCall: z.number().int().positive()
          })
          .strict()
          .optional()
      })
      .strict()
      .optional(),
    /** Where the run read and wrote: the data root `MEMORA_SOAK_DATA_ROOT` named, else null. */
    dataRoot: z.string().nullable().optional(),
    /** The Codex configuration of the real writer (F4), whose lane the injection ledger names. */
    realWriter: z
      .object({
        providerConfigId: z.string(),
        provider: z.string(),
        modelId: z.string().nullable()
      })
      .strict()
      .nullable()
      .optional(),
    /** The Decisions decider's admission (decision 32's remote check); absent: it was off. */
    decisions: z
      .object({ admitted: z.boolean(), capUsd: z.number().nullable() })
      .strict()
      .optional(),
    /** The F4 harness's frozen numbers and the predicate versions the report evaluated. */
    f4: z
      .object({
        codex: z
          .object({
            expected: z.number().int(),
            cap: z.number().int(),
            dropFromHour0: z.number().int()
          })
          .strict(),
        /** The windows of the run as the driver played them (ground truth), by id. */
        windows: z.array(
          z
            .object({
              id: z.string(),
              kind: z.string(),
              startMinute: z.number(),
              durationMinutes: z.number(),
              expect: z.object({ class: z.string(), reason: z.string() }).strict().optional(),
              settleMinutes: z.number(),
              settleEndMinutes: z.number()
            })
            .strict()
        ),
        /** Version of each predicate the report evaluates (E1 worker states, E5 fallback...). */
        predicates: z.record(z.string(), z.number().int())
      })
      .strict()
      .optional()
  })
  .strict();
export type SoakMeta = z.infer<typeof soakMetaSchema>;

/** Where the fakes, the driver and the collector append their records. */
export interface SoakEventSink {
  append(event: SoakEvent): void;
}

/** A sink that keeps the records in memory (tests). */
export class MemoryEventSink implements SoakEventSink {
  public readonly events: SoakEvent[] = [];

  public append(event: SoakEvent): void {
    this.events.push(soakEventSchema.parse(event));
  }
}

/**
 * Appends records to a newline-delimited JSON file, in order, one write at a time. A failed write
 * is kept for `flush` to report; it never throws into the exchange that produced the record.
 */
export class NdjsonFile<T> {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown;

  public constructor(
    private readonly path: string,
    private readonly parse: (value: T) => T = (value) => value
  ) {}

  public append(record: T): void {
    const line = `${JSON.stringify(this.parse(record))}\n`;
    this.tail = this.tail
      .then(async () => {
        await mkdir(dirname(this.path), { recursive: true });
        await appendFile(this.path, line);
      })
      .catch((error: unknown) => {
        this.failure ??= error;
      });
  }

  /** Waits for the records appended so far; throws the first write failure, once. */
  public async flush(): Promise<void> {
    await this.tail;
    if (this.failure !== undefined) {
      const failure = this.failure;
      this.failure = undefined;
      throw failure;
    }
  }
}

/** The event sink of a run directory. */
export function fileEventSink(path: string): SoakEventSink & { flush(): Promise<void> } {
  const file = new NdjsonFile<SoakEvent>(path, (event) => soakEventSchema.parse(event));
  return { append: (event) => file.append(event), flush: () => file.flush() };
}

/** Parses newline-delimited JSON; blank lines are skipped, and a bad line is counted, not thrown. */
export function parseNdjson<T>(
  text: string,
  schema: z.ZodType<T>
): { records: T[]; invalid: number } {
  const records: T[] = [];
  let invalid = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = schema.safeParse(JSON.parse(line));
      if (parsed.success) records.push(parsed.data);
      else invalid += 1;
    } catch {
      invalid += 1;
    }
  }
  return { records, invalid };
}
