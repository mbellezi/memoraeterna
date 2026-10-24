import {
  ArrowRightLeft,
  CircleDashed,
  Minus,
  MoveRight,
  Pencil,
  Plus,
  SlidersHorizontal
} from "lucide-react";
import type { TopicDiffChange } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { diffToneTokens, toneVar } from "./diff-tones";
import { diffChanges } from "./icicle-diff-model";

/** One glyph per kind of change, so the tint is never the only signal. */
export const diffIcons: Record<TopicDiffChange, typeof Plus> = {
  added: Plus,
  removed: Minus,
  moved: MoveRight,
  renamed: Pencil,
  changed: SlidersHorizontal,
  items: ArrowRightLeft,
  context: CircleDashed
};

/** The tint behind a block or a swatch for a kind of change. */
export const diffFill = (change: TopicDiffChange): string =>
  toneVar(diffToneTokens[diffChanges[change].tone].fill);

export function DiffGlyph({
  change,
  className
}: {
  change: TopicDiffChange;
  className?: string | undefined;
}) {
  const Icon = diffIcons[change];
  return (
    <Icon
      className={cn("size-3.5 shrink-0", className)}
      style={{ color: toneVar(diffToneTokens[diffChanges[change].tone].ink) }}
      aria-hidden="true"
    />
  );
}

/** A kind of change as a glyph and a word. */
export function DiffMark({
  t,
  change,
  className
}: {
  t: Translator;
  change: TopicDiffChange;
  className?: string | undefined;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap text-foreground",
        className
      )}
    >
      <DiffGlyph change={change} />
      {t(diffChanges[change].key)}
    </span>
  );
}

/** The small square of the legend: the tint and the glyph of a kind of change. */
export function DiffSwatch({ change }: { change: TopicDiffChange }) {
  return (
    <span
      aria-hidden="true"
      className="inline-flex size-5 shrink-0 items-center justify-center rounded-sm"
      style={{ background: diffFill(change) }}
    >
      <DiffGlyph change={change} />
    </span>
  );
}
