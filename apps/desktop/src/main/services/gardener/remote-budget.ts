// The RemoteBudget (F4 D14, T76; spec 3.3): every background remote attempt reserves before it starts.
// Priced routes are metered in US$ against the person's monthly cap: past its pause share remote
// background work waits until the person continues (`cap.money_80`), at the cap it waits for the next
// month or a higher cap (`cap.money_100`). Subscription routes (Codex OAuth) are metered in calls: each
// background attempt is one call of a daily cap (`cap.subscription_daily`). P0 is never refused, and
// user-started or interactive work is never refused. One in-process mutex covers the reservations and
// the in-memory ledger, which is loaded from the audit at start and at every month rollover and moves
// when an audited call settles: a reservation is released only after its audit row commits, so the
// money spent plus what is reserved never undercounts a call in flight.
import { createAiBudgetRepository, createSettingsRepository, type Queryable } from "@app/db";
import {
  auditedCallUsd,
  BudgetContinueSchema,
  budgetContinueSettingKey,
  callAdmission,
  defaultPriceTable,
  defaultRemoteBudgetConfig,
  estimateImport,
  localBudgetDay,
  localMonth,
  localMonthWindow,
  moneyAdmission,
  nextLocalBudgetDay,
  refusable,
  RemoteBudgetRefusal,
  resolvePrice,
  SubscriptionDailyCallsSchema,
  subscriptionDailyCallsSettingKey,
  tokensCostUsd,
  type AttemptTokenEstimate,
  type BudgetClass,
  type BudgetContinue,
  type BudgetSnapshot,
  type ImportEstimate,
  type ImportEstimateInput,
  type PriceTable,
  type RemoteBudgetConfig,
  type ResolvedPrice
} from "@app/domain";

import { estimateAiPlanningTokens } from "../ai-task-parameters.js";

/** Where the model a task's route runs, as the AI service's `taskRouteModel` answers. */
export type ImportRouteModel = (
  task: "knowledge-graph-generation",
  context: { operation: string; workloadClass: "write-quality" }
) => Promise<{ locality: "local" | "remote"; provider: string; modelId: string } | null>;

/** One remote call as the budget meters it. */
export interface RemoteBudgetCall {
  /** The scheduler lane; a local lane is never metered. */
  lane: string;
  /** The provider kind and model the call is priced with. */
  provider: string;
  modelId: string;
  /** Who the call spends for; null when its caller stated none (read as unknown, never refused). */
  budgetClass: BudgetClass | null;
  /** The lane priority as stored: 0 for P0 to 3 for P3. */
  priority: number;
  /** The tokens one attempt is reserved with. */
  estimate: AttemptTokenEstimate;
}

/** The audited usage a call settles with; a missing count keeps the reservation as spend. */
export interface RemoteBudgetUsage {
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
  /** A DEV cassette served the call: it spent nothing (the ledger skips its audit row too). */
  replayed?: boolean | undefined;
}

/**
 * What the status, the Activity drawer and the soak read (D27, D28); its schema
 * (`BudgetSnapshotSchema`, `@app/domain`) validates it at IPC and on the event bus.
 */
export type RemoteBudgetSnapshot = BudgetSnapshot;

/** The meters of a call that admitted attempts. */
interface TicketState {
  month: string;
  day: string;
  reservedUsd: number;
  /** The part of `reservedUsd` held by failed attempts the provider accepted and reported no usage for. */
  unreportedUsd: number;
  reservedCalls: number;
  settled: boolean;
}

/** Whether a usage holds both token counts. */
function completeUsage(usage: RemoteBudgetUsage): boolean {
  return (
    usage.inputTokens !== null &&
    usage.inputTokens !== undefined &&
    usage.outputTokens !== null &&
    usage.outputTokens !== undefined
  );
}

/**
 * The budget of one remote call: {@link RemoteBudgetTicket.admitAttempt} before each attempt (the
 * retry loop's `beforeAttempt`), {@link RemoteBudgetTicket.attemptFailed} after each failed one (its
 * `afterFailedAttempt`), {@link RemoteBudgetTicket.settle} once its audit row committed.
 */
