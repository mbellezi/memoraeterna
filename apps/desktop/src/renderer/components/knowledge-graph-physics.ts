import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { graphLayoutRadius, graphSeedFraction, type GraphForceSettings, type GraphLayoutEdge, type GraphLayoutNode } from "./knowledge-graph-layout-contract";

interface PhysicsNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  community: number;
}

interface PhysicsLink extends SimulationLinkDatum<PhysicsNode> { weight: number }

/** Presentation-only physics. No synthetic display nodes or picking edges enter the simulation. */
export function createGraphPhysics(inputNodes: GraphLayoutNode[], edges: GraphLayoutEdge[], initialSettings: GraphForceSettings, restored: boolean) {
  const topology = new Graph({ type: "undirected", multi: true, allowSelfLoops: false });
  inputNodes.forEach((node) => topology.addNode(node.id));
  edges.forEach((edge) => topology.addEdge(edge.source, edge.target, { weight: edge.weight }));
  let seed = 41;
  const communities = edges.length ? louvain(topology, {
    rng: () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }
  }) : {};
  const nodes: PhysicsNode[] = inputNodes.map((node, index) => ({
    ...node, vx: 0, vy: 0, degree: topology.degree(node.id), community: communities[node.id] ?? index
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<number, PhysicsNode[]>();
  nodes.filter((node) => node.degree > 0).forEach((node) => {
    const group = groups.get(node.community) ?? [];
    group.push(node);
    groups.set(node.community, group);
  });
  let settings = initialSettings;
  let radius = graphLayoutRadius(nodes.length, settings.linkDistance);
  if (!restored) {
    // Deterministic community seeds reduce the initial settling motion.
    [...groups.values()].sort((a, b) => b.length - a.length).forEach((members, index) => {
      const angle = index * 2.399963;
      const centerRadius = radius * 0.55 * Math.sqrt(index / Math.max(1, groups.size));
      members.forEach((node, memberIndex) => {
        const localRadius = settings.linkDistance * 0.4 * Math.sqrt(memberIndex);
        const localAngle = memberIndex * 2.399963;
        node.x = Math.cos(angle) * centerRadius + Math.cos(localAngle) * localRadius;
        node.y = Math.sin(angle) * centerRadius + Math.sin(localAngle) * localRadius;
      });
    });
    nodes.filter((node) => node.degree === 0).forEach((node) => {
      const angle = graphSeedFraction(node.id) * Math.PI * 2;
      const distance = radius * (0.86 + 0.2 * graphSeedFraction(`${node.id}:radius`));
      node.x = Math.cos(angle) * distance;
      node.y = Math.sin(angle) * distance;
    });
  }
  const simulation = forceSimulation(nodes).stop().alphaDecay(0.018).alphaMin(0.002).velocityDecay(0.35);
  function configure(next: GraphForceSettings) {
    settings = next;
    radius = graphLayoutRadius(nodes.length, settings.linkDistance);
    simulation
      .force("charge", forceManyBody<PhysicsNode>().strength(-settings.repulsion).distanceMin(8).theta(0.85))
      .force("link", forceLink<PhysicsNode, PhysicsLink>(edges.map((edge) => ({ ...edge })))
        .id((node) => node.id)
        .distance(settings.linkDistance)
        .strength((edge) => {
          const source = edge.source as PhysicsNode;
          const target = edge.target as PhysicsNode;
          return settings.linkStrength * Math.min(2, Math.sqrt(Math.max(0.2, edge.weight))) /
            Math.sqrt(Math.max(1, Math.min(source.degree, target.degree)));
        }))
      .force("x", forceX<PhysicsNode>(0).strength((node) => node.degree ? settings.centerStrength : settings.centerStrength * 0.1))
      .force("y", forceY<PhysicsNode>(0).strength((node) => node.degree ? settings.centerStrength : settings.centerStrength * 0.1))
      .force("collision", forceCollide<PhysicsNode>(settings.linkDistance * 0.16).strength(0.7))
      .force("communities", (alpha: number) => {
        for (const members of groups.values()) {
          if (members.length < 3) continue;
          let x = 0;
          let y = 0;
          members.forEach((node) => { x += node.x; y += node.y; });
          x /= members.length;
          y /= members.length;
          members.forEach((node) => {
            node.vx += (x - node.x) * 0.018 * alpha;
            node.vy += (y - node.y) * 0.018 * alpha;
          });
        }
      })
      .force("periphery", (alpha: number) => {
        for (const node of nodes) {
          const distance = Math.hypot(node.x, node.y);
          if (distance < 0.001) continue;
          // Orphans prefer a broad peripheral band. Other nodes encounter only a soft outer force.
          const target = radius * (0.86 + 0.2 * graphSeedFraction(`${node.id}:radius`));
          const magnitude = node.degree === 0
            ? (target - distance) * 0.12 * alpha
            : -Math.max(0, distance - radius * 1.25) * 0.08 * alpha;
          node.vx += node.x / distance * magnitude;
          node.vy += node.y / distance * magnitude;
        }
      });
  }
  configure(settings);

  return {
    nodes,
    simulation,
    configure,
    reheat() { simulation.alpha(Math.max(simulation.alpha(), 0.45)).alphaTarget(0); },
    drag(id: string, x: number, y: number, release: boolean) {
      const node = byId.get(id);
      if (!node) return;
      node.x = x; node.y = y;
      node.fx = release ? null : x; node.fy = release ? null : y;
      node.vx = 0; node.vy = 0;
      simulation.alpha(Math.max(simulation.alpha(), 0.25)).alphaTarget(release ? 0 : 0.18);
    },
    tick() {
      simulation.tick();
      return simulation.alphaTarget() === 0 && simulation.alpha() < 0.015 &&
        nodes.every((node) => Math.hypot(node.vx, node.vy) < 0.08);
    },
    positions() {
      const positions = new Float32Array(nodes.length * 2);
      nodes.forEach((node, index) => { positions[index * 2] = node.x; positions[index * 2 + 1] = node.y; });
      return positions;
    }
  };
}
