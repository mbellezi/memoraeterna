import { describe, expect, it } from "vitest";
import { createGraphPhysics, largeGroupSize, layoutCommunities } from "./physics";
import {
  defaultGraphForceSettings,
  graphLayoutCommandSchema,
  graphLayoutEventSchema,
  type GraphLayoutEdge
} from "./layout-contract";

function fixture() {
  const nodes = Array.from({ length: 32 }, (_, index) => ({
    id: String(index),
    x: index * 10,
    y: 0
  }));
  const edges: GraphLayoutEdge[] = [];
  for (let group = 0; group < 3; group += 1) {
    for (let i = 0; i < 8; i += 1) {
      edges.push({
        source: String(group * 8 + i),
        target: String(group * 8 + ((i + 1) % 8)),
        weight: 1
      });
      edges.push({
        source: String(group * 8 + i),
        target: String(group * 8 + ((i + 3) % 8)),
        weight: 1
      });
    }
  }
  edges.push({ source: "0", target: "8", weight: 0.2 }, { source: "8", target: "16", weight: 0.2 });
  return { nodes, edges };
}

function settle(physics: ReturnType<typeof createGraphPhysics>) {
  for (let tick = 0; tick < 800; tick += 1) if (physics.tick()) return tick;
  throw new Error("Physics did not settle");
}