export interface RemoteBudgetTicket {
  /** Whether the call is metered at all (a remote lane and a counted budget class). */
  readonly metered: boolean;
  /** The US$ its admitted attempts reserved on a priced route; null when not metered in money. */
  readonly estimateUsd: number | null;
  /** Reserves one attempt, or throws a {@link RemoteBudgetRefusal} for background work at a cap. */
  admitAttempt(attempt: number): Promise<void>;
  /**
   * Notes an attempt that failed: one the provider accepted without reporting its usage may have been
   * billed, so its reservation stays as spend even when a later attempt reports its own usage; one
   * that never reached the provider (`unsent`: its connection failed) gives its reservation back, a
   * call of the daily cap or its US$ estimate, so the probes of a long outage spend nothing.
   */
  attemptFailed(failed: { attempt: number; unreported: boolean; unsent?: boolean }): void;
  /**
   * What the audit row stores as `budget_estimate_usd` for the usage it records (0061), the US$ the
   * monthly ledger counts beyond the reported token counts: every admitted attempt's estimate when
   * the usage misses a count, else the estimates of the failed attempts the provider accepted and
   * reported no usage for (0 when none); null when the call is not metered in money.
   */
  auditEstimateUsd(usage: RemoteBudgetUsage): number | null;
  /** Releases the reservations and counts the audited usage; call it after the audit row committed. */
  settle(usage: RemoteBudgetUsage): Promise<void>;
}

/** The ticket of a call nothing meters: a local call, or work that is not background. */
export const unmeteredBudgetTicket: RemoteBudgetTicket = {
  metered: false,
  estimateUsd: null,
  admitAttempt: async () => undefined,
  attemptFailed: () => undefined,
  auditEstimateUsd: () => null,
  settle: async () => undefined
};

export interface RemoteBudgetOptions {
  getPool: () => Queryable | null;
  /** The person's monthly cap of background spend on priced routes (`knowledge.controls.v1`, T75). */
  monthlyCapUsd?: () => number;
  /**
   * The daily background call cap of subscription routes: the typed value, or the soak's DEV runtime
   * override (T89).
   */
  subscriptionDailyCalls?: () => number;
  config?: RemoteBudgetConfig;
  priceTable?: PriceTable;
  now?: () => Date;
  logger?: Pick<Console, "error">;
  /** Called after the meters changed (a settle, a refusal, a rollover, a continue). */
  onChange?: () => void;
}

/**
 * One attempt's reservation (D14): {@link estimateAiPlanningTokens} split into its parts, the UTF-8
 * bytes of the input and the instruction plus its margin as input tokens (a token holds at least one
 * byte, so it over-counts) and the output budget as output tokens.
 */
export function attemptTokenEstimate(
  input: string,
  instruction: string,
  maxOutputTokens: number
): AttemptTokenEstimate {
  return {
    inputTokens: estimateAiPlanningTokens(input, instruction, 0),
    outputTokens: Math.max(0, Math.floor(maxOutputTokens))
  };
}

/** Whether the monthly ledger counts a call: background, or an unclassified P2/P3 call (as 0061's index). */
export function countedInLedger(budgetClass: BudgetClass | null, priority: number): boolean {
  return budgetClass === "background" || (budgetClass === null && priority >= 2);
}

export class RemoteBudget {
  private readonly config: RemoteBudgetConfig;
  private readonly table: PriceTable;
  private readonly now: () => Date;
  private tail: Promise<unknown> = Promise.resolve();
  private month: string | null = null;
  private day: string | null = null;
  private spentUsd = 0;
  private usedCalls = 0;
  /** The tickets not settled yet: what they reserved is held until their audit rows commit. */
  private readonly active = new Set<TicketState>();
  private continued: BudgetContinue | null = null;
  /**
   * The last money refusal: background work stays blocked for its reason while the month, the cap
   * and at least the committed spend it saw hold (a released reservation can make room again).
   */
  private refusedAt: {
    reason: "money_80" | "money_100";
    month: string;
    capUsd: number;
    committedUsd: number;
  } | null = null;

  public constructor(private readonly options: RemoteBudgetOptions) {
    this.config = options.config ?? defaultRemoteBudgetConfig;
    this.table = options.priceTable ?? defaultPriceTable;
    this.now = options.now ?? (() => new Date());
  }

  /** US$ held by the attempts of calls that have not settled. */
  private get reservedUsd(): number {
    let sum = 0;
    for (const ticket of this.active) sum += ticket.reservedUsd;
    return sum;
  }

  /** Subscription calls held by the attempts of calls that have not settled. */
  private get reservedCalls(): number {
    let sum = 0;
    for (const ticket of this.active) sum += ticket.reservedCalls;
    return sum;
  }

  /** The price the budget meters a provider's model with. */
  public price(provider: string, modelId: string): ResolvedPrice {
    return resolvePrice(this.table, provider, modelId);
  }

  public get priceTable(): PriceTable {
    return this.table;
  }

