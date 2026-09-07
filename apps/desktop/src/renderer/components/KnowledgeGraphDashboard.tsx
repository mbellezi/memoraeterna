import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import Graph from "graphology";
import { SourceConnectionGraph } from "./SourceConnectionGraph";
import { KnowledgeGraphLayout } from "./knowledge-graph-layout";
import { defaultGraphForceSettings, graphLayoutRadius, type GraphForceSettings } from "./knowledge-graph-layout-contract";
import {
  GraphHoverIntent,
  GraphWheelMotion,
  blendGraphColor,
  boundedGraphWheelRatio,
  captureGraphWheelEvent,
  graphHighlightColor,
  graphMutedColor,
  graphZoomOutRatio,
  zoomOutCenteringStrength,
  type GraphHoverTarget
} from "./knowledge-graph-interaction";
import type Sigma from "sigma";
import type { EdgeLabelDrawingFunction, NodeLabelDrawingFunction } from "sigma/rendering";
import {
  AtSign,
  ArrowLeft,
  Boxes,
  CircleDot,
  Check,
  EqualApproximately,
  Focus,
  GitBranchPlus,
  GitCompareArrows,
  Lightbulb,
  Link2,
  LoaderCircle,
  Maximize2,
  Minus,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  SlidersHorizontal,
  Tags,
  Ungroup,
  Workflow,
  Waypoints,
  X
} from "lucide-react";
import type { IconNode, LucideIcon } from "lucide-react";
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
  graphNodeSize,
  graphTypography,
  nodeLabelOpacity,
  positionOverlayWithinViewport,
  relationLabelRevealAt,
  relationHitAreaScreenThickness,
  zoomCompensatedEdgeSize,
  zoomVisualStrength
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
  kind: "source" | "atomic_note";
  rawId: string | null;
  sourceItemId: string | null;
  title: string;
  subtitle: string | null;
  content: string | null;
  sourceType: string | null;
  noteStatus: string | null;
  detailCount: number;
  parentSourceItemId: string | null;
  childCount: number;
  visibleChildCount: number;
  importance: number;
  labelOpacity: number;
  labelColor?: string;
}

