import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode
} from "react";
import type Sigma from "sigma";
import { Maximize2, Minus, Plus, RefreshCw } from "lucide-react";
import type { ObjectNeighborhood } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { relationTypeView } from "../../lib/relation-stance";
import { useStableCallback } from "../../lib/stable-callback";
import { RelationStanceLabel } from "../RelationStanceLabel";
import { Button } from "../ui/button";
import { buildRenderer, createDisposer } from "./disposal";
import {
  initialReadState,
  readKey,
  readReducer,
  shouldRead,
  type Load,
  type Reread
} from "./ego-graph-reads";
import {
  egoCursorItems,
  buildEgoGraphModel,
  egoEdgeDescription,
  egoNodeDescription,
  moveEgoCursor,
  type EgoCursorItem,
  type EgoGraphModel
} from "./ego-graph-model";
import {
  buildEgoSigmaGraph,
  edgeDisplay,
  egoArrowOptions,
  nodeDisplay,
  type EgoGraph as EgoSigmaGraph,
  type EgoTarget
} from "./ego-graph-sigma";
import { readGraphPalette, watchGraphPalette } from "./graph-tokens";
import { drawHaloLabel } from "./labels";
import { GraphHoverIntent, type GraphHoverTarget } from "./interaction";
import { KnowledgeGraphLayout } from "./layout";
import { defaultGraphForceSettings, graphLayoutRadius } from "./layout-contract";
import { LineSample } from "./LineSamples";
import {
  graphTypography,
  positionOverlayWithinViewport,
  relationHitAreaScreenThickness,
  zoomCompensatedEdgeSize
} from "./view-model";
import { isWebGLAvailable } from "./webgl";

/** The graph's own forces: a small neighbourhood wants shorter links than a whole library. */
const egoForces = { ...defaultGraphForceSettings, linkDistance: 42, repulsion: 70 };

export interface EgoGraphProps {
  t: Translator;
  noteId: string;
  /** Grows when the page read the note's relations again (a push, a review): the graph reads again. */
  revision: number;
  /** False while the page is hidden: nothing loads. */
  active: boolean;
  onOpenNote: (noteId: string) => void;
  /** This window cannot draw the graph (no WebGL, or the renderer would not start): the host shows the list, with a notice. */
  onUnavailable: () => void;
  onShowList: () => void;
}

/**
 * The Note page's relation graph (F3 D43, R30): the note, its strongest related notes and, on a
 * toggle, theirs, read through `objects.neighborhood`. Loading, empty and error states; a note
 * opens its note; a relation shows a compact card on hover or keyboard focus. The List tab is the
 * text alternative, and without WebGL the host falls back to it. Another note is another graph: the
 * host gives each note its own (`key`), so nothing of the last one is read as this one's.
 */
export function EgoGraph(props: EgoGraphProps) {
  const { t, noteId, revision, active } = props;
  const [webgl] = useState(() => isWebGLAvailable());
  const [state, dispatch] = useReducer(readReducer, initialReadState);
  const onUnavailable = useStableCallback(props.onUnavailable);

  useEffect(() => {
    if (!webgl) onUnavailable();
  }, [webgl, onUnavailable]);

  useEffect(() => {
    if (!webgl || !active) return;
    const key = readKey(noteId, revision, state.request);
    // A failed load stays visible and retryable: only a Retry, or another revision, reads again.
    if (!shouldRead(state.failedKey, key)) return;
    let live = true;
    dispatch({ type: "started" });
    window.app.objects
      .neighborhood({ objectId: noteId, objectTypes: ["note"], depth: state.wanted })
      .then((answer) => {
        if (live) dispatch({ type: "answered", key, answer });
      })
      .catch(() => {
        if (live) dispatch({ type: "failed", key });
      });
    return () => {
      live = false;
    };
  }, [webgl, active, noteId, revision, state.request, state.wanted, state.failedKey]);

  if (!webgl) return null;
  return (
    <EgoGraphBody
      t={t}
      load={state.load}
      reread={state.reread}
      onDepth={(depth) => dispatch({ type: "depth", depth })}
      onRetry={() => dispatch({ type: "retry" })}
      onRetryReread={() => dispatch({ type: "retryReread" })}
      onOpenNote={props.onOpenNote}
      onUnavailable={onUnavailable}
      onShowList={props.onShowList}
    />
  );
}

