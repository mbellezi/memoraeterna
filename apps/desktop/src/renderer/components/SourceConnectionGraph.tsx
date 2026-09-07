import { useEffect, useRef, useState } from "react";
import Graph from "graphology";
import type Sigma from "sigma";
import { Maximize2 } from "lucide-react";
import type { Translator } from "@app/i18n";
import type { KnowledgeGraphSourceConnectionDetails } from "../../shared/ipc";
import { KnowledgeGraphLayout } from "./knowledge-graph-layout";
import { graphLayoutRadius, type GraphForceSettings } from "./knowledge-graph-layout-contract";
import { GraphHoverIntent, GraphWheelMotion, blendGraphColor, graphHighlightColor, graphMutedColor, boundedGraphWheelRatio, captureGraphWheelEvent, type GraphHoverTarget } from "./knowledge-graph-interaction";
import { graphNodeSize, graphTypography, relationHitAreaScreenThickness, zoomCompensatedEdgeSize } from "./knowledge-graph-view-model";

export const sourceConnectionEdgeThickness = 2.1;
export const sourceConnectionArrowOptions = { lengthToThicknessRatio: 4, widenessToThicknessRatio: 3 };

export function addSourceConnectionHitAreas(graph: Graph) {
  for (const edge of graph.edges()) graph.addDirectedEdgeWithKey(`hit:${edge}`, graph.source(edge), graph.target(edge), {
    type: "line", color: "rgba(0, 0, 0, 0)", size: relationHitAreaScreenThickness,
    interactionTarget: edge, label: null, forceLabel: false, zIndex: 10
  });
}

export function sourceConnectionEmphasis(graph: Graph, type: "node" | "edge", key: string,
  target: GraphHoverTarget | null, strength: number) {
  const base = type === "node" ? graph.getNodeAttribute(key, "color") : graph.getEdgeAttribute(key, "color");
  const label = type === "node" ? "#e2e8f0" : "#cbd5e1";
  const emphasized = !target || (type === "node"
    ? target.type === "node" ? key === target.key || graph.areNeighbors(key, target.key) : graph.extremities(target.key).includes(key)
    : target.type === "edge" ? key === target.key : graph.extremities(key).includes(target.key));
  if (!target) return { color: base, labelColor: label, zIndex: 0 };
  const opacity = 1 - strength * (1 - (target.type === "node" ? 0.1 : 0.04));
  return {
    color: emphasized ? type === "edge" ? blendGraphColor(base, graphHighlightColor, strength) : base
      : blendGraphColor(base, graphMutedColor, strength, opacity),
    labelColor: emphasized ? type === "edge" ? blendGraphColor(label, graphHighlightColor, strength) : label
      : blendGraphColor(label, graphMutedColor, strength, 1 - strength * 0.98),
    zIndex: emphasized ? 2 : 0
  };
}

export function buildSourceConnectionGraph(details: KnowledgeGraphSourceConnectionDetails) {
  const graph = new Graph({ type: "directed", multi: true });
  details.entities.forEach((entity, index) => {
    const angle = index * 2.399963229728653;
    const radius = 12 * Math.sqrt(index + 1);
    graph.addNode(entity.id, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius,
      label: entity.label, size: 5, color: entity.shared ? "#22d3ee" : "#c084fc", forceLabel: true });
  });
  for (const relation of details.relations) {
    if (graph.hasNode(relation.source) && graph.hasNode(relation.target)) {
      graph.addDirectedEdgeWithKey(relation.id, relation.source, relation.target,
        { label: relation.label, size: sourceConnectionEdgeThickness, color: "#94a3b8", type: "arrow", forceLabel: true });
    }
  }
  graph.forEachNode((id) => graph.setNodeAttribute(id, "size", graphNodeSize(graph.degree(id))));
  return graph;
}