  /**
   * The budget of one call. A call on the local lane, and user-started or interactive work, are not
   * metered (they are audited with their class); background work and unclassified P2/P3 work are.
   * The ledger is brought to the current month first, so a call that starts after a rollover is never
   * also counted by the reload.
   */
  public async open(call: RemoteBudgetCall): Promise<RemoteBudgetTicket> {
    if (!call.lane.startsWith("remote:") || !countedInLedger(call.budgetClass, call.priority))
      return unmeteredBudgetTicket;
    const price = this.price(call.provider, call.modelId);
    const state = await this.serialized(async (): Promise<TicketState> => {
      await this.current();
      const opened: TicketState = {
        month: this.month!,
        day: this.day!,
        reservedUsd: 0,
        unreportedUsd: 0,
        reservedCalls: 0,
        settled: false
      };
      this.active.add(opened);
      return opened;
    });
    const attemptUsd = tokensCostUsd(price, call.estimate);
    const subscription = price.billing === "subscription";
    const mayRefuse = refusable(call.budgetClass, call.priority);
    return {
      metered: true,
      get estimateUsd() {
        return subscription ? null : state.reservedUsd;
      },
      attemptFailed: (failed) => {
        if (state.settled) return;
        // Every attempt that ran was admitted first, so its estimate is part of the reservation; an
        // attempt that sent nothing gives it back (D14 meters what reaches the provider).
        if (failed.unsent) {
          if (subscription) state.reservedCalls = Math.max(0, state.reservedCalls - 1);
          else {
            const left = state.reservedUsd - attemptUsd;
            state.reservedUsd = left > 1e-12 ? left : 0;
            state.unreportedUsd = Math.min(state.unreportedUsd, state.reservedUsd);
          }
          return;
        }
        if (subscription || !failed.unreported) return;
        state.unreportedUsd = Math.min(state.reservedUsd, state.unreportedUsd + attemptUsd);
      },
      auditEstimateUsd: (usage) =>
        subscription ? null : completeUsage(usage) ? state.unreportedUsd : state.reservedUsd,
      admitAttempt: () =>
        this.serialized(async () => {
          if (state.settled) throw new Error("A settled budget ticket admits no attempt.");
          await this.current();
          const now = this.now();
          if (subscription) {
            if (
              mayRefuse &&
              callAdmission({
                usedCalls: this.usedCalls,
                reservedCalls: this.reservedCalls,
                capCalls: this.capCalls()
              }) === "subscription_daily"
            )
              throw this.refuse(
                new RemoteBudgetRefusal("subscription_daily", nextLocalBudgetDay(now))
              );
            state.reservedCalls += 1;
            return;
          }
          if (mayRefuse) {
            const verdict = moneyAdmission({
              spentUsd: this.spentUsd,
              reservedUsd: this.reservedUsd,
              estimateUsd: attemptUsd,
              capUsd: this.capUsd(),
              pauseShare: this.config.pauseShare,
              continued: this.isContinued()
            });
            if (verdict !== "admit") {
              this.refusedAt = {
                reason: verdict,
                month: this.month!,
                capUsd: this.capUsd(),
                committedUsd: this.spentUsd + this.reservedUsd
              };
              throw this.refuse(
                new RemoteBudgetRefusal(
                  verdict,
                  verdict === "money_100" ? localMonthWindow(now).end : null
                )
              );
            }
          }
          state.reservedUsd += attemptUsd;
        }),
      settle: (usage) =>
        this.serialized(async () => {
          if (state.settled) return;
          state.settled = true;
          // Released only now that its audit row committed (D14).
          this.active.delete(state);
          await this.current();
          // A call settles into the month and day it was admitted in; after a rollover its audit row
          // belongs to the window that was reloaded away.
          if (usage.replayed) {
            // A cassette replay sent nothing: its reservations are released and nothing is spent.
          } else if (subscription) {
            if (state.reservedCalls > 0 && state.day === this.day) {
              this.usedCalls += state.reservedCalls;
              await this.storeCalls();
            }
          } else if (state.month === this.month) {
            // What the audit row's usage and estimate make the ledger count (0061).
            this.spentUsd += auditedCallUsd({
              price,
              inputTokens: usage.inputTokens,
              outputTokens: usage.outputTokens,
              estimateUsd: state.reservedUsd,
              unreportedUsd: state.unreportedUsd
            });
          }
          this.options.onChange?.();
        })
    };
  }