interface EdgeAttributes {
  label: string;
  size: number;
  color: string;
  kind: "source_connection" | "atomic_note_relation" | "hierarchy_link" | "hit_area";
  confidence: number;
  weight: number;
  description: string | null;
  details: string[];
  layoutWeight: number;
  labelOpacity: number;
  labelColor?: string;
  labelRevealAt: number;
  relationType: string | null;
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

interface GraphBundle {
  graph: Graph<NodeAttributes, EdgeAttributes>;
  rawNodeKeys: string[];
  itemEdgeCount: number;
  stateKey: string;
  hierarchyGroups: Array<{ root: string; children: string[]; title: string }>;
}

export interface KnowledgeGraphViewState {
  stateKey: string;
  camera: { x: number; y: number; ratio: number; angle: number };
  nodePositions: Record<string, { x: number; y: number }>;
  bounds?: { x: [number, number]; y: [number, number] };
  forces?: GraphForceSettings;
  sourceHierarchy?: {
    showAll: boolean;
    expandedSourceIds: string[];
  };
}

interface HierarchyNodeActions {
  node: string;
  sourceItemId: string;
  childCount: number;
  expanded: boolean;
  x: number;
  y: number;
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
  relationType: string | null;
}

interface SourceHierarchyProjectionOptions {
  showAll: boolean;
  expandedSourceIds: ReadonlySet<string>;
  focusSourceId: string | null;
}

export function projectSourceHierarchy(
  data: DashboardData,
  options: SourceHierarchyProjectionOptions
): DashboardData {
  if (data.mode !== "sources") return data;
  const nodeById = new Map(data.nodes.map((node) => [node.id, node]));
  const rootCache = new Map<string, string>();
  const rootFor = (nodeId: string): string => {
    const cached = rootCache.get(nodeId);
    if (cached) return cached;
    const visited = new Set<string>();
    let current = nodeById.get(nodeId);
    while (current?.parentSourceItemId && nodeById.has(current.parentSourceItemId) && !visited.has(current.id)) {
      visited.add(current.id);
      current = nodeById.get(current.parentSourceItemId);
    }
    const rootId = current?.id ?? nodeId;
    for (const visitedId of visited) rootCache.set(visitedId, rootId);
    rootCache.set(nodeId, rootId);
    return rootId;
  };
  const roots = new Set(data.nodes.map((node) => rootFor(node.id)));
  const expanded = options.showAll
    ? roots
    : new Set([...options.expandedSourceIds].filter((id) => roots.has(id)));
  if (options.focusSourceId && roots.has(options.focusSourceId)) expanded.add(options.focusSourceId);
  const mappedId = (nodeId: string) => expanded.has(rootFor(nodeId)) ? nodeId : rootFor(nodeId);
  const resolvedFocusId = options.focusSourceId && roots.has(options.focusSourceId)
    ? options.focusSourceId
    : null;
  const focusMembers = resolvedFocusId
    ? new Set(data.nodes.filter((node) => rootFor(node.id) === resolvedFocusId).map((node) => node.id))
    : null;
  const visibleIds = new Set<string>();
  if (focusMembers) {
    for (const nodeId of focusMembers) visibleIds.add(nodeId);
    for (const edge of data.edges) {
      const sourceFocused = focusMembers.has(edge.source);
      const targetFocused = focusMembers.has(edge.target);
      if (sourceFocused === targetFocused) continue;
      visibleIds.add(mappedId(sourceFocused ? edge.target : edge.source));
    }
  } else {
    for (const node of data.nodes) {
      const rootId = rootFor(node.id);
      if (node.id === rootId || expanded.has(rootId)) visibleIds.add(node.id);
    }
  }

  const aggregatedDetailCounts = new Map<string, number>();
  for (const node of data.nodes) {
    const rootId = rootFor(node.id);
    aggregatedDetailCounts.set(rootId, (aggregatedDetailCounts.get(rootId) ?? 0) + node.detailCount);
  }
  const nodes = data.nodes.filter((node) => visibleIds.has(node.id)).map((node) => {
    const rootId = rootFor(node.id);
    if (node.id !== rootId || expanded.has(rootId)) return node;
    return { ...node, detailCount: aggregatedDetailCounts.get(rootId) ?? node.detailCount };
  });

  const groupedEdges = new Map<string, DashboardData["edges"][number]>();
  for (const edge of data.edges) {
    if (focusMembers && !focusMembers.has(edge.source) && !focusMembers.has(edge.target)) continue;
    const mappedSource = mappedId(edge.source);
    const mappedTarget = mappedId(edge.target);
    if (mappedSource === mappedTarget || !visibleIds.has(mappedSource) || !visibleIds.has(mappedTarget)) continue;
    const source = mappedSource < mappedTarget ? mappedSource : mappedTarget;
    const target = mappedSource < mappedTarget ? mappedTarget : mappedSource;
    const key = `${edge.kind}:${source}:${target}`;
    const current = groupedEdges.get(key);
    if (!current) {
      groupedEdges.set(key, { ...edge, id: `hierarchy:${key}`, source, target, details: [...edge.details] });
      continue;
    }
    current.weight += edge.weight;
    current.confidence = Math.max(current.confidence, edge.confidence);
    current.details = [...new Set([...current.details, ...edge.details])].slice(0, 6);
  }
  return { ...data, nodes, edges: [...groupedEdges.values()] };
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

const atomicRelationLegend = [
  { type: "supports", color: "#34d399", icon: Check },
  { type: "contrasts", color: "#fb7185", icon: GitCompareArrows },
  { type: "extends", color: "#60a5fa", icon: GitBranchPlus },
  { type: "similar_to", color: "#c084fc", icon: EqualApproximately },
  { type: "depends_on", color: "#fbbf24", icon: Workflow },
  { type: "clarifies", color: "#facc15", icon: Lightbulb },
  { type: "mentions", color: "#22d3ee", icon: AtSign },
  { type: "related", color: "#a78bfa", icon: Link2 }
] as const;

export function atomicRelationColor(type: string | null): string {
  return atomicRelationLegend.find((item) => item.type === type)?.color ?? "#cbd5e1";
}

export const atomicRelationMarkerRadius = 8.8;

function extractLucideIconNode(icon: LucideIcon): IconNode {
  const element = (icon as unknown as {
    render: (props: Record<string, never>, ref: null) => ReactElement<{ iconNode: IconNode }>;
  }).render({}, null);
  return element.props.iconNode;
}

export function atomicRelationIconNode(type: string | null): IconNode {
  const icon = atomicRelationLegend.find((item) => item.type === type)?.icon ?? CircleDot;
  return extractLucideIconNode(icon);
}

function atomicRelationIcon(type: string | null): LucideIcon {
  return atomicRelationLegend.find((item) => item.type === type)?.icon ?? CircleDot;
}

export function KnowledgeGraphDashboard({
  t,
  mode,
  wheelZoomSensitivity,
  initialViewState,
  onViewStateChange,
  onModeChange,
  onOpenSource,
  onOpenAtomicNote
}: {
  t: Translator;
  mode: KnowledgeGraphDashboardMode;
  wheelZoomSensitivity: number;
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
  const [layoutRunning, setLayoutRunning] = useState(false);
  const [layoutError, setLayoutError] = useState(false);
  const [forcesOpen, setForcesOpen] = useState(false);
  const [relationLegendOpen, setRelationLegendOpen] = useState(false);
  const [graphPopup, setGraphPopup] = useState(true);
  const [showAllSubitems, setShowAllSubitems] = useState(initialViewState?.sourceHierarchy?.showAll ?? false);
  const [expandedSourceIds, setExpandedSourceIds] = useState<Set<string>>(
    () => new Set(initialViewState?.sourceHierarchy?.expandedSourceIds ?? [])
  );
  const [hierarchyPreviewSourceId, setHierarchyPreviewSourceId] = useState<string | null>(null);
  const [hierarchyNodeActions, setHierarchyNodeActions] = useState<HierarchyNodeActions | null>(null);
  const sourceHierarchyRef = useRef({ showAll: showAllSubitems, expandedSourceIds });
  sourceHierarchyRef.current = { showAll: showAllSubitems, expandedSourceIds };
  const popupInsideRef = useRef(false);
  const [forces, setForces] = useState<GraphForceSettings>(initialViewState?.forces ?? defaultGraphForceSettings);
  const forcesRef = useRef(forces);
  const [hover, setHover] = useState<HoverCard | null>(null);
  const interactivePreviewRef = useRef(false);
  interactivePreviewRef.current = graphPopup && mode === "sources" && hover?.type === "edge";
  const [floatingEdgeLabel, setFloatingEdgeLabel] = useState<FloatingEdgeLabel | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<Sigma<NodeAttributes, EdgeAttributes> | null>(null);
  const layoutRef = useRef<KnowledgeGraphLayout | null>(null);
  const hoverExitTimerRef = useRef<number | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const hoverAnimationFrameRef = useRef<number | null>(null);
  const hoverStrengthRef = useRef(0);
  const cameraRatioRef = useRef(1);
  const hoveredKeyRef = useRef<string | null>(null);
  const hoveredNeighborsRef = useRef<Set<string>>(new Set());
  const draggingRef = useRef(false);
  const cancelWheelRef = useRef<() => void>(() => {});
  const dismissGraphInfoRef = useRef<() => void>(() => {});
  const hierarchyNodeActionsRef = useRef<HTMLDivElement | null>(null);
  const hierarchyActionNodeKeyRef = useRef<string | null>(null);
  const hierarchyActionInsideRef = useRef(false);
  const hierarchyActionExitTimerRef = useRef<number | null>(null);
  const hideHierarchyActionsRef = useRef<(immediate?: boolean) => void>(() => {});
  const freezeGraphRef = useRef<() => void>(() => {});

  useEffect(() => { popupInsideRef.current = false; }, [hover?.key, graphPopup]);

  useEffect(() => {
    if (mode !== "atomic_notes") setRelationLegendOpen(false);
  }, [mode]);

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

  const displayedData = useMemo(() => data ? projectSourceHierarchy(data, {
    showAll: showAllSubitems,
    expandedSourceIds,
    focusSourceId: null
  }) : null, [data, expandedSourceIds, showAllSubitems]);
  const bundle = useMemo(() => displayedData ? buildGraph(displayedData, t) : null, [displayedData, t]);
  const hierarchyPreviewData = useMemo(() => data && hierarchyPreviewSourceId
    ? projectSourceHierarchy(data, {
      showAll: false,
      expandedSourceIds: new Set([hierarchyPreviewSourceId]),
      focusSourceId: hierarchyPreviewSourceId
    })
    : null, [data, hierarchyPreviewSourceId]);
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
    const hierarchyGroups = bundle.hierarchyGroups;
    const restoredViewState = restoreKnowledgeGraphViewState(graph, graphStateKey, initialViewState);
    setLayoutError(false);
    const initialForces = initialViewState?.forces ?? defaultGraphForceSettings;
    forcesRef.current = initialForces;
    setForces(initialForces);
    void initializeRenderer().catch(() => { if (!disposed) { cleanupRenderer(); setLayoutError(true); setLayoutRunning(false); } });

    return () => {
      disposed = true;
      cleanupRenderer();
    };

    async function initializeRenderer() {
      const [{ default: SigmaConstructor }, { GraphNodeProgram, GraphEdgeProgram }] = await Promise.all([
        import("sigma"),
        import("./knowledge-graph-programs")
      ]);
      if (disposed) return;
      const labels = createSmoothNodeLabels(() => sigmaRef.current?.scheduleRender());
      const renderer = new SigmaConstructor<NodeAttributes, EdgeAttributes>(graph, graphContainer, {
      nodeProgramClasses: { circle: GraphNodeProgram<NodeAttributes, EdgeAttributes> },
      nodeHoverProgramClasses: { circle: GraphNodeProgram<NodeAttributes, EdgeAttributes> },
      edgeProgramClasses: { line: GraphEdgeProgram<NodeAttributes, EdgeAttributes> },
      allowInvalidContainer: true,
      defaultDrawNodeHover: (context, node, settings) => {
        if (!draggingRef.current && hoveredKeyRef.current === node.key && hoverStrengthRef.current > 0) {
          drawWrappedNodeLabel(context, { ...node, labelOpacity: hoverStrengthRef.current }, settings);
        }
      },
      defaultDrawNodeLabel: labels.draw,
      defaultDrawEdgeLabel: drawFadingEdgeLabel,
      enableEdgeEvents: true,
      hideEdgesOnMove: false,
      hideLabelsOnMove: false,
      labelColor: { color: "#cbd5e1" },
      labelDensity: 0,
      ...graphTypography,
      labelGridCellSize: 110,
      labelRenderedSizeThreshold: 0,
      itemSizesReference: "screen",
      minEdgeThickness: 1.2,
      renderEdgeLabels: true,
      stagePadding: 72,
      zIndex: true,
      minCameraRatio: 0.08,
      maxCameraRatio: null,
      zoomDuration: 280,
      zoomingRatio: 1.25,
      nodeReducer: (node, attributes) => reduceNode(
        node,
        attributes,
        cameraRatioRef.current,
        hoveredKeyRef.current,
        hoveredNeighborsRef.current,
        hoverStrengthRef.current,
        hoveredKeyRef.current && graph.hasNode(hoveredKeyRef.current) ? 0.1 : 0.04
      ),
      edgeReducer: (edge, attributes) => reduceEdge(
        graph,
        edge,
        attributes,
        cameraRatioRef.current,
        hoveredKeyRef.current,
        hoverStrengthRef.current
      )
      });
      sigmaRef.current = renderer;
      installHierarchyContainerLayer(renderer, graph, hierarchyGroups);
      renderer.on("beforeRender", labels.beginFrame);

    const camera = renderer.getCamera();
    const radius = graphLayoutRadius(graph.order, initialForces.linkDistance) * 1.4;
    renderer.setCustomBBox(restoredViewState && initialViewState?.bounds
      ? initialViewState.bounds : { x: [-radius, radius], y: [-radius, radius] });
    if (restoredViewState && initialViewState) camera.setState(initialViewState.camera);
    const updateCameraDetail = (ratio: number) => {
      cameraRatioRef.current = ratio;
      renderer.scheduleRefresh();
    };
    updateCameraDetail(camera.ratio);
    camera.on("updated", ({ ratio }) => updateCameraDetail(ratio));

    const mouse = renderer.getMouseCaptor();
    let draggedNode: string | null = null;
    let dragMoved = false;
    let suppressNextNodeClick = false;
    let floatingEdgeKey: string | null = null;
    let pointerTarget: GraphHoverTarget | null = null;
    let positionFrame: number | null = null;
    let targetPositions: Float32Array | null = null;
    let lastPositionFrame = 0;
    let simulationRunning = false;
    const nodeIndices = new Map(rawNodeKeys.map((node, index) => [node, index]));
    const clearHierarchyActions = () => {
      if (hierarchyActionExitTimerRef.current !== null) window.clearTimeout(hierarchyActionExitTimerRef.current);
      hierarchyActionExitTimerRef.current = null;
      hierarchyActionNodeKeyRef.current = null;
      hierarchyActionInsideRef.current = false;
      setHierarchyNodeActions(null);
    };
    const hideHierarchyActions = (immediate = false) => {
      if (hierarchyActionInsideRef.current && !immediate) return;
      if (hierarchyActionExitTimerRef.current !== null) window.clearTimeout(hierarchyActionExitTimerRef.current);
      if (immediate) { clearHierarchyActions(); return; }
      hierarchyActionExitTimerRef.current = window.setTimeout(clearHierarchyActions, 240);
    };
    hideHierarchyActionsRef.current = hideHierarchyActions;
    const syncHierarchyActions = () => {
      const element = hierarchyNodeActionsRef.current;
      const node = hierarchyActionNodeKeyRef.current;
      if (!element || !node || !graph.hasNode(node)) return;
      const display = renderer.getNodeDisplayData(node);
      if (!display) return;
      const position = renderer.graphToViewport(graph.getNodeAttributes(node));
      element.style.left = `${position.x}px`;
      element.style.top = `${position.y - renderer.scaleSize(display.size) - 7}px`;
    };
    renderer.on("afterRender", syncHierarchyActions);
    const showHierarchyActions = (node: string) => {
      const attributes = graph.getNodeAttributes(node);
      if (attributes.kind !== "source" || attributes.childCount === 0 || !attributes.sourceItemId) {
        hideHierarchyActions();
        return;
      }
      const display = renderer.getNodeDisplayData(node);
      if (!display) return;
      const position = renderer.graphToViewport(attributes);
      if (hierarchyActionExitTimerRef.current !== null) window.clearTimeout(hierarchyActionExitTimerRef.current);
      hierarchyActionExitTimerRef.current = null;
      hierarchyActionNodeKeyRef.current = node;
      setHierarchyNodeActions({
        node,
        sourceItemId: attributes.sourceItemId,
        childCount: attributes.childCount,
        expanded: attributes.visibleChildCount > 0,
        x: position.x,
        y: position.y - renderer.scaleSize(display.size) - 7
      });
      renderer.scheduleRender();
      window.requestAnimationFrame(syncHierarchyActions);
    };
    freezeGraphRef.current = () => {
      layoutRef.current?.kill();
      layoutRef.current = null;
      targetPositions = null;
      simulationRunning = false;
      if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
      positionFrame = null;
      setLayoutRunning(false);
      renderer.scheduleRefresh();
    };

    const interpolatePositions = (now: number) => {
      positionFrame = null;
      if (!targetPositions || disposed) return;
      const blend = 1 - Math.exp(-Math.min(64, now - (lastPositionFrame || now - 16)) / (draggedNode ? 10 : 32));
      lastPositionFrame = now;
      let remaining = 0;
      graph.updateEachNodeAttributes((node, attributes) => {
        if (node === draggedNode) return attributes;
        const index = nodeIndices.get(node)! * 2;
        const x = targetPositions![index]!;
        const y = targetPositions![index + 1]!;
        const distance = Math.hypot(x - attributes.x, y - attributes.y);
        remaining = Math.max(remaining, distance);
        return { ...attributes,
          x: distance < 0.01 ? x : attributes.x + (x - attributes.x) * blend,
          y: distance < 0.01 ? y : attributes.y + (y - attributes.y) * blend
        };
      }, { attributes: ["x", "y"] });
      if (remaining > 0.01) positionFrame = window.requestAnimationFrame(interpolatePositions);
      else if (!simulationRunning) setLayoutRunning(false);
    };

    const startPhysics = () => {
      layoutRef.current?.kill();
      const nodes = rawNodeKeys.map((id) => ({ id, x: graph.getNodeAttribute(id, "x"), y: graph.getNodeAttribute(id, "y") }));
      const edges = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "kind") !== "hit_area").map((edge) => {
        const [source, target] = graph.extremities(edge);
        return { source, target, weight: graph.getEdgeAttribute(edge, "layoutWeight") };
      });
      layoutRef.current = new KnowledgeGraphLayout(nodes, edges, forcesRef.current, restoredViewState,
        (positions, running) => {
          targetPositions = positions;
          simulationRunning = running;
          if (positionFrame === null) positionFrame = window.requestAnimationFrame(interpolatePositions);
        },
        () => { if (!disposed) { setLayoutError(true); setLayoutRunning(false); } }
      );
      setLayoutRunning(!restoredViewState);
    };

    const animateHighlight = (target: number, onComplete?: () => void) => {
      if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
      const startedAt = performance.now();
      const initial = hoverStrengthRef.current;
      const step = (now: number) => {
        const progress = Math.max(0, Math.min(1, (now - startedAt) / 140));
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

    const hidePopup = () => {
      if (popupInsideRef.current || interactivePreviewRef.current) return;
      floatingEdgeKey = null;
      setFloatingEdgeLabel(null);
      setHover((current) => current ? { ...current, exiting: true } : current);
      if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
      hoverExitTimerRef.current = window.setTimeout(() => setHover(null), 120);
    };
    const hoverIntent = new GraphHoverIntent(
      (target) => {
        if (disposed) return;
        if (!target) {
          animateHighlight(0, () => {
            hoveredKeyRef.current = null;
            hoveredNeighborsRef.current = new Set();
            renderer.scheduleRefresh();
          });
          return;
        }
        if (draggingRef.current) return;
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        hoveredKeyRef.current = target.key;
        hoveredNeighborsRef.current = new Set(target.type === "node"
          ? graph.neighbors(target.key) : graph.extremities(target.key));
        hoverStrengthRef.current = 0;
        animateHighlight(1);
        if (target.type === "edge" && edgeLabelFallsOutsideViewport(renderer, graph, target.key)) {
          floatingEdgeKey = target.key;
          setFloatingEdgeLabel({
            edge: target.key, label: graph.getEdgeAttribute(target.key, "label"),
            ...floatingLabelPosition(renderer, target)
          });
        }
      },
      (target) => {
        if (disposed) return;
        if (!target) { hidePopup(); return; }
        if (popupInsideRef.current || interactivePreviewRef.current) return;
        if (draggingRef.current) return;
        if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
        floatingEdgeKey = null;
        setFloatingEdgeLabel(null);
        setHover({ ...target, exiting: false });
      }
    );
    dismissGraphInfoRef.current = () => {
      popupInsideRef.current = false;
      hoverIntent.clear();
      setHover(null);
    };
    const resolveEdge = (edge: string) => graph.getEdgeAttribute(edge, "interactionTarget") ?? edge;
    renderer.on("enterNode", ({ node, event }) => {
      pointerTarget = { type: "node", key: node, x: event.x, y: event.y };
      if (draggingRef.current) return;
      graphContainer.style.cursor = "grab";
      showHierarchyActions(node);
      hoverIntent.enter(pointerTarget);
    });
    renderer.on("leaveNode", ({ node }) => {
      if (pointerTarget?.type === "node" && pointerTarget.key === node) pointerTarget = null;
      if (draggingRef.current) return;
      graphContainer.style.cursor = "default";
      if (hierarchyActionNodeKeyRef.current === node) hideHierarchyActions();
      hoverIntent.leave("node", node);
    });
    renderer.on("enterEdge", ({ edge, event }) => {
      if (draggingRef.current) return;
      pointerTarget = { type: "edge", key: resolveEdge(edge), x: event.x, y: event.y };
      hoverIntent.enter(pointerTarget);
    });
    renderer.on("leaveEdge", ({ edge }) => {
      if (pointerTarget?.type === "edge" && pointerTarget.key === resolveEdge(edge)) pointerTarget = null;
      if (!draggingRef.current) hoverIntent.leave("edge", resolveEdge(edge));
    });
    renderer.on("clickStage", () => { hideHierarchyActions(true); hoverIntent.clear(); });
    const suspendHover = () => {
      draggingRef.current = true;
      hoverIntent.suspend();
      cancelWheelRef.current();
      if (camera.isAnimated()) void camera.animate(camera.getState(), { duration: 1 });
      renderer.setSetting("enableEdgeEvents", false);
      if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
      hoverAnimationFrameRef.current = null;
      if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
      if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
      hoverStrengthRef.current = 0;
      hoveredKeyRef.current = null;
      hoveredNeighborsRef.current = new Set();
      setHover(null);
      setFloatingEdgeLabel(null);
      hideHierarchyActions(true);
      renderer.scheduleRefresh();
    };
    renderer.on("downStage", () => { pointerTarget = null; suspendHover(); });
    const wheelMotion = new GraphWheelMotion(wheelZoomSensitivity);
    let wheelFrame: number | null = null;
    let wheelAnchor = { x: 0, y: 0 };
    let knownZoomOutMaximum = Math.max(camera.ratio, measureGraphZoomOutRatio(renderer));
    let wheelMaximum: number | null = null;
    cancelWheelRef.current = () => {
      if (wheelFrame !== null) window.cancelAnimationFrame(wheelFrame);
      wheelFrame = null;
      wheelMotion.cancel();
    };
    const stepWheel = (now: number) => {
      wheelFrame = null;
      if (disposed || draggingRef.current) { wheelMotion.cancel(); return; }
      const maximum = wheelMaximum ?? knownZoomOutMaximum;
      const delta = wheelMotion.advance(now, {
        ratio: camera.ratio,
        minimum: camera.minRatio ?? 0.08,
        maximum
      });
      if (delta !== 0) {
        const ratio = boundedGraphWheelRatio(
          camera.ratio,
          delta,
          camera.minRatio ?? 0.08,
          maximum
        );
        if (ratio === camera.ratio) { wheelMotion.cancel(); return; }
        const zoomed = freshViewportZoomedState(renderer, wheelAnchor, ratio);
        if (delta > 0) {
          const center = graphCenter(renderer);
          const centering = zoomOutCenteringStrength(ratio, maximum);
          zoomed.x += (center.x - zoomed.x) * centering;
          zoomed.y += (center.y - zoomed.y) * centering;
        }
        camera.setState(zoomed);
      }
      if (wheelMotion.active) wheelFrame = window.requestAnimationFrame(stepWheel);
      else wheelMaximum = null;
    };
    const handleGraphWheel = (original: WheelEvent) => {
      // Sigma starts its own fixed-duration wheel animation after emitting its
      // captor event. Intercept the native event first so only this controller
      // is ever allowed to update the camera.
      captureGraphWheelEvent(original);
      if (draggingRef.current) return;
      if (original.deltaY === 0) return;
      hoverIntent.clear();
      hideHierarchyActions(true);
      if (wheelFrame === null && camera.isAnimated()) void camera.animate(camera.getState(), { duration: 1 });
      if (!wheelMotion.active) {
        const measuredMaximum = measureGraphZoomOutRatio(renderer);
        if (measuredMaximum >= camera.ratio) knownZoomOutMaximum = measuredMaximum;
        wheelMaximum = Math.max(camera.ratio, knownZoomOutMaximum);
      }
      wheelMotion.push(original, performance.now());
      const bounds = graphContainer.getBoundingClientRect();
      wheelAnchor = { x: original.clientX - bounds.left, y: original.clientY - bounds.top };
      if (wheelFrame === null && wheelMotion.active) wheelFrame = window.requestAnimationFrame(stepWheel);
    };
    graphContainer.addEventListener("wheel", handleGraphWheel, { capture: true, passive: false });
    renderer.on("downNode", ({ node, event }) => {
      pointerTarget = { type: "node", key: node, x: event.x, y: event.y };
      draggedNode = node;
      dragMoved = false;
      suspendHover();
      camera.disable();
      graphContainer.style.cursor = "grabbing";
      renderer.scheduleRefresh();
      event.preventSigmaDefault();
    });
    mouse.on("mousemove", (event) => {
      if (draggingRef.current) return;
      if (floatingEdgeKey) {
        const position = floatingLabelPosition(renderer, event);
        setFloatingEdgeLabel((current) => current?.edge === floatingEdgeKey
          ? { ...current, ...position }
          : current);
      }
      if (pointerTarget) {
        pointerTarget = { ...pointerTarget, x: event.x, y: event.y };
        hoverIntent.enter(pointerTarget);
      }
    });
    mouse.on("mouseleave", () => {
      if (draggingRef.current) return;
      pointerTarget = null;
      hoverIntent.clear();
    });
    mouse.on("mousemovebody", (event) => {
      if (!draggedNode) return;
      dragMoved = true;
      const position = renderer.viewportToGraph(event);
      graph.mergeNodeAttributes(draggedNode, position);
      layoutRef.current?.drag(draggedNode, position.x, position.y, false);
      setLayoutRunning(true);
      event.preventSigmaDefault();
      event.original.preventDefault();
      renderer.scheduleRefresh();
    });
    const releaseDrag = () => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      hoverIntent.resume();
      renderer.setSetting("enableEdgeEvents", true);
      if (!draggedNode) return;
      suppressNextNodeClick = dragMoved;
      if (dragMoved) {
        const position = graph.getNodeAttributes(draggedNode);
        targetPositions = null;
        layoutRef.current?.drag(draggedNode, position.x, position.y, true);
        renderer.scheduleRefresh();
      }
      draggedNode = null;
      dragMoved = false;
      camera.enable();
      graphContainer.style.cursor = "default";
    };
    mouse.on("mouseup", releaseDrag);
    window.addEventListener("blur", releaseDrag);

    renderer.on("clickNode", ({ node }) => {
      if (suppressNextNodeClick) {
        suppressNextNodeClick = false;
        return;
      }
      const attributes = graph.getNodeAttributes(node);
      persistViewState();
      if (attributes.kind === "atomic_note" && attributes.rawId && attributes.sourceItemId) {
        onOpenAtomicNote(attributes.sourceItemId, attributes.rawId);
      } else if (attributes.sourceItemId) {
        onOpenSource(attributes.sourceItemId);
      }
    });

      cleanupRenderer = () => {
        layoutRef.current?.kill();
        layoutRef.current = null;
        if (positionFrame !== null) window.cancelAnimationFrame(positionFrame);
        window.removeEventListener("blur", releaseDrag);
        graphContainer.removeEventListener("wheel", handleGraphWheel, { capture: true });
        persistViewState();
        hoverIntent.dispose();
        cancelWheelRef.current();
        cancelWheelRef.current = () => {};
        dismissGraphInfoRef.current = () => {};
        hideHierarchyActionsRef.current = () => {};
        freezeGraphRef.current = () => {};
        clearHierarchyActions();
        draggingRef.current = false;
        if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
        if (focusTimerRef.current !== null) window.clearTimeout(focusTimerRef.current);
        if (hoverAnimationFrameRef.current !== null) window.cancelAnimationFrame(hoverAnimationFrameRef.current);
        renderer.kill();
        sigmaRef.current = null;
      };
      startPhysics();

      function persistViewState() {
        onViewStateChange(mode, {
          ...captureKnowledgeGraphViewState(renderer, graph, graphStateKey),
          forces: forcesRef.current,
          ...(mode === "sources" ? { sourceHierarchy: {
            showAll: sourceHierarchyRef.current.showAll,
            expandedSourceIds: [...sourceHierarchyRef.current.expandedSourceIds]
          } } : {})
        });
      }
    }
  }, [bundle, initialViewState, mode, onOpenAtomicNote, onOpenSource, onViewStateChange, wheelZoomSensitivity]);

