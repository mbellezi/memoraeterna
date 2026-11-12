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
   * The directional phrase ("this note supports"), shown in place of the word from 480 px of the
   * page's container, wrapped at a word when the column is narrow ("this note / supports"), so a
   * narrow panel still says who supports whom; narrower than that, the word.
   */
  phrase?: string | null;
}) {
  const view = relationTypeView(type);
  return (
    <span
      className={cn(
        "inline-flex gap-1.5 text-xs font-semibold whitespace-nowrap",
        // A phrase can take two lines: the glyph stays level with the first.
        phrase ? "items-start [&>svg]:mt-0.5" : "items-center",
        stanceTextClass[view.stance],
        className
      )}
    >
      <StanceGlyph stance={view.stance} size={size} />
      {phrase ? (
        <>
          <span className="@min-[480px]:hidden">{t(view.wordKey)}</span>
          <span className="hidden whitespace-normal @min-[480px]:inline">{phrase}</span>
        </>
      ) : linked ? (
        t("notePage.linkedStance", { values: { type: t(view.wordKey) } })
      ) : (
        t(view.wordKey)
      )}
    </span>
  );
}
