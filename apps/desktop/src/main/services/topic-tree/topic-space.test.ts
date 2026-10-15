import type { TopicTreeRecord } from "@app/db";
import { describe, expect, it } from "vitest";

import { compareTreeSpace, sameSpace, treeSpace } from "./topic-space.js";
import type { TopicEmbeddingSpace } from "./topic-space.js";

const tree = {
  id: "00000000-0000-4000-8000-000000000001",
  status: "active",
  spaceKey: "space-a",
  embeddingProvider: "local",
  embeddingModel: "qwen3-embedding-0.6b",
  embeddingRuntime: "gguf",
  dimensions: 1024
} as TopicTreeRecord;

const routeA: TopicEmbeddingSpace = {
  spaceKey: "space-a",
  provider: "local",
  model: "qwen3-embedding-0.6b",
  runtime: "gguf",
  dimensions: 1024
};

describe("the tree's embedding space (D26)", () => {
  it("is ready when the route resolves to the tree's space", () => {
    expect(compareTreeSpace(tree, { kind: "ready", space: routeA })).toEqual({
      kind: "ready",
      space: treeSpace(tree)
    });
  });

  it("reports space_changed, with both spaces, when the route moved", () => {
    const routeB = { ...routeA, spaceKey: "space-b", runtime: "mlx" };
    expect(compareTreeSpace(tree, { kind: "ready", space: routeB })).toEqual({
      kind: "space_changed",
      tree: treeSpace(tree),
      active: routeB
    });
    // The same key in another dimension is another space; spaces are never compared by name.
    expect(sameSpace(routeA, { ...routeA, dimensions: 768 })).toBe(false);
  });

  it("keeps an existing tree in its own space while the route cannot be resolved", () => {
    expect(compareTreeSpace(tree, { kind: "blocked", reason: "no_embedding_route" })).toEqual({
      kind: "ready",
      space: treeSpace(tree)
    });
  });
});
