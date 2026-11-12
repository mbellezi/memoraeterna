import {
  gardenerAutonomyLevels,
  TreeShapeSchema,
  type BudgetSnapshot,
  type GardenerAutonomy,
  type GardenerStatusSnapshot,
  type TreeShape
} from "@app/domain";
import type { LanguageCode, MessageKey } from "@app/i18n";

import type { JobRecord } from "../../../../shared/ipc";
import type { StatusTone } from "../../SettingControls";
import {
  monthlyCapMaxUsd,
  parseMonthlyCapInput
} from "../../../components/settings/knowledge-controls-state";

/**
 * What Settings › Knowledge shows, as pure functions (F5 T164, design record §7.6, the Settings v2
 * mockup): the words of each choice, the money, the month's spend as a share of the cap, the tone of
 * the Gardener's status line and where the relation descriptions stand.
 */

export const autonomyOptions: ReadonlyArray<{
  value: GardenerAutonomy;
  label: MessageKey;
  description: MessageKey;
}> = gardenerAutonomyLevels.map((value) => ({
  value,
  label: `settingsKnowledge.autonomy.${value}.label` as MessageKey,
  description: `settingsKnowledge.autonomy.${value}.description` as MessageKey
}));

export const treeShapeOptions: ReadonlyArray<{ value: TreeShape; label: MessageKey }> =
  TreeShapeSchema.options.map((value) => ({
    value,
    label: `settingsKnowledge.treeShape.${value}` as MessageKey
  }));

export { monthlyCapMaxUsd };

/** The cap as typed text: a comma or a point is the decimal mark, and a value out of range is brought in. */
export const parseCap = (text: string): number | null =>
  parseMonthlyCapInput(text, monthlyCapMaxUsd);

/** Dollars and cents in the person's language: "US$ 12,00" in pt-BR, "$12.00" in English. */
export const formatMoney = (locale: LanguageCode, amount: number): string =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);

/** The number alone ("12,00"), for the field; its currency symbol sits in front of it. */
export const formatAmount = (locale: LanguageCode, amount: number): string =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    amount
  );

/** The currency symbol this language writes for US dollars ("US$", "$"). */
export function currencySymbol(locale: LanguageCode): string {
  const part = new Intl.NumberFormat(locale, { style: "currency", currency: "USD" })
    .formatToParts(0)
    .find((entry) => entry.type === "currency");
  return part?.value ?? "$";
}

export interface SpendView {
  /** 0 to 100: how much of the cap the month's spend is. */
  percent: number;
  spent: number;
  cap: number;
  /** The cap is near (paused) or reached (exhausted); open otherwise. */
  state: BudgetSnapshot["money"]["state"];
}

export function spendView(money: BudgetSnapshot["money"] | null): SpendView | null {
  if (!money) return null;
  const percent = money.capUsd > 0 ? Math.min(100, (money.spentUsd / money.capUsd) * 100) : 100;
  return { percent, spent: money.spentUsd, cap: money.capUsd, state: money.state };
}

/**
 * The tone of the Gardener's status line: running work moves, an idle Gardener is fine, one that is
 * held or needs the person is a warning (never red: the pause is the person's own choice).
 */
export function gardenerTone(status: GardenerStatusSnapshot): StatusTone {
  if (status.state === "running") return "working";
  if (status.state === "idle") return "ok";
  return "warn";
}

export type LabelsView =
  | { kind: "idle" }
  | { kind: "working"; queued: boolean; progress: number; jobId: string; canCancel: boolean }
  | { kind: "done"; updated: number | null }
  | { kind: "failed"; canRetry: boolean; jobId: string };

/** Where the descriptions of the connections stand, from the last job of that kind. */
export function labelsView(job: JobRecord | null): LabelsView {
  if (!job) return { kind: "idle" };
  if (job.status === "queued" || job.status === "running")
    return {
      kind: "working",
      queued: job.status === "queued",
      progress: job.progress,
      jobId: job.id,
      canCancel: job.canCancel
    };
  if (job.status === "failed") return { kind: "failed", canRetry: job.canRetry, jobId: job.id };
  if (job.status === "succeeded")
    return { kind: "done", updated: job.labelResult?.updated ?? null };
  return { kind: "idle" };
}