/**
 * The states of the graph (loading, error with Retry, ready), apart from how the answer is read, so
 * each can be drawn and tested on its own.
 */
export function EgoGraphBody({
  t,
  load,
  reread = "idle",
  onDepth,
  onRetry,
  onRetryReread = onRetry,
  onOpenNote,
  onUnavailable,
  onShowList
}: {
  t: Translator;
  load: Load;
  reread?: Reread;
  onDepth: (depth: 1 | 2) => void;
  onRetry: () => void;
  onRetryReread?: () => void;
  onOpenNote: (noteId: string) => void;
  onUnavailable: () => void;
  onShowList: () => void;
}) {
  if (load.status === "loading")
    return (
      <div role="status" aria-busy="true" className="h-88 rounded-lg bg-soft">
        <span className="sr-only">{t("notePage.graph.loading")}</span>
      </div>
    );
  if (load.status === "error")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-foreground">{t("notePage.graph.error")}</p>
        <Button type="button" onClick={onRetry}>
          <RefreshCw aria-hidden="true" />
          {t("shell.actions.retry")}
        </Button>
      </div>
    );
  return (
    <EgoGraphView
      t={t}
      answer={load.answer}
      // The toggle says what is drawn, not what was asked for: a failed reread leaves both as they were.
      depth={load.answer.depth}
      reread={reread}
      onDepth={onDepth}
      onRetryReread={onRetryReread}
      onOpenNote={onOpenNote}
      onUnavailable={onUnavailable}
      onShowList={onShowList}
    />
  );
}

