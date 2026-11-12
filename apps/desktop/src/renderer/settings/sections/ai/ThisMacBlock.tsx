import { useId } from "react";
import { Monitor } from "lucide-react";
import type { HardwareProfileResult } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { SolidCheck } from "../../../components/ui/solid-glyphs";
import { cn } from "../../../lib/cn";
import { InlineAction } from "../../InlineAction";
import type { Load } from "./ai-controller";
import {
  hardwareReasonKeys,
  macFacts,
  macTitleKeys,
  recommendationWhyKeys,
  setupNameKeys
} from "./ai-model";
import { AreaNotice } from "./ai-parts";

/**
 * AI › This Mac (decision 25, informative only): what Memora detected on this computer, the setup
 * that fits it and why. It changes nothing by itself: the line says so, and the only action is to
 * detect again. The block is a registry entry of its own (`ai.thisMac`), so a search result or a link
 * finds it and lights it like a row; it has no control to reset.
 */
export function ThisMacBlock({
  t,
  id,
  heading,
  highlighted,
  load,
  redetecting,
  redetected,
  notice,
  onRetry,
  onRedetect
}: {
  t: Translator;
  /** The registry id, for the link and the search to find it. */
  id: string;
  /** The group's heading id this block is named by. */
  heading: string;
  highlighted: boolean;
  load: Load<HardwareProfileResult>;
  redetecting: boolean;
  redetected: boolean;
  notice: string | undefined;
  onRetry: () => void;
  onRedetect: () => void;
}) {
  return (
    <div
      role="group"
      aria-labelledby={heading}
      data-setting-id={id}
      tabIndex={-1}
      className={cn(
        "relative mt-3 rounded-lg outline-none transition-colors [transition-duration:var(--motion-slow)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        highlighted && "bg-surface-selected [box-shadow:0_0_0_8px_var(--surface-selected)]"
      )}
    >
      {load.status === "loading" ? (
        <LoadingState t={t} className="rounded-lg border border-border bg-surface px-5 py-4">
          <Skeleton className="h-4 w-48" />
          <div className="flex gap-8">
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
          <Skeleton className="h-3 w-4/5" />
        </LoadingState>
      ) : load.status === "error" ? (
        <ErrorState
          t={t}
          message={t("settingsAi.thisMac.error")}
          kept={t("settingsAi.thisMac.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={onRetry}
        />
      ) : (
        <MacCard
          t={t}
          result={load.value}
          redetecting={redetecting}
          redetected={redetected}
          notice={notice}
          onRedetect={onRedetect}
        />
      )}
    </div>
  );
}

function MacCard({
  t,
  result,
  redetecting,
  redetected,
  notice,
  onRedetect
}: {
  t: Translator;
  result: HardwareProfileResult;
  redetecting: boolean;
  redetected: boolean;
  notice: string | undefined;
  onRedetect: () => void;
}) {
  const facts = macFacts(t, result);
  const { recommendation } = result;
  const titleId = useId();
  return (
    <section
      aria-labelledby={titleId}
      className="rounded-lg border border-border bg-surface px-5 py-4"
    >
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1">
        <Monitor aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-secondary-foreground" />
        <div className="min-w-0 flex-1">
          <h4 id={titleId} className="m-0 text-base font-semibold leading-5 text-foreground">
            {t(macTitleKeys[facts.kind])}
          </h4>
          {facts.chip ? (
            <p className="m-0 text-xs leading-5 text-muted-foreground">{facts.chip}</p>
          ) : null}
        </div>
        <span className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-surface px-2 text-xs leading-none text-secondary-foreground">
          {t("settingsAi.thisMac.tag")}
        </span>
      </div>
      <dl className="m-0 mt-3 grid grid-cols-[repeat(auto-fit,minmax(7.5rem,max-content))] gap-x-8 gap-y-3">
        {facts.facts.map((fact) => (
          <div key={fact.label} className="min-w-0">
            <dt className="text-xs leading-5 text-muted-foreground">{t(fact.label)}</dt>
            <dd className="m-0 text-base leading-5 text-foreground tabular-nums">{fact.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 flex gap-3 border-t border-border pt-3 text-sm leading-5">
        <SolidCheck className="mt-0.5 text-success" />
        <div className="min-w-0 [text-wrap:pretty]">
          <p className="m-0">
            <b className="font-semibold">
              {t("settingsAi.thisMac.recommended", {
                values: { setup: t(setupNameKeys[recommendation.recommended]) }
              })}
            </b>{" "}
            {t(recommendationWhyKeys[recommendation.recommended])}
          </p>
          {recommendation.reasons.length > 0 ? (
            <ul className="m-0 mt-1 grid list-none gap-0.5 p-0 text-secondary-foreground">
              {recommendation.reasons.map((reason) => (
                <li key={reason}>{t(hardwareReasonKeys[reason])}</li>
              ))}
            </ul>
          ) : null}
          <p className="m-0 mt-1.5 flex flex-wrap items-baseline gap-x-2 text-xs text-secondary-foreground">
            <span>{t("settingsAi.thisMac.nothingChanges")}</span>
            <InlineAction size="xs" disabled={redetecting} onClick={onRedetect}>
              {redetecting ? t("settingsAi.thisMac.redetecting") : t("settingsAi.thisMac.redetect")}
            </InlineAction>
            {redetected && !redetecting ? (
              <span role="status" className="text-muted-foreground">
                {t("settingsAi.thisMac.redetected")}
              </span>
            ) : null}
          </p>
          <AreaNotice message={notice} className="mt-1" />
        </div>
      </div>
    </section>
  );
}