export function SourceConnectionGraph({ details, forces, wheelZoomSensitivity, t }: {
  details: KnowledgeGraphSourceConnectionDetails;
  forces: GraphForceSettings;
  wheelZoomSensitivity: number;
  t: Translator;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<KnowledgeGraphLayout | null>(null);
  const fitRef = useRef(() => {});
  const forcesRef = useRef(forces);
  forcesRef.current = forces;
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => { layoutRef.current?.configure(forces); }, [forces]);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let disposed = false;
    let cleanup = () => {};
    setFailed(false);
    void initialize().catch(() => { cleanup(); if (!disposed) setFailed(true); });
    return () => { disposed = true; cleanup(); };

    async function initialize() {
      const [{ default: SigmaConstructor }, { GraphNodeProgram, GraphEdgeProgram, createGraphArrowProgram }, { drawDiscNodeHover }] = await Promise.all([
        import("sigma"), import("./knowledge-graph-programs"), import("sigma/rendering")
      ]);
      if (disposed || !container) return;
      const graph = buildSourceConnectionGraph(details);
      addSourceConnectionHitAreas(graph);
      let cameraRatio = 1;
      let target: GraphHoverTarget | null = null;
      let hoverStrength = 0;
      let dragging = false;
      let hoverFrame: number | null = null;
      const renderer: Sigma = new SigmaConstructor(graph, container, {
        allowInvalidContainer: true, nodeProgramClasses: { circle: GraphNodeProgram },
        nodeHoverProgramClasses: { circle: GraphNodeProgram },
        edgeProgramClasses: { arrow: createGraphArrowProgram(sourceConnectionArrowOptions), line: GraphEdgeProgram },
        enableEdgeEvents: true, zIndex: true,
        labelColor: { attribute: "labelColor", color: "#e2e8f0" }, edgeLabelColor: { attribute: "labelColor", color: "#cbd5e1" },
        // Sigma's hover background is white; regular canvas labels remain light.
        defaultDrawNodeHover: (context, node, settings) => {
          if (!dragging) drawDiscNodeHover(context, node, { ...settings, labelColor: { color: "#0f172a" } });
        },
        ...graphTypography,
        labelRenderedSizeThreshold: 0,
        renderEdgeLabels: true, stagePadding: 40, minCameraRatio: 0.02, maxCameraRatio: 12,
        minEdgeThickness: 1.2,
        nodeReducer: (node, attributes) => ({ ...attributes, ...sourceConnectionEmphasis(graph, "node", node, target, hoverStrength) }),
        edgeReducer: (edge, attributes) => attributes.interactionTarget
          ? { ...attributes, size: zoomCompensatedEdgeSize(cameraRatio, relationHitAreaScreenThickness) }
          : { ...attributes, ...sourceConnectionEmphasis(graph, "edge", edge, target, hoverStrength), size: zoomCompensatedEdgeSize(cameraRatio, sourceConnectionEdgeThickness) },
        itemSizesReference: "screen", hideEdgesOnMove: false, hideLabelsOnMove: false
      });
      const radius = graphLayoutRadius(graph.order, forcesRef.current.linkDistance) * 1.4;
      renderer.setCustomBBox({ x: [-radius, radius], y: [-radius, radius] });
      const camera = renderer.getCamera();
      const hoverIntent = new GraphHoverIntent((next) => {
        if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
        if (next) { target = next; hoverStrength = 0; }
        const from = hoverStrength;
        const started = performance.now();
        const animate = (now: number) => {
          const progress = Math.min(1, (now - started) / 140);
          hoverStrength = from + ((next ? 1 : 0) - from) * (1 - Math.pow(1 - progress, 3));
          renderer.scheduleRefresh();
          if (progress < 1) hoverFrame = requestAnimationFrame(animate);
          else { hoverFrame = null; if (!next) target = null; }
        };
        hoverFrame = requestAnimationFrame(animate);
      }, () => {});
      const resolveEdge = (edge: string): string => graph.getEdgeAttribute(edge, "interactionTarget") ?? edge;
      renderer.on("enterNode", ({ node, event }) => hoverIntent.enter({ type: "node", key: node, x: event.x, y: event.y }));
      renderer.on("leaveNode", ({ node }) => hoverIntent.leave("node", node));
      renderer.on("enterEdge", ({ edge, event }) => hoverIntent.enter({ type: "edge", key: resolveEdge(edge), x: event.x, y: event.y }));
      renderer.on("leaveEdge", ({ edge }) => hoverIntent.leave("edge", resolveEdge(edge)));
      renderer.getMouseCaptor().on("mouseleave", () => { if (!dragging) hoverIntent.clear(); });
      const suspendHover = () => {
        dragging = true;
        hoverIntent.suspend();
        if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
        hoverFrame = null; target = null; hoverStrength = 0;
        renderer.setSetting("enableEdgeEvents", false);
        renderer.scheduleRefresh();
      };
      camera.on("updated", ({ ratio }) => { cameraRatio = ratio; renderer.scheduleRefresh(); });
      let interacted = false;
      let dragged: string | null = null;
      let wheelFrame: number | null = null;
      let fitFrame: number | null = null;
      let anchor = { x: 0, y: 0 };
      const motion = new GraphWheelMotion(wheelZoomSensitivity);
      const cancelWheel = () => {
        motion.cancel();
        if (wheelFrame !== null) cancelAnimationFrame(wheelFrame);
        wheelFrame = null;
      };
      const fit = () => {
        renderer.refresh();
        const cameraState = camera.getState();
        const points = graph.nodes().map((id) => renderer.graphToViewport(graph.getNodeAttributes(id) as { x: number; y: number }, { cameraState }));
        if (!points.length) return;
        const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
        const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
        const center = renderer.viewportToFramedGraph({ x: (left + right) / 2, y: (top + bottom) / 2 }, { cameraState });
        const { width, height } = renderer.getDimensions();
        const ratio = camera.ratio * Math.max((right - left) / Math.max(1, width - 160), (bottom - top) / Math.max(1, height - 100));
        camera.setState({ ...center, ratio: Math.max(0.02, Math.min(12, ratio || 0.2)) });
      };
      fitRef.current = () => { interacted = false; cancelWheel(); fit(); };
      const scheduleFit = () => {
        if (!interacted && fitFrame === null) fitFrame = requestAnimationFrame(() => { fitFrame = null; if (!interacted) fit(); });
      };
      const stepWheel = (now: number) => {
        wheelFrame = null;
        const delta = motion.advance(now, { ratio: camera.ratio, minimum: 0.02, maximum: 12 });
        if (delta) {
          const ratio = boundedGraphWheelRatio(camera.ratio, delta, 0.02, 12);
          const state = camera.getState();
          const before = renderer.viewportToFramedGraph(anchor, { cameraState: state });
          const after = renderer.viewportToFramedGraph(anchor, { cameraState: { ...state, ratio } });
          camera.setState({ ratio, x: state.x + before.x - after.x, y: state.y + before.y - after.y });
        }
        if (motion.active) wheelFrame = requestAnimationFrame(stepWheel);
      };
      const wheel = (event: WheelEvent) => {
        captureGraphWheelEvent(event);
        interacted = true;
        if (dragged) return;
        const rect = container.getBoundingClientRect();
        anchor = { x: event.clientX - rect.left, y: event.clientY - rect.top };
        motion.push(event, performance.now());
        if (wheelFrame === null && motion.active) wheelFrame = requestAnimationFrame(stepWheel);
      };
      container.addEventListener("wheel", wheel, { capture: true, passive: false });
      renderer.on("downStage", () => { interacted = true; cancelWheel(); suspendHover(); });
      renderer.on("downNode", ({ node, event }) => {
        interacted = true; cancelWheel(); suspendHover(); dragged = node; camera.disable(); event.preventSigmaDefault();
      });
      renderer.getMouseCaptor().on("mousemovebody", (event) => {
        if (!dragged) return;
        const point = renderer.viewportToGraph(event);
        graph.mergeNodeAttributes(dragged, point);
        layoutRef.current?.drag(dragged, point.x, point.y, false);
        event.preventSigmaDefault(); event.original.preventDefault();
      });
      const release = () => {
        dragging = false; hoverIntent.resume(); renderer.setSetting("enableEdgeEvents", true);
        if (dragged) {
          const point = graph.getNodeAttributes(dragged);
          layoutRef.current?.drag(dragged, point.x, point.y, true);
        }
        dragged = null; camera.enable();
      };
      renderer.getMouseCaptor().on("mouseup", release);
      window.addEventListener("blur", release);
      const resizeObserver = new ResizeObserver(() => { renderer.resize(); scheduleFit(); });
      resizeObserver.observe(container);
      cleanup = () => {
        hoverIntent.dispose();
        if (hoverFrame !== null) cancelAnimationFrame(hoverFrame);
        resizeObserver.disconnect();
        cancelWheel();
        if (fitFrame !== null) cancelAnimationFrame(fitFrame);
        container.removeEventListener("wheel", wheel, { capture: true });
        window.removeEventListener("blur", release);
        layoutRef.current?.kill(); layoutRef.current = null;
        fitRef.current = () => {};
        renderer.kill();
      };
      const nodes = graph.nodes();
      layoutRef.current = new KnowledgeGraphLayout(
        nodes.map((id) => ({ id, x: graph.getNodeAttribute(id, "x"), y: graph.getNodeAttribute(id, "y") })),
        graph.edges().filter((id) => !graph.isSelfLoop(id) && !graph.getEdgeAttribute(id, "interactionTarget")).map((id) => ({ source: graph.source(id), target: graph.target(id), weight: 1 })),
        forcesRef.current, false,
        (positions) => {
          nodes.forEach((id, index) => { if (id !== dragged) graph.mergeNodeAttributes(id, { x: positions[index * 2]!, y: positions[index * 2 + 1]! }); });
          scheduleFit();
        },
        () => { if (!disposed) setFailed(true); }
      );
      scheduleFit();
    }
  }, [details, wheelZoomSensitivity, retry]);

  return <div className="relative h-full min-h-0 overflow-hidden rounded-lg bg-slate-950">
    <div ref={containerRef} className="absolute inset-0" role="application" aria-label={t("knowledgeGraph.graphPopup")} tabIndex={0} />
    <button type="button" className="absolute right-2 top-2 rounded border border-white/20 bg-slate-900 p-1.5 text-slate-200" aria-label={t("knowledgeGraph.fit")} title={t("knowledgeGraph.fit")} onClick={() => fitRef.current()}><Maximize2 className="h-4 w-4" /></button>
    {failed ? <div className="absolute inset-0 grid place-content-center gap-2 bg-slate-950/90 p-4 text-sm">
      <p>{t("knowledgeGraph.layoutError")}</p><button type="button" onClick={() => setRetry((value) => value + 1)}>{t("shell.actions.retry")}</button>
    </div> : null}
  </div>;
}
