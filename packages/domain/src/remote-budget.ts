// The RemoteBudget's typed configuration and its pure arithmetic (F4 D14, T76; spec 3.3). Background
// remote attempts reserve before they start: priced routes in US$ against the user's monthly cap
// (a pause at its warning share until the user continues, local-only at 100%), subscription routes
// (Codex OAuth) one call each against a daily background call cap. Interactive (P0) and user-started
// work is counted and never refused. The service that keeps the ledger lives in the main process.
import { z } from "zod";

import { resolvePrice, tokensCostUsd, type PriceTable, type ResolvedPrice } from "./price-table.js";

/**
 * Who a remote call spends for (D14): `user` (work the person started: an import's own stages and
 * its link job), `background` (Gardener work, metered and refused at the caps) and `interactive`
 * (the person waits for the answer). Callers state it beside the workload class and the priority.
 */
export const budgetClasses = ["user", "background", "interactive"] as const;
export const BudgetClassSchema = z.enum(budgetClasses);
export type BudgetClass = z.infer<typeof BudgetClassSchema>;

export const remoteBudgetConfigSchema = z
  .object({
    /** The monthly cap of background spend on priced routes, US$, until the user sets one (Q3). */
    defaultMonthlyCapUsd: z.number().min(0).max(100_000).default(5),
    /**
     * The share of the monthly cap past which remote background work pauses until the user
     * continues (the Activity "needs you" item) (cal.).
     */
    pauseShare: z.number().gt(0).lt(1).default(0.8),
    /** Background calls a day on subscription routes (Codex OAuth), every attempt one call (cal.). */
    subscriptionDailyCalls: z.number().int().min(0).max(1_000_000).default(800),
    /**
     * The tokens an import is priced with per chunk, every generative call of its plan included
     * (X7-REF: 138,438 input and 65,351 output tokens for 66 chunks) (cal.).
     */
    importTokensPerChunk: z
      .object({
        input: z.number().int().min(0).default(2_100),
        output: z.number().int().min(0).default(1_000)
      })
      .strict()
      .default({ input: 2_100, output: 1_000 })
  })
  .strict();
export type RemoteBudgetConfig = z.infer<typeof remoteBudgetConfigSchema>;
export const defaultRemoteBudgetConfig: RemoteBudgetConfig = remoteBudgetConfigSchema.parse({});

/** The settings key of the subscription routes' daily background call counter. */
export const subscriptionDailyCallsSettingKey = "gardener.budget.subscriptionCalls.v1";
/** The settings key of the month the user chose to continue past the pause share in. */
export const budgetContinueSettingKey = "gardener.budget.continue.v1";

export const SubscriptionDailyCallsSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    calls: z.number().int().nonnegative()
  })
  .strict();
export type SubscriptionDailyCalls = z.infer<typeof SubscriptionDailyCallsSchema>;

export const BudgetContinueSchema = z
  .object({
    month: z.string().regex(/^\d{4}-\d{2}$/u),
    /** The cap the person continued under; raising the cap asks again only past its new share. */
    capUsd: z.number().min(0)
  })
  .strict();
export type BudgetContinue = z.infer<typeof BudgetContinueSchema>;

/** The blocker reasons of the cap class the budget refuses with (spec 3.1). */
export const remoteBudgetRefusalReasons = ["money_80", "money_100", "subscription_daily"] as const;
export type RemoteBudgetRefusalReason = (typeof remoteBudgetRefusalReasons)[number];

/**
 * A background remote attempt the budget refused before it started (D14): nothing was sent. The
 * supervisor maps it to a per-task blocker of class `cap` (T75), never to a failure. `clearsAt` is
 * when it clears by itself (the next local day or month), null when the person must act.
 */
export class RemoteBudgetRefusal extends Error {
  public override readonly name = "BackgroundBlocked";
  public readonly blockedClass = "cap" as const;

  public constructor(
    public readonly blockedReason: RemoteBudgetRefusalReason,
    public readonly clearsAt: Date | null
  ) {
    super(`gardener.blocked.cap.${blockedReason}`);
  }
}

/** Whether an error, or one it wraps, is a budget refusal. */
export function remoteBudgetRefusalOf(error: unknown): RemoteBudgetRefusal | null {
  for (let depth = 0; depth < 5 && error !== null && error !== undefined; depth++) {
    if (error instanceof RemoteBudgetRefusal) return error;
    if (
      typeof error === "object" &&
      (error as { name?: unknown }).name === "BackgroundBlocked" &&
      (error as { blockedClass?: unknown }).blockedClass === "cap" &&
      remoteBudgetRefusalReasons.includes(
        (error as { blockedReason?: unknown }).blockedReason as RemoteBudgetRefusalReason
      )
    ) {
      const { blockedReason, clearsAt } = error as {
        blockedReason: RemoteBudgetRefusalReason;
        clearsAt?: unknown;
      };
      return new RemoteBudgetRefusal(blockedReason, clearsAt instanceof Date ? clearsAt : null);
    }
    error = (error as { cause?: unknown }).cause;
  }
  return null;
}

/** The tokens one attempt is reserved with (D14: `estimateAiPlanningTokens`, which over-counts). */
export interface AttemptTokenEstimate {
  inputTokens: number;
  outputTokens: number;
}

/** Whether a call is metered and refused at all: only background work off P0 (D14). */
export function refusable(budgetClass: BudgetClass | null, priority: number | null): boolean {
  return budgetClass === "background" && priority !== 0;
}

/**
 * The money meter's verdict for one more attempt: admitted only when the month's spend, what is
 * reserved and its own estimate stay within the cap, so no cap is passed by more than one attempt's
 * estimation error; past the pause share it waits for the person to continue.
 */
