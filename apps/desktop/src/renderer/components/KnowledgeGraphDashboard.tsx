import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type FA2Layout from "graphology-layout-forceatlas2/worker";
import type Sigma from "sigma";
import type { EdgeLabelDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import {
  Focus,
  LoaderCircle,
  Maximize2,
  Minus,
  Network,
  Plus,
  RefreshCw,
  Search,
  Waypoints
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type {
  KnowledgeGraphDashboard as DashboardData,
  KnowledgeGraphDashboardMode,
  KnowledgeGraphSourceConnectionDetails
} from "../../shared/ipc";
import { cn } from "../lib/cn";
import { Input } from "./ui/input";
import {
  isLabelOutsideViewport,
  isNodeVisibleAtLod,
  linkedNodeSpringForce,
  lodFromRatio,
  positionOverlayWithinViewport,
  relationLabelRevealAt,
  relationHitAreaScreenThickness,
  zoomCompensatedEdgeSize,
  zoomVisualStrength,
  type LodLevel
} from "./knowledge-graph-view-model";

type SourceRelationKind = "shared_entity" | "semantic_relation";

interface SourceRelationGroup {
  kind: SourceRelationKind;
  weight: number;
  confidence: number;
  details: string[];
}

interface NodeAttributes {
  x: number;
  y: number;
  label: string;
  size: number;
  color: string;
  kind: "source" | "atomic_note" | "community";
  lod: "item" | "community";
  rawId: string | null;
  sourceItemId: string | null;
  title: string;
  subtitle: string | null;
  content: string | null;
  sourceType: string | null;
  noteStatus: string | null;
  detailCount: number;
  memberCount: number;
  importance: number;
  labelOpacity: number;
}

interface EdgeAttributes {
  label: string;
  size: number;
  color: string;
  kind: "source_connection" | "atomic_note_relation" | "community" | "support" | "hit_area";
  lod: "item" | "community" | "support";
  confidence: number;
  weight: number;
  description: string | null;
  details: string[];
  layoutWeight: number;
  labelOpacity: number;
  labelRevealAt: number;
  sourceRelations: SourceRelationGroup[];
  interactionTarget: string | null;
}

interface HoverCard {
  type: "node" | "edge";
  key: string;
  x: number;
  y: number;
  exiting: boolean;
}

interface FloatingEdgeLabel {
  edge: string;
  label: string;
  x: number;
  y: number;
}

interface CircularBounds {
  centerX: number;
  centerY: number;
  radius: number;
}

interface ConnectedNodeSpring {
  node: string;
  x: number;
  y: number;
  restLength: number;
  velocityX: number;
  velocityY: number;
}

interface GraphBundle {
  graph: Graph<NodeAttributes, EdgeAttributes>;
  rawNodeKeys: string[];
  communityCount: number;
  itemEdgeCount: number;
  stateKey: string;
}

export interface KnowledgeGraphViewState {
  stateKey: string;
  camera: { x: number; y: number; ratio: number; angle: number };
  nodePositions: Record<string, { x: number; y: number }>;
}

interface PreparedGraphEdge {
  id: string;
  source: string;
  target: string;
  kind: "source_connection" | "atomic_note_relation";
  label: string;
  description: string | null;
  weight: number;
  confidence: number;
  details: string[];
  sourceRelations: SourceRelationGroup[];
}

const sourceColors: Record<string, string> = {
  PersonalNote: "#0891b2", DailyNote: "#4f46e5", WebArticle: "#0284c7",
  Book: "#059669", BookChapter: "#0d9488", PeriodicalIssue: "#d97706",
  AcademicPaper: "#7c3aed", DocumentSection: "#64748b", StandaloneArticle: "#ea580c",
  Video: "#e11d48", GenericDocument: "#c026d3"
};

const noteColors: Record<string, string> = {
  approved: "#7c3aed",
  pending_review: "#d97706"
};

const atomicRelationMessageKeys: Readonly<Record<string, MessageKey>> = {
  supports: "knowledge.relations.types.supports",
  contrasts: "knowledge.relations.types.contrasts",
  extends: "knowledge.relations.types.extends",
  similar_to: "knowledge.relations.types.similar_to",
  depends_on: "knowledge.relations.types.depends_on",
  clarifies: "knowledge.relations.types.clarifies",
  mentions: "knowledge.relations.types.mentions",
  related: "knowledge.relations.types.related"
};

const mutedNode = "#94a3b8";
const mutedEdge = "rgb(17, 30, 46)";

export function KnowledgeGraphDashboard({
  t,
  mode,
  initialViewState,
  onViewStateChange,
  onModeChange,
  onOpenSource,
  onOpenAtomicNote
}: {
  t: Translator;
  mode: KnowledgeGraphDashboardMode;
  initialViewState: KnowledgeGraphViewState | undefined;
  onViewStateChange: (mode: KnowledgeGraphDashboardMode, state: KnowledgeGraphViewState) => void;
  onModeChange: (mode: KnowledgeGraphDashboardMode) => void;
  onOpenSource: (sourceItemId: string) => void;
  onOpenAtomicNote: (sourceItemId: string, atomicNoteId: string) => void;
}) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [query, setQuery] = useState("");
  const [lod, setLod] = useState<LodLevel>("hubs");
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [hover, setHover] = useState<HoverCard | null>(null);
  const [floatingEdgeLabel, setFloatingEdgeLabel] = useState<FloatingEdgeLabel | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const layoutRef = useRef<FA2Layout<NodeAttributes, EdgeAttributes> | null>(null);
  const layoutTimerRef = useRef<number | null>(null);
  const hoverActivationTimerRef = useRef<number | null>(null);
  const hoverExitTimerRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const hoverAnimationFrameRef = useRef<number | null>(null);
  const hoverStrengthRef = useRef(0);
  const cameraRatioRef = useRef(1);
  const circularBoundsRef = useRef<CircularBounds | null>(null);
  const lodRef = useRef<LodLevel>("hubs");
  const hoveredKeyRef = useRef<string | null>(null);
  const hoveredNeighborsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    setData(null);
    window.app.knowledge.getGraphDashboard(mode)
      .then((result) => { if (active) setData(result); })
      .catch(() => { if (active) setError(true); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [mode, reloadToken]);

  const bundle = useMemo(() => data ? buildGraph(data, t) : null, [data, t]);
  const searchResults = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized || !data) return [];
    return data.nodes.filter((node) => `${node.title} ${node.subtitle ?? ""}`.toLocaleLowerCase().includes(normalized)).slice(0, 8);
  }, [data, query]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !bundle || bundle.rawNodeKeys.length === 0) return;
    const graphContainer = container;
    let disposed = false;
    let cleanupRenderer = () => {};
    const graph = bundle.graph;
    const rawNodeKeys = bundle.rawNodeKeys;
    const graphStateKey = bundle.stateKey;
    const restoredViewState = restoreKnowledgeGraphViewState(graph, graphStateKey, initialViewState);
    void initializeRenderer();

    return () => {
      disposed = true;
      cleanupRenderer();
    };

    async function initializeRenderer() {
      const [{ default: SigmaConstructor }, { default: FA2LayoutConstructor }] = await Promise.all([
        import("sigma"),
        import("graphology-layout-forceatlas2/worker")
      ]);
      if (disposed) return;
      const renderer = new SigmaConstructor<NodeAttributes, EdgeAttributes>(graph, graphContainer, {
      allowInvalidContainer: true,
      defaultDrawNodeHover: drawWrappedNodeLabel,
      defaultDrawNodeLabel: drawWrappedNodeLabel,
      defaultDrawEdgeLabel: drawFadingEdgeLabel,
      enableEdgeEvents: true,
      hideEdgesOnMove: graph.size > 12_000,
      hideLabelsOnMove: false,
      labelColor: { color: "#cbd5e1" },
      labelDensity: 0.1,
      labelFont: "Inter, ui-sans-serif, system-ui, sans-serif",
      labelGridCellSize: 110,
      labelRenderedSizeThreshold: 9,
      labelSize: 12,
      labelWeight: "500",
      itemSizesReference: "screen",
      minEdgeThickness: 1.2,
      renderEdgeLabels: true,
      stagePadding: 72,
      zIndex: true,
      minCameraRatio: 0.08,
      maxCameraRatio: 8,
      nodeReducer: (node, attributes) => reduceNode(
        graph,
        node,
        attributes,
        lodRef.current,
        cameraRatioRef.current,
        hoveredKeyRef.current,
        hoveredNeighborsRef.current
      ),
      edgeReducer: (edge, attributes) => reduceEdge(
        graph,
        edge,
        attributes,
        lodRef.current,
        cameraRatioRef.current,
        hoveredKeyRef.current,
        hoverStrengthRef.current
      )
      });
      sigmaRef.current = renderer;

    const camera = renderer.getCamera();
    if (restoredViewState && initialViewState) camera.setState(initialViewState.camera);
    const updateCameraDetail = (ratio: number) => {
      cameraRatioRef.current = ratio;
      const next = lodFromRatio(ratio);
      if (lodRef.current !== next) {
        lodRef.current = next;
        setLod(next);
      }
      renderer.scheduleRefresh();
    };
    updateCameraDetail(camera.ratio);
    camera.on("updated", ({ ratio }) => updateCameraDetail(ratio));

    const mouse = renderer.getMouseCaptor();
    let pendingHover: Omit<HoverCard, "exiting"> | null = null;
    let draggedNode: string | null = null;
    let dragMoved = false;
    let suppressNextNodeClick = false;
    let floatingEdgeKey: string | null = null;
    let connectedSprings: ConnectedNodeSpring[] = [];
    let dragAttractor: { x: number; y: number } | null = null;
    let connectedSpringFrame: number | null = null;
    let connectedSpringLastAt = 0;
    let connectedSpringReleasedAt: number | null = null;

    const animateHighlight = (target: number, onComplete?: () => void) => {
      if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
      const startedAt = performance.now();
      const initial = hoverStrengthRef.current;
      const step = (now: number) => {
        const progress = Math.min(1, (now - startedAt) / 140);
        hoverStrengthRef.current = initial + (target - initial) * (1 - Math.pow(1 - progress, 3));
        renderer.scheduleRefresh();
        if (progress < 1) hoverAnimationFrameRef.current = window.requestAnimationFrame(step);
        else {
          hoverAnimationFrameRef.current = null;
          onComplete?.();
        }
      };
      hoverAnimationFrameRef.current = window.requestAnimationFrame(step);
    };

    const clearActivationTimer = () => {
      if (hoverActivationTimerRef.current !== null) window.clearTimeout(hoverActivationTimerRef.current);
      hoverActivationTimerRef.current = null;
    };
    const hidePopup = () => {
      pendingHover = null;
      floatingEdgeKey = null;
      setFloatingEdgeLabel(null);
      clearActivationTimer();
      setHover((current) => current ? { ...current, exiting: true } : null);
      if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
      hoverExitTimerRef.current = window.setTimeout(() => setHover(null), 120);
    };
    const hideHover = () => {
      hidePopup();
      animateHighlight(0, () => {
        hoveredKeyRef.current = null;
        hoveredNeighborsRef.current = new Set();
        renderer.scheduleRefresh();
      });
    };
    const scheduleHover = (next: Omit<HoverCard, "exiting">) => {
      if (hoveredKeyRef.current && hoveredKeyRef.current !== next.key) hideHover();
      pendingHover = next;
      clearActivationTimer();
      hoverActivationTimerRef.current = window.setTimeout(() => {
        if (!pendingHover || pendingHover.key !== next.key) return;
        hoveredKeyRef.current = next.key;
        hoveredNeighborsRef.current = new Set(next.type === "node"
          ? graph.neighbors(next.key)
          : graph.extremities(next.key));
        floatingEdgeKey = null;
        setFloatingEdgeLabel(null);
        setHover({ ...pendingHover, exiting: false });
        pendingHover = null;
        renderer.scheduleRefresh();
      }, 1_000);
    };
    const queueNode = ({ node, event }: { node: string; event: { x: number; y: number } }) => {
      graphContainer.style.cursor = "grab";
      floatingEdgeKey = null;
      setFloatingEdgeLabel(null);
      hoveredKeyRef.current = node;
      hoveredNeighborsRef.current = new Set(graph.neighbors(node));
      animateHighlight(1);
      scheduleHover({ type: "node", key: node, x: event.x, y: event.y });
    };
    const queueEdge = ({ edge, event }: { edge: string; event: { x: number; y: number } }) => {
      const interactionTarget = graph.getEdgeAttribute(edge, "interactionTarget");
      const resolvedEdge = interactionTarget && graph.hasEdge(interactionTarget) ? interactionTarget : edge;
      const kind = graph.getEdgeAttribute(resolvedEdge, "kind");
      if (kind === "support" || kind === "community") return;
      hoveredKeyRef.current = resolvedEdge;
      hoveredNeighborsRef.current = new Set(graph.extremities(resolvedEdge));
      animateHighlight(1);
      if (edgeLabelFallsOutsideViewport(renderer, graph, resolvedEdge)) {
        floatingEdgeKey = resolvedEdge;
        setFloatingEdgeLabel({
          edge: resolvedEdge,
          label: graph.getEdgeAttribute(resolvedEdge, "label"),
          ...floatingLabelPosition(renderer, event)
        });
      } else {
        floatingEdgeKey = null;
        setFloatingEdgeLabel(null);
      }
      scheduleHover({ type: "edge", key: resolvedEdge, x: event.x, y: event.y });
    };
    renderer.on("enterNode", queueNode);
    renderer.on("leaveNode", () => { if (!draggedNode) graphContainer.style.cursor = "default"; hideHover(); });
    renderer.on("enterEdge", queueEdge);
    renderer.on("leaveEdge", hideHover);
    renderer.on("clickStage", hideHover);
    renderer.on("downNode", ({ node, event }) => {
      if (connectedSpringFrame !== null) window.cancelAnimationFrame(connectedSpringFrame);
      connectedSpringFrame = null;
      draggedNode = node;
      dragMoved = false;
      const draggedLod = graph.getNodeAttribute(node, "lod");
      const draggedNeighbors = graph.neighbors(node).filter((neighbor) => {
        const attributes = graph.getNodeAttributes(neighbor);
        return attributes.lod === draggedLod && isNodeVisibleAtLod(
          lodRef.current,
          attributes.lod === "community",
          attributes.importance,
          hubThreshold(graph)
        );
      });
      const attributes = graph.getNodeAttributes(node);
      dragAttractor = { x: attributes.x, y: attributes.y };
      connectedSprings = draggedNeighbors.map((neighbor) => {
        const position = graph.getNodeAttributes(neighbor);
        return {
          node: neighbor,
          x: position.x,
          y: position.y,
          restLength: Math.max(0.2, Math.hypot(position.x - attributes.x, position.y - attributes.y)),
          velocityX: 0,
          velocityY: 0
        };
      });
      connectedSpringReleasedAt = null;
      hidePopup();
      if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
      hoverAnimationFrameRef.current = null;
      hoverStrengthRef.current = 1;
      hoveredKeyRef.current = node;
      hoveredNeighborsRef.current = new Set(graph.neighbors(node));
      circularBoundsRef.current = measureCircularBounds(graph, rawNodeKeys);
      camera.disable();
      graphContainer.style.cursor = "grabbing";
      renderer.scheduleRefresh();
      event.preventSigmaDefault();
    });
    mouse.on("mousemove", (event) => {
      if (floatingEdgeKey) {
        const position = floatingLabelPosition(renderer, event);
        setFloatingEdgeLabel((current) => current?.edge === floatingEdgeKey
          ? { ...current, ...position }
          : current);
      }
      if (!pendingHover || draggedNode) return;
      scheduleHover({ ...pendingHover, x: event.x, y: event.y });
    });
    mouse.on("mousemovebody", (event) => {
      if (!draggedNode) return;
      if (!dragMoved) stopLayout(false);
      dragMoved = true;
      const position = renderer.viewportToGraph(event);
      const bounded = circularBoundsRef.current
        ? clampPointToCircle(position, circularBoundsRef.current)
        : position;
      graph.mergeNodeAttributes(draggedNode, bounded);
      dragAttractor = bounded;
      startConnectedSpring();
      event.preventSigmaDefault();
      event.original.preventDefault();
      renderer.scheduleRefresh();
    });
    mouse.on("mouseup", () => {
      if (!draggedNode) return;
      suppressNextNodeClick = dragMoved;
      if (dragMoved) {
        connectedSpringReleasedAt = performance.now();
        startConnectedSpring();
        renderer.scheduleRefresh();
      } else {
        connectedSprings = [];
        dragAttractor = null;
      }
      draggedNode = null;
      dragMoved = false;
      camera.enable();
      graphContainer.style.cursor = "default";
    });

    function startConnectedSpring() {
      if (connectedSprings.length === 0 || connectedSpringFrame !== null) return;
      connectedSpringLastAt = performance.now();
      connectedSpringFrame = window.requestAnimationFrame(stepConnectedSpring);
    }

    function stepConnectedSpring(now: number) {
      if (!dragAttractor) {
        connectedSpringFrame = null;
        connectedSprings = [];
        return;
      }
      const frameScale = Math.min(2, Math.max(0.5, (now - connectedSpringLastAt) / 16));
      let remainingMotion = 0;
      for (const spring of connectedSprings) {
        const force = linkedNodeSpringForce(spring, dragAttractor, spring.restLength);
        spring.velocityX = (spring.velocityX + force.x * frameScale) * Math.pow(0.82, frameScale);
        spring.velocityY = (spring.velocityY + force.y * frameScale) * Math.pow(0.82, frameScale);
        spring.x += spring.velocityX * frameScale;
        spring.y += spring.velocityY * frameScale;
        const next = circularBoundsRef.current
          ? clampPointToCircle(spring, circularBoundsRef.current)
          : { x: spring.x, y: spring.y };
        spring.x = next.x;
        spring.y = next.y;
        graph.mergeNodeAttributes(spring.node, next);
        const currentLength = Math.hypot(dragAttractor.x - spring.x, dragAttractor.y - spring.y);
        remainingMotion = Math.max(
          remainingMotion,
          Math.abs(currentLength - spring.restLength),
          Math.hypot(spring.velocityX, spring.velocityY)
        );
      }
      connectedSpringLastAt = now;
      renderer.scheduleRefresh();
      const releasedTooLong = connectedSpringReleasedAt !== null && now - connectedSpringReleasedAt > 900;
      if ((!releasedTooLong && remainingMotion >= 0.001) || draggedNode) {
        connectedSpringFrame = window.requestAnimationFrame(stepConnectedSpring);
      } else {
        connectedSpringFrame = null;
        connectedSprings = [];
        dragAttractor = null;
      }
    }
    renderer.on("clickNode", ({ node }) => {
      if (suppressNextNodeClick) {
        suppressNextNodeClick = false;
        return;
      }
      const attributes = graph.getNodeAttributes(node);
      persistViewState();
      if (attributes.kind === "community") {
        const display = renderer.getNodeDisplayData(node);
        if (display) void camera.animate({ x: display.x, y: display.y, ratio: 0.42 }, { duration: 420 });
      } else if (attributes.kind === "atomic_note" && attributes.rawId && attributes.sourceItemId) {
        onOpenAtomicNote(attributes.sourceItemId, attributes.rawId);
      } else if (attributes.sourceItemId) {
        onOpenSource(attributes.sourceItemId);
      }
    });

      if (restoredViewState) {
        circularBoundsRef.current = measureCircularBounds(graph, rawNodeKeys);
        setLayoutRunning(false);
      } else {
        startLayout(graph);
      }
      cleanupRenderer = () => {
        stopLayout(false);
        persistViewState();
        clearActivationTimer();
        if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
        if (connectedSpringFrame !== null) window.cancelAnimationFrame(connectedSpringFrame);
        renderer.kill();
        sigmaRef.current = null;
      };

      function persistViewState() {
        onViewStateChange(mode, captureKnowledgeGraphViewState(renderer, graph, graphStateKey));
      }

      function startLayout(target: Graph<NodeAttributes, EdgeAttributes>) {
        stopLayout(false);
        const layout = new FA2LayoutConstructor<NodeAttributes, EdgeAttributes>(target, {
        getEdgeWeight: (_edge, attributes) => attributes.layoutWeight,
        settings: {
          barnesHutOptimize: target.order > 500,
          barnesHutTheta: 0.6,
          edgeWeightInfluence: 0.65,
          gravity: 1.35,
          linLogMode: true,
          scalingRatio: target.order > 5_000 ? 14 : 8,
          slowDown: target.order > 5_000 ? 18 : 10,
          strongGravityMode: true
        }
        });
        layoutRef.current = layout;
        layout.start();
        setLayoutRunning(true);
        layoutTimerRef.current = window.setTimeout(() => stopLayout(true), target.order > 5_000 ? 5_000 : 2_800);
      }

      function stopLayout(applyCircularBoundary = true) {
        if (layoutTimerRef.current !== null) window.clearTimeout(layoutTimerRef.current);
        layoutTimerRef.current = null;
        layoutRef.current?.stop();
        layoutRef.current?.kill();
        layoutRef.current = null;
        if (applyCircularBoundary) {
          circularBoundsRef.current = constrainGraphToCircle(graph, rawNodeKeys);
          renderer.setCustomBBox(null);
          renderer.scheduleRefresh();
        }
        if (!disposed) setLayoutRunning(false);
      }
    }
  }, [bundle, initialViewState, mode, onOpenAtomicNote, onOpenSource, onViewStateChange]);

  function zoom(factor: number) {
    const camera = sigmaRef.current?.getCamera();
    if (!camera) return;
    if (factor < 1) void camera.animatedZoom({ factor: 1 / factor, duration: 220 });
    else void camera.animatedUnzoom({ factor, duration: 220 });
  }

  function focusNode(id: string) {
    const renderer = sigmaRef.current;
    const key = `item:${id}`;
    if (!renderer || !renderer.getGraph().hasNode(key)) return;
    const display = renderer.getNodeDisplayData(key);
    if (!display) return;
    void renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.24 }, { duration: 420 });
    hoveredKeyRef.current = key;
    hoveredNeighborsRef.current = new Set(renderer.getGraph().neighbors(key));
    renderer.scheduleRefresh();
    setQuery("");
    if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
    focusTimerRef.current = window.setTimeout(() => {
      hoveredKeyRef.current = null;
      hoveredNeighborsRef.current = new Set();
      renderer.scheduleRefresh();
    }, 1_400);
  }

  async function rerunLayout() {
    const graph = sigmaRef.current?.getGraph();
    if (!graph || layoutRunning) return;
    const { default: FA2LayoutConstructor } = await import("graphology-layout-forceatlas2/worker");
    const layout = new FA2LayoutConstructor<NodeAttributes, EdgeAttributes>(graph, {
      getEdgeWeight: (_edge, attributes) => attributes.layoutWeight,
      settings: {
        barnesHutOptimize: true, barnesHutTheta: 0.6, gravity: 1.35, linLogMode: true,
        scalingRatio: 10, slowDown: 12, strongGravityMode: true
      }
    });
    layoutRef.current = layout;
    layout.start();
    setLayoutRunning(true);
    layoutTimerRef.current = window.setTimeout(() => {
      layout.stop();
      layout.kill();
      circularBoundsRef.current = constrainGraphToCircle(graph, graph.nodes().filter((node) => graph.getNodeAttribute(node, "lod") === "item"));
      sigmaRef.current?.setCustomBBox(null).scheduleRefresh();
      layoutRef.current = null;
      layoutTimerRef.current = null;
      setLayoutRunning(false);
    }, 2_500);
  }

  return (
    <section className="motion-fade-in-up flex h-[calc(100vh-7rem)] min-h-[34rem] flex-col overflow-hidden rounded-2xl border border-slate-200 bg-slate-950 shadow-xl dark:border-slate-800">
      <header className="relative z-20 flex flex-wrap items-center gap-3 border-b border-white/10 bg-slate-950/90 px-4 py-3 text-white backdrop-blur">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/5 p-1" aria-label={t("knowledgeGraph.viewSelector")}>
          {(["sources", "atomic_notes"] as const).map((item) => (
            <button key={item} type="button" className={cn(
              "rounded-md px-3 py-1.5 text-sm font-medium transition",
              mode === item ? "bg-cyan-400 text-slate-950 shadow" : "text-slate-300 hover:bg-white/10 hover:text-white"
            )} onClick={() => onModeChange(item)}>
              {t(item === "sources" ? "knowledgeGraph.sources" : "knowledgeGraph.atomicNotes")}
            </button>
          ))}
        </div>
        <div className="relative min-w-48 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" aria-hidden="true" />
          <Input value={query} onChange={(event) => setQuery(event.target.value)} className="h-9 border-white/10 bg-white/5 pl-9 text-white placeholder:text-slate-500" placeholder={t("knowledgeGraph.searchPlaceholder")} />
          {searchResults.length > 0 ? <ol className="absolute left-0 right-0 top-11 max-h-72 overflow-auto rounded-xl border border-slate-700 bg-slate-900 p-1 shadow-2xl">
            {searchResults.map((node) => <li key={node.id}><button type="button" className="w-full rounded-lg px-3 py-2 text-left hover:bg-white/10" onClick={() => focusNode(node.id)}>
              <span className="block truncate text-sm font-medium">{node.title}</span>
              <span className="block truncate text-xs text-slate-400">{node.subtitle}</span>
            </button></li>)}
          </ol> : null}
        </div>
        <div className="flex items-center gap-1">
          <GraphAction icon={Minus} label={t("knowledgeGraph.zoomOut")} onClick={() => zoom(1.45)} />
          <GraphAction icon={Plus} label={t("knowledgeGraph.zoomIn")} onClick={() => zoom(0.7)} />
          <GraphAction icon={Maximize2} label={t("knowledgeGraph.fit")} onClick={() => void sigmaRef.current?.getCamera().animatedReset({ duration: 350 })} />
          <GraphAction icon={layoutRunning ? LoaderCircle : Waypoints} label={t("knowledgeGraph.relayout")} spinning={layoutRunning} disabled={layoutRunning} onClick={rerunLayout} />
          <GraphAction icon={RefreshCw} label={t("knowledgeGraph.refresh")} onClick={() => setReloadToken((current) => current + 1)} />
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle_at_center,_#172554_0%,_#020617_62%)]">
        <div ref={containerRef} className="absolute inset-0" role="application" aria-label={t("knowledgeGraph.canvasLabel")} />
        {loading ? <GraphState icon={LoaderCircle} title={t("shell.states.loading")} spinning /> : null}
        {error ? <GraphState icon={Network} title={t("knowledgeGraph.error")} action={t("shell.actions.retry")} onAction={() => setReloadToken((current) => current + 1)} /> : null}
        {!loading && !error && data?.nodes.length === 0 ? <GraphState icon={Network} title={t("knowledgeGraph.empty")} /> : null}

        {!loading && data && data.nodes.length > 0 ? <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-2 text-xs text-slate-300">
          <span className="rounded-full border border-white/10 bg-slate-950/75 px-2.5 py-1 backdrop-blur">{t("knowledgeGraph.nodeCount", { values: { count: data.nodes.length } })}</span>
          <span className="rounded-full border border-white/10 bg-slate-950/75 px-2.5 py-1 backdrop-blur">{t("knowledgeGraph.edgeCount", { values: { count: bundle?.itemEdgeCount ?? data.edges.length } })}</span>
          <span className="rounded-full border border-white/10 bg-slate-950/75 px-2.5 py-1 backdrop-blur">{t(`knowledgeGraph.lod.${lod}` as MessageKey)}</span>
          {data.truncated ? <span className="rounded-full border border-amber-400/30 bg-amber-950/80 px-2.5 py-1 text-amber-200">{t("knowledgeGraph.truncated")}</span> : null}
        </div> : null}

        {floatingEdgeLabel ? <div
          className="motion-graph-tooltip-in pointer-events-none absolute z-10 max-w-56 rounded-md border border-cyan-300/20 bg-slate-900/92 px-2 py-1 text-xs font-medium leading-snug text-slate-100 shadow-lg backdrop-blur"
          style={{ left: floatingEdgeLabel.x, top: floatingEdgeLabel.y }}
        >
          {floatingEdgeLabel.label}
        </div> : null}
        {hover && bundle ? <GraphTooltip hover={hover} graph={bundle.graph} t={t} /> : null}
      </div>
    </section>
  );
}

