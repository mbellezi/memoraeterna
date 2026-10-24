import type { SoakWindowSpec } from "./soak-plan-f4.js";
import type { GroundTruthRecord, SoakEventSink } from "./soak-records.js";

/**
 * The windows with ground truth of the 7-day soak (F4 T89, spec 5.4): periods in which the harness
 * makes one thing true (a usage limit, autonomy off, a missing ranker, a battery, a money cap) and
 * knows what the status sentence must say meanwhile. A {@link WindowRunner} starts and ends each
 * window through {@link WindowPorts}, which the app wires to the real controls, power override,
 * budget and fetch layer, and writes a `ground_truth` record at every transition with the class and
 * reason the sentence must show once the settle after it has passed (two minutes unless the window
 * says otherwise: the sign-in window recovers by a probe every five). The report (E5) compares the
 * per-minute status samples with those records, so a window that did not take effect shows up as a
 * mismatch instead of passing silently.
 *
 * A window does not know the product: every effect goes through a port, so the runner is tested with
 * fakes on a fake clock.
 */

export const defaultSettleMs = 2 * 60_000;
const minute = 60_000;

/** A control change the runner makes; the Knowledge controls' own update shape. */
export interface ControlsChange {
  autonomy?: "off" | "suggest" | "auto";
  paused?: boolean;
  onlyIdle?: boolean;
  onlyOnAc?: boolean;
  monthlyCapUsd?: number;
}

export type PowerBlockWord = "active" | "idle" | "battery";

export interface WindowPorts {
  /** The fetch layer of the real Codex lane: a window answers every request it sees. */
  lane: {
    start(
      id: string,
      kind: "usage_limit" | "refused" | "enotfound" | "unauthorized",
      durationMs: number
    ): void;
    end(id: string): void;
  };
  controls: {
    update(change: ControlsChange): Promise<unknown>;
    autonomy(): "off" | "suggest" | "auto";
  };
  /** The DEV power override: alternating blocks of `active` and `idle`, or `battery`; null lifts it. */
  power: { setBlocks(blocks: readonly PowerBlockWord[] | null): void };
  /** The product's Codex daily background call cap, overridden at run time (D14, E4(b)). */
  codexDailyCap: {
    /** Calls counted and in flight today, and the budget's day (to re-apply the cap after a rollover). */
    today(): Promise<{ calls: number; day: string }>;
    set(calls: number | null): void;
  };
  hooks: {
    invalidateRanker(): Promise<void>;
    restoreRanker(): Promise<void>;
    markEmbedderVerifying(): Promise<void>;
    clearEmbedderVerifying(): Promise<void>;
  };
  harnessCap: { lowerToSpentPlus(calls: number): number; restore(): void };
  money: MoneyPort | null;
}

/** The money window's effects: a priced loopback fake for the explanation backfill, a monthly cap, a pass. */
export interface MoneyPort {
  routeToFake(): Promise<{ baseUrl: string; model: string }>;
  restoreRoute(): Promise<void>;
  spentUsd(): Promise<number>;
  monthlyCapUsd(): number;
  state(): Promise<"open" | "paused" | "exhausted">;
  continuePastPause(): Promise<void>;
  enqueueBackfill(count: number): Promise<number>;
}

export interface WindowClock {
  now(): number;
}

type Detail = Record<string, string | number | boolean | null>;

/** Settle after a window's start, or after its end, in milliseconds. */
export function settleMs(window: SoakWindowSpec, phase: "start" | "end"): number {
  const minutes =
    phase === "start" ? window.settleMinutes : (window.settleEndMinutes ?? window.settleMinutes);
  return Math.round(minutes * minute);
}

/** One start or end of a window, in milliseconds from the start of the run. */
export interface WindowTransition {
  atMs: number;
  phase: "start" | "end";
  window: SoakWindowSpec;
}

