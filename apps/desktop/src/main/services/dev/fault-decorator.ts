import { z } from "zod";

import {
  seededUnit,
  type FakeCallContext,
  type FakeHttpRequest,
  type FakeProviderKind,
  type FakeWindow,
  type ReplyScript
} from "./fake-remote-core.js";
import { faultWindowKinds, remoteFaultKinds, type RemoteFaultKind } from "./soak-records.js";

/**
 * The fault decorator of the soak's fake remote providers (F3 R6, T62, spec 5.9). `withFaults`
 * wraps any `FakeProviderKind` and adds, to its generation replies only, the faults of a plan:
 * a 429 with `Retry-After`, a 503, a stall in the middle of the answer, a first byte that comes
 * late, a malformed answer, and (through the plan's windows, played by the server) an outage and
 * answers ten times slower. The wrapped kind never knows: a third remote kind (the Decisions API,
 * plan decision 30) gets the same faults, ledger and report by being wrapped the same way.
 *
 * The schedule is a function of the seed, the provider and the request's number, never of timing or
 * concurrency: the same seed gives the same faults on the same requests. Forced faults (a burst of
 * the same fault on the next requests once a moment has passed) guarantee that a short run, such as
 * the 4 h pre-soak, sees every kind end a whole call, not only a single attempt.
 */

const probability = z.number().min(0).max(1);

export const faultPlanSchema = z
  .object({
    /** Per-request probabilities, drawn in this order from one number in [0, 1). */
    rates: z
      .object({
        rateLimit: probability.default(0),
        unavailable: probability.default(0),
        stall: probability.default(0),
        lateFirstByte: probability.default(0),
        malformed: probability.default(0)
      })
      .strict()
      .default({ rateLimit: 0, unavailable: 0, stall: 0, lateFirstByte: 0, malformed: 0 }),
    /** `Retry-After` of an injected 429, in whole seconds, drawn from this inclusive range. */
    retryAfterSeconds: z
      .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
      .default([1, 10]),
    /** How long the answer stays silent after its first text (a stall), and before its first byte. */
    stallMs: z.number().int().positive().default(25_000),
    lateFirstByteMs: z.number().int().positive().default(35_000),
    /** Outage (connection refused) and slow answers, in minutes from the start of the fake. */
    windows: z
      .array(
        z
          .object({
            kind: z.enum(faultWindowKinds),
            startMinute: z.number().nonnegative(),
            durationMinutes: z.number().positive(),
            /** Latency multiplier of a `slow` window. */
            factor: z.number().positive().default(10)
          })
          .strict()
      )
      .default([]),
    /** From `afterMinute` on, the next `count` generation requests all carry `kind`. */
    forced: z
      .array(
        z
          .object({
            kind: z.enum(remoteFaultKinds),
            afterMinute: z.number().nonnegative(),
            count: z.number().int().positive().max(20)
          })
          .strict()
      )
      .default([])
  })
  .strict();
export type FaultPlan = z.infer<typeof faultPlanSchema>;
export type FaultPlanInput = z.input<typeof faultPlanSchema>;

/** The fault a request carries. */
export interface RequestFault {
  kind: RemoteFaultKind;
  /** Whole seconds of a 429's `Retry-After`. */
  retryAfterSeconds?: number;
  forced: boolean;
}

const rateOrder = [
  ["rateLimit", "rate_limit"],
  ["unavailable", "unavailable"],
  ["stall", "stall"],
  ["lateFirstByte", "late_first_byte"],
  ["malformed", "malformed"]
] as const satisfies ReadonlyArray<readonly [keyof FaultPlan["rates"], RemoteFaultKind]>;

/** The faults of one provider, drawn from a seed. */
export class FaultSchedule {
  private readonly forcedLeft: number[];

  public constructor(
    public readonly plan: FaultPlan,
    private readonly seed: number,
    private readonly provider: string
  ) {
    this.forcedLeft = plan.forced.map((entry) => entry.count);
  }

  /**
   * The fault of the `seq`-th generation request (1-based), `elapsedMs` after the fake started.
   * Forced faults come first, in the order of the plan; the random ones depend on the seed, the
   * provider and `seq` only.
   */
  public requestFault(seq: number, elapsedMs: number): RequestFault | null {
    for (const [index, entry] of this.plan.forced.entries()) {
      if (elapsedMs < entry.afterMinute * 60_000 || this.forcedLeft[index]! <= 0) continue;
      this.forcedLeft[index]! -= 1;
      return {
        kind: entry.kind,
        forced: true,
        ...(entry.kind === "rate_limit" ? { retryAfterSeconds: this.retryAfter(seq) } : {})
      };
    }
    const draw = seededUnit(this.seed, this.provider, seq, "fault");
    let threshold = 0;
    for (const [rate, kind] of rateOrder) {
      threshold += this.plan.rates[rate];
      if (draw < threshold)
        return {
          kind,
          forced: false,
          ...(kind === "rate_limit" ? { retryAfterSeconds: this.retryAfter(seq) } : {})
        };
    }
    return null;
  }

