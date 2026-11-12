import {
  ClipboardCheck,
  Coins,
  Copy,
  FileWarning,
  History,
  Info,
  Link2,
  OctagonAlert,
  RotateCcw,
  Scale,
  TriangleAlert,
  Unlink
} from "lucide-react";
import type { ChangeSetRisk, InboxKind } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { riskLabels } from "./inbox-model";

/** Risk as a glyph and a word, so colour is never the only signal (state tokens, AA in both themes). */
export const riskIcon: Record<ChangeSetRisk, typeof Info> = {
  high: OctagonAlert,
  medium: TriangleAlert,
  low: Info
};

export const riskTone: Record<ChangeSetRisk, string> = {
  high: "text-danger",
  medium: "text-warning",
  low: "text-info"
};

export function RiskMark({
  t,
  risk,
  className
}: {
  t: Translator;
  risk: ChangeSetRisk;
  className?: string | undefined;
}) {
  const Icon = riskIcon[risk];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        riskTone[risk],
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(riskLabels[risk])}
    </span>
  );
}

export const kindIcon: Record<InboxKind, typeof Info> = {
  review: ClipboardCheck,
  quarantined: RotateCcw,
  contradiction: Scale,
  suggestion: Link2,
  withdrawn: Unlink,
  duplicate: Copy,
  obsidian_conflict: FileWarning,
  budget: Coins,
  backlog: History
};