  /**
   * `budget.estimateImport` (spec 3.3): an import plan's chunk count priced on the route that writes
   * its notes and graph (the bulk of an imported source's tokens), with the typed tokens per chunk.
   */
  public async estimateImport(
    input: ImportEstimateInput,
    routes: { routeModel: ImportRouteModel }
  ): Promise<ImportEstimate> {
    const route = await routes.routeModel("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
    return estimateImport({
      chunkCount: input.chunkCount,
      route,
      table: this.table,
      config: this.config
    });
  }

  /** The meters now, after a rollover when one is due. */
  public snapshot(): Promise<RemoteBudgetSnapshot> {
    return this.serialized(async () => {
      await this.current();
      return this.describe();
    });
  }

  /**
   * The person's "continue" past the pause share (the Activity "needs you" item): remote background
   * work resumes up to the cap for the rest of the month, under this cap or a lower one.
   */
  public continuePastPause(): Promise<RemoteBudgetSnapshot> {
    return this.serialized(async () => {
      await this.current();
      const record: BudgetContinue = { month: this.month!, capUsd: this.capUsd() };
      await createSettingsRepository(this.pool()).set(budgetContinueSettingKey, record);
      this.continued = record;
      this.options.onChange?.();
      return this.describe();
    });
  }

  /** Reads the ledger and the counters again (a library reset cleared the audit). */
  public reload(): Promise<RemoteBudgetSnapshot> {
    return this.serialized(async () => {
      this.month = null;
      this.day = null;
      await this.current();
      this.options.onChange?.();
      return this.describe();
    });
  }

  private describe(): RemoteBudgetSnapshot {
    const capUsd = this.capUsd();
    const continued = this.isContinued();
    const committed = this.spentUsd + this.reservedUsd;
    const capCalls = this.capCalls();
    // A refusal holds while its month, its cap and the committed spend it saw do.
    const refused =
      this.refusedAt &&
      this.refusedAt.month === this.month &&
      this.refusedAt.capUsd === capUsd &&
      committed >= this.refusedAt.committedUsd - 1e-12
        ? this.refusedAt.reason
        : null;
    return {
      month: this.month!,
      day: this.day!,
      money: {
        spentUsd: this.spentUsd,
        reservedUsd: this.reservedUsd,
        capUsd,
        pauseShare: this.config.pauseShare,
        continued,
        state:
          committed >= capUsd || refused === "money_100"
            ? "exhausted"
            : !continued && (committed >= capUsd * this.config.pauseShare || refused === "money_80")
              ? "paused"
              : "open",
        priceTableVersion: this.table.version
      },
      calls: {
        usedCalls: this.usedCalls,
        reservedCalls: this.reservedCalls,
        capCalls,
        state: this.usedCalls + this.reservedCalls >= capCalls ? "exhausted" : "open"
      }
    };
  }

  private refuse(refusal: RemoteBudgetRefusal): RemoteBudgetRefusal {
    this.options.onChange?.();
    return refusal;
  }

  private capUsd(): number {
    const cap = this.options.monthlyCapUsd?.() ?? this.config.defaultMonthlyCapUsd;
    return Number.isFinite(cap) && cap >= 0 ? cap : 0;
  }

  private capCalls(): number {
    const cap = this.options.subscriptionDailyCalls?.() ?? this.config.subscriptionDailyCalls;
    return Number.isSafeInteger(cap) && cap >= 0 ? cap : 0;
  }

  private isContinued(): boolean {
    return (
      this.continued !== null &&
      this.continued.month === this.month &&
      this.capUsd() <= this.continued.capUsd
    );
  }

  private pool(): Queryable {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }

  /** Loads the month's ledger and the day's calls when the window moved (or on first use). */
  private async current(): Promise<void> {
    const now = this.now();
    const month = localMonth(now);
    const day = localBudgetDay(now);
    if (this.month === month && this.day === day) return;
    const pool = this.pool();
    const settings = createSettingsRepository(pool);
    if (this.month !== month) {
      const entries = await createAiBudgetRepository(pool).monthLedger(localMonthWindow(now));
      let spent = 0;
      for (const entry of entries) {
        const price = this.price(entry.provider, entry.modelId);
        if (price.billing === "subscription") continue;
        spent +=
          tokensCostUsd(price, {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens
          }) +
          entry.estimateUsd +
          tokensCostUsd(price, {
            inputTokens: entry.unestimatedInputTokens,
            outputTokens: entry.unestimatedOutputTokens
          });
      }
      const continued = BudgetContinueSchema.safeParse(
        await settings.get(budgetContinueSettingKey)
      );
      this.spentUsd = spent;
      this.continued = continued.success ? continued.data : null;
      this.month = month;
    }
    if (this.day !== day) {
      const stored = SubscriptionDailyCallsSchema.safeParse(
        await settings.get(subscriptionDailyCallsSettingKey)
      );
      this.usedCalls = stored.success && stored.data.day === day ? stored.data.calls : 0;
      this.day = day;
    }
  }

  private async storeCalls(): Promise<void> {
    try {
      await createSettingsRepository(this.pool()).set(subscriptionDailyCallsSettingKey, {
        day: this.day,
        calls: this.usedCalls
      });
    } catch (error) {
      // The in-memory count still holds the cap for this run; the next start reads what was stored.
      this.options.logger?.error("Failed to store the subscription call count", error);
    }
  }

  private serialized<T>(run: () => Promise<T>): Promise<T> {
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => undefined);
    return result;
  }
}