/** Every start and end of the windows, in time order (a start before an end at the same moment). */
export function windowTransitions(windows: readonly SoakWindowSpec[]): WindowTransition[] {
  return windows
    .flatMap((window) => [
      { atMs: Math.round(window.startMinute * minute), phase: "start" as const, window },
      {
        atMs: Math.round((window.startMinute + window.durationMinutes) * minute),
        phase: "end" as const,
        window
      }
    ])
    .toSorted((a, b) => a.atMs - b.atMs || (a.phase === b.phase ? 0 : a.phase === "end" ? -1 : 1));
}

/** The state of the money window's small machine. */
type MoneyStage = "filling" | "paused" | "continued" | "exhausted";

interface Running {
  window: SoakWindowSpec;
  startedAt: number;
  previousAutonomy?: "off" | "suggest" | "auto";
  /** only_idle / only_ac: the active block the last tick saw, as an index, or null. */
  activeBlock?: number | null;
  /** codex_daily_cap: the day the cap was set for and the extra calls it allows. */
  capDay?: string;
  money?: {
    stage: MoneyStage;
    originalCapUsd: number;
    pausedAt?: number;
    reached80: boolean;
  };
}

export interface WindowRunnerOptions {
  ports: WindowPorts;
  sink: SoakEventSink;
  clock: WindowClock;
  logger?: Pick<Console, "info" | "error">;
}

const failureText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(/\s+/gu, " ").slice(0, 200);

const expectOf = (window: SoakWindowSpec) =>
  window.expect ? { class: window.expect.class, reason: window.expect.reason } : undefined;

export class WindowRunner {
  private readonly running = new Map<string, Running>();

  public constructor(private readonly options: WindowRunnerOptions) {}

  /** The ids of the windows that are open. */
  public get open(): string[] {
    return [...this.running.keys()];
  }

  private record(
    window: SoakWindowSpec,
    phase: "start" | "end",
    detail: Detail,
    over: { id?: string; expect?: { class: string; reason: string } | null; settle?: number } = {}
  ): void {
    const at = this.options.clock.now();
    // `expect: null` says the window as a whole expects nothing (its parts do); unset: the window's own.
    const expect =
      phase === "start"
        ? over.expect === undefined
          ? expectOf(window)
          : (over.expect ?? undefined)
        : undefined;
    const record: GroundTruthRecord = {
      type: "ground_truth",
      id: over.id ?? window.id,
      kind: window.kind,
      phase,
      at: new Date(at).toISOString(),
      ...(expect ? { expect } : {}),
      settleUntil: new Date(at + (over.settle ?? settleMs(window, phase))).toISOString(),
      detail
    };
    this.options.sink.append(record);
  }

  /** Starts a window: its effect first, then the record that says what the sentence must show. */
  public async start(window: SoakWindowSpec): Promise<void> {
    if (this.running.has(window.id)) return;
    const now = this.options.clock.now();
    const state: Running = { window, startedAt: now };
    this.running.set(window.id, state);
    const { ports } = this.options;
    const durationMs = Math.round(window.durationMinutes * minute);
    let detail: Detail = {};
    let expectNow: { class: string; reason: string } | null | undefined = undefined;
    try {
      switch (window.kind) {
        case "usage_limit":
        case "refused":
        case "enotfound":
        case "unauthorized":
          ports.lane.start(window.id, window.kind, durationMs);
          break;
        case "autonomy_off":
        case "autonomy_suggest":
          state.previousAutonomy = ports.controls.autonomy();
          await ports.controls.update({
            autonomy: window.kind === "autonomy_off" ? "off" : "suggest"
          });
          detail = { previousAutonomy: state.previousAutonomy };
          break;
        case "pause":
          await ports.controls.update({ paused: true });
          break;
        case "codex_daily_cap": {
          const today = await ports.codexDailyCap.today();
          const extra = window.params.extraCalls ?? 10;
          ports.codexDailyCap.set(today.calls + extra);
          state.capDay = today.day;
          detail = { callsSoFar: today.calls, cap: today.calls + extra };
          break;
        }
        case "ranker_invalid":
          await ports.hooks.invalidateRanker();
          break;
        case "embedder_verifying":
          await ports.hooks.markEmbedderVerifying();
          break;
        case "only_idle":
          await ports.controls.update({ onlyIdle: true });
          ports.power.setBlocks(["active", "idle"]);
          // The expectation holds in the active blocks only: tick() records each of them.
          expectNow = null;
          state.activeBlock = null;
          break;
        case "only_ac":
          await ports.controls.update({ onlyOnAc: true });
          ports.power.setBlocks(["battery"]);
          break;
        case "harness_cap":
          detail = { cap: ports.harnessCap.lowerToSpentPlus(window.params.calls ?? 1.5) };
          break;
        case "money":
          detail = await this.startMoney(window, state);
          // The sentence is checked from the moment the budget reaches its 80% (tick()).
          expectNow = null;
          break;
      }
    } catch (error) {
      detail = { ...detail, error: failureText(error) };
      this.options.logger?.error(`SOAK window ${window.id} did not start: ${failureText(error)}`);
    }
    this.record(window, "start", detail, expectNow === undefined ? {} : { expect: expectNow });
  }

