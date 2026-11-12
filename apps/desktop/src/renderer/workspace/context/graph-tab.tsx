import { useEffect, useReducer, useState } from "react";
import { Link2, Network } from "lucide-react";
import type { ObjectNeighborhood } from "@app/domain";
import type { Translator } from "@app/i18n";

import { EgoGraphBody } from "../../components/graph/EgoGraph";
import { buildEgoGraphModel } from "../../components/graph/ego-graph-model";
import {
  initialReadState,
  readKey,
  readReducer,
  shouldRead,
  type Load
} from "../../components/graph/ego-graph-reads";
import { isWebGLAvailable } from "../../components/graph/webgl";
import { Button } from "../../components/ui/button";
import { useObjectChanged } from "../../lib/object-events";
import type { PanelLoadState } from "../PanelFrame";
import { formatView } from "../route";
import {
  ContextEmpty,
  ContextError,
  ContextLink,
  ContextFrame,
  ContextHeading,
  StanceLegend,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";

/**
 * The Grafo tab (design record §5.6): for a note, the DOI ego graph (`objects.neighborhood`, which
 * stays notes-only, D11) with the stance legend; for any other kind the legend and a way to the Map
 * scoped to the object. The graph is drawn only where this window can draw it; the list in
 * Conexões has the same information, and the tab says so.
 */
export const tab = "graph";
export const surface = "context-graph";

/** The state of the graph tab for a note: its read, and whether there is anything to draw. */
export function graphState(load: Load): PanelLoadState {
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  const model = buildEgoGraphModel(load.answer);
  return model.nodes.length <= 1 || model.edges.length === 0 ? "empty" : "success";
}

export function GraphTab(props: ContextTabProps) {
  return props.kind === "note" ? <NoteGraph {...props} /> : <OtherGraph {...props} />;
}
export { GraphTab as Component };

/** The body of the note's graph for a read: loading, error, the graph, or why it is not drawn. */
export function NoteGraphView({
  t,
  load,
  webgl,
  reread = "idle",
  onDepth,
  onRetry,
  onOpenNote,
  onUnavailable,
  onShowList,
  onLink
}: {
  t: Translator;
  load: Load;
  /** This window can draw the graph; false shows the words instead of the picture. */
  webgl: boolean;
  reread?: "idle" | "pending" | "failed";
  onDepth: (depth: 1 | 2) => void;
  onRetry: () => void;
  onOpenNote: (noteId: string) => void;
  onUnavailable: () => void;
  onShowList: () => void;
  /** Starts linking this note to another: what an empty graph offers (the same as an empty Connections). */
  onLink?: () => void;
}) {
  const state = graphState(load);
  return (
    <ContextFrame surface={surface} state={state}>
      <ContextHeading
        title={t("contextPanel.headings.graph.note.title")}
        description={t("contextPanel.headings.graph.note.description")}
      />
      {load.status === "error" ? (
        <ContextError t={t} message="contextPanel.errors.graph" kept="note" onRetry={onRetry} />
      ) : state === "empty" ? (
        <ContextEmpty
          action={
            onLink ? (
              <Button variant="secondary" onClick={onLink}>
                <Link2 aria-hidden="true" />
                {t("contextPanel.connections.link")}
              </Button>
            ) : (
              <ContextLink onClick={onShowList}>{t("contextPanel.graph.showList")}</ContextLink>
            )
          }
        >
          {t("contextPanel.graph.empty")}
        </ContextEmpty>
      ) : state === "success" && !webgl ? (
        <div className="grid justify-items-start gap-2">
          <p role="status" className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
            {t("contextPanel.graph.unavailable")}
          </p>
          <ContextLink onClick={onShowList}>{t("contextPanel.graph.showList")}</ContextLink>
        </div>
      ) : (
        <EgoGraphBody
          t={t}
          load={load}
          reread={reread}
          onDepth={onDepth}
          onRetry={onRetry}
          onOpenNote={onOpenNote}
          onUnavailable={onUnavailable}
          onShowList={onShowList}
        />
      )}
    </ContextFrame>
  );
}

function NoteGraph(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onTab, onLink, onState, onCount } = props;
  const [webgl, setWebgl] = useState(() => isWebGLAvailable());
  const [state, dispatch] = useReducer(readReducer, initialReadState);
  const [revision, setRevision] = useState(0);
  // A change to the note (a relation kept, removed or found) draws the graph again.
  useObjectChanged([address], () => setRevision((value) => value + 1), active);

  useEffect(() => {
    if (!active) return undefined;
    const key = readKey(id, revision, state.request);
    // A failed read stays visible and retryable: only a Retry, or a change, reads again.
    if (!shouldRead(state.failedKey, key)) return undefined;
    let live = true;
    dispatch({ type: "started" });
    const read: Promise<ObjectNeighborhood | null> =
      typeof window === "undefined"
        ? Promise.reject(new Error("window.app is not available"))
        : window.app.objects.neighborhood({
            objectId: id,
            objectTypes: ["note"],
            depth: state.wanted
          });
    read
      .then((answer) => {
        if (live) dispatch({ type: "answered", key, answer });
      })
      .catch(() => {
        if (live) dispatch({ type: "failed", key });
      });
    return () => {
      live = false;
    };
  }, [active, id, revision, state.request, state.wanted, state.failedKey]);

  useReportedState(graphState(state.load), onState);
  useReportedCount(null, onCount);
  return (
    <NoteGraphView
      t={t}
      load={state.load}
      webgl={webgl}
      reread={state.reread}
      onDepth={(depth) => dispatch({ type: "depth", depth })}
      onRetry={() => dispatch({ type: "retry" })}
      onOpenNote={(noteId) => onOpen(`memora://note/${noteId}`)}
      onUnavailable={() => setWebgl(false)}
      onShowList={() => onTab?.("connections")}
      {...(onLink ? { onLink: () => onLink(address) } : {})}
    />
  );
}

/** Any other kind: the legend and the way to the Map, scoped to the object (T143). */
function OtherGraph({ t, kind, id, onOpen, onState, onCount }: ContextTabProps) {
  useReportedState("success", onState);
  useReportedCount(null, onCount);
  return (
    <ContextFrame surface={surface} state="success">
      <ContextHeading
        title={t("contextPanel.headings.graph.other.title")}
        description={t("contextPanel.headings.graph.other.description")}
      />
      <p className="m-0 text-xs font-semibold text-secondary-foreground">
        {t("contextPanel.graph.legend")}
      </p>
      <StanceLegend t={t} />
      <div className="mt-4">
        <Button
          variant="secondary"
          onClick={() =>
            onOpen(formatView({ view: "map", lens: "relations", scope: { kind, id } }))
          }
        >
          <Network aria-hidden="true" />
          {t("contextPanel.graph.openMap")}
        </Button>
      </div>
    </ContextFrame>
  );
}
