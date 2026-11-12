import { useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type Sigma from "sigma";
import { Maximize2, Minus, Plus } from "lucide-react";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { useStableCallback } from "../../../../lib/stable-callback";
import { RelationStanceLabel } from "../../../../components/RelationStanceLabel";
import { Button } from "../../../../components/ui/button";
import { ErrorState } from "../../../../components/ui/error-state";
import { buildRenderer, createDisposer } from "../../../../components/graph/disposal";
import {
  readGraphPalette,
  topicColour,
  watchGraphPalette,
  type GraphPalette
} from "../../../../components/graph/graph-tokens";
import {
  GraphHoverIntent,
  GraphWheelMotion,
  boundedGraphWheelRatio,
  captureGraphWheelEvent,
  type GraphHoverTarget
} from "../../../../components/graph/interaction";
import { moveEgoCursor } from "../../../../components/graph/ego-graph-model";
import {
  drawHaloLabel,
  drawPillLabel,
  type PillContext
} from "../../../../components/graph/labels";
import { KnowledgeGraphLayout } from "../../../../components/graph/layout";
import {
  graphLayoutRadius,
  type GraphForceSettings,
  type GraphLayoutEdge,
  type GraphLayoutNode
} from "../../../../components/graph/layout-contract";
import {
  graphTypography,
  positionOverlayWithinViewport,
  zoomCompensatedEdgeSize
} from "../../../../components/graph/view-model";
import {
  branchCursorItems,
  branchEdgeDescription,
  branchNodeDescription,
  connectionCounts,
  groupDescription,
  nodeGroupLabel,
  type BranchCursorItem,
  type BranchModel
} from "./branch-model";
import {
  branchEdgeDisplay,
  branchForces,
  branchNodeDisplay,
  branchZoom,
  buildBranchSigmaGraph,
  drawMidpointGlyph,
  groupNodeKey,
  landscapeTurn,
  placeGroupNodes,
  relationOf,
  showsGroups,
  turnPositions,
  type BranchGraph,
  type BranchTarget
} from "./branch-sigma";

/**
 * What lays the notes out: the renderer Web Worker (`KnowledgeGraphLayout`) in the app. It hands
 * positions back as they settle and says when it failed; `kill` stops it.
 */
export type BranchLayoutFactory = (
  nodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  settings: GraphForceSettings,
  onPositions: (positions: Float32Array, running: boolean) => void,
  onError: () => void
) => { kill(): void };

export const workerLayout: BranchLayoutFactory = (nodes, edges, settings, onPositions, onError) =>
  new KnowledgeGraphLayout(nodes, edges, settings, false, onPositions, onError);

export interface RelationsCanvasProps {
  t: Translator;
  model: BranchModel;
  /** `graphWheelZoomSensitivity` (Settings › Advanced): how far one wheel step zooms. */
  wheelZoomSensitivity: number;
  onOpenNote: (noteId: string) => void;
  /** This window cannot draw WebGL: the host says so, and the table carries the connections. */
  onUnavailable: () => void;
  /** The note or relation chosen elsewhere (the table, T152); the canvas emphasises it. */
  selected?: BranchCursorItem | null;
  /** The person chose a note or a relation on the canvas, or cleared the choice. */
  onSelect?: (item: BranchCursorItem | null) => void;
  /** The layout engine; the worker unless a screen module settles it another way. */
  createLayout?: BranchLayoutFactory;
  className?: string;
}

interface CardTarget {
  type: "node" | "edge";
  id: string;
  /** Beside the pointer and inside the canvas; null for one the keyboard opened. */
  place: { x: number; y: number } | null;
}

type Failure = "layout" | "context";

const cardSize = { width: 296, height: 120 };
const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

/**
 * The Map › Grafo canvas (F5 D19, design record 7.5): one branch's notes as dots in their topic's
 * colour, relations as lines in their stance colour with the stance glyph at the midpoint, labels
 * on a halo of the theme's canvas. Zoomed out, each topic becomes a pill joined to the others by
 * one line as thick as the connections between them. The layout runs in a Web Worker; the wheel
 * zooms by the person's `graphWheelZoomSensitivity`; the buttons fit and zoom; the keyboard walks
 * the notes and the relations, Enter opens a note. The renderer, the worker and every listener
 * live exactly as long as the model they draw.
 */
export function RelationsCanvas({
  t,
  model,
  wheelZoomSensitivity,
  onOpenNote,
  onUnavailable,
  selected = null,
  onSelect,
  createLayout = workerLayout,
  className
}: RelationsCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const api = useRef<{
    fit: () => void;
    zoom: (factor: number) => void;
    emphasise: (target: BranchTarget | null) => void;
    setSensitivity: (value: number) => void;
  } | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [retry, setRetry] = useState(0);
  const [card, setCard] = useState<CardTarget | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const openNote = useStableCallback(onOpenNote);
  const unavailable = useStableCallback(onUnavailable);
  const select = useStableCallback((item: BranchCursorItem | null) => onSelect?.(item));
  const items = useMemo(() => branchCursorItems(model), [model]);
  const counts = useMemo(() => connectionCounts(model), [model]);
  const nodesById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model]);
  const edgesById = useMemo(() => new Map(model.edges.map((edge) => [edge.id, edge])), [model]);
  const groupsById = useMemo(
    () => new Map(model.groups.map((group) => [groupNodeKey(group.id), group])),
    [model]
  );
  const sensitivity = useRef(wheelZoomSensitivity);
  sensitivity.current = wheelZoomSensitivity;
  const titleOf = (id: string) => nodesById.get(id)?.title ?? "";

  const describe = (item: BranchCursorItem): string => {
    if (item.type === "node") {
      const node = nodesById.get(item.id);
      return node ? branchNodeDescription(model, node, counts.get(node.id) ?? 0, t) : "";
    }
    const edge = edgesById.get(item.id);
    return edge ? branchEdgeDescription(edge, titleOf, t) : "";
  };

  useLayoutEffect(() => {
    api.current?.setSensitivity(wheelZoomSensitivity);
  }, [wheelZoomSensitivity]);

  // A choice made in the table is emphasised here, and described, without moving the camera.
  useLayoutEffect(() => {
    api.current?.emphasise(selected ? { type: selected.type, key: selected.id } : null);
  }, [selected]);

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
        import("../../../../components/graph/programs")
      ]);
      if (disposer.disposed || !container) return;
      let palette: GraphPalette = readGraphPalette(container);
      const graph: BranchGraph = buildBranchSigmaGraph(model, palette);
      let cameraRatio = 1;
      let zoomedOut = false;
      let target: BranchTarget | null = null;
      const reducedMotion =
        typeof window.matchMedia === "function" && window.matchMedia(reducedMotionQuery).matches;
      const drawLabel = (
        context: CanvasRenderingContext2D,
        data: { x: number; y: number; size: number; label?: string | null; key?: string },
        emphasised: boolean
      ) => {
        const key = data.key ?? "";
        const attributes = graph.hasNode(key) ? graph.getNodeAttributes(key) : null;
        const display = data as { labelColor?: string; emphasised?: boolean };
        if (attributes?.kind === "group")
          drawPillLabel(
            context as unknown as PillContext,
            {
              ...data,
              emphasised: emphasised || display.emphasised === true,
              ringColour: topicColour(palette, attributes.colourIndex ?? 0),
              ...(display.labelColor ? { labelColor: display.labelColor } : {})
            },
            palette
          );
        else
          drawHaloLabel(
            context,
            {
              ...data,
              emphasised: emphasised || display.emphasised === true,
              ...(display.labelColor ? { labelColor: display.labelColor } : {})
            },
            palette
          );
      };
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
              dashed: programs.GraphDashedEdgeProgram
            },
            enableEdgeEvents: true,
            renderEdgeLabels: true,
            zIndex: true,
            labelColor: { attribute: "labelColor", color: palette.label },
            defaultDrawNodeLabel: (context, data) => drawLabel(context, data, false),
            defaultDrawNodeHover: (context, data) => drawLabel(context, data, true),
            // The edge-label layer carries each relation's stance glyph at its midpoint.
            defaultDrawEdgeLabel: (context, edge, source, target) => {
              const data = edge as { glyphColor?: string; key?: string; hidden?: boolean };
              if (zoomedOut || !data.key || !graph.hasEdge(data.key)) return;
              const attributes = graph.getEdgeAttributes(data.key);
              if (attributes.kind !== "note" || attributes.interactionTarget !== null) return;
              drawMidpointGlyph(
                context,
                source,
                target,
                attributes.stance,
                data.glyphColor ?? palette.stance[attributes.stance ?? "related"],
                palette
              );
            },
            ...graphTypography,
            labelDensity: 0.7,
            labelGridCellSize: 150,
            labelRenderedSizeThreshold: 3,
            stagePadding: 48,
            minCameraRatio: 0.08,
            maxCameraRatio: 8,
            minEdgeThickness: 1.2,
            enableCameraRotation: false,
            itemSizesReference: "screen",
            hideEdgesOnMove: false,
            hideLabelsOnMove: false,
            nodeReducer: (node, attributes) => ({
              ...attributes,
              ...branchNodeDisplay(graph, node, target, zoomedOut, palette)
            }),
            edgeReducer: (edge, attributes) => {
              const display = branchEdgeDisplay(graph, edge, target, zoomedOut, palette);
              return {
                ...attributes,
                ...display,
                size: zoomCompensatedEdgeSize(cameraRatio, display.size ?? attributes.size)
              };
            }
          })
      );
      built = true;
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

      const radius = graphLayoutRadius(graph.order, branchForces.linkDistance) * 1.4;
      renderer.setCustomBBox({ x: [-radius, radius], y: [-radius, radius] });
      const camera = renderer.getCamera();
      camera.on("updated", ({ ratio }) => {
        cameraRatio = ratio;
        const next = showsGroups(model, ratio);
        if (next !== zoomedOut) {
          zoomedOut = next;
          setCard(null);
        }
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
        const points = graph
          .filterNodes((_key, attributes) => attributes.kind === "note")
          .map((id) => renderer.graphToViewport(graph.getNodeAttributes(id), { cameraState }));
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
            (right - left) / Math.max(1, width - 200),
            (bottom - top) / Math.max(1, height - 120)
          );
        // Fitting never jumps to the groups' view: the notes are what a fit shows.
        const ceiling = model.groups.length >= 2 ? branchZoom.superNodes * 0.95 : 8;
        camera.setState({ ...center, ratio: Math.max(0.08, Math.min(ceiling, ratio || 0.5)) });
      };
      const scheduleFit = () => {
        if (!interacted && fitFrame === null)
          fitFrame = requestAnimationFrame(() => {
            fitFrame = null;
            if (!interacted) fit();
          });
      };

      // The wheel zooms around the pointer, as far as the person's sensitivity says.
      let wheelMotion = new GraphWheelMotion(sensitivity.current);
      let wheelFrame: number | null = null;
      let wheelAnchor = { x: 0, y: 0 };
      disposer.add(() => {
        if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
        wheelMotion.cancel();
      });
      const stepWheel = (now: number) => {
        wheelFrame = null;
        const minimum = 0.08;
        const maximum = 8;
        const delta = wheelMotion.advance(now, { ratio: camera.ratio, minimum, maximum });
        if (delta !== 0) {
          const ratio = boundedGraphWheelRatio(camera.ratio, delta, minimum, maximum);
          if (ratio !== camera.ratio)
            camera.setState(renderer.getViewportZoomedState(wheelAnchor, ratio));
        }
        if (wheelMotion.active) wheelFrame = requestAnimationFrame(stepWheel);
      };
      const onWheel = (event: WheelEvent) => {
        captureGraphWheelEvent(event);
        if (event.deltaY === 0) return;
        interacted = true;
        hoverIntent.clear();
        const bounds = container.getBoundingClientRect();
        wheelAnchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        wheelMotion.push(event, performance.now());
        if (wheelFrame === null) wheelFrame = requestAnimationFrame(stepWheel);
      };
      container.addEventListener("wheel", onWheel, { capture: true, passive: false });
      disposer.add(() => container.removeEventListener("wheel", onWheel, { capture: true }));

      const hoverIntent = new GraphHoverIntent(
        (next: GraphHoverTarget | null) => {
          target = next ? { type: next.type, key: next.key } : null;
          renderer.scheduleRefresh();
        },
        (next: GraphHoverTarget | null) =>
          setCard(
            next
              ? {
                  type: next.type,
                  id: next.key,
                  place: positionOverlayWithinViewport(
                    { x: next.x, y: next.y },
                    cardSize,
                    renderer.getDimensions()
                  )
                }
              : null
          )
      );
      disposer.add(() => hoverIntent.dispose());
      renderer.on("enterNode", ({ node, event }) =>
        hoverIntent.enter({ type: "node", key: node, x: event.x, y: event.y })
      );
      renderer.on("leaveNode", ({ node }) => hoverIntent.leave("node", node));
      renderer.on("enterEdge", ({ edge, event }) => {
        if (graph.getEdgeAttribute(edge, "kind") === "super") return;
        hoverIntent.enter({ type: "edge", key: relationOf(graph, edge), x: event.x, y: event.y });
      });
      renderer.on("leaveEdge", ({ edge }) => hoverIntent.leave("edge", relationOf(graph, edge)));
      renderer.getMouseCaptor().on("mousemove", (event) => hoverIntent.move(event));
      renderer.getMouseCaptor().on("mouseleave", () => hoverIntent.clear());
      renderer.on("clickNode", ({ node }) => {
        const attributes = graph.getNodeAttributes(node);
        if (attributes.kind === "note") {
          openNote(node);
          return;
        }
        // A pill opens its topic's notes: the camera comes in on it, below the groups' view.
        interacted = true;
        hoverIntent.clear();
        const point = renderer.graphToViewport(attributes);
        camera.setState(renderer.getViewportZoomedState(point, branchZoom.superNodes * 0.6));
      });
      renderer.on("clickEdge", ({ edge, event }) => {
        if (graph.getEdgeAttribute(edge, "kind") === "super") return;
        hoverIntent.clear();
        const relation = relationOf(graph, edge);
        target = { type: "edge", key: relation };
        renderer.scheduleRefresh();
        select({ type: "edge", id: relation });
        setCard({
          type: "edge",
          id: relation,
          place: positionOverlayWithinViewport(
            { x: event.x, y: event.y },
            cardSize,
            renderer.getDimensions()
          )
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
      disposer.add(
        watchGraphPalette(container, (next) => {
          // A theme change repaints with the new colours; nothing is built again.
          palette = next;
          graph.forEachNode((key, attributes) => {
            if (attributes.kind === "group")
              graph.setNodeAttribute(
                key,
                "color",
                topicColour(palette, attributes.colourIndex ?? 0)
              );
          });
          renderer.refresh();
        })
      );

      const notes = graph.filterNodes((_key, attributes) => attributes.kind === "note");
      const index = new Map(notes.map((id, position) => [id, position]));
      let turn: number | null = null;
      const layout = createLayout(
        notes.map((id) => {
          const attributes = graph.getNodeAttributes(id);
          return {
            id,
            x: attributes.x,
            y: attributes.y,
            ...(attributes.group !== null ? { group: attributes.group } : {})
          };
        }),
        model.edges
          .filter((edge) => index.has(edge.a) && index.has(edge.b))
          .map((edge) => ({ source: edge.a, target: edge.b, weight: edge.suggested ? 0.6 : 1 })),
        branchForces,
        (settled, running) => {
          // Someone who prefers less motion sees the settled graph, never the settling.
          if (reducedMotion && running) return;
          // The branch runs along the canvas's long side, turned continuously as it settles.
          const { width, height } = renderer.getDimensions();
          turn = landscapeTurn(settled, width >= height, turn);
          const positions = turnPositions(settled, turn);
          notes.forEach((id, position) => {
            graph.mergeNodeAttributes(id, {
              x: positions[position * 2]!,
              y: positions[position * 2 + 1]!
            });
          });
          placeGroupNodes(graph);
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
          if (factor > 1) void camera.animatedZoom({ duration: reducedMotion ? 0 : 160 });
          else void camera.animatedUnzoom({ duration: reducedMotion ? 0 : 160 });
        },
        emphasise: (next) => {
          target = next;
          renderer.scheduleRefresh();
        },
        setSensitivity: (value) => {
          wheelMotion.cancel();
          wheelMotion = new GraphWheelMotion(value);
        }
      };
      if (selected) api.current.emphasise({ type: selected.type, key: selected.id });
      scheduleFit();
    }
    // `selected` is applied by its own effect; the canvas is built again only for a new model.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, retry, openNote, unavailable, createLayout]);

  const stand = (next: number | null) => {
    setCursor(next);
    const item = next === null ? null : items[next];
    api.current?.emphasise(item ? { type: item.type, key: item.id } : null);
    setCard(item ? { type: item.type, id: item.id, place: null } : null);
    select(item ?? null);
    if (item) setAnnouncement(describe(item));
  };

  const cardNode = card?.type === "node" ? nodesById.get(card.id) : undefined;
  const cardGroup = card?.type === "node" ? groupsById.get(card.id) : undefined;
  const cardEdge = card?.type === "edge" ? edgesById.get(card.id) : undefined;
  const hintId = `${useId()}-hint`;

  return (
    <div
      className={cn(
        "relative min-h-80 overflow-hidden rounded-lg border border-border bg-surface",
        className
      )}
      onKeyDown={(event) => {
        if (event.target !== containerRef.current) return;
        if (event.key === "Escape" && (card || cursor !== null)) {
          event.preventDefault();
          event.stopPropagation();
          stand(null);
          return;
        }
        if (event.key === "Enter" && cursor !== null) {
          const item = items[cursor];
          if (item?.type === "node") {
            event.preventDefault();
            openNote(item.id);
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
        aria-label={t("mapRelations.canvas.label", {
          values: {
            scope: model.scopeTitle,
            notes: model.nodes.length,
            relations: model.edges.length
          }
        })}
        aria-describedby={hintId}
        tabIndex={0}
        onBlur={() => {
          if (cursor !== null) stand(null);
        }}
      />
      <p id={hintId} className="sr-only">
        {t("mapRelations.canvas.hint")}
      </p>
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <div className="absolute right-2 top-2 flex flex-col gap-1">
        <CanvasControl label={t("mapRelations.controls.fit")} onClick={() => api.current?.fit()}>
          <Maximize2 aria-hidden="true" />
        </CanvasControl>
        <CanvasControl
          label={t("mapRelations.controls.zoomIn")}
          onClick={() => api.current?.zoom(2)}
        >
          <Plus aria-hidden="true" />
        </CanvasControl>
        <CanvasControl
          label={t("mapRelations.controls.zoomOut")}
          onClick={() => api.current?.zoom(0.5)}
        >
          <Minus aria-hidden="true" />
        </CanvasControl>
      </div>
      {cardNode || cardEdge || cardGroup ? (
        <div
          role="presentation"
          className={cn(
            "motion-graph-tooltip-in pointer-events-none absolute z-10 w-74 rounded-lg border border-border-strong bg-surface p-3 text-foreground [box-shadow:var(--shadow-pop)]",
            !card?.place && "bottom-2 left-2"
          )}
          style={card?.place ? { left: card.place.x, top: card.place.y } : undefined}
        >
          {cardNode ? (
            <>
              <p className="m-0 text-sm font-semibold leading-snug">{cardNode.title}</p>
              <p className="m-0 mt-1 text-xs text-secondary-foreground">
                {t("mapRelations.node.meta", {
                  values: {
                    topic: nodeGroupLabel(model, cardNode, t),
                    count: counts.get(cardNode.id) ?? 0
                  }
                })}
              </p>
              <p className="m-0 mt-2 text-xs text-muted-foreground">
                {t("mapRelations.canvas.openHint")}
              </p>
            </>
          ) : null}
          {cardGroup ? (
            <p className="m-0 text-sm leading-snug">{groupDescription(cardGroup, model, t)}</p>
          ) : null}
          {cardEdge ? (
            <>
              <RelationStanceLabel type={cardEdge.type} t={t} />
              <p className="m-0 mt-1 text-sm leading-snug">
                {branchEdgeDescription(cardEdge, titleOf, t)}
              </p>
            </>
          ) : null}
        </div>
      ) : null}
      {failure ? (
        <div className="absolute inset-0 grid place-content-center bg-surface p-6">
          <ErrorState
            t={t}
            message={t(
              failure === "context" ? "mapRelations.failure.context" : "mapRelations.failure.layout"
            )}
            kept={t("mapRelations.error.kept")}
            retryLabel={t("shell.actions.retry")}
            onRetry={() => setRetry((value) => value + 1)}
          />
        </div>
      ) : null}
    </div>
  );
}

function CanvasControl({
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