describe("knowledge graph physics", () => {
  it("forms compact communities and spreads orphans over a peripheral band", () => {
    const { nodes, edges } = fixture();
    const physics = createGraphPhysics(nodes, edges, defaultGraphForceSettings, false);
    settle(physics);
    const connected = physics.nodes.filter((node) => node.degree > 0);
    const orphans = physics.nodes.filter((node) => node.degree === 0);
    const meanRadius = (items: typeof connected) =>
      items.reduce((sum, node) => sum + Math.hypot(node.x, node.y), 0) / items.length;
    expect(meanRadius(orphans)).toBeGreaterThan(meanRadius(connected) * 1.2);
    const radii = orphans.map((node) => Math.hypot(node.x, node.y));
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(5);
    const distances = edges
      .filter((edge) => edge.weight === 1)
      .map((edge) => {
        const a = physics.nodes[Number(edge.source)]!;
        const b = physics.nodes[Number(edge.target)]!;
        return Math.hypot(a.x - b.x, a.y - b.y);
      });
    expect(distances.reduce((a, b) => a + b, 0) / distances.length).toBeLessThan(
      meanRadius(orphans)
    );
    expect(physics.positions().every(Number.isFinite)).toBe(true);
    expect(nodes[0]).toEqual({ id: "0", x: 0, y: 0 });
    expect(edges[0]?.source).toBe("0");
  });

  it("pins the dragged node, propagates motion beyond immediate neighbors, and cools after release", () => {
    const nodes = [0, 1, 2, 3].map((i) => ({ id: String(i), x: i * 55, y: 0 }));
    const edges = [0, 1, 2].map((i) => ({ source: String(i), target: String(i + 1), weight: 1 }));
    const physics = createGraphPhysics(nodes, edges, defaultGraphForceSettings, true);
    settle(physics);
    const before = { ...physics.nodes[2]! };
    physics.drag("0", -180, 160, false);
    for (let i = 0; i < 45; i += 1) physics.tick();
    expect(physics.nodes[0]).toMatchObject({ x: -180, y: 160 });
    expect(
      Math.hypot(physics.nodes[2]!.x - before.x, physics.nodes[2]!.y - before.y)
    ).toBeGreaterThan(5);
    physics.drag("0", -180, 160, true);
    expect(settle(physics)).toBeGreaterThan(1);
    expect(physics.nodes[0]!.fx).toBeNull();
    expect(physics.nodes.every((node) => Math.hypot(node.vx, node.vy) < 0.08)).toBe(true);
  });

  it("preserves restored coordinates until interaction and supports independent link distance", () => {
    const { nodes, edges } = fixture();
    const physics = createGraphPhysics(nodes, edges, defaultGraphForceSettings, true);
    expect(physics.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(nodes);
    const layoutAt = (distance: number) => {
      const layout = createGraphPhysics(
        nodes,
        edges,
        { ...defaultGraphForceSettings, linkDistance: distance },
        false
      );
      settle(layout);
      return layout.nodes.reduce((sum, node) => sum + Math.hypot(node.x, node.y), 0);
    };
    expect(layoutAt(120)).toBeGreaterThan(layoutAt(25) * 1.3);
  });

  it("handles empty, singleton, orphan-only and disconnected graphs without non-finite positions", () => {
    for (const count of [0, 1, 12]) {
      const nodes = Array.from({ length: count }, (_, i) => ({ id: String(i), x: 0, y: 0 }));
      const physics = createGraphPhysics(nodes, [], defaultGraphForceSettings, false);
      settle(physics);
      expect(physics.positions().every(Number.isFinite)).toBe(true);
    }
  });

  it("reheats changed topology from the visible positions without community reseeding", () => {
    const nodes = [
      { id: "parent", x: 90, y: 40 },
      { id: "child", x: 105, y: 50 },
      { id: "neighbor", x: 145, y: 40 }
    ];
    const physics = createGraphPhysics(
      nodes,
      [
        { source: "parent", target: "child", weight: 3 },
        { source: "child", target: "neighbor", weight: 1 }
      ],
      defaultGraphForceSettings,
      true
    );
    expect(physics.nodes.map(({ id, x, y }) => ({ id, x, y }))).toEqual(nodes);
    expect(physics.simulation.alpha()).toBe(0);
    physics.reheat();
    expect(physics.simulation.alpha()).toBe(0.45);
    physics.tick();
    physics.nodes.forEach((node, index) => {
      expect(Math.hypot(node.x - nodes[index]!.x, node.y - nodes[index]!.y)).toBeLessThan(10);
    });
    expect(settle(physics)).toBeGreaterThan(1);
    expect(physics.positions().every(Number.isFinite)).toBe(true);
  });

  it("validates both worker boundaries", () => {
    expect(
      graphLayoutCommandSchema.safeParse({
        type: "configure",
        settings: { ...defaultGraphForceSettings, repulsion: -100 }
      }).success
    ).toBe(false);
    expect(
      graphLayoutEventSchema.safeParse({
        type: "positions",
        positions: new Float32Array([NaN, 1]),
        running: false,
        sequence: 0
      }).success
    ).toBe(false);
    expect(
      graphLayoutCommandSchema.safeParse({
        type: "drag",
        id: "a",
        x: Infinity,
        y: 0,
        release: false,
        sequence: 1
      }).success
    ).toBe(false);
  });
});

describe("topic groups in the layout (Map › Grafo, D19)", () => {
  /** Two topics: a large one made of two dense clusters joined by one line, and a small one. */
  function groupedFixture() {
    const nodes = [
      ...Array.from({ length: 30 }, (_, index) => ({
        id: `big-${index}`,
        x: 0,
        y: 0,
        group: "big"
      })),
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `small-${index}`,
        x: 0,
        y: 0,
        group: "small"
      }))
    ];
    const edges: GraphLayoutEdge[] = [];
    for (const offset of [0, 15])
      for (let i = 0; i < 15; i += 1)
        for (let j = i + 1; j < 15; j += 3)
          edges.push({ source: `big-${offset + i}`, target: `big-${offset + j}`, weight: 1 });
    edges.push({ source: "big-0", target: "big-15", weight: 1 });
    for (let i = 0; i < 5; i += 1)
      edges.push({ source: `small-${i}`, target: `small-${i + 1}`, weight: 1 });
    edges.push({ source: "big-3", target: "small-0", weight: 1 });
    return { nodes, edges };
  }

  it("keeps each topic one community, and splits only a large topic by Louvain inside it", () => {
    const { nodes, edges } = groupedFixture();
    const communities = layoutCommunities(nodes, edges);
    const of = (prefix: string) =>
      new Set([...communities.entries()].filter(([id]) => id.startsWith(prefix)).map(([, c]) => c));
    expect(of("small-")).toEqual(new Set(["small"]));
    const big = of("big-");
    expect(big.size).toBeGreaterThanOrEqual(2);
    for (const community of big) expect(community.startsWith("big:")).toBe(true);
    // The two dense halves of the large topic land in different communities.
    expect(communities.get("big-1")).not.toBe(communities.get("big-20"));
    // Deterministic.
    expect([...layoutCommunities(nodes, edges)]).toEqual([...communities]);
    expect(largeGroupSize).toBeGreaterThan(6);
  });

  it("holds a topic's notes together, an unconnected one included, closer than to another topic", () => {
    const { nodes, edges } = groupedFixture();
    const lonely = { id: "small-lonely", x: 0, y: 0, group: "small" };
    const physics = createGraphPhysics([...nodes, lonely], edges, defaultGraphForceSettings, false);
    settle(physics);
    const centre = (prefix: string) => {
      const members = physics.nodes.filter((node) => node.id.startsWith(prefix));
      return {
        x: members.reduce((sum, node) => sum + node.x, 0) / members.length,
        y: members.reduce((sum, node) => sum + node.y, 0) / members.length
      };
    };
    const small = centre("small-");
    const big = centre("big-");
    const node = physics.nodes.find((entry) => entry.id === "small-lonely")!;
    expect(Math.hypot(node.x - small.x, node.y - small.y)).toBeLessThan(
      Math.hypot(node.x - big.x, node.y - big.y)
    );
    expect(physics.positions().every(Number.isFinite)).toBe(true);
  });

  it("carries a node's group through the worker's init command", () => {
    // The layout parses each command before posting it: a group the schema stripped would never
    // reach the worker, and the notes would no longer gather by topic.
    const command = graphLayoutCommandSchema.parse({
      type: "init",
      nodes: [{ id: "a", x: 0, y: 0, group: "topic" }],
      edges: [],
      settings: defaultGraphForceSettings,
      restored: false
    });
    expect(command.type === "init" ? command.nodes[0]?.group : undefined).toBe("topic");
  });
});
