import type { Translator } from "@app/i18n";

import { cn } from "../lib/cn";
import { relationTypeView, stanceTextClass } from "../lib/relation-stance";
import { StanceGlyph } from "./glyphs";

/**
 * The one stance label of relation views: glyph and word in the stance colour, never the raw type.
 * `linked` reads "linked: extends" for a relation of a directed type that nobody gave a direction
 * (decision 31b), so the word beside a note never says who extends whom.
 */
export function RelationStanceLabel({
  type,
  t,
  size = 14,
  className,
  linked = false,
  phrase = null
}: {
  type: string;
  t: Translator;
  size?: number;
  className?: string;
  linked?: boolean;
  /**
   * The wide sheet's directional phrase ("supports this note"), shown in place of the word from
   * 760 px of the page's container; narrower, the word.
   */
  phrase?: string | null;
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
      {phrase ? (
        <>
          <span className="@min-[760px]:hidden">{t(view.wordKey)}</span>
          <span className="hidden whitespace-normal @min-[760px]:inline">{phrase}</span>
        </>
      ) : linked ? (
        t("notePage.linkedStance", { values: { type: t(view.wordKey) } })
      ) : (
        t(view.wordKey)
      )}
    </span>
  );
}
