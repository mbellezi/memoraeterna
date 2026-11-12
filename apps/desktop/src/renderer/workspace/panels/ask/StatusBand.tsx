import type { ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { Kbd } from "../../../components/ui/kbd";
import { SolidTriangle } from "../../../components/ui/solid-glyphs";
import { cn } from "../../../lib/cn";
import type { AnswerStage } from "./answer-model";
import { MetaClauses } from "./MetaClauses";

/**
 * The status band of the Question page (design record §6.4): one line for the stage the Ask is in,
 * never folded into another (retrieving, answering, waiting for the provider), and the line the
 * answer ends on: when it was answered with "Refazer", that it may be outdated, or that the person
 * stopped it with "Continuar". It is exactly the reading measure, on the selected surface. The
 * stage is on the band (`data-stage`), so a journey reads where the Ask is without parsing words.
 */

export interface StatusBandProps {
  t: Translator;
  stage: AnswerStage;
  /** The distinct sources the answer has cited so far (or cites). */
  sources: number;
  /** When a stored answer was written, as ISO text. */
  completedAt?: string | undefined;
  /** A cited source changed after the answer was stored. */
  stale: boolean;
  /** Stop is possible (the request is known and not stopping already). */
  canStop: boolean;
  /** Ask again is possible. */
  canAskAgain: boolean;
  onStop: () => void;
  onAskAgain: () => void;
  /** The last action failed: said once, quietly, under the band. */
  actionFailed?: "stop" | "again" | null;
}

const plural = (
  t: Translator,
  count: number,
  one: Parameters<Translator>[0],
  many: Parameters<Translator>[0]
) => t(count === 1 ? one : many, { values: { count } });

/**
 * The day an answer was written, as the person's language says it without its filler words:
 * "11 nov" for pt-BR, "Nov 11" for English.
 */
export function answerDate(t: Translator, iso: string | undefined): string {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(t.locale, { day: "numeric", month: "short" })
    .formatToParts(date)
    .filter((part) => part.type === "day" || part.type === "month")
    .map((part) => part.value.replace(/\.$/, ""))
    .join("\u00a0");
}

function Dots() {
  return (
    <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-1">
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          style={{ animationDelay: `${dot * 160}ms` }}
          className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse motion-reduce:opacity-70"
        />
      ))}
    </span>
  );
}

export function StatusBand(props: StatusBandProps) {
  const { t, stage, sources, completedAt, stale, canStop, canAskAgain, onStop, onAskAgain } = props;
  const live = stage === "retrieving" || stage === "answering" || stage === "waitingForProvider";
  const date = answerDate(t, completedAt);

  // A stored answer whose source changed says so as the band's own line, with the date after it.
  const outdated = stale && stage === "done";
  let lead: ReactNode;
  const rest: ReactNode[] = [];
  let action: ReactNode = null;
  if (stage === "retrieving") {
    lead = t("askPanel.band.retrieving");
    rest.push(
      <span className="text-secondary-foreground">{t("askPanel.band.retrievingHint")}</span>
    );
  } else if (stage === "answering") {
    lead = t("askPanel.band.answering");
    if (sources > 0)
      rest.push(
        <span className="text-secondary-foreground">
          {plural(
            t,
            sources,
            "askPanel.band.answeringSourcesOne",
            "askPanel.band.answeringSourcesMany"
          )}
        </span>
      );
  } else if (stage === "waitingForProvider") {
    lead = t("askPanel.band.waiting");
    rest.push(<span className="text-secondary-foreground">{t("askPanel.band.waitingHint")}</span>);
  } else if (stage === "canceled") {
    lead = t("askPanel.band.canceled");
    if (canAskAgain)
      action = (
        <Button variant="secondary" onClick={onAskAgain}>
          {t("askPanel.band.continue")}
        </Button>
      );
  } else {
    lead = date ? t("askPanel.band.doneOn", { values: { date } }) : t("askPanel.answer.label");
    if (outdated)
      rest.unshift(
        <span key="done" className="text-secondary-foreground">
          {lead}
        </span>
      );
    if (sources > 0)
      rest.push(
        <span className="text-secondary-foreground">
          {plural(t, sources, "askPanel.band.sourcesOne", "askPanel.band.sourcesMany")}
        </span>
      );
    if (canAskAgain)
      action = (
        <Button variant="link" onClick={onAskAgain} className="h-7 min-h-0 px-2">
          {t("askPanel.band.again")}
        </Button>
      );
  }
  if (outdated)
    lead = (
      <span className="inline-flex items-start gap-1.5">
        <SolidTriangle className="mt-0.5 text-warning" />
        <span>{t("askPanel.band.stale")}</span>
      </span>
    );
  if (live && canStop)
    action = (
      <Button variant="secondary" onClick={onStop} className="h-7 min-h-0 gap-2 px-2.5">
        {t("askPanel.band.stop")}
        <Kbd>Esc</Kbd>
      </Button>
    );

  return (
    <div className="grid min-w-0 max-w-(--measure) gap-1.5">
      <div
        data-stage={stage}
        role={live ? "status" : undefined}
        className={cn(
          "flex min-h-10 min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-surface-selected px-3 py-2 text-sm text-foreground"
        )}
      >
        {live ? <Dots /> : null}
        <span className="min-w-0 flex-1 basis-48">
          <MetaClauses
            clauses={[
              <strong key="lead" className="font-semibold">
                {lead}
              </strong>,
              ...rest
            ]}
          />
        </span>
        {action}
      </div>
      {props.actionFailed ? (
        <p role="status" className="m-0 text-xs text-secondary-foreground">
          {t(props.actionFailed === "stop" ? "askPanel.failed.stop" : "askPanel.failed.again")}
        </p>
      ) : null}
    </div>
  );
}