function GraphAction({ icon: Icon, label, onClick, disabled = false, spinning = false }: {
  icon: typeof Focus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  spinning?: boolean;
}) {
  return <button type="button" disabled={disabled} className="grid h-9 w-9 place-items-center rounded-lg border border-white/10 bg-white/5 text-slate-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50" aria-label={label} title={label} onClick={onClick}>
    <Icon className={cn("h-4 w-4", spinning && "animate-spin")} aria-hidden="true" />
  </button>;
}

function GraphState({ icon: Icon, title, action, onAction, spinning = false }: {
  icon: typeof Network;
  title: string;
  action?: string;
  onAction?: () => void;
  spinning?: boolean;
}) {
  return <div className="absolute inset-0 grid place-items-center bg-slate-950/70 text-center text-white backdrop-blur-sm">
    <div className="grid max-w-sm justify-items-center gap-3 px-6">
      <Icon className={cn("h-8 w-8 text-cyan-300", spinning && "animate-spin")} aria-hidden="true" />
      <p className="text-sm text-slate-200">{title}</p>
      {action && onAction ? <button type="button" className="rounded-lg bg-cyan-400 px-3 py-2 text-sm font-semibold text-slate-950" onClick={onAction}>{action}</button> : null}
    </div>
  </div>;
}

