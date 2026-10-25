import { gardenerBlockerClasses } from "@app/domain";
import { z } from "zod";

/**
 * The F4 part of a soak plan profile (T89, spec 5.4): what the 7-day Hybrid soak and its 5 h gate S
 * add to F3's day. A profile with an `f4` section runs the real Codex writer (`MEMORA_SOAK_REAL_WRITER`)
 * under a token budget (`codex.expected`, `codex.cap`, without which the driver refuses to run), with
 * faults injected in front of the Codex adapter at zero tokens, and with windows of known ground truth
 * the status sentence is checked against.
 */

const probability = z.number().min(0).max(1);

/** What the fetch layer in front of the Codex adapter injects into one request. */
export const fetchFaultKinds = [
  "rate_limit",
  "unavailable",
  "late_first_byte",
  "stall",
  "malformed",
  "unauthorized",
  "context_overflow"
] as const;
export type FetchFaultKind = (typeof fetchFaultKinds)[number];

const zeroRates = {
  rateLimit: 0,
  unavailable: 0,
  lateFirstByte: 0,
  stall: 0,
  malformed: 0,
  unauthorized: 0,
  contextOverflow: 0
};

/**
 * Per-request faults of the real Codex lane. Every kind but `stall` answers (or fails) without the
 * request ever reaching the provider, so it costs no token; a stall forwards the request, lets real
 * deltas through and then goes silent. Bodies are synthetic shapes built from our parser's patterns:
 * no real `usage_limit_reached` body is captured in the repository, and the report says so.
 */
export const fetchFaultPlanSchema = z
  .object({
    /** Per-request probabilities, drawn in this order from one number in [0, 1). */
    rates: z
      .object({
        rateLimit: probability.default(0),
        unavailable: probability.default(0),
        lateFirstByte: probability.default(0),
        stall: probability.default(0),
        malformed: probability.default(0),
        unauthorized: probability.default(0),
        contextOverflow: probability.default(0)
      })
      .strict()
      .default(zeroRates),
    /** `Retry-After` of an injected 429, in whole seconds, drawn from this inclusive range. */
    retryAfterSeconds: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .default([1, 10]),
    /** How long the answer stays silent after its real deltas (a stall), and before its first byte. */
    stallMs: z.number().int().positive().default(25_000),
    lateFirstByteMs: z.number().int().positive().default(35_000),
    /**
     * From `afterMinute` on, the next `count` generation requests all carry `kind`. With `aim:
     * "structured"` only a request of a structured caller counts (one that states an output
     * contract and repairs a refused answer, never a repair itself): a malformed answer needs one,
     * since a plain-text consumer (a summary) turns cut JSON into a partial summary and never repairs.
     */
    forced: z
      .array(
        z
          .object({
            kind: z.enum(fetchFaultKinds),
            afterMinute: z.number().nonnegative(),
            count: z.number().int().positive().max(20),
            aim: z.literal("structured").optional()
          })
          .strict()
      )
      .default([])
  })
  .strict();
export type FetchFaultPlan = z.infer<typeof fetchFaultPlanSchema>;

/**
 * What a window does. The first group is injected at the fetch layer of the Codex lane; the rest
 * are controls, caps, hooks and overrides the driver sets at the window's start and lifts at its
 * end (spec 5.4 "Windows with ground truth").
 */
export const soakWindowKinds = [
  "usage_limit",
  "refused",
  "enotfound",
  "unauthorized",
  "autonomy_off",
  "autonomy_suggest",
  "pause",
  "codex_daily_cap",
  "ranker_invalid",
  "embedder_verifying",
  "only_idle",
  "only_ac",
  "money",
  "harness_cap"
] as const;
export type SoakWindowKind = (typeof soakWindowKinds)[number];

/** The windows that change what the Codex lane's requests meet. */
export const fetchWindowKinds = ["usage_limit", "refused", "enotfound", "unauthorized"] as const;

const windowBase = {
  kind: z.enum(soakWindowKinds),
  durationMinutes: z.number().positive(),
  /** The status the product must show once the window has settled; absent: nothing to check. */
  expect: z
    .object({ class: z.enum(gardenerBlockerClasses), reason: z.string().min(1).max(64) })
    .strict()
    .optional(),
  /** Minutes the status gets to follow a start, and (by default the same) an end. */
  settleMinutes: z.number().nonnegative().default(2),
  settleEndMinutes: z.number().nonnegative().optional(),
  /**
   * Numbers a kind needs (`extraCalls`, `attempts`, `continueAfterMinutes`, `blockMinutes`) and the
   * load a window brings so its condition affects work (`backfillRelations`, `backfillDelayMinutes`,
   * `noteEdits`: see `WindowRunner.startWork`).
   */
  params: z.record(z.string().min(1).max(40), z.number()).default({})
};

