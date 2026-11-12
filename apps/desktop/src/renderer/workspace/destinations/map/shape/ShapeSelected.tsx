import { useId, type ReactNode } from "react";
import { ZoomIn } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { HealthMark } from "./health-marks";
import type { PanelModel } from "./shape-model";

export interface ShapeSelectedProps {
  t: Translator;
  model: PanelModel;
  onOpenTopic: (topicId: string) => void;
  onZoomIn: () => void;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-base font-semibold text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

/** The selected block: what it is, how much it holds, where it sits, and the ways on from here. */
export function ShapeSelected({ t, model, onOpenTopic, onZoomIn }: ShapeSelectedProps) {
  const headingId = useId();
  const number = new Intl.NumberFormat(t.locale);
  const unsorted = model.kind === "unsorted";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
          <ObjectKindGlyph kind="topic" className="text-object-topic" />
          {unsorted ? t("topics.shape.panel.selectedUnsorted") : t("topics.shape.panel.selected")}
        </span>
        <h2
          id={headingId}
          className="font-reading text-2xl font-semibold text-foreground [overflow-wrap:anywhere]"
        >
          {model.title}
        </h2>
        {model.trail.length > 0 ? (
          <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]">
            {model.trail.join(" › ")}
          </p>
        ) : null}
        {model.mark ? <p className="text-xs text-secondary-foreground">{model.mark}</p> : null}
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Fact label={t("topics.shape.panel.items")}>{number.format(model.items)}</Fact>
        {unsorted ? null : (
          <>
            <Fact label={t("topics.shape.panel.level")}>{number.format(model.level)}</Fact>
            <Fact label={t("topics.shape.panel.children")}>{model.childrenText}</Fact>
            <Fact label={t("topics.shape.panel.coherence")}>{model.coherenceText}</Fact>
            <Fact label={t("topics.shape.panel.week")}>{model.weekText}</Fact>
            <div className="flex min-w-0 flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">{t("topics.shape.panel.health")}</dt>
              <dd className="pt-1">
                {model.health ? <HealthMark t={t} health={model.health} /> : null}
              </dd>
            </div>
          </>
        )}
      </dl>
      {unsorted ? (
        <p className="text-sm text-secondary-foreground">{t("topics.shape.panel.unsortedNote")}</p>
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
    </section>
  );
}
