import type { MonitoringPrune } from "../../../shared/monitoring";

/**
 * The confirmation before old call-log records are deleted (F5 T165): the person says how old and
 * what, the app counts what would go (`monitoring.prune` with `preview`), and only a count above
 * zero can be confirmed. Deleting never happens from a form that was not counted. Pure.
 */

export type PruneUnit = MonitoringPrune["unit"];
export type PruneScope = MonitoringPrune["scope"];

export interface PruneForm {
  /** Typed text, so a half-typed number is a state of the form, not an error. */
  amount: string;
  unit: PruneUnit;
  scope: PruneScope;
}

export const defaultPruneForm: PruneForm = { amount: "30", unit: "days", scope: "all" };

export const pruneAmountMax = 3_650;

/** The request the form stands for, or null while the amount is not a whole number from 1 to 3650. */
export function pruneRequestOf(form: PruneForm): Omit<MonitoringPrune, "preview"> | null {
  if (!/^\d{1,4}$/u.test(form.amount.trim())) return null;
  const amount = Number(form.amount.trim());
  if (amount < 1 || amount > pruneAmountMax) return null;
  return { amount, unit: form.unit, scope: form.scope };
}

export type PruneCount =
  | { status: "idle" }
  | { status: "counting" }
  | { status: "failed" }
  | { status: "counted"; count: number; cutoff: string };

export type PruneStage =
  | { kind: "invalid" }
  | { kind: "counting" }
  | { kind: "failed" }
  | { kind: "nothing" }
  | { kind: "ready"; count: number; cutoff: string };

/** What the dialog says of the form: not valid, being counted, failed to count, nothing, or ready. */
export function pruneStageOf(form: PruneForm, counted: PruneCount): PruneStage {
  if (pruneRequestOf(form) === null) return { kind: "invalid" };
  if (counted.status === "failed") return { kind: "failed" };
  if (counted.status !== "counted") return { kind: "counting" };
  return counted.count > 0
    ? { kind: "ready", count: counted.count, cutoff: counted.cutoff }
    : { kind: "nothing" };
}

/** Only a counted, non-empty form can be confirmed. */
export const canConfirmPrune = (stage: PruneStage): boolean => stage.kind === "ready";