function ViewportTooltip({ hover, className, children }: {
  hover: HoverCard;
  className: string;
  children: ReactNode;
}) {
  const tooltipRef = useRef<HTMLElement | null>(null);
  const [position, setPosition] = useState({ x: hover.x + 14, y: hover.y + 14 });

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current;
    const viewport = tooltip?.offsetParent;
    if (!(tooltip instanceof HTMLElement) || !(viewport instanceof HTMLElement)) return;
    const updatePosition = () => {
      const next = positionOverlayWithinViewport(
        { x: hover.x, y: hover.y },
        { width: tooltip.offsetWidth, height: tooltip.offsetHeight },
        { width: viewport.clientWidth, height: viewport.clientHeight }
      );
      setPosition((current) => current.x === next.x && current.y === next.y ? current : next);
    };
    updatePosition();
    const observer = new ResizeObserver(updatePosition);
    observer.observe(tooltip);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [hover.x, hover.y]);

  return <aside
    ref={tooltipRef}
    className={cn(
      "pointer-events-none absolute z-10 max-h-[calc(100%-1rem)] max-w-[calc(100%-1rem)] overflow-y-auto rounded-xl border border-white/15 bg-slate-900/95 p-3 text-white shadow-2xl backdrop-blur",
      className,
      hover.exiting ? "motion-graph-tooltip-out" : "motion-graph-tooltip-in"
    )}
    style={{ left: position.x, top: position.y }}
  >
    {children}
  </aside>;
}