export function moneyAdmission(input: {
  spentUsd: number;
  reservedUsd: number;
  estimateUsd: number;
  capUsd: number;
  pauseShare: number;
  /** The person continued past the pause share this month, under this cap. */
  continued: boolean;
}): "admit" | "money_80" | "money_100" {
  const after = input.spentUsd + input.reservedUsd + input.estimateUsd;
  if (after > input.capUsd) return "money_100";
  if (!input.continued && after > input.capUsd * input.pauseShare) return "money_80";
  return "admit";
}

/** The call meter's verdict for one more background attempt on a subscription route. */
export function callAdmission(input: {
  usedCalls: number;
  reservedCalls: number;
  capCalls: number;
}): "admit" | "subscription_daily" {
  return input.usedCalls + input.reservedCalls + 1 > input.capCalls
    ? "subscription_daily"
    : "admit";
}

/** The local calendar month of `at`, as `YYYY-MM`. */
export function localMonth(at: Date): string {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}`;
}

/** The local month window `at` falls in: its first instant and the next month's. */
export function localMonthWindow(at: Date): { start: Date; end: Date } {
  return {
    start: new Date(at.getFullYear(), at.getMonth(), 1),
    end: new Date(at.getFullYear(), at.getMonth() + 1, 1)
  };
}

/** The local calendar day of `at`, as `YYYY-MM-DD`. */
export function localBudgetDay(at: Date): string {
  return `${localMonth(at)}-${String(at.getDate()).padStart(2, "0")}`;
}

/** The start of the local day after `at`'s. */
export function nextLocalBudgetDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
}

/**
 * What one audited remote call cost in money: its tokens at its price when both counts are known,
 * plus the estimates of its failed attempts the provider accepted without reporting their usage;
 * else the estimate of every attempt it was reserved with (D14: NULL usage keeps the estimate, never
 * zero). Priced calls only; a subscription call costs nothing in money.
 */
export function auditedCallUsd(input: {
  price: Pick<ResolvedPrice, "billing" | "inputUsdPerM" | "outputUsdPerM">;
  inputTokens: number | null | undefined;
  outputTokens: number | null | undefined;
  /** The admission estimate of the attempts it made, when it reserved any. */
  estimateUsd: number | null | undefined;
  /**
   * The admission estimate of its failed attempts that may have been billed and reported no usage
   * (a stream that stalled after its deltas); counted on top of known token counts.
   */
  unreportedUsd?: number | null | undefined;
  /** Output tokens to price a call with no usage and no stored estimate at (its `maxTokens`). */
  fallbackOutputTokens?: number;
}): number {
  if (input.price.billing === "subscription") return 0;
  if (
    input.inputTokens !== null &&
    input.inputTokens !== undefined &&
    input.outputTokens !== null &&
    input.outputTokens !== undefined
  )
    return (
      tokensCostUsd(input.price, {
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens
      }) + Math.max(0, input.unreportedUsd ?? 0)
    );
  if (input.estimateUsd !== null && input.estimateUsd !== undefined && input.estimateUsd > 0)
    return input.estimateUsd;
  // A row with neither (written before 0061): its output budget at the price, never zero.
  return tokensCostUsd(input.price, {
    inputTokens: input.inputTokens ?? 0,
    outputTokens: Math.max(input.outputTokens ?? 0, input.fallbackOutputTokens ?? 0)
  });
}

/**
 * What the import plan chip shows (spec 3.3 "Estimates for users"): US$ on a priced route (`known`
 * false when the model is priced conservatively), "not metered" on a subscription route, nothing on
 * a local route, and `none` when no route can write.
 */
export const ImportEstimateSchema = z.discriminatedUnion("billing", [
  z
    .object({
      billing: z.literal("per_token"),
      usd: z.number().nonnegative().finite(),
      known: z.boolean(),
      priceTableVersion: z.string().min(1)
    })
    .strict(),
  z.object({ billing: z.literal("subscription") }).strict(),
  z.object({ billing: z.literal("local") }).strict(),
  z.object({ billing: z.literal("none") }).strict()
]);
export type ImportEstimate = z.infer<typeof ImportEstimateSchema>;

/** The request of `budget.estimateImport`: the chunk count of the import plan. */
export const ImportEstimateInputSchema = z
  .object({ chunkCount: z.number().int().min(0).max(10_000_000) })
  .strict();
export type ImportEstimateInput = z.infer<typeof ImportEstimateInputSchema>;

/**
 * The estimate of an import on its writer route: its chunk count times the typed tokens per chunk
 * at the route's price; a subscription route is not metered and a local one costs nothing.
 */
export function estimateImport(input: {
  chunkCount: number;
  route: { locality: "local" | "remote"; provider: string; modelId: string } | null;
  table: PriceTable;
  config?: RemoteBudgetConfig;
}): ImportEstimate {
  if (!input.route) return { billing: "none" };
  if (input.route.locality === "local") return { billing: "local" };
  const price = resolvePrice(input.table, input.route.provider, input.route.modelId);
  if (price.billing === "subscription") return { billing: "subscription" };
  const perChunk = (input.config ?? defaultRemoteBudgetConfig).importTokensPerChunk;
  const chunks = Math.max(0, Math.ceil(input.chunkCount));
  return {
    billing: "per_token",
    usd: tokensCostUsd(price, {
      inputTokens: chunks * perChunk.input,
      outputTokens: chunks * perChunk.output
    }),
    known: price.known,
    priceTableVersion: price.priceTableVersion
  };
}
