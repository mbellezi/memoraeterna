import type { Translator } from "@app/i18n";

import { cn } from "../lib/cn";
import { relationTypeView, stanceTextClass } from "../lib/relation-stance";
import { StanceGlyph } from "./glyphs";

/** The one stance label of relation views: glyph and word in the stance colour, never the raw type. */
export function RelationStanceLabel({
  type,
  t,
  size = 14,
  className
}: {
  type: string;
  t: Translator;
  size?: number;
  className?: string;
}) {
  const view = relationTypeView(type);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-semibold whitespace-nowrap",
        stanceTextClass[view.stance],
        className
      )}
    >
      <StanceGlyph stance={view.stance} size={size} />
      {t(view.wordKey)}
    </span>
  );
}
