import { CircleCheck, OctagonAlert, TriangleAlert } from "lucide-react";
import type { TopicHealth } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import type { HealthTone } from "../../../../components/topic-page/topic-page-model";
import { shapeHealth } from "./shape-model";

/** The Map's short size words, which fit the 124 px column of its table. */
export const mapHealthKeys = {
  good: "map.health.good",
  attention: "map.health.attention",
  violation: "map.health.violation"
} as const satisfies Record<TopicHealth, MessageKey>;

export const toneClass: Record<HealthTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
};

export const toneIcon: Record<HealthTone, typeof CircleCheck> = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert
};

/** Health as a glyph and a word, so colour is never the only signal. */
export function HealthMark({
  t,
  health,
  short = false,
  capitalized = false,
  className
}: {
  t: Translator;
  health: TopicHealth;
  /** The Map's size words ("equilibrado", "grande demais") instead of the health words. */
  short?: boolean;
  /** Starts the word with a capital: the inspector says it as a sentence, the table as a cell. */
  capitalized?: boolean;
  className?: string | undefined;
}) {
  const view = shapeHealth[health];
  const Icon = toneIcon[view.tone];
  const word = t(short ? mapHealthKeys[health] : view.key);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        toneClass[view.tone],
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {capitalized ? word.charAt(0).toLocaleUpperCase(t.locale) + word.slice(1) : word}
    </span>
  );
}