  /** Ends a window: the effect is lifted, and the record says the sentence returns to the next truth. */
  public async end(window: SoakWindowSpec): Promise<void> {
    const state = this.running.get(window.id);
    if (!state) return;
    const { ports } = this.options;
    let detail: Detail = {};
    try {
      switch (window.kind) {
        case "usage_limit":
        case "refused":
        case "enotfound":
        case "unauthorized":
          ports.lane.end(window.id);
          break;
        case "autonomy_off":
        case "autonomy_suggest":
          await ports.controls.update({ autonomy: state.previousAutonomy ?? "auto" });
          break;
        case "pause":
          await ports.controls.update({ paused: false });
          break;
        case "codex_daily_cap":
          ports.codexDailyCap.set(null);
          break;
        case "ranker_invalid":
          await ports.hooks.restoreRanker();
          break;
        case "embedder_verifying":
          await ports.hooks.clearEmbedderVerifying();
          break;
        case "only_idle":
          this.closeBlock(state);
          await ports.controls.update({ onlyIdle: false });
          ports.power.setBlocks(null);
          break;
        case "only_ac":
          await ports.controls.update({ onlyOnAc: false });
          ports.power.setBlocks(null);
          break;
        case "harness_cap":
          ports.harnessCap.restore();
          break;
        case "money":
          detail = await this.endMoney(window, state);
          break;
      }
    } catch (error) {
      detail = { ...detail, error: failureText(error) };
      this.options.logger?.error(`SOAK window ${window.id} did not end: ${failureText(error)}`);
    }
    this.running.delete(window.id);
    this.record(window, "end", detail);
  }

  /**
   * Called every sample interval: the blocks of the idle window, the day rollover of the daily cap
   * and the money window's stages.
   */
  public async tick(): Promise<void> {
    for (const state of [...this.running.values()]) {
      const { window } = state;
      try {
        if (window.kind === "only_idle") this.tickBlocks(state);
        else if (window.kind === "codex_daily_cap") await this.tickDailyCap(state);
        else if (window.kind === "money") await this.tickMoney(state);
      } catch (error) {
        this.options.logger?.error(`SOAK window ${window.id} tick failed: ${failureText(error)}`);
      }
    }
  }

  /** The idle window alternates `blockMinutes` of activity and of idleness, active first. */
  private tickBlocks(state: Running): void {
    const { window } = state;
    const blockMs = Math.round((window.params.blockMinutes ?? 10) * minute);
    const index = Math.floor((this.options.clock.now() - state.startedAt) / blockMs);
    const active = index % 2 === 0;
    const current = active ? index : null;
    if (current === state.activeBlock) return;
    this.closeBlock(state);
    if (current !== null) {
      state.activeBlock = current;
      this.record(window, "start", { block: current }, { id: `${window.id}#${current / 2 + 1}` });
    }
  }

  private closeBlock(state: Running): void {
    if (state.activeBlock === null || state.activeBlock === undefined) return;
    const { window } = state;
    this.record(
      window,
      "end",
      { block: state.activeBlock },
      { id: `${window.id}#${state.activeBlock / 2 + 1}` }
    );
    state.activeBlock = null;
  }

