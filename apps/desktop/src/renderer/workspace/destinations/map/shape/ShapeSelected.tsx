import { useId } from "react";
import { ArrowRight, ZoomIn } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { countLabel } from "../../../../components/topic-page/topic-page-model";
import { HealthMark } from "./health-marks";
import { growthDays } from "./shape-growth";
import type { PanelModel } from "./shape-model";

export interface ShapeSelectedProps {
  t: Translator;
  model: PanelModel;
  onOpenTopic: (topicId: string) => void;
  onZoomIn: () => void;
  /** A proposal for this topic waits in the Inbox: the next step is to read it there. */
  onOpenInbox?: (() => void) | undefined;
}

/** "96 notas · 7 subtópicos diretos · +2 notas em 7 dias": what the selected block holds. */
export function selectedLine(t: Translator, model: PanelModel): string {
  const number = new Intl.NumberFormat(t.locale);
  const parts = [countLabel(t, "notes", model.items)];
  if (model.subtopics > 0)
    parts.push(
      model.subtopics === 1
        ? t("map.selected.subtopicsOne")
        : t("map.selected.subtopics", { values: { count: number.format(model.subtopics) } })
    );
  if (model.growth !== null)
    parts.push(
      t("map.selected.growth", {
        values: { growth: model.growthText, days: number.format(growthDays) }
      })
    );
  return parts.join(" · ");
}

/** The selected block: what it is, how much it holds, where it sits, and the ways on from here. */
export function ShapeSelected({
  t,
  model,
  onOpenTopic,
  onZoomIn,
  onOpenInbox
}: ShapeSelectedProps) {
  const headingId = useId();
  const unsorted = model.kind === "unsorted";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
        <ObjectKindGlyph kind="topic" className="text-object-topic" />
        {unsorted ? t("topics.shape.panel.selectedUnsorted") : t("map.inspector.selected")}
      </span>
      <h2
        id={headingId}
        className="m-0 font-reading text-2xl font-semibold text-foreground [overflow-wrap:anywhere]"
      >
        {model.title}
      </h2>
      {model.trail.length > 0 ? (
        <p className="m-0 text-sm text-muted-foreground [overflow-wrap:anywhere]">
          {model.trail.join(" › ")}
        </p>
      ) : null}
      <p className="m-0 text-sm text-foreground">{selectedLine(t, model)}</p>
      {model.health || model.mark ? (
        <p className="m-0 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-secondary-foreground">
          {model.health ? <HealthMark t={t} health={model.health} /> : null}
          {model.mark}
        </p>
      ) : null}
      {unsorted ? (
        <p className="m-0 text-sm text-secondary-foreground">
          {t("topics.shape.panel.unsortedNote")}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="primary" onClick={() => onOpenTopic(model.topicId)}>
            {t("topics.shape.panel.open")}
          </Button>
          <Button type="button" disabled={!model.canZoom} onClick={onZoomIn}>
            <ZoomIn aria-hidden="true" />
            {t("topics.shape.panel.zoomIn")}
          </Button>
        </div>
      )}
      {onOpenInbox ? (
        <div className="flex flex-col gap-1 border-t border-border pt-3">
          <h3 className="m-0 text-xs font-semibold text-secondary-foreground">
            {t("map.inspector.next")}
          </h3>
          <Button type="button" variant="link" className="justify-start" onClick={onOpenInbox}>
            {t("map.inspector.nextInbox")}
            <ArrowRight aria-hidden="true" />
          </Button>
        </div>
      ) : null}
    </section>
  );
}