function GraphTooltip({ hover, graph, t }: {
  hover: HoverCard;
  graph: Graph<NodeAttributes, EdgeAttributes>;
  t: Translator;
}) {
  if (hover.type === "node" && graph.hasNode(hover.key)) {
    const node = graph.getNodeAttributes(hover.key);
    return <ViewportTooltip hover={hover} className="w-80">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">{t(node.kind === "community" ? "knowledgeGraph.community" : node.kind === "source" ? "knowledgeGraph.source" : "knowledgeGraph.atomicNote")}</p>
      <h3 className="mt-1 text-sm font-semibold leading-snug">{node.title}</h3>
      {node.subtitle ? <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-300">{node.subtitle}</p> : null}
      {node.kind === "atomic_note" && node.content ? <p className="mt-2 max-h-48 overflow-hidden whitespace-pre-wrap border-t border-white/10 pt-2 text-xs leading-relaxed text-slate-200">{node.content}</p> : null}
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
        <div><dt className="text-slate-500">{t("knowledgeGraph.connections")}</dt><dd>{node.importance}</dd></div>
        <div><dt className="text-slate-500">{t(node.kind === "community" ? "knowledgeGraph.items" : "knowledgeGraph.entities")}</dt><dd>{node.kind === "community" ? node.memberCount : node.detailCount}</dd></div>
      </dl>
      {node.kind !== "community" ? <p className="mt-2 text-[11px] text-cyan-300">{t("knowledgeGraph.clickToOpen")}</p> : <p className="mt-2 text-[11px] text-cyan-300">{t("knowledgeGraph.clickToExplore")}</p>}
    </ViewportTooltip>;
  }
  if (hover.type === "edge" && graph.hasEdge(hover.key)) {
    const edge = graph.getEdgeAttributes(hover.key);
    if (edge.kind === "support" || edge.kind === "community") return null;
    if (edge.kind === "source_connection") {
      const [source, target] = graph.extremities(hover.key);
      const sourceItemId = graph.getNodeAttribute(source, "rawId");
      const targetSourceItemId = graph.getNodeAttribute(target, "rawId");
      if (!sourceItemId || !targetSourceItemId) return null;
      return <SourceConnectionTooltip
        hover={hover}
        sourceItemId={sourceItemId}
        targetSourceItemId={targetSourceItemId}
        summary={edge.sourceRelations}
        t={t}
      />;
    }
    return <ViewportTooltip hover={hover} className="w-80">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">{t(`knowledgeGraph.edgeKinds.${edge.kind}` as MessageKey)}</p>
      <p className="mt-1 text-sm font-medium">{edge.label}</p>
      {edge.description ? <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-slate-300">{edge.description}</p> : null}
      {edge.details.length > 0 ? <ul className="mt-2 grid gap-1 text-xs text-slate-300">{edge.details.slice(0, 4).map((detail) => <li key={detail}>• {detail}</li>)}</ul> : null}
      <p className="mt-2 text-[11px] tabular-nums text-slate-400">{t("knowledgeGraph.confidence", { values: { value: Math.round(edge.confidence * 100) } })}</p>
    </ViewportTooltip>;
  }
  return null;
}

function SourceConnectionTooltip({ hover, sourceItemId, targetSourceItemId, summary, t }: {
  hover: HoverCard;
  sourceItemId: string;
  targetSourceItemId: string;
  summary: SourceRelationGroup[];
  t: Translator;
}) {
  const [details, setDetails] = useState<KnowledgeGraphSourceConnectionDetails | null>(null);

  useEffect(() => {
    let active = true;
    window.app.knowledge.getGraphSourceConnectionDetails(sourceItemId, targetSourceItemId)
      .then((result) => { if (active) setDetails(result); })
      .catch(() => { /* Keep the bounded dashboard summary as a fallback. */ });
    return () => { active = false; };
  }, [sourceItemId, targetSourceItemId]);

  const groups = details ? [
    {
      kind: "shared_entity" as const,
      weight: details.sharedEntities.length,
      details: details.sharedEntities
    },
    {
      kind: "semantic_relation" as const,
      weight: details.semanticRelations.length,
      details: details.semanticRelations
    }
  ].filter((group) => group.details.length > 0) : summary;

  return <ViewportTooltip hover={hover} className="w-96">
    <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">
      {t("knowledgeGraph.edgeKinds.source_connection")}
    </p>
    <div className="mt-2 grid gap-3">
      {groups.map((relation) => <section key={relation.kind}>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-xs font-semibold text-slate-100">
            {t(`knowledgeGraph.edgeKinds.${relation.kind}` as MessageKey)}
          </h3>
          <span className="text-[11px] tabular-nums text-slate-400">
            {t("knowledgeGraph.edgeCount", { values: { count: relation.weight } })}
          </span>
        </div>
        {relation.details.length > 0 ? <ul className="mt-1 grid gap-1 text-xs leading-relaxed text-slate-300">
          {relation.details.map((detail) => <li key={detail}>• {detail}</li>)}
        </ul> : null}
      </section>)}
    </div>
  </ViewportTooltip>;
}

function buildGraph(data: DashboardData, t: Translator): GraphBundle {
  const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "undirected", multi: true, allowSelfLoops: false });
  for (const node of data.nodes) {
    const angle = hashFraction(node.id, 0) * Math.PI * 2;
    const radius = 4 + hashFraction(node.id, 1) * 8;
    graph.addNode(`item:${node.id}`, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      label: node.title,
      size: 4,
      color: node.kind === "source" ? sourceColors[node.sourceType ?? ""] ?? "#0891b2" : noteColors[node.noteStatus ?? ""] ?? "#7c3aed",
      kind: node.kind,
      lod: "item",
      rawId: node.id,
      sourceItemId: node.sourceItemId,
      title: node.title,
      subtitle: node.subtitle,
      content: node.content,
      sourceType: node.sourceType,
      noteStatus: node.noteStatus,
      detailCount: node.detailCount,
      memberCount: 1,
      importance: 0,
      labelOpacity: 0.8
    });
  }
  const preparedEdges = prepareGraphEdges(data, t);
  const stateKey = knowledgeGraphStateKey(data, preparedEdges);
  for (const edge of preparedEdges) {
    const source = `item:${edge.source}`;
    const target = `item:${edge.target}`;
    if (!graph.hasNode(source) || !graph.hasNode(target)) continue;
    graph.addEdgeWithKey(`item-edge:${edge.id}`, source, target, {
      label: edge.label,
      size: Math.min(1.05, 0.18 + Math.log2(edge.weight + 1) * 0.14),
      color: edge.kind === "atomic_note_relation"
        ? "rgba(167, 139, 250, 0.16)"
        : "rgba(56, 189, 248, 0.08)",
      kind: edge.kind,
      lod: "item",
      confidence: edge.confidence,
      weight: edge.weight,
      description: edge.description,
      details: edge.details,
      layoutWeight: Math.max(0.2, Math.log2(edge.weight + 1) * edge.confidence),
      labelOpacity: 0.2,
      labelRevealAt: edge.kind === "atomic_note_relation"
        ? relationLabelRevealAt(edge.id, edge.confidence, preparedEdges.length)
        : 2,
      sourceRelations: edge.sourceRelations,
      interactionTarget: null
    });
  }

  const rawNodeKeys = graph.nodes();
  for (const node of rawNodeKeys) {
    const degree = graph.degree(node);
    graph.updateNodeAttribute(node, "importance", () => degree);
    graph.updateNodeAttribute(node, "size", () => Math.min(13, 3.5 + Math.log2(degree + 1) * 1.8));
  }
  if (rawNodeKeys.length === 0) {
    return { graph, rawNodeKeys, communityCount: 0, itemEdgeCount: preparedEdges.length, stateKey };
  }

  const mapping = graph.size > 0
    ? louvain(graph, { getEdgeWeight: (_edge, attributes) => attributes.layoutWeight, rng: seededRandom(41) })
    : Object.fromEntries(rawNodeKeys.map((node, index) => [node, index]));
  const communities = new Map<number, string[]>();
  for (const node of rawNodeKeys) {
    const community = mapping[node] ?? communities.size;
    communities.set(community, [...(communities.get(community) ?? []), node]);
  }
  const orderedCommunities = [...communities.entries()].toSorted((left, right) => right[1].length - left[1].length || left[0] - right[0]);
  const nodeCommunity = new Map<string, string>();
  orderedCommunities.forEach(([community, members], index) => {
    const communityKey = `community:${community}`;
    const angle = index * 2.399963;
    const radius = 5 * Math.sqrt(index + 1);
    graph.addNode(communityKey, {
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      label: `${members.length}`,
      size: Math.min(24, 7 + Math.log2(members.length + 1) * 3),
      color: index % 2 === 0 ? "#22d3ee" : "#818cf8",
      kind: "community",
      lod: "community",
      rawId: null,
      sourceItemId: null,
      title: String(members.length),
      subtitle: null,
      content: null,
      sourceType: null,
      noteStatus: null,
      detailCount: 0,
      memberCount: members.length,
      importance: members.reduce((sum, member) => sum + graph.degree(member), 0),
      labelOpacity: 0.25
    });
    members.forEach((member) => {
      nodeCommunity.set(member, communityKey);
      graph.addEdge(communityKey, member, {
        label: "", size: 0, color: "rgba(0,0,0,0)", kind: "support", lod: "support",
        confidence: 0, weight: 1, description: null, details: [], layoutWeight: 0.32,
        labelOpacity: 0, labelRevealAt: 2, sourceRelations: [], interactionTarget: null
      });
    });
  });

  const aggregated = new Map<string, { source: string; target: string; weight: number }>();
  for (const edge of graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "lod") === "item")) {
    const [rawSource, rawTarget] = graph.extremities(edge);
    const source = nodeCommunity.get(rawSource);
    const target = nodeCommunity.get(rawTarget);
    if (!source || !target || source === target) continue;
    const key = [source, target].sort().join("|");
    const current = aggregated.get(key) ?? { source, target, weight: 0 };
    current.weight += graph.getEdgeAttribute(edge, "layoutWeight");
    aggregated.set(key, current);
  }
  for (const [key, edge] of aggregated) {
    graph.addEdgeWithKey(`community-edge:${key}`, edge.source, edge.target, {
      label: "", size: Math.min(1.2, 0.3 + Math.log2(edge.weight + 1) * 0.2), color: "rgba(34, 211, 238, 0.08)",
      kind: "community", lod: "community", confidence: 0, weight: edge.weight,
      description: null, details: [], layoutWeight: Math.max(0.15, Math.log2(edge.weight + 1) * 0.18),
      labelOpacity: 0, labelRevealAt: 2, sourceRelations: [], interactionTarget: null
    });
  }
  for (const [index, [, members]] of orderedCommunities.entries()) {
    const centerAngle = index * 2.399963;
    const centerRadius = 5 * Math.sqrt(index + 1);
    const centerX = Math.cos(centerAngle) * centerRadius;
    const centerY = Math.sin(centerAngle) * centerRadius;
    for (const member of members) {
      const localAngle = hashFraction(member, 2) * Math.PI * 2;
      const localRadius = 0.8 + hashFraction(member, 3) * Math.max(2, Math.sqrt(members.length));
      graph.mergeNodeAttributes(member, { x: centerX + Math.cos(localAngle) * localRadius, y: centerY + Math.sin(localAngle) * localRadius });
    }
  }
  const interactionEdges = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "lod") === "item");
  for (const edge of interactionEdges) {
    const [source, target] = graph.extremities(edge);
    graph.addEdgeWithKey(`hit:${edge}`, source, target, {
      label: "",
      size: relationHitAreaScreenThickness,
      color: "rgba(0, 0, 0, 0)",
      kind: "hit_area",
      lod: "item",
      confidence: 0,
      weight: 1,
      description: null,
      details: [],
      layoutWeight: 0,
      labelOpacity: 0,
      labelRevealAt: 2,
      sourceRelations: [],
      interactionTarget: edge
    });
  }
  return {
    graph,
    rawNodeKeys,
    communityCount: communities.size,
    itemEdgeCount: preparedEdges.length,
    stateKey
  };
}