export function EgoGraphView({
  t,
  answer,
  depth,
  reread,
  onDepth,
  onRetryReread,
  onOpenNote,
  onUnavailable,
  onShowList
}: {
  t: Translator;
  answer: ObjectNeighborhood;
  depth: 1 | 2;
  reread: Reread;
  onDepth: (depth: 1 | 2) => void;
  onRetryReread: () => void;
  onOpenNote: (noteId: string) => void;
  onUnavailable: () => void;
  onShowList: () => void;
}) {
  const model = useMemo(() => buildEgoGraphModel(answer), [answer]);
  const empty = model.nodes.length <= 1 || model.edges.length === 0;
  const hintId = useId();
  const pending = reread === "pending";
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button
          type="button"
          variant="secondary"
          aria-pressed={depth === 2}
          aria-busy={pending || undefined}
          className={cn(pending && "cursor-progress")}
          // A second press while the read is in flight would only ask for the same thing again.
          onClick={() => {
            if (!pending) onDepth(depth === 2 ? 1 : 2);
          }}
        >
          {t("notePage.graph.depthTwo")}
        </Button>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t("notePage.graph.counts", {
            values: { notes: model.nodes.length, relations: model.edges.length }
          })}
        </span>
        <Button type="button" variant="link" className="ml-auto" onClick={onShowList}>
          {t("notePage.graph.showList")}
        </Button>
      </div>
      {reread === "failed" ? (
        <div role="status" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.graph.rereadError")}</p>
          <Button type="button" onClick={onRetryReread}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {empty ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("notePage.graph.empty")}
        </p>
      ) : (
        <>
          <EgoGraphCanvas
            t={t}
            model={model}
            hintId={hintId}
            onOpenNote={onOpenNote}
            onUnavailable={onUnavailable}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {t("notePage.graph.keyboardHint")}
          </p>
          <EgoLegend t={t} model={model} />
          {model.truncated ? (
            <p className="text-xs text-muted-foreground">
              {t("notePage.graph.truncated", {
                values: { shown: model.drawnNeighbours, total: model.neighbourTotal }
              })}
            </p>
          ) : null}
          {model.omittedEdges > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t("notePage.graph.omitted", { values: { count: model.omittedEdges } })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/** Words for every line style and stance on the canvas: colour is never the only signal. */
function EgoLegend({ t, model }: { t: Translator; model: EgoGraphModel }) {
  return (
    <section aria-label={t("notePage.graph.legend")} className="flex flex-col gap-1.5">
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-secondary-foreground">
        {model.stances.map((stance) => (
          <li key={stance}>
            <RelationStanceLabel type={model.stanceTypes[stance] ?? "related"} t={t} />
          </li>
        ))}
      </ul>
      <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-secondary-foreground">
        {model.hasKept ? (
          <li className="inline-flex items-center gap-2">
            <LineSample suggested={false} />
            {t("notePage.graph.legendKept")}
          </li>
        ) : null}
        {model.hasSuggestions ? (
          <li className="inline-flex items-center gap-2">
            <LineSample suggested />
            {t("notePage.graph.legendSuggested")}
          </li>
        ) : null}
        {model.hasArrows ? (
          <li className="inline-flex items-center gap-2">
            <LineSample suggested={false} arrow />
            {t("notePage.graph.legendArrow")}
          </li>
        ) : null}
        <li>{t("notePage.graph.legendFocus")}</li>
      </ul>
    </section>
  );
}

interface CardTarget {
  type: "node" | "edge";
  id: string;
  /** Where the card sits, beside the pointer and inside the canvas; null for one the keyboard opened. */
  place: { x: number; y: number } | null;
}

const cardSize = { width: 296, height: 120 };

/** Where a card opened at the pointer sits: beside it, kept inside the canvas. */
function cardPlace(renderer: Sigma, x: number, y: number): { x: number; y: number } {
  return positionOverlayWithinViewport({ x, y }, cardSize, renderer.getDimensions());
}

/** Why a built graph stopped being drawn: its layout could not be calculated, or its WebGL context was lost. */
type Failure = "layout" | "context";

function EgoGraphCanvas({
  t,
  model,
  hintId,
  onOpenNote,
  onUnavailable
}: {
  t: Translator;
  model: EgoGraphModel;
  hintId: string;
  onOpenNote: (noteId: string) => void;
  onUnavailable: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const api = useRef<{
    fit: () => void;
    zoom: (factor: number) => void;
    emphasise: (target: EgoTarget | null) => void;
  } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retry, setRetry] = useState(0);
  const [card, setCard] = useState<CardTarget | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const openNote = useStableCallback(onOpenNote);
  const unavailable = useStableCallback(onUnavailable);
  const items = useMemo(() => egoCursorItems(model), [model]);
  const nodesById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model]);
  const edgesById = useMemo(() => new Map(model.edges.map((edge) => [edge.id, edge])), [model]);
  const titleOf = (id: string) => nodesById.get(id)?.title ?? "";

  const describe = (item: EgoCursorItem): string => {
    if (item.type === "node") {
      const node = nodesById.get(item.id);
      return node ? egoNodeDescription(node, t) : "";
    }
    const edge = edgesById.get(item.id);
    return edge ? egoEdgeDescription(edge, titleOf, t) : "";
  };

  // The renderer, the layout and every listener live exactly as long as the model they draw. Each
  // is handed to the disposer the moment it exists, so a step that throws later still releases the
  // ones before it; they go while the container is still attached, once, whatever order React
  // cleans up in. A renderer that cannot be built at all sends the page to its list.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const disposer = createDisposer();
    let released = false;
    let built = false;
    setFailure(null);
    setCard(null);
    setCursor(null);
    void initialize().catch(() => {
      disposer.dispose();
      if (released) return;
      // Before the renderer stands, there is nothing to retry into; after it, the layout is the fault.
      if (built) setFailure("layout");
      else unavailable();
    });
    return () => {
      released = true;
      api.current = null;
      disposer.dispose();
    };

    async function initialize() {
      const [{ default: SigmaConstructor }, programs] = await Promise.all([
        import("sigma"),
        import("./programs")
      ]);
      if (disposer.disposed || !container) return;
      let palette = readGraphPalette(container);
      const graph: EgoSigmaGraph = buildEgoSigmaGraph(model, palette);
      let cameraRatio = 1;
      let target: EgoTarget | null = null;
      const reducedMotion =
        typeof window.matchMedia === "function" &&
        window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Sigma lays its canvases down before it builds its programs: a failure here leaves none behind.
      const renderer: Sigma = buildRenderer(
        container,
        disposer,
        () =>
          new SigmaConstructor(graph, container, {
            allowInvalidContainer: true,
            nodeProgramClasses: { circle: programs.GraphNodeProgram },
            nodeHoverProgramClasses: { circle: programs.GraphNodeProgram },
            edgeProgramClasses: {
              line: programs.GraphEdgeProgram,
              arrow: programs.createGraphArrowProgram(egoArrowOptions),
              dashed: programs.GraphDashedEdgeProgram,
              "dashed-arrow": programs.createGraphDashedArrowProgram(egoArrowOptions)
            },
            enableEdgeEvents: true,
            zIndex: true,
            labelColor: { attribute: "labelColor", color: palette.label },
            // Labels sit on a halo of the canvas, in the theme's colours; the hovered one is bolder.
            defaultDrawNodeLabel: (context, node) => {
              drawHaloLabel(context, node, palette);
            },
            defaultDrawNodeHover: (context, node) => {
              drawHaloLabel(context, { ...node, emphasised: true }, palette);
            },
            ...graphTypography,
            labelRenderedSizeThreshold: 0,
            stagePadding: 36,
            minCameraRatio: 0.05,
            maxCameraRatio: 6,
            minEdgeThickness: 1.2,
            enableCameraRotation: false,
            itemSizesReference: "screen",
            hideEdgesOnMove: false,
            hideLabelsOnMove: false,
            nodeReducer: (node, attributes) => ({
              ...attributes,
              ...nodeDisplay(graph, node, target, palette)
            }),
            edgeReducer: (edge, attributes) => {
              if (attributes.interactionTarget)
                return {
                  ...attributes,
                  size: zoomCompensatedEdgeSize(cameraRatio, relationHitAreaScreenThickness)
                };
              const display = edgeDisplay(graph, edge, target, palette);
              return {
                ...attributes,
                ...display,
                size: zoomCompensatedEdgeSize(cameraRatio, display.size)
              };
            }
          })
      );
      built = true;
      // A lost context (a GPU reset, the browser's cap on contexts) leaves a canvas that draws
      // nothing: say so, and let Retry build it again.
      const contextLost = () => {
        if (!disposer.disposed) setFailure("context");
      };
      const glLayers = ["edges", "nodes", "hoverNodes"].flatMap((id) => {
        const layer = renderer.getCanvases()[id];
        return layer ? [layer] : [];
      });
      for (const layer of glLayers) layer.addEventListener("webglcontextlost", contextLost);
      disposer.add(() => {
        for (const layer of glLayers) layer.removeEventListener("webglcontextlost", contextLost);
      });
      // The page scrolls under the pointer, so the wheel and a double click never reach Sigma's
      // zoom: the camera is zoomed by the buttons and fitted by the code. (Sigma's own switch for
      // zooming would also freeze the camera API, so the events are stopped instead.)
      const keepPageScrolling = (event: Event) => event.stopPropagation();
      container.addEventListener("wheel", keepPageScrolling, { capture: true });
      container.addEventListener("dblclick", keepPageScrolling, { capture: true });
      disposer.add(() => {
        container.removeEventListener("wheel", keepPageScrolling, { capture: true });
        container.removeEventListener("dblclick", keepPageScrolling, { capture: true });
      });
      const radius = graphLayoutRadius(graph.order, egoForces.linkDistance) * 1.4;
      renderer.setCustomBBox({ x: [-radius, radius], y: [-radius, radius] });
      const camera = renderer.getCamera();
      camera.on("updated", ({ ratio }) => {
        cameraRatio = ratio;
        renderer.scheduleRefresh();
      });

      let interacted = false;
      let fitFrame: number | null = null;
      disposer.add(() => {
        if (fitFrame !== null) cancelAnimationFrame(fitFrame);
      });
      const fit = () => {
        renderer.refresh();
        const cameraState = camera.getState();
        const points = graph.nodes().map((id) =>
          renderer.graphToViewport(graph.getNodeAttributes(id) as { x: number; y: number }, {
            cameraState
          })
        );
        if (!points.length) return;
        const xs = points.map((point) => point.x);
        const ys = points.map((point) => point.y);
        const [left, right, top, bottom] = [
          Math.min(...xs),
          Math.max(...xs),
          Math.min(...ys),
          Math.max(...ys)
        ];
        const center = renderer.viewportToFramedGraph(
          { x: (left + right) / 2, y: (top + bottom) / 2 },
          { cameraState }
        );
        const { width, height } = renderer.getDimensions();
        const ratio =
          camera.ratio *
          Math.max(
            (right - left) / Math.max(1, width - 140),
            (bottom - top) / Math.max(1, height - 90)
          );
        camera.setState({ ...center, ratio: Math.max(0.05, Math.min(6, ratio || 0.5)) });
      };
      const scheduleFit = () => {
        if (!interacted && fitFrame === null)
          fitFrame = requestAnimationFrame(() => {
            fitFrame = null;
            if (!interacted) fit();
          });
      };

      // The pointer: a short dwell highlights, a still pointer shows the compact card.
      const resolveEdge = (edge: string): string =>
        (graph.getEdgeAttribute(edge, "interactionTarget") as string | null) ?? edge;
      const hoverIntent = new GraphHoverIntent(
        (next: GraphHoverTarget | null) => {
          target = next ? { type: next.type, key: next.key } : null;
          renderer.scheduleRefresh();
        },
        (next: GraphHoverTarget | null) =>
          setCard(
            next
              ? { type: next.type, id: next.key, place: cardPlace(renderer, next.x, next.y) }
              : null
          )
      );
      disposer.add(() => hoverIntent.dispose());
      renderer.on("enterNode", ({ node, event }) =>
        hoverIntent.enter({ type: "node", key: node, x: event.x, y: event.y })
      );
      renderer.on("leaveNode", ({ node }) => hoverIntent.leave("node", node));
      renderer.on("enterEdge", ({ edge, event }) =>
        hoverIntent.enter({ type: "edge", key: resolveEdge(edge), x: event.x, y: event.y })
      );
      renderer.on("leaveEdge", ({ edge }) => hoverIntent.leave("edge", resolveEdge(edge)));
      renderer.getMouseCaptor().on("mousemove", (event) => hoverIntent.move(event));
      renderer.getMouseCaptor().on("mouseleave", () => hoverIntent.clear());
      renderer.on("clickNode", ({ node }) => {
        if (!graph.getNodeAttribute(node, "focus")) openNote(node);
      });
      renderer.on("clickEdge", ({ edge, event }) => {
        hoverIntent.clear();
        setCard({
          type: "edge",
          id: resolveEdge(edge),
          place: cardPlace(renderer, event.x, event.y)
        });
      });
      renderer.on("downStage", () => {
        interacted = true;
        hoverIntent.clear();
        setCard(null);
      });

      const resizeObserver = new ResizeObserver(() => {
        renderer.resize();
        scheduleFit();
      });
      disposer.add(() => resizeObserver.disconnect());
      resizeObserver.observe(container);
      const stopPalette = watchGraphPalette(container, (next) => {
        // A theme change repaints with the new colours; nothing is built again.
        palette = next;
        renderer.refresh();
      });
      disposer.add(stopPalette);

      const layout = new KnowledgeGraphLayout(
        graph.nodes().map((id) => ({
          id,
          x: graph.getNodeAttribute(id, "x"),
          y: graph.getNodeAttribute(id, "y")
        })),
        graph
          .edges()
          .filter((id) => !graph.getEdgeAttribute(id, "interactionTarget"))
          .map((id) => ({
            source: graph.source(id),
            target: graph.target(id),
            weight: graph.getEdgeAttribute(id, "suggested") ? 0.6 : 1
          })),
        egoForces,
        false,
        (positions, running) => {
          // Someone who prefers less motion sees the settled graph, never the settling.
          if (reducedMotion && running) return;
          graph.nodes().forEach((id, index) => {
            graph.mergeNodeAttributes(id, {
              x: positions[index * 2]!,
              y: positions[index * 2 + 1]!
            });
          });
          scheduleFit();
        },
        () => {
          if (!released) setFailure("layout");
        }
      );
      disposer.add(() => layout.kill());

      api.current = {
        fit: () => {
          interacted = false;
          fit();
        },
        zoom: (factor) => {
          interacted = true;
          if (factor > 1) void camera.animatedZoom({ duration: 160 });
          else void camera.animatedUnzoom({ duration: 160 });
        },
        emphasise: (next) => {
          target = next;
          renderer.scheduleRefresh();
        }
      };
      scheduleFit();
    }
  }, [model, retry, openNote, unavailable]);

  // The keyboard cursor emphasises and describes the note or relation it stands on; none clears both.
  const stand = (next: number | null) => {
    setCursor(next);
    const item = next === null ? null : items[next];
    api.current?.emphasise(item ? { type: item.type, key: item.id } : null);
    setCard(item ? { type: item.type, id: item.id, place: null } : null);
    if (item) setAnnouncement(describe(item));
  };

  const cardNode = card?.type === "node" ? nodesById.get(card.id) : undefined;
  const cardEdge = card?.type === "edge" ? edgesById.get(card.id) : undefined;

  return (
    <div
      className="relative h-88 overflow-hidden rounded-lg border border-border bg-surface"
      onKeyDown={(event) => {
        // The buttons keep their own keys; the cursor is the canvas's.
        if (event.target !== containerRef.current) return;
        if (event.key === "Escape" && (card || cursor !== null)) {
          event.preventDefault();
          event.stopPropagation();
          stand(null);
          return;
        }
        if (event.key === "Enter" && cursor !== null) {
          const item = items[cursor];
          const node = item?.type === "node" ? nodesById.get(item.id) : undefined;
          if (node && !node.focus) {
            event.preventDefault();
            openNote(node.id);
          }
          return;
        }
        const next = moveEgoCursor(items.length, cursor, event.key);
        if (next === null) return;
        event.preventDefault();
        stand(next);
      }}
    >
      <div
        ref={containerRef}
        className="absolute inset-0 outline-offset-[-3px] focus-visible:outline-2 focus-visible:outline-accent"
        role="application"
        aria-label={t("notePage.graph.label", {
          values: { notes: model.nodes.length, relations: model.edges.length }
        })}
        aria-describedby={hintId}
        tabIndex={0}
        onBlur={() => stand(null)}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <GraphControl label={t("knowledgeGraph.fit")} onClick={() => api.current?.fit()}>
          <Maximize2 aria-hidden="true" />
        </GraphControl>
        <GraphControl label={t("knowledgeGraph.zoomIn")} onClick={() => api.current?.zoom(2)}>
          <Plus aria-hidden="true" />
        </GraphControl>
        <GraphControl label={t("knowledgeGraph.zoomOut")} onClick={() => api.current?.zoom(0.5)}>
          <Minus aria-hidden="true" />
        </GraphControl>
      </div>
      {cardNode || cardEdge ? (
        <div
          role="presentation"
          className={cn(
            "motion-graph-tooltip-in pointer-events-none absolute z-10 w-74 rounded-lg border border-border-strong bg-surface p-3 text-foreground shadow-lg",
            !card?.place && "bottom-2 left-2"
          )}
          style={card?.place ? { left: card.place.x, top: card.place.y } : undefined}
        >
          {cardNode ? (
            <>
              <p
                className="text-sm font-semibold leading-snug"
                lang={cardNode.language ?? undefined}
              >
                {cardNode.title}
              </p>
              <p
                className="mt-1 line-clamp-3 font-reading text-sm leading-snug text-secondary-foreground"
                lang={cardNode.language ?? undefined}
              >
                {cardNode.ideaStatement}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(cardNode.focus ? "notePage.graph.thisNoteHint" : "notePage.graph.openHint")}
              </p>
            </>
          ) : null}
          {cardEdge ? (
            <>
              <RelationStanceLabel
                type={cardEdge.type}
                t={t}
                linked={relationTypeView(cardEdge.type).directed && !cardEdge.directed}
              />
              <p className="mt-1 text-sm leading-snug">
                {egoEdgeDescription(cardEdge, titleOf, t)}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="absolute inset-0 grid place-content-center gap-2 bg-surface/95 p-4 text-sm text-foreground">
          <p>
            {t(failure === "context" ? "notePage.graph.contextLost" : "knowledgeGraph.layoutError")}
          </p>
          <Button type="button" onClick={() => setRetry((value) => value + 1)}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function GraphControl({
  label,
  onClick,
  children
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      type="button"
      variant="secondary"
      className="size-8 min-h-0 p-0"
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