  function zoom(factor: number) {
    dismissGraphInfoRef.current();
    cancelWheelRef.current();
    const renderer = sigmaRef.current;
    if (!renderer) return;
    const camera = renderer.getCamera();
    const maximum = Math.max(camera.ratio, measureGraphZoomOutRatio(renderer));
    void camera.animate({ ratio: clamp(camera.ratio * factor, camera.minRatio ?? 0.08, maximum) }, { duration: 220 });
  }

  function focusNode(id: string) {
    dismissGraphInfoRef.current();
    cancelWheelRef.current();
    const renderer = sigmaRef.current;
    const key = `item:${id}`;
    if (!renderer || !renderer.getGraph().hasNode(key)) return;
    const display = renderer.getNodeDisplayData(key);
    if (!display) return;
    void renderer.getCamera().animate({ x: display.x, y: display.y, ratio: 0.24 }, { duration: 420 });
    hoveredKeyRef.current = key;
    hoverStrengthRef.current = 1;
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

  function rerunLayout() {
    if (!layoutRef.current || layoutError) { setReloadToken((value) => value + 1); return; }
    layoutRef.current.reheat();
    setLayoutRunning(true);
  }

  function changeForces(next: GraphForceSettings) {
    if (!layoutRef.current || layoutError) return;
    forcesRef.current = next;
    setForces(next);
    layoutRef.current?.configure(next);
    setLayoutRunning(true);
  }

  function fitGraph() {
    dismissGraphInfoRef.current();
    cancelWheelRef.current();
    const renderer = sigmaRef.current;
    if (!renderer) return;
    // Animate the camera in the same coordinate system instead of renormalizing the graph.
    const bbox = renderer.getBBox();
    const center = renderer.viewportToFramedGraph(renderer.graphToViewport({ x: (bbox.x[0] + bbox.x[1]) / 2, y: (bbox.y[0] + bbox.y[1]) / 2 }));
    const corners = bbox.x.flatMap((x) => bbox.y.map((y) => renderer.graphToViewport({ x, y })));
    const { width, height } = renderer.getDimensions();
    const spanX = Math.max(...corners.map((point) => point.x)) - Math.min(...corners.map((point) => point.x));
    const spanY = Math.max(...corners.map((point) => point.y)) - Math.min(...corners.map((point) => point.y));
    const ratio = renderer.getCamera().ratio * Math.max(spanX / Math.max(1, width - 144), spanY / Math.max(1, height - 144));
    void renderer.getCamera().animate({ ...center, ratio: clamp(ratio, 0.08, 8) }, { duration: 350 });
  }

  function toggleSourceHierarchy(sourceItemId: string) {
    hideHierarchyActionsRef.current(true);
    if (showAllSubitems) {
      setExpandedSourceIds(new Set(
        data?.nodes.filter((node) => node.childCount > 0 && node.id !== sourceItemId).map((node) => node.id) ?? []
      ));
      setShowAllSubitems(false);
      return;
    }
    setExpandedSourceIds((current) => {
      const next = new Set(current);
      if (next.has(sourceItemId)) next.delete(sourceItemId);
      else next.add(sourceItemId);
      return next;
    });
  }

  function openSourceHierarchyPreview(sourceItemId: string) {
    freezeGraphRef.current();
    dismissGraphInfoRef.current();
    hideHierarchyActionsRef.current(true);
    setHierarchyPreviewSourceId(sourceItemId);
  }

  function toggleAllSubitems() {
    setShowAllSubitems((current) => !current);
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
          <GraphAction icon={Maximize2} label={t("knowledgeGraph.fit")} onClick={fitGraph} />
          <div className="relative">
            <GraphAction
              icon={SlidersHorizontal}
              label={t("knowledgeGraph.forces.title")}
              active={forcesOpen}
              controls="graphForcesPopover"
              onClick={() => setForcesOpen((open) => !open)}
            />
            {forcesOpen ? (
              <section
                id="graphForcesPopover"
                className="motion-graph-tooltip-in absolute right-0 top-11 z-30 w-96 max-w-[calc(100vw-2rem)] rounded-xl border border-white/15 bg-slate-900/95 p-4 text-xs text-slate-300 shadow-2xl backdrop-blur"
                aria-label={t("knowledgeGraph.forces.title")}
              >
                <h3 className="mb-3 font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {t("knowledgeGraph.forces.title")}
                </h3>
                <div className="grid grid-cols-2 gap-x-5 gap-y-3">
                  {([
                    { key: "repulsion", min: 10, max: 300, step: 5 },
                    { key: "linkStrength", min: 0.05, max: 1, step: 0.05 },
                    { key: "linkDistance", min: 20, max: 150, step: 5 },
                    { key: "centerStrength", min: 0.005, max: 0.12, step: 0.005 }
                  ] as const).map(({ key, min, max, step }) => <label key={key} className="grid gap-2">
                    <span className="flex justify-between gap-2"><span>{t(`knowledgeGraph.forces.${key}`)}</span><output className="tabular-nums">{forces[key]}</output></span>
                    <input type="range" min={min} max={max} step={step} value={forces[key]} disabled={!bundle?.rawNodeKeys.length || loading || layoutError}
                      className="w-full accent-cyan-400" onChange={(event) => changeForces({ ...forces, [key]: Number(event.target.value) })} />
                  </label>)}
                </div>
                <button
                  type="button"
                  className="mt-4 inline-flex items-center gap-2 rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-medium text-cyan-300 transition hover:border-cyan-300/30 hover:bg-white/10 disabled:opacity-50"
                  disabled={!bundle?.rawNodeKeys.length || loading || layoutError}
                  onClick={() => changeForces(defaultGraphForceSettings)}
                >
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                  {t("knowledgeGraph.forces.reset")}
                </button>
              </section>
            ) : null}
          </div>
          <GraphAction icon={layoutRunning ? LoaderCircle : Waypoints} label={t("knowledgeGraph.relayout")} spinning={layoutRunning} disabled={layoutRunning || loading || !bundle?.rawNodeKeys.length} onClick={rerunLayout} />
          <GraphAction icon={RefreshCw} label={t("knowledgeGraph.refresh")} onClick={() => setReloadToken((current) => current + 1)} />
          {mode === "sources" ? <GraphAction
            icon={showAllSubitems ? Boxes : Ungroup}
            label={t(showAllSubitems ? "knowledgeGraph.subitems.groupAll" : "knowledgeGraph.subitems.showAll")}
            active={showAllSubitems}
            pressed={showAllSubitems}
            onClick={toggleAllSubitems}
          /> : null}
          {mode === "sources" ? <GraphAction icon={Network} label={t("knowledgeGraph.graphPopup")} active={graphPopup} pressed={graphPopup} onClick={() => { setGraphPopup((value) => !value); }} /> : null}
        </div>
      </header>

      <div className="relative min-h-0 flex-1 bg-[radial-gradient(circle_at_center,_#172554_0%,_#020617_62%)]">
        <div ref={containerRef} className="absolute inset-0" role="application" aria-label={t("knowledgeGraph.canvasLabel")} />
        {mode === "sources" && hierarchyNodeActions
          && Number.isFinite(hierarchyNodeActions.x) && Number.isFinite(hierarchyNodeActions.y) ? <div
          ref={hierarchyNodeActionsRef}
          className="absolute z-20 flex -translate-x-1/2 -translate-y-full items-center gap-1"
          style={{ left: hierarchyNodeActions.x, top: hierarchyNodeActions.y }}
          onPointerEnter={() => {
            hierarchyActionInsideRef.current = true;
            if (hierarchyActionExitTimerRef.current !== null) window.clearTimeout(hierarchyActionExitTimerRef.current);
            hierarchyActionExitTimerRef.current = null;
          }}
          onPointerLeave={() => {
            hierarchyActionInsideRef.current = false;
            hideHierarchyActionsRef.current();
          }}
        >
          <button type="button" className="grid h-7 w-7 place-items-center rounded-full border border-violet-300/30 bg-slate-950/95 text-violet-200 shadow-lg backdrop-blur transition hover:bg-violet-400/25 hover:text-white" aria-label={t(hierarchyNodeActions.expanded ? "knowledgeGraph.subitems.collapse" : "knowledgeGraph.subitems.expand", { values: { count: hierarchyNodeActions.childCount } })} title={t(hierarchyNodeActions.expanded ? "knowledgeGraph.subitems.collapse" : "knowledgeGraph.subitems.expand", { values: { count: hierarchyNodeActions.childCount } })} onClick={() => toggleSourceHierarchy(hierarchyNodeActions.sourceItemId)}>
            {hierarchyNodeActions.expanded ? <Minus className="h-3.5 w-3.5" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
          <button type="button" className="grid h-7 w-7 place-items-center rounded-full border border-cyan-300/30 bg-slate-950/95 text-cyan-200 shadow-lg backdrop-blur transition hover:bg-cyan-400/25 hover:text-white" aria-label={t("knowledgeGraph.subitems.focus")} title={t("knowledgeGraph.subitems.focus")} onClick={() => openSourceHierarchyPreview(hierarchyNodeActions.sourceItemId)}>
            <Focus className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div> : null}
        {loading ? <GraphState icon={LoaderCircle} title={t("shell.states.loading")} spinning /> : null}
        {error ? <GraphState icon={Network} title={t("knowledgeGraph.error")} action={t("shell.actions.retry")} onAction={() => setReloadToken((current) => current + 1)} /> : null}
        {layoutError && !error ? <GraphState icon={Network} title={t("knowledgeGraph.layoutError")} action={t("shell.actions.retry")} onAction={() => setReloadToken((current) => current + 1)} /> : null}
        {!loading && !error && data?.nodes.length === 0 ? <GraphState icon={Network} title={t("knowledgeGraph.empty")} /> : null}

        {!loading && data && data.nodes.length > 0 ? <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-2 text-xs text-slate-300">
          <span className="rounded-full border border-white/10 bg-slate-950/75 px-2.5 py-1 backdrop-blur">{t("knowledgeGraph.nodeCount", { values: { count: bundle?.rawNodeKeys.length ?? data.nodes.length } })}</span>
          <span className="rounded-full border border-white/10 bg-slate-950/75 px-2.5 py-1 backdrop-blur">{t("knowledgeGraph.edgeCount", { values: { count: bundle?.itemEdgeCount ?? data.edges.length } })}</span>
          {data.truncated ? <span className="rounded-full border border-amber-400/30 bg-amber-950/80 px-2.5 py-1 text-amber-200">{t("knowledgeGraph.truncated")}</span> : null}
        </div> : null}

        {mode === "atomic_notes" && !loading && !error && data && data.nodes.length > 0 ? (
          <div className="absolute bottom-3 right-3 z-10">
            {relationLegendOpen ? (
              <section
                id="atomicRelationLegend"
                className="motion-graph-tooltip-in absolute bottom-10 right-0 w-56 rounded-xl border border-white/15 bg-slate-900/95 p-3 text-white shadow-2xl backdrop-blur"
                aria-label={t("knowledgeGraph.relationLegend.title")}
              >
                <h3 className="mb-2 text-xs font-semibold uppercase tracking-[0.14em] text-slate-400">
                  {t("knowledgeGraph.relationLegend.title")}
                </h3>
                <ul className="grid gap-1.5">
                  {atomicRelationLegend.map(({ type, color, icon: Icon }) => (
                    <li key={type} className="flex items-center gap-2 text-xs text-slate-200">
                      <span
                        className="grid h-6 w-6 shrink-0 place-items-center rounded-full border bg-slate-950"
                        style={{ borderColor: `${color}99`, color }}
                      >
                        <Icon className="h-4 w-4" aria-hidden="true" />
                      </span>
                      <span>{t(atomicRelationMessageKeys[type]!)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-slate-950/85 px-3 py-1.5 text-xs font-medium text-slate-200 shadow-lg backdrop-blur transition hover:border-violet-300/50 hover:text-white"
              aria-expanded={relationLegendOpen}
              aria-controls="atomicRelationLegend"
              onClick={() => setRelationLegendOpen((open) => !open)}
            >
              <Tags className="h-3.5 w-3.5 text-violet-300" aria-hidden="true" />
              {t("knowledgeGraph.relationLegend.trigger")}
            </button>
          </div>
        ) : null}

        {floatingEdgeLabel ? <div
          className="motion-graph-tooltip-in pointer-events-none absolute z-10 max-w-56 rounded-md border border-red-300/20 bg-slate-900/92 px-2 py-1 text-xs font-medium leading-snug text-red-300 shadow-lg backdrop-blur"
          style={{ left: floatingEdgeLabel.x, top: floatingEdgeLabel.y }}
        >
          {floatingEdgeLabel.label}
        </div> : null}
        {hover && bundle ? <GraphTooltip key={`${hover.type}:${hover.key}`} hover={hover} graph={bundle.graph} t={t}
          graphPopup={graphPopup} forces={forces} wheelZoomSensitivity={wheelZoomSensitivity}
          onPopupEnter={() => {
            popupInsideRef.current = true;
            cancelWheelRef.current();
            if (hoverExitTimerRef.current !== null) window.clearTimeout(hoverExitTimerRef.current);
            hoverExitTimerRef.current = null;
            setHover((current) => current ? { ...current, exiting: false } : current);
          }}
          onPopupLeave={() => { popupInsideRef.current = false; dismissGraphInfoRef.current(); }}
        /> : null}
        {mode === "sources" && hierarchyPreviewData && hierarchyPreviewSourceId ? <SourceHierarchyPreviewOverlay
          data={hierarchyPreviewData}
          sourceItemId={hierarchyPreviewSourceId}
          forces={forces}
          wheelZoomSensitivity={wheelZoomSensitivity}
          t={t}
          onClose={() => setHierarchyPreviewSourceId(null)}
          onOpenSource={onOpenSource}
        /> : null}
      </div>
    </section>
  );
}

function GraphAction({ icon: Icon, label, onClick, disabled = false, spinning = false, active = false, controls, pressed }: {
  icon: typeof Focus;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  spinning?: boolean;
  active?: boolean;
  controls?: string;
  pressed?: boolean;
}) {
  return <button type="button" disabled={disabled} className={cn(
    "grid h-9 w-9 place-items-center rounded-lg border text-slate-300 transition hover:bg-white/10 hover:text-white disabled:opacity-50",
    active ? "border-cyan-300/50 bg-cyan-400/15 text-cyan-200" : "border-white/10 bg-white/5"
  )} aria-label={label} title={label} aria-pressed={pressed} aria-expanded={controls ? active : undefined} aria-controls={controls} onClick={onClick}>
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

function SourceHierarchyPreviewOverlay({ data, sourceItemId, forces, wheelZoomSensitivity, t, onClose, onOpenSource }: {
  data: DashboardData;
  sourceItemId: string;
  forces: GraphForceSettings;
  wheelZoomSensitivity: number;
  t: Translator;
  onClose: () => void;
  onOpenSource: (sourceItemId: string) => void;
}) {
  const panelRef = useRef<HTMLElement>(null);
  const source = data.nodes.find((node) => node.id === sourceItemId);
  useLayoutEffect(() => {
    const previousFocus = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "BrowserBack" && !(event.altKey && event.key === "ArrowLeft")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    const mouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("mouseup", mouseBack, true);
    const unsubscribe = window.app.system.subscribeNavigation((direction) => {
      if (direction === "back") onClose();
    });
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("mouseup", mouseBack, true);
      unsubscribe();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [onClose]);

  return <section ref={panelRef} tabIndex={-1} role="dialog" aria-label={t("knowledgeGraph.subitems.focus")}
    className="absolute inset-0 z-30 flex flex-col bg-slate-950/55 p-3 text-white outline-none backdrop-blur-[2px]">
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-violet-300/20 bg-slate-950/96 shadow-2xl">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-slate-900/95 px-3 py-2">
        <GraphAction icon={ArrowLeft} label={t("knowledgeGraph.subitems.closeFocus")} onClick={onClose} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-semibold text-violet-200">{source?.title ?? t("knowledgeGraph.source")}</p>
          <p className="truncate text-[11px] text-slate-400">{t("knowledgeGraph.subitems.focusDescription")}</p>
        </div>
        <GraphAction icon={X} label={t("shell.actions.close")} onClick={onClose} />
      </header>
      <div className="relative min-h-0 flex-1">
        <SourceHierarchyPreviewGraph data={data} forces={forces} wheelZoomSensitivity={wheelZoomSensitivity} t={t} onOpenSource={onOpenSource} />
      </div>
    </div>
  </section>;
}

function SourceHierarchyPreviewGraph({ data, forces, wheelZoomSensitivity, t, onOpenSource }: {
  data: DashboardData;
  forces: GraphForceSettings;
  wheelZoomSensitivity: number;
  t: Translator;
  onOpenSource: (sourceItemId: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<KnowledgeGraphLayout | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const [failed, setFailed] = useState(false);
  const bundle = useMemo(() => buildGraph(data, t), [data, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || bundle.rawNodeKeys.length === 0) return;
    let disposed = false;
    let cleanup = () => {};
    setFailed(false);
    void initialize().catch(() => { cleanup(); if (!disposed) setFailed(true); });
    return () => { disposed = true; cleanup(); };

    async function initialize() {
      const [{ default: SigmaConstructor }, { GraphNodeProgram, GraphEdgeProgram }] = await Promise.all([
        import("sigma"), import("./knowledge-graph-programs")
      ]);
      if (disposed || !container) return;
      const graph = bundle.graph;
      const labels = createSmoothNodeLabels(() => renderer?.scheduleRender());
      let cameraRatio = 1;
      let renderer: Sigma<NodeAttributes, EdgeAttributes> | null = new SigmaConstructor<NodeAttributes, EdgeAttributes>(graph, container, {
        nodeProgramClasses: { circle: GraphNodeProgram<NodeAttributes, EdgeAttributes> },
        nodeHoverProgramClasses: { circle: GraphNodeProgram<NodeAttributes, EdgeAttributes> },
        edgeProgramClasses: { line: GraphEdgeProgram<NodeAttributes, EdgeAttributes> },
        allowInvalidContainer: true,
        defaultDrawNodeLabel: labels.draw,
        defaultDrawEdgeLabel: drawFadingEdgeLabel,
        enableEdgeEvents: false,
        hideEdgesOnMove: false,
        hideLabelsOnMove: false,
        labelColor: { color: "#cbd5e1" },
        labelDensity: 0,
        ...graphTypography,
        labelGridCellSize: 110,
        labelRenderedSizeThreshold: 0,
        itemSizesReference: "screen",
        minEdgeThickness: 1.2,
        renderEdgeLabels: true,
        stagePadding: 64,
        zIndex: true,
        minCameraRatio: 0.04,
        maxCameraRatio: 10,
        nodeReducer: (node, attributes) => reduceNode(node, attributes, cameraRatio, null, new Set(), 0),
        edgeReducer: (edge, attributes) => reduceEdge(graph, edge, attributes, cameraRatio, null, 0)
      });
      installHierarchyContainerLayer(renderer, graph, bundle.hierarchyGroups);
      renderer.on("beforeRender", labels.beginFrame);
      const radius = graphLayoutRadius(graph.order, forces.linkDistance) * 1.4;
      renderer.setCustomBBox({ x: [-radius, radius], y: [-radius, radius] });
      const camera = renderer.getCamera();
      cameraRatio = camera.ratio;
      camera.on("updated", ({ ratio }) => { cameraRatio = ratio; renderer?.scheduleRefresh(); });
      let interacted = false;
      let draggedNode: string | null = null;
      let dragMoved = false;
      let suppressNextClick = false;
      let wheelFrame: number | null = null;
      let fitFrame: number | null = null;
      let wheelAnchor = { x: 0, y: 0 };
      const wheelMotion = new GraphWheelMotion(wheelZoomSensitivity);
      const cancelWheel = () => {
        wheelMotion.cancel();
        if (wheelFrame !== null) window.cancelAnimationFrame(wheelFrame);
        wheelFrame = null;
      };
      const fit = () => {
        if (!renderer) return;
        renderer.refresh();
        const cameraState = camera.getState();
        const points = graph.nodes().map((id) => renderer!.graphToViewport(graph.getNodeAttributes(id), { cameraState }));
        if (points.length === 0) return;
        const left = Math.min(...points.map((point) => point.x));
        const right = Math.max(...points.map((point) => point.x));
        const top = Math.min(...points.map((point) => point.y));
        const bottom = Math.max(...points.map((point) => point.y));
        const center = renderer.viewportToFramedGraph({ x: (left + right) / 2, y: (top + bottom) / 2 }, { cameraState });
        const { width, height } = renderer.getDimensions();
        const ratio = camera.ratio * Math.max((right - left) / Math.max(1, width - 160), (bottom - top) / Math.max(1, height - 120));
        camera.setState({ ...center, ratio: clamp(ratio || 0.2, 0.04, 10) });
      };
      fitRef.current = () => { interacted = false; cancelWheel(); fit(); };
      const scheduleFit = () => {
        if (!interacted && fitFrame === null) fitFrame = window.requestAnimationFrame(() => {
          fitFrame = null;
          if (!interacted) fit();
        });
      };
      const stepWheel = (now: number) => {
        wheelFrame = null;
        if (!renderer) return;
        const delta = wheelMotion.advance(now, { ratio: camera.ratio, minimum: 0.04, maximum: 10 });
        if (delta !== 0) {
          const ratio = boundedGraphWheelRatio(camera.ratio, delta, 0.04, 10);
          const state = camera.getState();
          const before = renderer.viewportToFramedGraph(wheelAnchor, { cameraState: state });
          const after = renderer.viewportToFramedGraph(wheelAnchor, { cameraState: { ...state, ratio } });
          camera.setState({ ratio, x: state.x + before.x - after.x, y: state.y + before.y - after.y });
        }
        if (wheelMotion.active) wheelFrame = window.requestAnimationFrame(stepWheel);
      };
      const handleWheel = (event: WheelEvent) => {
        captureGraphWheelEvent(event);
        interacted = true;
        if (draggedNode || !renderer) return;
        const bounds = container.getBoundingClientRect();
        wheelAnchor = { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
        wheelMotion.push(event, performance.now());
        if (wheelFrame === null && wheelMotion.active) wheelFrame = window.requestAnimationFrame(stepWheel);
      };
      container.addEventListener("wheel", handleWheel, { capture: true, passive: false });
      renderer.on("downStage", () => { interacted = true; cancelWheel(); });
      renderer.on("downNode", ({ node, event }) => {
        interacted = true;
        cancelWheel();
        draggedNode = node;
        dragMoved = false;
        camera.disable();
        event.preventSigmaDefault();
      });
      renderer.getMouseCaptor().on("mousemovebody", (event) => {
        if (!draggedNode || !renderer) return;
        dragMoved = true;
        const point = renderer.viewportToGraph(event);
        graph.mergeNodeAttributes(draggedNode, point);
        layoutRef.current?.drag(draggedNode, point.x, point.y, false);
        event.preventSigmaDefault();
        event.original.preventDefault();
        renderer.scheduleRefresh();
      });
      const releaseDrag = () => {
        if (!draggedNode) return;
        suppressNextClick = dragMoved;
        const point = graph.getNodeAttributes(draggedNode);
        layoutRef.current?.drag(draggedNode, point.x, point.y, true);
        draggedNode = null;
        dragMoved = false;
        camera.enable();
      };
      renderer.getMouseCaptor().on("mouseup", releaseDrag);
      window.addEventListener("blur", releaseDrag);
      renderer.on("clickNode", ({ node }) => {
        if (suppressNextClick) { suppressNextClick = false; return; }
        const sourceItemId = graph.getNodeAttribute(node, "sourceItemId");
        if (sourceItemId) onOpenSource(sourceItemId);
      });
      const resizeObserver = new ResizeObserver(() => { renderer?.resize(); scheduleFit(); });
      resizeObserver.observe(container);
      const nodes = bundle.rawNodeKeys;
      layoutRef.current = new KnowledgeGraphLayout(
        nodes.map((id) => ({ id, x: graph.getNodeAttribute(id, "x"), y: graph.getNodeAttribute(id, "y") })),
        graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "kind") !== "hit_area").map((edge) => {
          const [source, target] = graph.extremities(edge);
          return { source, target, weight: graph.getEdgeAttribute(edge, "layoutWeight") };
        }),
        forces,
        false,
        (positions) => {
          nodes.forEach((id, index) => {
            if (id !== draggedNode) graph.mergeNodeAttributes(id, { x: positions[index * 2]!, y: positions[index * 2 + 1]! });
          });
          renderer?.scheduleRefresh();
          scheduleFit();
        },
        () => { if (!disposed) setFailed(true); }
      );
      scheduleFit();
      cleanup = () => {
        cancelWheel();
        if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
        container.removeEventListener("wheel", handleWheel, { capture: true });
        window.removeEventListener("blur", releaseDrag);
        resizeObserver.disconnect();
        layoutRef.current?.kill();
        layoutRef.current = null;
        fitRef.current = () => {};
        renderer?.kill();
        renderer = null;
      };
    }
  }, [bundle, forces, onOpenSource, wheelZoomSensitivity]);

  return <div className="relative h-full overflow-hidden bg-[radial-gradient(circle_at_center,_#172554_0%,_#020617_62%)]">
    <div ref={containerRef} className="absolute inset-0" role="application" aria-label={t("knowledgeGraph.subitems.focusDescription")} />
    <button type="button" className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg border border-white/15 bg-slate-950/80 text-slate-200 shadow-lg transition hover:bg-white/10 hover:text-white" aria-label={t("knowledgeGraph.fit")} title={t("knowledgeGraph.fit")} onClick={() => fitRef.current()}>
      <Maximize2 className="h-4 w-4" aria-hidden="true" />
    </button>
    {failed ? <GraphState icon={Network} title={t("knowledgeGraph.layoutError")} /> : null}
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

interface GraphPopupOptions {
  graphPopup: boolean;
  forces: GraphForceSettings;
  wheelZoomSensitivity: number;
  onPopupEnter: () => void;
  onPopupLeave: () => void;
}

function GraphTooltip({ hover, graph, t, ...popupOptions }: {
  hover: HoverCard;
  graph: Graph<NodeAttributes, EdgeAttributes>;
  t: Translator;
} & GraphPopupOptions) {
  if (hover.type === "node" && graph.hasNode(hover.key)) {
    const node = graph.getNodeAttributes(hover.key);
    return <ViewportTooltip hover={hover} className="w-80">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">{t(node.kind === "source" ? "knowledgeGraph.source" : "knowledgeGraph.atomicNote")}</p>
      <h3 className="mt-1 text-sm font-semibold leading-snug">{node.title}</h3>
      {node.subtitle ? <p className="mt-1 line-clamp-3 text-xs leading-relaxed text-slate-300">{node.subtitle}</p> : null}
      {node.kind === "atomic_note" && node.content ? <p className="mt-2 max-h-48 overflow-hidden whitespace-pre-wrap border-t border-white/10 pt-2 text-xs leading-relaxed text-slate-200">{node.content}</p> : null}
      <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-300">
        <div><dt className="text-slate-500">{t("knowledgeGraph.connections")}</dt><dd>{node.importance}</dd></div>
        <div><dt className="text-slate-500">{t("knowledgeGraph.entities")}</dt><dd>{node.detailCount}</dd></div>
      </dl>
      <p className="mt-2 text-[11px] text-cyan-300">{t("knowledgeGraph.clickToOpen")}</p>
    </ViewportTooltip>;
  }
  if (hover.type === "edge" && graph.hasEdge(hover.key)) {
    const edge = graph.getEdgeAttributes(hover.key);
    if (edge.kind === "source_connection") {
      const [source, target] = graph.extremities(hover.key);
      const sourceItemId = graph.getNodeAttribute(source, "rawId");
      const targetSourceItemId = graph.getNodeAttribute(target, "rawId");
      if (!sourceItemId || !targetSourceItemId) return null;
      return <SourceConnectionTooltip
        {...popupOptions}
        hover={hover}
        sourceItemId={sourceItemId}
        targetSourceItemId={targetSourceItemId}
        summary={edge.sourceRelations}
        t={t}
      />;
    }
    const RelationIcon = atomicRelationIcon(edge.relationType);
    const relationColor = atomicRelationColor(edge.relationType);
    return <ViewportTooltip hover={hover} className="w-80">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">{t(`knowledgeGraph.edgeKinds.${edge.kind}` as MessageKey)}</p>
      <p className="mt-1 flex items-center gap-2 text-sm font-medium">
        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border bg-slate-950" style={{ borderColor: `${relationColor}99`, color: relationColor }}>
          <RelationIcon className="h-4 w-4" aria-hidden="true" />
        </span>
        <span>{edge.label}</span>
      </p>
      {edge.description ? <p className="mt-1 line-clamp-4 text-xs leading-relaxed text-slate-300">{edge.description}</p> : null}
      {edge.details.length > 0 ? <ul className="mt-2 grid gap-1 text-xs text-slate-300">{edge.details.slice(0, 4).map((detail) => <li key={detail}>• {detail}</li>)}</ul> : null}
      <p className="mt-2 text-[11px] tabular-nums text-slate-400">{t("knowledgeGraph.confidence", { values: { value: Math.round(edge.confidence * 100) } })}</p>
    </ViewportTooltip>;
  }
  return null;
}

function SourceConnectionTooltip({ hover, sourceItemId, targetSourceItemId, summary, t, graphPopup, forces, wheelZoomSensitivity, onPopupEnter, onPopupLeave }: {
  hover: HoverCard;
  sourceItemId: string;
  targetSourceItemId: string;
  summary: SourceRelationGroup[];
  t: Translator;
} & GraphPopupOptions) {
  const [details, setDetails] = useState<KnowledgeGraphSourceConnectionDetails | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const closeRef = useRef(onPopupLeave);
  const enterRef = useRef(onPopupEnter);
  closeRef.current = onPopupLeave;
  enterRef.current = onPopupEnter;
  const panelRef = useRef<HTMLElement>(null);

  useLayoutEffect(() => {
    if (!graphPopup) return;
    enterRef.current();
    const previousFocus = document.activeElement;
    panelRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "BrowserBack" && !(event.altKey && event.key === "ArrowLeft")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    const mouseBack = (event: MouseEvent) => {
      if (event.button !== 3) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      closeRef.current();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("mouseup", mouseBack, true);
    const unsubscribe = window.app.system.subscribeNavigation((direction) => {
      if (direction === "back") closeRef.current();
    });
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("mouseup", mouseBack, true);
      unsubscribe();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [graphPopup]);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setFailed(false);
    window.app.knowledge.getGraphSourceConnectionDetails(sourceItemId, targetSourceItemId)
      .then((result) => { if (active) setDetails(result); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [sourceItemId, targetSourceItemId, retry]);

  if (graphPopup) {
    return <section ref={panelRef} tabIndex={-1} role="dialog" aria-label={t("knowledgeGraph.graphPopup")}
      className="absolute inset-0 z-20 flex flex-col overflow-hidden bg-slate-950 text-white outline-none">
      <header className="flex shrink-0 items-center gap-3 border-b border-white/10 bg-slate-900 px-3 py-2">
        <GraphAction icon={ArrowLeft} label={t("knowledgeGraph.backToGraph")} onClick={onPopupLeave} />
        <p className="min-w-0 flex-1 truncate text-xs font-semibold text-cyan-300">{t("knowledgeGraph.edgeKinds.source_connection")}</p>
        <GraphAction icon={X} label={t("shell.actions.close")} onClick={onPopupLeave} />
      </header>
      <div className="relative min-h-0 flex-1">
        {failed ? <GraphState icon={Network} title={t("knowledgeGraph.error")} action={t("shell.actions.retry")} onAction={() => setRetry((value) => value + 1)} />
          : !details ? <GraphState icon={LoaderCircle} title={t("shell.states.loading")} spinning />
          : details.entities.length === 0 ? <GraphState icon={Network} title={t("knowledgeGraph.empty")} />
          : <SourceConnectionGraph details={details} forces={forces} wheelZoomSensitivity={wheelZoomSensitivity} t={t} />}
      </div>
    </section>;
  }

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

export function buildGraph(data: DashboardData, t: Translator): GraphBundle {
  const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: "undirected", multi: true, allowSelfLoops: false });
  const visibleNodeIds = new Set(data.nodes.map((node) => node.id));
  const visibleChildren = new Map<string, string[]>();
  for (const node of data.nodes) {
    if (!node.parentSourceItemId || !visibleNodeIds.has(node.parentSourceItemId)) continue;
    const children = visibleChildren.get(node.parentSourceItemId) ?? [];
    children.push(node.id);
    visibleChildren.set(node.parentSourceItemId, children);
  }
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
      rawId: node.id,
      sourceItemId: node.sourceItemId,
      title: node.title,
      subtitle: node.subtitle,
      content: node.content,
      sourceType: node.sourceType,
      noteStatus: node.noteStatus,
      detailCount: node.detailCount,
      parentSourceItemId: node.parentSourceItemId,
      childCount: node.childCount,
      visibleChildCount: visibleChildren.get(node.id)?.length ?? 0,
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
      confidence: edge.confidence,
      weight: edge.weight,
      description: edge.description,
      details: edge.details,
      layoutWeight: Math.max(0.2, Math.log2(edge.weight + 1) * edge.confidence),
      labelOpacity: 0.2,
      labelRevealAt: edge.kind === "atomic_note_relation"
        ? relationLabelRevealAt(edge.id, edge.confidence, preparedEdges.length)
        : 2,
      relationType: edge.relationType,
      sourceRelations: edge.sourceRelations,
      interactionTarget: null
    });
  }

  const hierarchyGroups = [...visibleChildren.entries()].map(([rootId, childIds]) => ({
    root: `item:${rootId}`,
    children: childIds.map((id) => `item:${id}`),
    title: data.nodes.find((node) => node.id === rootId)?.title ?? ""
  }));
  for (const group of hierarchyGroups) {
    for (const child of group.children) {
      const key = `hierarchy:${group.root}:${child}`;
      if (!graph.hasNode(group.root) || !graph.hasNode(child) || graph.hasEdge(key)) continue;
      graph.addEdgeWithKey(key, group.root, child, {
        label: "",
        size: 0,
        color: "rgba(0, 0, 0, 0)",
        kind: "hierarchy_link",
        confidence: 1,
        weight: 1,
        description: null,
        details: [],
        layoutWeight: 3,
        labelOpacity: 0,
        labelRevealAt: 2,
        relationType: null,
        sourceRelations: [],
        interactionTarget: null
      });
    }
  }

  const rawNodeKeys = graph.nodes();
  for (const node of rawNodeKeys) {
    const degree = graph.degree(node);
    graph.updateNodeAttribute(node, "importance", () => degree);
    graph.updateNodeAttribute(node, "size", () => graphNodeSize(degree)
      + Math.min(5, Math.log2(graph.getNodeAttribute(node, "childCount") + 1) * 1.5));
  }
  if (rawNodeKeys.length === 0) {
    return { graph, rawNodeKeys, itemEdgeCount: preparedEdges.length, stateKey, hierarchyGroups };
  }

  const interactionEdges = graph.edges().filter((edge) => graph.getEdgeAttribute(edge, "kind") !== "hierarchy_link");
  for (const edge of interactionEdges) {
    const [source, target] = graph.extremities(edge);
    graph.addEdgeWithKey(`hit:${edge}`, source, target, {
      label: "",
      size: relationHitAreaScreenThickness,
      color: "rgba(0, 0, 0, 0)",
      kind: "hit_area",
      confidence: 0,
      weight: 1,
      description: null,
      details: [],
      layoutWeight: 0,
      labelOpacity: 0,
      labelRevealAt: 2,
      relationType: null,
      sourceRelations: [],
      interactionTarget: edge
    });
  }
  return {
    graph,
    rawNodeKeys,
    itemEdgeCount: preparedEdges.length,
    stateKey,
    hierarchyGroups
  };
}

function installHierarchyContainerLayer(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  groups: GraphBundle["hierarchyGroups"]
) {
  const canvas = groups.length > 0 ? renderer.createCanvas("hierarchy-containers", {
    beforeLayer: "edges", style: { inset: "0", pointerEvents: "none", zIndex: "0" }
  }) : null;
  const context = canvas?.getContext("2d") ?? null;
  const badgeCanvas = renderer.createCanvas("hierarchy-count-badges", {
    beforeLayer: "mouse", style: { inset: "0", pointerEvents: "none", zIndex: "8" }
  });
  const badgeContext = badgeCanvas.getContext("2d");
  if (!badgeContext) return;
  const draw = () => {
    const { width, height } = renderer.getDimensions();
    const pixelRatio = window.devicePixelRatio || 1;
    const canvasWidth = Math.max(1, Math.round(width * pixelRatio));
    const canvasHeight = Math.max(1, Math.round(height * pixelRatio));
    for (const layer of [canvas, badgeCanvas]) {
      if (!layer || layer.width === canvasWidth && layer.height === canvasHeight) continue;
      layer.width = canvasWidth;
      layer.height = canvasHeight;
      layer.style.width = `${width}px`;
      layer.style.height = `${height}px`;
    }
    if (context) {
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);
      for (const group of groups) {
        if (!graph.hasNode(group.root)) continue;
        const members = [group.root, ...group.children].filter((node) => graph.hasNode(node));
        const points = members.map((node) => renderer.graphToViewport(graph.getNodeAttributes(node)));
        if (points.length < 2) continue;
        const minX = Math.min(...points.map((point) => point.x));
        const maxX = Math.max(...points.map((point) => point.x));
        const minY = Math.min(...points.map((point) => point.y));
        const maxY = Math.max(...points.map((point) => point.y));
        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;
        const radiusX = Math.max(58, (maxX - minX) / 2 + 38);
        const radiusY = Math.max(48, (maxY - minY) / 2 + 34);
        context.beginPath();
        context.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        context.fillStyle = "rgba(124, 58, 237, 0.09)";
        context.fill();
        context.save();
        context.setLineDash([5, 5]);
        context.lineWidth = 1.25;
        context.strokeStyle = "rgba(196, 181, 253, 0.46)";
        context.stroke();
        context.restore();
        const rootPoint = points[0]!;
        context.beginPath();
        for (const childPoint of points.slice(1)) {
          context.moveTo(rootPoint.x, rootPoint.y);
          context.lineTo(childPoint.x, childPoint.y);
        }
        context.lineWidth = 1;
        context.strokeStyle = "rgba(196, 181, 253, 0.28)";
        context.stroke();
        context.font = "600 11px Inter, ui-sans-serif, system-ui, sans-serif";
        context.fillStyle = "rgba(221, 214, 254, 0.92)";
        context.fillText(group.title, centerX - radiusX + 12, centerY - radiusY + 18, Math.max(80, radiusX * 2 - 24));
      }
    }
    badgeContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    badgeContext.clearRect(0, 0, width, height);
    graph.forEachNode((node, attributes) => {
      if (attributes.kind !== "source" || attributes.childCount === 0) return;
      const display = renderer.getNodeDisplayData(node);
      if (!display) return;
      const position = renderer.graphToViewport(attributes);
      const size = renderer.scaleSize(display.size);
      const x = position.x - size * 0.68;
      const y = position.y - size * 0.68;
      const radius = attributes.childCount > 99 ? 11 : 9.5;
      badgeContext.beginPath();
      badgeContext.arc(x, y, radius, 0, Math.PI * 2);
      badgeContext.fillStyle = "rgba(2, 6, 23, 0.96)";
      badgeContext.fill();
      badgeContext.lineWidth = 1.5;
      badgeContext.strokeStyle = attributes.color;
      badgeContext.stroke();
      badgeContext.fillStyle = "#f8fafc";
      badgeContext.font = `${attributes.childCount > 99 ? 7 : 9}px Inter, ui-sans-serif, system-ui, sans-serif`;
      badgeContext.textAlign = "center";
      badgeContext.textBaseline = "middle";
      badgeContext.fillText(String(attributes.childCount), x, y + 0.5);
    });
  };
  renderer.on("afterRender", draw);
}

export function prepareGraphEdges(data: DashboardData, t: Translator): PreparedGraphEdge[] {
  if (data.mode === "atomic_notes") {
    return data.edges.map((edge) => ({
      ...edge,
      kind: "atomic_note_relation",
      label: formatEdgeLabel(edge.label, t),
      relationType: edge.label,
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
      sourceRelations: [],
      relationType: null
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
  edges.forEach((edge) => include(`${edge.id}:${edge.source}:${edge.target}:${edge.weight}:${edge.confidence}`));
  return `force-v1:${data.mode}:${data.nodes.length}:${edges.length}:${hash >>> 0}`;
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
    nodePositions,
    bounds: renderer.getCustomBBox() ?? renderer.getBBox()
  };
}

function graphCenter(renderer: Sigma<NodeAttributes, EdgeAttributes>) {
  const bbox = renderer.getBBox();
  const graphPoint = { x: (bbox.x[0] + bbox.x[1]) / 2, y: (bbox.y[0] + bbox.y[1]) / 2 };
  const cameraState = renderer.getCamera().getState();
  return renderer.viewportToFramedGraph(
    renderer.graphToViewport(graphPoint, { cameraState }),
    { cameraState }
  );
}

function measureGraphZoomOutRatio(renderer: Sigma<NodeAttributes, EdgeAttributes>): number {
  const bbox = renderer.getBBox();
  const cameraState = renderer.getCamera().getState();
  // Force Sigma to recompute from the current camera state. Its cached matrix can
  // still describe the previous frame while inertial zoom schedules the next one.
  const corners = bbox.x.flatMap((x) => bbox.y.map((y) => renderer.graphToViewport(
    { x, y },
    { cameraState }
  )));
  const span = {
    width: Math.max(...corners.map((point) => point.x)) - Math.min(...corners.map((point) => point.x)),
    height: Math.max(...corners.map((point) => point.y)) - Math.min(...corners.map((point) => point.y))
  };
  const maximumNodeDiameter = renderer.getGraph().nodes().reduce((maximum, node) => {
    const size = renderer.getNodeDisplayData(node)?.size ?? 0;
    return Math.max(maximum, size * 2);
  }, 0);
  return Math.max(0.08, graphZoomOutRatio(
    renderer.getCamera().ratio,
    span,
    renderer.getDimensions(),
    maximumNodeDiameter + 24
  ));
}

function freshViewportZoomedState(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  viewportTarget: { x: number; y: number },
  newRatio: number
) {
  const cameraState = renderer.getCamera().getState();
  const override = { cameraState };
  const graphTarget = renderer.viewportToFramedGraph(viewportTarget, override);
  const viewport = renderer.getDimensions();
  const graphCenterPoint = renderer.viewportToFramedGraph(
    { x: viewport.width / 2, y: viewport.height / 2 },
    override
  );
  const ratioDifference = newRatio / cameraState.ratio;
  return {
    angle: cameraState.angle,
    x: (graphTarget.x - graphCenterPoint.x) * (1 - ratioDifference) + cameraState.x,
    y: (graphTarget.y - graphCenterPoint.y) * (1 - ratioDifference) + cameraState.y,
    ratio: newRatio
  };
}

export function restoreKnowledgeGraphViewState(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  stateKey: string,
  state?: KnowledgeGraphViewState
): boolean {
  if (!state || state.stateKey !== stateKey) return false;
  const nodes = graph.nodes();
  if (!nodes.every((node) => {
    const point = state.nodePositions[node];
    return point && Number.isFinite(point.x) && Number.isFinite(point.y);
  })) return false;
  for (const node of nodes) {
    const position = state.nodePositions[node];
    if (position) graph.mergeNodeAttributes(node, position);
  }
  return true;
}

export function reduceNode(
  node: string,
  attributes: NodeAttributes,
  cameraRatio: number,
  hovered: string | null,
  neighbors: Set<string>,
  hoverStrength = 1,
  backgroundOpacity = 0.1
) {
  const opacity = nodeLabelOpacity(cameraRatio, attributes.importance);
  if (!hovered) return {
    ...attributes,
    hidden: false,
    forceLabel: true,
    label: attributes.label,
    labelColor: "#cbd5e1",
    labelOpacity: opacity
  };
  const emphasized = node === hovered || neighbors.has(node);
  return {
    ...attributes,
    hidden: false,
    color: emphasized ? attributes.color : blendGraphColor(attributes.color, graphMutedColor, hoverStrength, 1 + (backgroundOpacity - 1) * hoverStrength),
    forceLabel: true,
    label: attributes.label,
    labelColor: emphasized ? "#cbd5e1" : blendGraphColor("#cbd5e1", graphMutedColor, hoverStrength),
    labelOpacity: emphasized ? opacity + (1 - opacity) * hoverStrength : opacity * (1 - hoverStrength * 0.98),
    zIndex: emphasized ? 2 : 0
  };
}

export function reduceEdge(
  graph: Graph<NodeAttributes, EdgeAttributes>,
  edge: string,
  attributes: EdgeAttributes,
  cameraRatio: number,
  hovered: string | null,
  hoverStrength: number
) {
  if (attributes.kind === "hierarchy_link") return { ...attributes, hidden: true, forceLabel: false };
  if (attributes.kind === "hit_area") {
    return {
      ...attributes,
      hidden: false,
      color: "rgba(0, 0, 0, 0)",
      size: zoomCompensatedEdgeSize(cameraRatio, relationHitAreaScreenThickness),
      forceLabel: false,
      label: null,
      labelOpacity: 0,
      zIndex: 10
    };
  }
  const zoomStrength = zoomVisualStrength(cameraRatio);
  const revealProgress = attributes.label && attributes.labelRevealAt <= 1
    ? clamp((zoomStrength - attributes.labelRevealAt) / Math.max(0.01, 1 - attributes.labelRevealAt), 0, 1)
    : 0;
  const showRestingLabel = revealProgress > 0;
  const restingLabelOpacity = revealProgress * 0.9;
  const compensatedSize = zoomCompensatedEdgeSize(cameraRatio);
  if (!hovered) return {
    ...attributes,
    hidden: false,
    color: restingEdgeColor(attributes.kind, zoomStrength),
    size: compensatedSize,
    forceLabel: showRestingLabel,
    label: showRestingLabel ? attributes.label : null,
    labelColor: "#94a3b8",
    labelOpacity: restingLabelOpacity
  };
  const incident = hovered === edge || graph.extremities(edge).includes(hovered);
  return {
    ...attributes,
    hidden: false,
    color: hoveredEdgeColor(attributes.kind, hoverStrength, zoomStrength, incident, graph.hasNode(hovered) ? 0.1 : undefined),
    size: compensatedSize,
    forceLabel: Boolean(attributes.label) && (showRestingLabel || incident),
    label: attributes.label,
    labelColor: blendGraphColor("#94a3b8", incident ? graphHighlightColor : graphMutedColor, hoverStrength),
    labelOpacity: incident ? restingLabelOpacity + (1 - restingLabelOpacity) * hoverStrength : restingLabelOpacity * (1 - hoverStrength * 0.97),
    zIndex: incident ? 2 : 0
  };
}

function restingEdgeColor(kind: EdgeAttributes["kind"], strength: number): string {
  if (kind === "atomic_note_relation") return `rgba(167, 139, 250, ${0.06 + strength * 0.42})`;
  return `rgba(56, 189, 248, ${0.04 + strength * 0.38})`;
}

function hoveredEdgeColor(kind: EdgeAttributes["kind"], strength: number, zoomStrength: number, emphasized: boolean, backgroundOpacity?: number): string {
  const base = kind === "atomic_note_relation" ? 0.06 + zoomStrength * 0.42 : 0.04 + zoomStrength * 0.38;
  return blendGraphColor(
    kind === "atomic_note_relation" ? "#a78bfa" : "#38bdf8",
    emphasized ? graphHighlightColor : graphMutedColor,
    strength,
    emphasized ? base + (1 - base) * strength : base + ((backgroundOpacity ?? base * 0.03) - base) * strength
  );
}

function edgeLabelFallsOutsideViewport(
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
  edge: string
): boolean {
  if (graph.getEdgeAttribute(edge, "kind") === "atomic_note_relation") return false;
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

function createSmoothNodeLabels(schedule: () => void) {
  type Rectangle = { left: number; right: number; top: number; bottom: number };
  let occupied: Rectangle[] = [];
  let now = 0;
  const history = new Map<string, { opacity: number; at: number }>();
  const measurements = new Map<string, { width: number; height: number }>();
  const draw: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (context, data, settings) => {
    if (!data.label) return;
    const key = String(data.key);
    const desired = Number(data.labelOpacity ?? 1);
    const previous = history.get(key);
    if (desired < 0.001 && (!previous || previous.opacity < 0.001)) return;
    const cacheKey = `${settings.labelSize}:${data.label}`;
    let measurement = measurements.get(cacheKey);
    if (!measurement) {
      context.font = `${settings.labelWeight} ${settings.labelSize}px ${settings.labelFont}`;
      const lines = wrapCanvasText(context, data.label, 190, 3);
      measurement = { width: Math.max(...lines.map((line) => context.measureText(line).width)), height: lines.length * settings.labelSize * 1.18 };
      measurements.set(cacheKey, measurement);
    }
    const rectangle = {
      left: data.x - measurement.width / 2 - 5, right: data.x + measurement.width / 2 + 5,
      top: data.y + data.size + 2, bottom: data.y + data.size + measurement.height + 8
    };
    const overlaps = occupied.some((other) => rectangle.left < other.right && rectangle.right > other.left && rectangle.top < other.bottom && rectangle.bottom > other.top);
    const target = overlaps || occupied.length >= 350 ? 0 : desired;
    if (target > 0) occupied.push(rectangle);
    const elapsed = previous ? Math.min(64, now - previous.at) : 16;
    const before = previous?.opacity ?? 0;
    const opacity = Math.abs(target - before) < 0.005 ? target : before + (target - before) * (1 - Math.exp(-elapsed / 100));
    history.set(key, { opacity, at: now });
    if (Math.abs(opacity - target) > 0.005) schedule();
    if (opacity > 0.001) drawWrappedNodeLabel(context, { ...data, labelOpacity: opacity }, settings);
  };
  return { draw, beginFrame() { occupied = []; now = performance.now(); } };
}

const drawWrappedNodeLabel: NodeLabelDrawingFunction<NodeAttributes, EdgeAttributes> = (context, data, settings) => {
  if (!data.label) return;
  const opacity = Number((data as typeof data & { labelOpacity?: number }).labelOpacity ?? 1);
  const color = data.labelColor ?? (settings.labelColor.attribute
    ? String(data[settings.labelColor.attribute] ?? settings.labelColor.color ?? "#cbd5e1")
    : settings.labelColor.color);
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
  const x = (sourceData.x + targetData.x) / 2;
  const y = (sourceData.y + targetData.y) / 2;
  if (edgeData.kind === "atomic_note_relation") {
    drawAtomicRelationMarker(context, edgeData.relationType, x, y, opacity);
    return;
  }
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = edgeData.labelColor ?? (settings.edgeLabelColor.attribute
    ? String(edgeData[settings.edgeLabelColor.attribute] ?? settings.edgeLabelColor.color ?? "#cbd5e1")
    : settings.edgeLabelColor.color) ?? "#94a3b8";
  context.font = `${settings.edgeLabelWeight} ${settings.edgeLabelSize}px ${settings.edgeLabelFont}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const lines = wrapCanvasText(context, edgeData.label, 120, 2);
  const lineHeight = settings.edgeLabelSize * 1.12;
  lines.forEach((line, index) => context.fillText(line, x, y + (index - (lines.length - 1) / 2) * lineHeight));
  context.restore();
};

function drawAtomicRelationMarker(
  context: CanvasRenderingContext2D,
  relationType: string | null,
  x: number,
  y: number,
  opacity: number
) {
  const color = atomicRelationColor(relationType);
  context.save();
  context.globalAlpha = opacity;
  context.fillStyle = "#0f172a";
  context.strokeStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = 1.5;
  context.beginPath();
  context.arc(x, y, atomicRelationMarkerRadius, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.translate(x - 6, y - 6);
  context.scale(0.5, 0.5);
  context.lineWidth = 2;
  for (const node of atomicRelationIconNode(relationType)) drawLucideCanvasNode(context, node);
  context.restore();
}

function drawLucideCanvasNode(context: CanvasRenderingContext2D, [element, attributes]: IconNode[number]) {
  context.beginPath();
  if (element === "path") {
    context.stroke(new Path2D(attributes.d));
    return;
  }
  if (element === "circle") {
    context.arc(Number(attributes.cx), Number(attributes.cy), Number(attributes.r), 0, Math.PI * 2);
  } else if (element === "line") {
    context.moveTo(Number(attributes.x1), Number(attributes.y1));
    context.lineTo(Number(attributes.x2), Number(attributes.y2));
  } else if (element === "rect") {
    context.roundRect(
      Number(attributes.x ?? 0),
      Number(attributes.y ?? 0),
      Number(attributes.width),
      Number(attributes.height),
      Number(attributes.rx ?? 0)
    );
  } else if (element === "polyline" || element === "polygon") {
    const points = (attributes.points ?? "").trim().split(/\s+/u).map((point) => point.split(",").map(Number));
    points.forEach(([pointX, pointY], index) => {
      if (index === 0) context.moveTo(pointX!, pointY!);
      else context.lineTo(pointX!, pointY!);
    });
    if (element === "polygon") context.closePath();
  } else if (element === "ellipse") {
    context.ellipse(Number(attributes.cx), Number(attributes.cy), Number(attributes.rx), Number(attributes.ry), 0, 0, Math.PI * 2);
  }
  context.stroke();
}

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


function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
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
