import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { parseObjectAddress, type ObjectSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { EmptyState } from "../../components/ui/empty-state";
import { ErrorState } from "../../components/ui/error-state";
import { Button } from "../../components/ui/button";
import { LoadingState, Skeleton, SkeletonLines } from "../../components/ui/skeleton";
import { recordView } from "../../lib/view-history";
import type { PanelLoadState } from "../PanelFrame";
import type { PanelProps } from "../PanelStack";
import { SourceController, type SourceSnapshot } from "./source/source-controller";
import { SourcePanelView } from "./source/SourcePanelView";
import { SourceStripSkeleton } from "./source/SourceStrip";
import { stripModel } from "./source/source-strip-model";

/**
 * The Source panel (design record 6.2, T140): one source with its live generation strip, its notes
 * and where each one sits in the tree, its connections, its text with the cited passage marked, and
 * its details. `panels/*.panel.tsx` registers by file: this module exports the four parts the stack
 * needs. The page reads through `SourceController` (the source, the strip's values, the notes'
 * places) and follows the bus; it holds no timer and asks nothing while hidden.
 */

export const kind = "source";

/** Any address of a source, with or without an anchor (`#passage`, `#span`, `#relation`). */
export function match(address: string): boolean {
  return parseObjectAddress(address)?.kind === "source";
}

export function title(summary: ObjectSummary | null): string {
  return summary?.title ?? "";
}

const sourceIdOf = (address: string): string | null => {
  const parsed = parseObjectAddress(address);
  return parsed?.kind === "source" ? parsed.id : null;
};

/** The state the frame writes for a snapshot of the controller. */
export function loadStateOf(snapshot: SourceSnapshot): PanelLoadState {
  switch (snapshot.load.status) {
    case "loading":
      return "loading";
    case "error":
      return "error";
    case "missing":
      return "empty";
    case "ready":
      return "success";
  }
}

function PanelLoading({ t, compact }: { t: Translator; compact: boolean }) {
  return (
    <LoadingState t={t} className="max-w-(--measure)">
      <Skeleton className="h-6 w-4/5 max-w-(--measure) sm:w-3/5" />
      <Skeleton className="w-2/5" />
      {compact ? null : <SourceStripSkeleton />}
      <SkeletonLines lines={compact ? 3 : 4} className="mt-2 max-w-(--measure)" />
    </LoadingState>
  );
}

export function Component({
  t,
  address,
  mode,
  active,
  onState,
  onPlace,
  onOpen,
  current
}: PanelProps) {
  const sourceId = sourceIdOf(address);
  const [controller] = useState(
    () =>
      new SourceController({
        api: () => window.app,
        record: recordView
      })
  );
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);

  useEffect(() => {
    if (sourceId) controller.show(sourceId, active);
  }, [controller, sourceId, active]);
  useEffect(() => () => controller.dispose(), [controller]);

  const reported: PanelLoadState = sourceId ? loadStateOf(snapshot) : "error";
  useEffect(() => onState(reported), [onState, reported]);

  // While the source is being made its place is a guess the ribbon says so; afterwards it is placed.
  const strip = snapshot.strip.status === "ready" ? snapshot.strip.progress : null;
  const unfinished = useMemo(() => {
    const kindOfStrip = stripModel(strip, snapshot.readAt).kind;
    return kindOfStrip === "running" || kindOfStrip === "paused" || kindOfStrip === "needsYou";
  }, [strip, snapshot.readAt]);
  useEffect(
    () => onPlace({ place: unfinished ? "tentativeSource" : "placed" }),
    [onPlace, unfinished]
  );

  const want = useCallback((ids: readonly string[]) => controller.want(ids), [controller]);
  const handlers = useMemo(
    () => ({
      onOpen,
      onRetryStrip: () => controller.retryStrip(),
      onRun: (request: "notes" | "retry") => void controller.run(request),
      want
    }),
    [controller, onOpen, want]
  );

  if (reported === "loading") return <PanelLoading t={t} compact={mode === "compact"} />;
  if (reported === "error")
    return (
      <ErrorState
        t={t}
        className="max-w-(--measure)"
        message={t("sourcePage.errors.open")}
        kept={t("sourcePage.errors.kept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={() => controller.retry()}
      />
    );
  if (snapshot.load.status !== "ready")
    return (
      <EmptyState
        className="max-w-(--measure)"
        headline={t("sourcePage.gone.title")}
        action={
          <Button variant="secondary" onClick={() => onOpen("memora://library")}>
            {t("sourcePage.gone.action")}
          </Button>
        }
      >
        {t("sourcePage.gone.body")}
      </EmptyState>
    );
  return (
    <SourcePanelView
      t={t}
      address={address}
      mode={mode}
      current={current}
      detail={snapshot.load.detail}
      snapshot={snapshot}
      handlers={handlers}
    />
  );
}
