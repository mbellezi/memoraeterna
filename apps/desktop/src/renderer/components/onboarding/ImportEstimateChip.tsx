import { useEffect, useMemo, useState } from "react";
import { Coins, LoaderCircle, TriangleAlert } from "lucide-react";
import type { ProcessingPlanRequest } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import {
  loadImportEstimate,
  type ChipState,
  type ChunkBasis,
  type EstimateApi
} from "./import-estimate";

const productApi = (): EstimateApi => window.app.budget;

/**
 * What the import plan costs on the route that writes (F4 D14): the money for a priced model, "not
 * metered" for a subscription, nothing for a model on this computer. It follows the plan and the
 * size of the source, reads once per change and says so while it waits; a failed read can be tried
 * again and never stops the import.
 */
export function ImportEstimateChip({
  t,
  plan,
  basis,
  api = productApi
}: {
  t: Translator;
  plan: ProcessingPlanRequest;
  basis: ChunkBasis;
  api?: () => EstimateApi;
}) {
  const [attempt, setAttempt] = useState(0);
  const [answer, setAnswer] = useState<{ key: string; state: ChipState } | null>(null);
  const chunks = basis.kind === "unknown" ? 0 : basis.chunks;
  const key = useMemo(
    () =>
      `${attempt}|${t.locale}|${basis.kind}|${chunks}|${plan.preset}|${plan.requestedStages.join(",")}`,
    [attempt, basis.kind, chunks, plan.preset, plan.requestedStages, t.locale]
  );
  useEffect(() => {
    let live = true;
    void loadImportEstimate(api(), plan, basis, t.locale).then((state) => {
      if (live) setAnswer({ key, state });
    });
    return () => {
      live = false;
    };
  }, [api, basis, key, plan, t.locale]);
  const state: ChipState = answer?.key === key ? answer.state : { status: "loading" };

  return (
    <section
      aria-label={t("onboarding.estimate.title")}
      className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-soft px-3 py-2 text-xs text-secondary-foreground"
    >
      {state.status === "loading" ? (
        <LoaderCircle
          className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin motion-reduce:animate-none"
          aria-hidden="true"
        />
      ) : state.status === "error" ? (
        <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
      ) : (
        <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      )}
      <div className="grid min-w-0 flex-1 gap-0.5" role="status" aria-live="polite">
        {state.status === "loading" ? (
          <p>{t("onboarding.estimate.loading")}</p>
        ) : state.status === "error" ? (
          <p>{t("onboarding.estimate.error")}</p>
        ) : (
          state.lines.map((line) => (
            <p key={line.key}>{t(line.key, line.values ? { values: line.values } : undefined)}</p>
          ))
        )}
      </div>
      {state.status === "error" ? (
        <Button type="button" variant="link" onClick={() => setAttempt((count) => count + 1)}>
          {t("onboarding.estimate.retry")}
        </Button>
      ) : null}
    </section>
  );
}