export function prepareGraphEdges(data: DashboardData, t: Translator): PreparedGraphEdge[] {
  if (data.mode === "atomic_notes") {
    return data.edges.map((edge) => ({
      ...edge,
      kind: "atomic_note_relation",
      label: formatEdgeLabel(edge.label, t),
      sourceRelations: []
    }));
  }

  const grouped = new Map<string, PreparedGraphEdge>();
  for (const edge of data.edges) {
    const source = edge.source < edge.target ? edge.source : edge.target;
    const target = edge.source < edge.target ? edge.target : edge.source;
    const key = `${source}:${target}`;
    const current: PreparedGraphEdge = grouped.get(key) ?? {
      id: key,
      source,
      target,
      kind: "source_connection" as const,
      label: "",
      description: null,
      weight: 0,
      confidence: 0,
      details: [],
      sourceRelations: []
    };
    current.weight += edge.weight;
    current.confidence = Math.max(current.confidence, edge.confidence);
    current.details.push(...edge.details);
    current.sourceRelations.push({
      kind: edge.kind as SourceRelationKind,
      weight: edge.weight,
      confidence: edge.confidence,
      details: edge.details
    });
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

function knowledgeGraphStateKey(data: DashboardData, edges: PreparedGraphEdge[]): string {
  let hash = 2166136261;
  const include = (value: string) => {
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
  };
  data.nodes.forEach((node) => include(node.id));
  edges.forEach((edge) => include(edge.id));
  return `${data.mode}:${data.nodes.length}:${edges.length}:${hash >>> 0}`;
}

function captureKnowledgeGraphViewState(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  stateKey: string
): KnowledgeGraphViewState {
  const nodePositions: KnowledgeGraphViewState["nodePositions"] = {};
  graph.forEachNode((node, attributes) => {
    nodePositions[node] = { x: attributes.x, y: attributes.y };
  });
  const camera = renderer.getCamera().getState();
  return {
    stateKey,
    camera: { x: camera.x, y: camera.y, ratio: camera.ratio, angle: camera.angle },
    nodePositions
  };
}

function restoreKnowledgeGraphViewState(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  stateKey: string,
  state?: KnowledgeGraphViewState
): boolean {
  if (!state || state.stateKey !== stateKey) return false;
  const nodes = graph.nodes();
  if (!nodes.every((node) => state.nodePositions[node])) return false;
  for (const node of nodes) {
    const position = state.nodePositions[node];
    if (position) graph.mergeNodeAttributes(node, position);
  }
  return true;
}

function reduceNode(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  node: string,
  attributes: NodeAttributes,
  lod: LodLevel,
  cameraRatio: number,
  hovered: string | null,
  neighbors: Set<string>
) {
  const isCommunity = attributes.lod === "community";
  const visible = isNodeVisibleAtLod(lod, isCommunity, attributes.importance, hubThreshold(graph));
  if (!visible) return { ...attributes, hidden: true };
  const zoomStrength = zoomVisualStrength(cameraRatio);
  if (!hovered) return {
    ...attributes,
    hidden: false,
    forceLabel: lod === "detail" ? attributes.importance >= 4 : false,
    label: attributes.label,
    labelOpacity: isCommunity
      ? 0.18 + zoomStrength * 0.32
      : 0.14 + zoomStrength * 0.86
  };
  const emphasized = node === hovered || neighbors.has(node);
  return {
    ...attributes,
    hidden: false,
    color: emphasized ? attributes.color : mutedNode,
    forceLabel: emphasized,
    label: emphasized && !isCommunity ? attributes.label : null,
    labelOpacity: emphasized ? 1 : 0.16,
    zIndex: emphasized ? 2 : 0
  };
}

function reduceEdge(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  edge: string,
  attributes: EdgeAttributes,
  lod: LodLevel,
  cameraRatio: number,
  hovered: string | null,
  hoverStrength: number
) {
  if (attributes.kind === "hit_area") {
    return {
      ...attributes,
      hidden: lod === "overview",
      color: "rgba(0, 0, 0, 0)",
      size: zoomCompensatedEdgeSize(cameraRatio, relationHitAreaScreenThickness),
      forceLabel: false,
      label: null,
      labelOpacity: 0,
      zIndex: 10
    };
  }
  const visible = attributes.lod === (lod === "overview" ? "community" : "item");
  if (attributes.lod === "support" || !visible) return { ...attributes, hidden: true };
  const zoomStrength = zoomVisualStrength(cameraRatio);
  const revealProgress = attributes.label && attributes.labelRevealAt <= 1
    ? clamp((zoomStrength - attributes.labelRevealAt) / Math.max(0.01, 1 - attributes.labelRevealAt), 0, 1)
    : 0;
  const showRestingLabel = revealProgress > 0;
  const restingLabelOpacity = showRestingLabel ? 0.08 + revealProgress * 0.82 : 0;
  const screenThickness = attributes.kind === "community" ? 1.4 : 1.8;
  const compensatedSize = zoomCompensatedEdgeSize(cameraRatio, screenThickness);
  if (!hovered) return {
    ...attributes,
    hidden: false,
    color: restingEdgeColor(attributes.kind, zoomStrength),
    size: compensatedSize,
    forceLabel: showRestingLabel,
    label: showRestingLabel ? attributes.label : null,
    labelOpacity: restingLabelOpacity
  };
  const incident = hovered === edge || graph.extremities(edge).includes(hovered);
  return {
    ...attributes,
    hidden: false,
    color: incident ? highlightedEdgeColor(attributes.kind, hoverStrength) : mutedEdge,
    size: compensatedSize,
    forceLabel: incident && Boolean(attributes.label) && (hoverStrength > 0.05 || showRestingLabel),
    label: incident && attributes.label ? attributes.label : null,
    labelOpacity: incident ? Math.max(hoverStrength, restingLabelOpacity) : 0.18,
    zIndex: incident ? 2 : 0
  };
}

function restingEdgeColor(kind: EdgeAttributes["kind"], strength: number): string {
  if (kind === "community") return `rgba(34, 211, 238, ${0.05 + strength * 0.18})`;
  if (kind === "atomic_note_relation") return `rgba(167, 139, 250, ${0.06 + strength * 0.42})`;
  return `rgba(56, 189, 248, ${0.04 + strength * 0.38})`;
}

function highlightedEdgeColor(kind: EdgeAttributes["kind"], strength: number): string {
  const opacity = 0.08 + 0.92 * strength;
  if (kind === "atomic_note_relation") return `rgba(196, 181, 253, ${opacity})`;
  return `rgba(125, 211, 252, ${opacity})`;
}

function edgeLabelFallsOutsideViewport(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  edge: string
): boolean {
  if (!graph.getEdgeAttribute(edge, "label")) return false;
  const [source, target] = graph.extremities(edge);
  const sourceData = renderer.getNodeDisplayData(source);
  const targetData = renderer.getNodeDisplayData(target);
  if (!sourceData || !targetData) return true;
  const midpointX = (sourceData.x + targetData.x) / 2;
  const midpointY = (sourceData.y + targetData.y) / 2;
  const { width, height } = renderer.getDimensions();
  const label = graph.getEdgeAttribute(edge, "label");
  const horizontalMargin = Math.min(104, Math.max(32, label.length * 3.2));
  return isLabelOutsideViewport(midpointX, midpointY, width, height, horizontalMargin, 28);
}

function floatingLabelPosition(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  event: { x: number; y: number }
): { x: number; y: number } {
  const { width, height } = renderer.getDimensions();
  return {
    x: clamp(event.x + 14, 8, Math.max(8, width - 232)),
    y: clamp(event.y + 14, 8, Math.max(8, height - 48))
  };
}

const drawWrappedNodeLabel: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (context, data, settings) => {
  if (!data.label) return;
  const opacity = Number((data as typeof data & { labelOpacity?: number }).labelOpacity ?? 1);
  const color = settings.labelColor.attribute
    ? String(data[settings.labelColor.attribute] ?? settings.labelColor.color ?? "#cbd5e1")
    : settings.labelColor.color;
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = color ?? "#cbd5e1";
  context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
  context.textAlign = "center";
  context.textBaseline = "top";
  const lines = wrapCanvasText(context, data.label, 190, 3);
  const lineHeight = settings.labelSize * 1.18;
  const startY = data.y + data.size + 4;
  lines.forEach((line, index) => context.fillText(line, data.x, startY + index * lineHeight));
  context.restore();
};

const drawFadingEdgeLabel: EdgeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (
  context,
  edgeData,
  sourceData,
  targetData,
  settings
) => {
  if (!edgeData.label) return;
  const opacity = Number((edgeData as typeof edgeData & { labelOpacity?: number }).labelOpacity ?? 1);
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = (settings.edgeLabelColor.attribute
    ? String(edgeData[settings.edgeLabelColor.attribute] ?? settings.edgeLabelColor.color ?? "#cbd5e1")
    : settings.edgeLabelColor.color) ?? "#94a3b8";
  context.font = `${settings.edgeLabelWeight} ${settings.edgeLabelSize}px ${settings.edgeLabelFont}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const x = (sourceData.x + targetData.x) / 2;
  const y = (sourceData.y + targetData.y) / 2;
  const lines = wrapCanvasText(context, edgeData.label, 120, 2);
  const lineHeight = settings.edgeLabelSize * 1.12;
  lines.forEach((line, index) => context.fillText(line, x, y + (index - (lines.length - 1) / 2) * lineHeight));
  context.restore();
};

function wrapCanvasText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const words = text.trim().split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  while (words.length > 0 && lines.length < maxLines) {
    const word = words.shift() ?? "";
    const candidate = current ? `${current} ${word}` : word;
    if (context.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }
    if (current) {
      lines.push(current);
      current = word;
    } else {
      lines.push(ellipsizeCanvasText(context, word, maxWidth));
      current = "";
    }
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (words.length > 0 && lines.length > 0) {
    lines[lines.length - 1] = ellipsizeCanvasText(
      context,
      `${lines.at(-1) ?? ""} ${words.join(" ")}`,
      maxWidth
    );
  }
  return lines;
}

function ellipsizeCanvasText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (context.measureText(text).width <= maxWidth) return text;
  let result = text;
  while (result.length > 1 && context.measureText(`${result}…`).width > maxWidth) result = result.slice(0, -1);
  return `${result.trimEnd()}…`;
}

function measureCircularBounds(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  rawNodeKeys: string[]
): CircularBounds {
  const nodes = rawNodeKeys.filter((node) => graph.hasNode(node));
  if (nodes.length === 0) return { centerX: 0, centerY: 0, radius: 1 };
  const centerX = nodes.reduce((sum, node) => sum + graph.getNodeAttribute(node, "x"), 0) / nodes.length;
  const centerY = nodes.reduce((sum, node) => sum + graph.getNodeAttribute(node, "y"), 0) / nodes.length;
  const radii = nodes.map((node) => {
    const attributes = graph.getNodeAttributes(node);
    return Math.hypot(attributes.x - centerX, attributes.y - centerY);
  }).sort((left, right) => left - right);
  const percentile = radii[Math.min(radii.length - 1, Math.floor(radii.length * 0.92))] ?? 1;
  return { centerX, centerY, radius: Math.max(1, percentile * 1.18) };
}

function constrainGraphToCircle(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  rawNodeKeys: string[]
): CircularBounds {
  const nodes = rawNodeKeys.filter((node) => graph.hasNode(node));
  if (nodes.length === 0) return { centerX: 0, centerY: 0, radius: 1 };
  const measured = measureCircularBounds(graph, nodes);
  const varianceX = nodes.reduce((sum, node) => {
    const value = graph.getNodeAttribute(node, "x") - measured.centerX;
    return sum + value * value;
  }, 0) / nodes.length;
  const varianceY = nodes.reduce((sum, node) => {
    const value = graph.getNodeAttribute(node, "y") - measured.centerY;
    return sum + value * value;
  }, 0) / nodes.length;
  const targetSpread = Math.sqrt((varianceX + varianceY) / 2) || 1;
  const scaleX = clamp(targetSpread / (Math.sqrt(varianceX) || 1), 0.45, 2.4);
  const scaleY = clamp(targetSpread / (Math.sqrt(varianceY) || 1), 0.45, 2.4);
  for (const node of graph.nodes()) {
    const attributes = graph.getNodeAttributes(node);
    graph.mergeNodeAttributes(node, {
      x: (attributes.x - measured.centerX) * scaleX,
      y: (attributes.y - measured.centerY) * scaleY
    });
  }
  const normalizedBounds = measureCircularBounds(graph, nodes);
  const bounds = { centerX: normalizedBounds.centerX, centerY: normalizedBounds.centerY, radius: normalizedBounds.radius };
  for (const node of graph.nodes()) {
    const attributes = graph.getNodeAttributes(node);
    graph.mergeNodeAttributes(node, clampPointToCircle(attributes, bounds));
  }
  return bounds;
}

function clampPointToCircle(point: { x: number; y: number }, bounds: CircularBounds): { x: number; y: number } {
  const deltaX = point.x - bounds.centerX;
  const deltaY = point.y - bounds.centerY;
  const distance = Math.hypot(deltaX, deltaY);
  if (distance <= bounds.radius || distance === 0) return { x: point.x, y: point.y };
  const ratio = bounds.radius / distance;
  return { x: bounds.centerX + deltaX * ratio, y: bounds.centerY + deltaY * ratio };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function hubThreshold(graph: Graph<NodeAttributes, EdgeAttributes>): number {
  if (graph.order < 250) return 2;
  if (graph.order < 2_000) return 4;
  return 7;
}

function formatEdgeLabel(label: string, t: Translator): string {
  if (label === "shared_entity") return t("knowledgeGraph.edgeKinds.shared_entity");
  if (label === "semantic_relation") return t("knowledgeGraph.edgeKinds.semantic_relation");
  const atomicRelationKey = atomicRelationMessageKeys[label];
  if (atomicRelationKey) return t(atomicRelationKey);
  return label.replaceAll("_", " ");
}

function hashFraction(value: string, salt: number): number {
  let hash = 2166136261 ^ salt;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