  private async tickDailyCap(state: Running): Promise<void> {
    const today = await this.options.ports.codexDailyCap.today();
    if (today.day === state.capDay) return;
    // The budget's day rolled over: the counter restarted, so the cap is set again from the new count.
    const extra = state.window.params.extraCalls ?? 10;
    this.options.ports.codexDailyCap.set(today.calls + extra);
    state.capDay = today.day;
  }

  // --- The money window ------------------------------------------------------------------------

  private async startMoney(window: SoakWindowSpec, state: Running): Promise<Detail> {
    const money = this.options.ports.money;
    if (!money) throw new Error("the money window needs the priced loopback fake");
    const fake = await money.routeToFake();
    const spent = await money.spentUsd();
    const attempts = window.params.attempts ?? 8;
    const estimate = window.params.attemptEstimateUsd ?? 0.008;
    const original = money.monthlyCapUsd();
    const cap = Math.round((spent + attempts * estimate) * 1_000_000) / 1_000_000;
    await this.options.ports.controls.update({ monthlyCapUsd: cap });
    const queued = await money.enqueueBackfill(window.params.backfillRelations ?? 10);
    state.money = { stage: "filling", originalCapUsd: original, reached80: false };
    return {
      fakeModel: fake.model,
      spentUsd: spent,
      capUsd: cap,
      attemptEstimateUsd: estimate,
      relationsQueued: queued
    };
  }

  /**
   * The money window's stages: the budget reaches its 80% and the sentence must say `cap.money_80`;
   * ten minutes later the driver presses "continue"; the budget then reaches its cap and the sentence
   * must say `cap.money_100` (generative background waits; placement and deciding continue).
   */
  private async tickMoney(state: Running): Promise<void> {
    const money = this.options.ports.money;
    const stage = state.money;
    if (!money || !stage) return;
    const { window } = state;
    const now = this.options.clock.now();
    const budget = await money.state();
    if (stage.stage === "filling" && budget === "paused") {
      stage.reached80 = true;
      stage.pausedAt = now;
      stage.stage = "paused";
      this.record(
        window,
        "start",
        { stage: "money_80" },
        {
          id: `${window.id}#80`,
          expect: { class: "cap", reason: "money_80" }
        }
      );
    }
    if (stage.stage === "filling" && budget === "exhausted") {
      // Past the 80% between two looks: the sentence is the cap's, the 80% item was not seen.
      stage.reached80 = true;
      stage.stage = "exhausted";
      this.record(
        window,
        "start",
        { stage: "money_100", skipped80: true },
        {
          id: `${window.id}#100`,
          expect: { class: "cap", reason: "money_100" }
        }
      );
    }
    if (stage.stage === "paused" && stage.pausedAt !== undefined) {
      const wait = Math.round((window.params.continueAfterMinutes ?? 10) * minute);
      if (now - stage.pausedAt >= wait) {
        await money.continuePastPause();
        stage.stage = "continued";
        this.record(
          window,
          "end",
          { stage: "money_80", continued: true },
          { id: `${window.id}#80` }
        );
      }
    }
    if (stage.stage === "continued" && budget === "exhausted") {
      stage.stage = "exhausted";
      this.record(
        window,
        "start",
        { stage: "money_100" },
        {
          id: `${window.id}#100`,
          expect: { class: "cap", reason: "money_100" }
        }
      );
    }
  }

  private async endMoney(window: SoakWindowSpec, state: Running): Promise<Detail> {
    const money = this.options.ports.money;
    const stage = state.money;
    if (!money || !stage) return {};
    if (stage.stage === "paused")
      this.record(window, "end", { stage: "money_80" }, { id: `${window.id}#80` });
    if (stage.stage === "exhausted")
      this.record(window, "end", { stage: "money_100" }, { id: `${window.id}#100` });
    await money.restoreRoute();
    await this.options.ports.controls.update({ monthlyCapUsd: stage.originalCapUsd });
    return { reached80: stage.reached80, stage: stage.stage };
  }
}
