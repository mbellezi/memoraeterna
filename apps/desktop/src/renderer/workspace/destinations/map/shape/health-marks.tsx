import { CircleCheck, OctagonAlert, TriangleAlert } from "lucide-react";
import type { TopicHealth } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import type { HealthTone } from "../../../../components/topic-page/topic-page-model";
import { shapeHealth } from "./shape-model";

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
  className
}: {
  t: Translator;
  health: TopicHealth;
  className?: string | undefined;
}) {
  const view = shapeHealth[health];
  const Icon = toneIcon[view.tone];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
        toneClass[view.tone],
        className
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t(view.key)}
    </span>
  );
}
