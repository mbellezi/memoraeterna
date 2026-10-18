import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

/**
 * What a soak run writes into `.cache/f3/soak/<run>/` and what `scripts/soak/report.ts` reads back
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
  "post_outage_probe"
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
    kind: z.enum(["none", ...remoteFaultKinds, "slow"]),
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
    plannedMs: milliseconds.nullable()
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

export const soakEventSchema = z.discriminatedUnion("type", [
  exchangeRecord,
  windowRecord,
  localFaultRecord,
  actionRecord,
  breakerRecord,
  jobFailureRecord
]);
export type SoakEvent = z.infer<typeof soakEventSchema>;
export type ExchangeRecord = z.infer<typeof exchangeRecord>;
export type WindowRecord = z.infer<typeof windowRecord>;
export type LocalFaultRecord = z.infer<typeof localFaultRecord>;
export type ActionRecord = z.infer<typeof actionRecord>;
export type BreakerRecord = z.infer<typeof breakerRecord>;
export type JobFailureEvent = z.infer<typeof jobFailureRecord>;

const laneSample = z
  .object({
    lane: z.string(),
    limit: z.number(),
    running: z.number(),
    held: z.number(),
    waiting: z.object({ P0: z.number(), P1: z.number(), P2: z.number(), P3: z.number() }),
    rateLimits: z.number(),
    breaker: z.string().nullable()
  })
  .strict();

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
    lockedAt: z.number().nullable()
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
      .nullable()
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
    finishedAt: iso.nullable()
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
    endReason: z.enum(["duration", "stop_file", "signal", "error"]).nullable(),
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
    plan: z.unknown()
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
