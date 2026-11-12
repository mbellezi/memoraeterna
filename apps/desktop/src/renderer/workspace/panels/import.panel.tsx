import { useCallback, useEffect, useRef, useState } from "react";
import { formatObjectAddress, type ObjectSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { SourceDetail } from "../../../shared/ipc";
import { ImportView } from "../../components/ImportView";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorState } from "../../components/ui/error-state";
import { NoteLeaveDialog, type LeaveCopy } from "../../components/note-page/NoteLeaveDialog";
import { LoadingState } from "../../components/ui/skeleton";
import type { PanelLoadState } from "../PanelFrame";
import type { PanelProps } from "../PanelStack";
import { parseViewAddress } from "../route";
import { ImportScroller, ImportSkeleton } from "./import-scroller";

/**
 * The advanced import panel (D32, T150): the old import wizard hosted in the panel stack until F6
 * rebuilds it. It is where the structure editor, enrichment, manual entry, containers and the
 * editing of a source live; Adicionar's "Mais opções de importação…" opens it, and so does the
 * Source panel's "Editar" (`memora://import?source=<id>` edits that source). The wizard keeps its
 * own form, its own calls and its own look; this module only reads what it needs to start (the
 * app's settings and, to edit, the source), says its load state to the frame and, after a save,
 * replaces itself with the saved Source.
 */

export const kind = "import";

export function match(address: string): boolean {
  return parseViewAddress(address)?.view === "import";
}

export function title(_summary: ObjectSummary | null, t: Translator): string {
  return t("addFlow.importPanel.title");
}

/** An old wizard has no compact form: where it would be the previous panel it is a spine. */
export const compact = false;

const sourceIdOf = (address: string): string | null => {
  const view = parseViewAddress(address);
  return view?.view === "import" && view.sourceId ? view.sourceId : null;
};

type Data =
  | { status: "loading" }
  | { status: "error" }
  | { status: "gone" }
  | { status: "ready"; metadataEnrichmentEnabled: boolean; source: SourceDetail | null };

/** What the wizard needs to start; read once per address and again on "Tentar de novo". */
function useImportData(sourceId: string | null, active: boolean) {
  const [attempt, setAttempt] = useState(0);
  const key = `${sourceId ?? ""}:${attempt}`;
  // The answer belongs to the read that asked: another address or a retry is loading until it answers.
  const [answer, setAnswer] = useState<{ key: string; data: Data } | null>(null);
  useEffect(() => {
    if (!active) return undefined;
    let live = true;
    void (async () => {
      let data: Data;
      try {
        // A new import reads only whether the metadata lookup is on; if that read fails the wizard
        // still opens, with the lookup off, so no sentence about editing a source is ever told
        // for an import that has no source.
        const [app, source] = await Promise.all([
          sourceId ? window.app.settings.getApp() : window.app.settings.getApp().catch(() => null),
          sourceId ? window.app.knowledge.getSourceDetail(sourceId) : Promise.resolve(null)
        ]);
        data =
          sourceId && source === null
            ? { status: "gone" }
            : {
                status: "ready",
                metadataEnrichmentEnabled: app?.metadataEnrichmentEnabled ?? false,
                source
              };
      } catch {
        data = { status: "error" };
      }
      if (live) setAnswer({ key, data });
    })();
    return () => {
      live = false;
    };
  }, [sourceId, active, key]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const data: Data = answer?.key === key ? answer.data : { status: "loading" };
  return { data, retry };
}

export const loadStateOf = (data: Data): PanelLoadState =>
  data.status === "ready"
    ? "success"
    : data.status === "gone"
      ? "empty"
      : data.status === "error"
        ? "error"
        : "loading";

function Body({ children }: { children: React.ReactNode }) {
  return <div className="min-w-0 max-w-[57rem]">{children}</div>;
}

const leaveCopy: LeaveCopy = {
  title: "addFlow.importPanel.leave.title",
  description: "addFlow.importPanel.leave.description",
  keep: "addFlow.importPanel.leave.keep",
  discard: "addFlow.importPanel.leave.discard"
};

/**
 * The wizard holds a long form, so the panel registers a leave guard: a close, a Back or a fold
 * into a spine asks first while something was entered (`ImportView` says so through
 * `onDirtyChange`), and never after a save, which replaces the panel on purpose.
 */
function useLeaveGuard(onLeaveGuard: PanelProps["onLeaveGuard"]) {
  const dirty = useRef(false);
  const [leaving, setLeaving] = useState<{ go: () => void } | null>(null);
  useEffect(() => {
    if (!onLeaveGuard) return undefined;
    onLeaveGuard((go) => {
      if (dirty.current) setLeaving({ go });
      else go();
    });
    return () => onLeaveGuard(null);
  }, [onLeaveGuard]);
  const setDirty = useCallback((next: boolean) => {
    dirty.current = next;
  }, []);
  return {
    leaving,
    setDirty,
    keep: () => setLeaving(null),
    discard: () => {
      const go = leaving?.go;
      dirty.current = false;
      setLeaving(null);
      go?.();
    }
  };
}

export function Component({ t, address, active, onState, onOpen, onLeaveGuard }: PanelProps) {
  const sourceId = sourceIdOf(address);
  const { data, retry } = useImportData(sourceId, active);
  const reported = loadStateOf(data);
  useEffect(() => onState(reported), [onState, reported]);
  const guard = useLeaveGuard(onLeaveGuard);

  if (data.status === "loading")
    return (
      <Body>
        <LoadingState t={t}>
          <ImportSkeleton />
        </LoadingState>
      </Body>
    );
  if (data.status === "error")
    return (
      <Body>
        <ErrorState
          t={t}
          message={t("addFlow.importPanel.errors.open")}
          kept={t("addFlow.importPanel.errors.kept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={retry}
        />
      </Body>
    );
  if (data.status === "gone")
    return (
      <Body>
        <EmptyState
          className="max-w-(--measure)"
          headline={t("addFlow.importPanel.gone.title")}
          action={
            <Button variant="secondary" onClick={() => onOpen("memora://library")}>
              {t("addFlow.importPanel.gone.action")}
            </Button>
          }
        >
          {t("addFlow.importPanel.gone.body")}
        </EmptyState>
      </Body>
    );
  return (
    <>
      <ImportScroller>
        <ImportView
          t={t}
          active={active}
          metadataEnrichmentEnabled={data.metadataEnrichmentEnabled}
          {...(data.source ? { editing: data.source } : {})}
          onDirtyChange={guard.setDirty}
          // A saved source replaces this panel: the person lands on it, with its generation strip.
          onSaved={(sourceItemId) => {
            guard.setDirty(false);
            onOpen(formatObjectAddress({ kind: "source", id: sourceItemId }), { replace: true });
          }}
        />
      </ImportScroller>
      {guard.leaving ? (
        <NoteLeaveDialog
          t={t}
          copy={leaveCopy}
          onKeepEditing={guard.keep}
          onDiscard={guard.discard}
        />
      ) : null}
    </>
  );
}