  /** The random faults of the first `count` requests: the same on every call (audits and tests). */
  public preview(count: number): Array<RequestFault | null> {
    const copy = new FaultSchedule({ ...this.plan, forced: [] }, this.seed, this.provider);
    return Array.from({ length: count }, (_, index) => copy.requestFault(index + 1, 0));
  }

  /** The latency multiplier at `elapsedMs`: the factor of the `slow` window it falls in, else 1. */
  public slowFactor(elapsedMs: number): number {
    for (const window of this.plan.windows) {
      if (window.kind !== "slow") continue;
      const start = window.startMinute * 60_000;
      if (elapsedMs >= start && elapsedMs < start + window.durationMinutes * 60_000)
        return window.factor;
    }
    return 1;
  }

  /** The plan's windows in the server's terms. */
  public windows(): FakeWindow[] {
    return this.plan.windows.map((window) => ({
      kind: window.kind,
      startMs: Math.round(window.startMinute * 60_000),
      durationMs: Math.round(window.durationMinutes * 60_000),
      factor: window.factor
    }));
  }

  private retryAfter(seq: number): number {
    const [low, high] = this.plan.retryAfterSeconds;
    const [from, to] = low <= high ? [low, high] : [high, low];
    return (
      from + Math.floor(seededUnit(this.seed, this.provider, seq, "retry-after") * (to - from + 1))
    );
  }
}

/** A reply script with every wait stretched by `factor`. */
function slowed(script: ReplyScript, factor: number): ReplyScript {
  return {
    ...script,
    parts: script.parts.map((part) => ({ ...part, delayMs: Math.round(part.delayMs * factor) }))
  };
}

/** Index of the part after which a stall is injected: the second piece of text, else the last. */
function stallIndex(script: ReplyScript): number {
  const texts = script.parts.flatMap((part, index) => (part.text ? [index] : []));
  return texts[1] ?? texts[0] ?? script.parts.length - 1;
}

/**
 * Wraps a kind so that its generation replies carry the plan's faults. Replies to other routes
 * (model lists) pass through. The `tag` of a faulted reply says which fault it carries, and the
 * server writes it into the exchange record.
 */
export function withFaults(kind: FakeProviderKind, schedule: FaultSchedule): FakeProviderKind {
  const { plan } = schedule;
  return {
    ...kind,
    reply(request: FakeHttpRequest, context: FakeCallContext): ReplyScript {
      const base = kind.reply(request, context);
      if (!kind.isGeneration(request)) return base;
      const fault = schedule.requestFault(context.seq, context.elapsedMs);
      if (fault === null) {
        const factor = schedule.slowFactor(context.elapsedMs);
        if (factor === 1) return base;
        return { ...slowed(base, factor), tag: { kind: "slow", injected: true } };
      }
      const tag = (extra: Partial<NonNullable<ReplyScript["tag"]>> = {}) => ({
        kind: fault.kind,
        injected: true,
        ...extra
      });
      switch (fault.kind) {
        case "rate_limit":
          return {
            ...kind.rateLimited(fault.retryAfterSeconds ?? 1),
            tag: tag({ retryAfterSeconds: fault.retryAfterSeconds ?? 1 })
          };
        case "unavailable":
          return { ...kind.unavailable(), tag: tag() };
        case "malformed":
          return {
            ...kind.replyWithText(request, context, kind.malformedText(request, context)),
            tag: tag()
          };
        case "late_first_byte": {
          const [first, ...rest] = base.parts;
          if (!first) return { ...base, tag: tag() };
          return {
            ...base,
            parts: [{ ...first, delayMs: first.delayMs + plan.lateFirstByteMs }, ...rest],
            tag: tag()
          };
        }
        case "stall": {
          // The silence comes after the piece at `index`, before the next one (or before the end).
          const index = stallIndex(base);
          const parts = base.parts.map((part, at) =>
            at === index + 1 ? { ...part, delayMs: part.delayMs + plan.stallMs } : part
          );
          if (index + 1 >= parts.length) parts.push({ delayMs: plan.stallMs, data: "" });
          return { ...base, parts, tag: tag() };
        }
      }
    }
  };
}
