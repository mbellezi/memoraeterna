import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type SimulationNodeDatum,
  type SimulationLinkDatum
} from "d3-force";
import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import {
  graphLayoutRadius,
  graphSeedFraction,
  type GraphForceSettings,
  type GraphLayoutEdge,
  type GraphLayoutNode
} from "./layout-contract";

interface PhysicsNode extends SimulationNodeDatum {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
  community: string;
  /** The topic group, or null for a graph laid out without groups. */
  group: string | null;
}

/** A topic group with at least this many notes is split by Louvain into communities of its own. */
export const largeGroupSize = 24;

type Random = () => number;

function seededRandom(): Random {
  let seed = 41;
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

/**
 * Each node's community. Without groups: Louvain on the whole graph. With topic groups (the Map ›
 * Grafo, D19): the group, and inside a group of `largeGroupSize` notes or more, Louvain on the
 * relations among that group's notes, so a large topic shows its own clusters and never mixes
 * with another topic's. Deterministic: the same graph always gives the same communities.
 */
export function layoutCommunities(
  nodes: readonly GraphLayoutNode[],
  edges: readonly GraphLayoutEdge[],
  random: Random = seededRandom()
): Map<string, string> {
  const communities = new Map<string, string>();
  const grouped = nodes.some((node) => node.group !== undefined);
  if (!grouped) {
    const topology = new Graph({ type: "undirected", multi: true, allowSelfLoops: false });
    nodes.forEach((node) => topology.addNode(node.id));
    edges.forEach((edge) => topology.addEdge(edge.source, edge.target, { weight: edge.weight }));
    const found: Record<string, number> = edges.length ? louvain(topology, { rng: random }) : {};
    nodes.forEach((node, index) =>
      communities.set(node.id, String(found[node.id] ?? `solo:${index}`))
    );
    return communities;
  }
  const groupOf = new Map(nodes.map((node) => [node.id, node.group ?? `solo:${node.id}`]));
  const members = new Map<string, string[]>();
  for (const node of nodes) {
    const group = groupOf.get(node.id)!;
    members.set(group, [...(members.get(group) ?? []), node.id]);
  }
  for (const [group, ids] of [...members.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (ids.length < largeGroupSize) {
      ids.forEach((id) => communities.set(id, group));
      continue;
    }
    const inside = new Graph({ type: "undirected", multi: true, allowSelfLoops: false });
    ids.forEach((id) => inside.addNode(id));
    for (const edge of edges)
      if (groupOf.get(edge.source) === group && groupOf.get(edge.target) === group)
        inside.addEdge(edge.source, edge.target, { weight: edge.weight });
    const found: Record<string, number> = inside.size ? louvain(inside, { rng: random }) : {};
    ids.forEach((id) =>
      communities.set(id, found[id] === undefined ? group : `${group}:${found[id]}`)
    );
  }
  return communities;
}

interface PhysicsLink extends SimulationLinkDatum<PhysicsNode> {
  weight: number;
}

/** Presentation-only physics. No synthetic display nodes or picking edges enter the simulation. */
export function createGraphPhysics(
  inputNodes: GraphLayoutNode[],
  edges: GraphLayoutEdge[],
  initialSettings: GraphForceSettings,
  restored: boolean
) {
  const degrees = new Map<string, number>();
  for (const edge of edges) {
    degrees.set(edge.source, (degrees.get(edge.source) ?? 0) + 1);
    degrees.set(edge.target, (degrees.get(edge.target) ?? 0) + 1);
  }
  const communities = layoutCommunities(inputNodes, edges);
  const grouped = inputNodes.some((node) => node.group !== undefined);
  const nodes: PhysicsNode[] = inputNodes.map((node, index) => ({
    id: node.id,
    x: node.x,
    y: node.y,
    vx: 0,
    vy: 0,
    degree: degrees.get(node.id) ?? 0,
    community: communities.get(node.id) ?? `solo:${index}`,
    group: grouped ? (node.group ?? null) : null
  }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  // A note of a topic group stays with its group even when it has no relation drawn.
  const placedTogether = (node: PhysicsNode) => node.degree > 0 || node.group !== null;
  const groups = new Map<string, PhysicsNode[]>();
  nodes.filter(placedTogether).forEach((node) => {
    const group = groups.get(node.community) ?? [];
    group.push(node);
    groups.set(node.community, group);
  });
  const topicGroups = new Map<string, PhysicsNode[]>();
  nodes.forEach((node) => {
    if (node.group === null) return;
    topicGroups.set(node.group, [...(topicGroups.get(node.group) ?? []), node]);
  });
  const topicSize = (members: PhysicsNode[]) =>
    topicGroups.get(members[0]!.group ?? "")?.length ?? members.length;
  let settings = initialSettings;
  let radius = graphLayoutRadius(nodes.length, settings.linkDistance);
  if (!restored) {
    // Deterministic community seeds reduce the initial settling motion; the communities of one
    // topic group are seeded next to each other.
    [...groups.values()]
      .sort(
        (a, b) =>
          topicSize(b) - topicSize(a) ||
          (a[0]!.group ?? "").localeCompare(b[0]!.group ?? "") ||
          b.length - a.length
      )
      .forEach((members, index) => {
        const angle = index * 2.399963;
        const centerRadius = radius * 0.55 * Math.sqrt(index / Math.max(1, groups.size));
        members.forEach((node, memberIndex) => {
          const localRadius = settings.linkDistance * 0.4 * Math.sqrt(memberIndex);
          const localAngle = memberIndex * 2.399963;
          node.x = Math.cos(angle) * centerRadius + Math.cos(localAngle) * localRadius;
          node.y = Math.sin(angle) * centerRadius + Math.sin(localAngle) * localRadius;
        });
      });
    nodes
      .filter((node) => !placedTogether(node))
      .forEach((node) => {
        const angle = graphSeedFraction(node.id) * Math.PI * 2;
        const distance = radius * (0.86 + 0.2 * graphSeedFraction(`${node.id}:radius`));
        node.x = Math.cos(angle) * distance;
        node.y = Math.sin(angle) * distance;
      });
  }
  const simulation = forceSimulation(nodes)
    .stop()
    .alpha(restored ? 0 : 1)
    .alphaDecay(0.018)
    .alphaMin(0.002)
    .velocityDecay(0.35);
  function configure(next: GraphForceSettings) {
    settings = next;
    radius = graphLayoutRadius(nodes.length, settings.linkDistance);
    simulation
      .force(
        "charge",
        forceManyBody<PhysicsNode>().strength(-settings.repulsion).distanceMin(8).theta(0.85)
      )
      .force(
        "link",
        forceLink<PhysicsNode, PhysicsLink>(edges.map((edge) => ({ ...edge })))
          .id((node) => node.id)
          .distance(settings.linkDistance)
          .strength((edge) => {
            const source = edge.source as PhysicsNode;
            const target = edge.target as PhysicsNode;
            return (
              (settings.linkStrength * Math.min(2, Math.sqrt(Math.max(0.2, edge.weight)))) /
              Math.sqrt(Math.max(1, Math.min(source.degree, target.degree)))
            );
          })
      )
      .force(
        "x",
        forceX<PhysicsNode>(0).strength((node) =>
          node.degree ? settings.centerStrength : settings.centerStrength * 0.1
        )
      )
      .force(
        "y",
        forceY<PhysicsNode>(0).strength((node) =>
          node.degree ? settings.centerStrength : settings.centerStrength * 0.1
        )
      )
      .force("collision", forceCollide<PhysicsNode>(settings.linkDistance * 0.16).strength(0.7))
      .force("communities", (alpha: number) => {
        for (const members of groups.values()) {
          if (members.length < 3) continue;
          let x = 0;
          let y = 0;
          members.forEach((node) => {
            x += node.x;
            y += node.y;
          });
          x /= members.length;
          y /= members.length;
          members.forEach((node) => {
            node.vx += (x - node.x) * 0.018 * alpha;
            node.vy += (y - node.y) * 0.018 * alpha;
          });
        }
      })
      .force("topics", (alpha: number) => {
        // A topic group holds together as a whole, around its communities.
        for (const members of topicGroups.values()) {
          if (members.length < 2) continue;
          let x = 0;
          let y = 0;
          members.forEach((node) => {
            x += node.x;
            y += node.y;
          });
          x /= members.length;
          y /= members.length;
          members.forEach((node) => {
            node.vx += (x - node.x) * 0.012 * alpha;
            node.vy += (y - node.y) * 0.012 * alpha;
          });
        }
      })
      .force("periphery", (alpha: number) => {
        for (const node of nodes) {
          const distance = Math.hypot(node.x, node.y);
          if (distance < 0.001) continue;
          // Orphans prefer a broad peripheral band. Other nodes encounter only a soft outer force.
          const target = radius * (0.86 + 0.2 * graphSeedFraction(`${node.id}:radius`));
          const magnitude = !placedTogether(node)
            ? (target - distance) * 0.12 * alpha
            : -Math.max(0, distance - radius * 1.25) * 0.08 * alpha;
          node.vx += (node.x / distance) * magnitude;
          node.vy += (node.y / distance) * magnitude;
        }
      });
  }
  configure(settings);

  return {
    nodes,
    simulation,
    configure,
    reheat() {
      simulation.alpha(Math.max(simulation.alpha(), 0.45)).alphaTarget(0);
    },
    drag(id: string, x: number, y: number, release: boolean) {
      const node = byId.get(id);
      if (!node) return;
      node.x = x;
      node.y = y;
      node.fx = release ? null : x;
      node.fy = release ? null : y;
      node.vx = 0;
      node.vy = 0;
      simulation.alpha(Math.max(simulation.alpha(), 0.25)).alphaTarget(release ? 0 : 0.18);
    },
    tick() {
      simulation.tick();
      return (
        simulation.alphaTarget() === 0 &&
        simulation.alpha() < 0.015 &&
        nodes.every((node) => Math.hypot(node.vx, node.vy) < 0.08)
      );
    },
    positions() {
      const positions = new Float32Array(nodes.length * 2);
      nodes.forEach((node, index) => {
        positions[index * 2] = node.x;
        positions[index * 2 + 1] = node.y;
      });
      return positions;
    }
  };
}