export const soakWindowSchema = z
  .object({ id: z.string().min(1).max(40), startMinute: z.number().nonnegative(), ...windowBase })
  .strict();
export type SoakWindowSpec = z.infer<typeof soakWindowSchema>;

/** A window that repeats (the daily pause): the n-th one starts at `offsetMinutes + n * everyMinutes`. */
export const soakWindowSeriesSchema = z
  .object({
    idPrefix: z.string().min(1).max(30),
    everyMinutes: z.number().positive(),
    offsetMinutes: z.number().nonnegative(),
    ...windowBase
  })
  .strict();
export type SoakWindowSeries = z.infer<typeof soakWindowSeriesSchema>;

/** The tokens one action of each kind costs on the Codex lane (spec 5.4's table), for the projection. */
export const codexTokenPlanSchema = z
  .object({
    article: z.number().nonnegative(),
    typing_fault: z.number().nonnegative(),
    source_reimport: z.number().nonnegative(),
    ask: z.number().nonnegative(),
    explain: z.number().nonnegative(),
    explain_burst: z.number().nonnegative(),
    topic_open: z.number().nonnegative(),
    note_edit: z.number().nonnegative(),
    burst_edit: z.number().nonnegative(),
    contention_burst: z.number().nonnegative(),
    /** Work nobody schedules (REFRESH, backfill, naming, stalls), spread over every hour. */
    backgroundPerHour: z.number().nonnegative()
  })
  .strict();
export type CodexTokenPlan = z.infer<typeof codexTokenPlanSchema>;

export const soakF4Schema = z
  .object({
    codex: z
      .object({
        /** Expected tokens over the run; provisional until gate S re-freezes it (T91). */
        expected: z.number().int().positive(),
        /** The harness cap, enforced by reservation; the driver refuses to run without it. */
        cap: z.number().int().positive(),
        /** Drop steps applied from hour 0 (gate S's re-projection exceeded the ceiling). */
        dropFromHour0: z.number().int().min(0).max(5).default(0),
        tokens: codexTokenPlanSchema,
        /** Windows during which the planned remote tokens of an hour are scaled (usage limit: none). */
        windowTokenFactor: z
          .partialRecord(z.enum(soakWindowKinds), z.number().min(0).max(1))
          .default({})
      })
      .strict(),
    /** Faults in front of the Codex adapter; absent: none are injected. */
    injection: fetchFaultPlanSchema.optional(),
    windows: z.array(soakWindowSchema).default([]),
    windowSeries: z.array(soakWindowSeriesSchema).default([]),
    /** The priced loopback fake of the money window (a priced OpenAI-compatible route, US$ per million tokens). */
    money: z
      .object({
        model: z.string().min(1).max(60).default("dev-fake-priced-1"),
        inputUsdPerM: z.number().positive().default(1),
        outputUsdPerM: z.number().positive().default(4),
        latencyMs: z.number().int().nonnegative().default(1_200)
      })
      .strict()
      .optional(),
    /** Whether the Decisions decider may run (`MEMORA_SOAK_ADMIT_DECISIONS`); the 7-day soak keeps it off. */
    decisions: z.enum(["off", "admitted"]).default("off"),
    /**
     * `answers`: the start turns debug mode and full capture on in the profile, so
     * `monitoring_operations` keeps each answer (`soak-capture.ts`). The owner confirmed that
     * retention for gate S's profile only (10-25): `soak7-gate` alone sets it, and the run is
     * refused on any other profile folder. Absent: the library must have full capture off.
     */
    capture: z.literal("answers").optional()
  })
  .strict();
export type SoakF4Plan = z.infer<typeof soakF4Schema>;

/** The windows of a profile with the series expanded, in start order, ids unique. */
export function expandWindows(plan: SoakF4Plan, durationMinutes: number): SoakWindowSpec[] {
  const windows: SoakWindowSpec[] = [...plan.windows];
  for (const series of plan.windowSeries) {
    const { idPrefix, everyMinutes, offsetMinutes, ...base } = series;
    for (let index = 0; ; index += 1) {
      const startMinute = offsetMinutes + index * everyMinutes;
      if (startMinute >= durationMinutes) break;
      windows.push({ ...base, id: `${idPrefix}-${index + 1}`, startMinute });
    }
  }
  const ids = new Set<string>();
  for (const window of windows) {
    if (ids.has(window.id)) throw new Error(`duplicate soak window id ${window.id}`);
    ids.add(window.id);
  }
  return windows.toSorted((a, b) => a.startMinute - b.startMinute || a.id.localeCompare(b.id));
}
