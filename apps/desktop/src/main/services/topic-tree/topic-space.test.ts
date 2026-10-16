import type { PgPool, TopicTreeRecord } from "@app/db";
import { describe, expect, it, vi } from "vitest";

import type { ActiveEmbeddingSpace } from "../ai-service.js";
import {
  compareTreeSpace,
  coverageShare,
  createRouteSpaceResolver,
  routeSpaceOf,
  sameSpace,
  treeSpace
} from "./topic-space.js";
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
    expect(compareTreeSpace(tree, { kind: "ready", space: routeB, local: true })).toEqual({
      kind: "space_changed",
      tree: treeSpace(tree),
      route: { spaceKey: "space-b", space: routeB, local: true }
    });
    // The same key in another dimension is another space; spaces are never compared by name.
    expect(sameSpace(routeA, { ...routeA, dimensions: 768 })).toBe(false);
  });

  it("knows a route's space by its key before any note has a vector of it", () => {
    const unembedded = { kind: "unembedded", spaceKey: "space-b", local: false } as const;
    expect(compareTreeSpace(tree, unembedded)).toEqual({
      kind: "space_changed",
      tree: treeSpace(tree),
      route: { spaceKey: "space-b", space: null, local: false }
    });
    // A route back on the tree's own key needs no stored vector to be the tree's space.
    expect(compareTreeSpace(tree, { ...unembedded, spaceKey: "space-a" })).toEqual({
      kind: "ready",
      space: treeSpace(tree)
    });
    // A resolver that cannot tell where the model runs reports it as unknown, never as local.
    expect(routeSpaceOf({ kind: "ready", space: routeA })?.local).toBeNull();
  });

  it("keeps an existing tree in its own space while the route cannot be resolved", () => {
    expect(compareTreeSpace(tree, { kind: "blocked", reason: "no_embedding_route" })).toEqual({
      kind: "ready",
      space: treeSpace(tree)
    });
    expect(routeSpaceOf({ kind: "blocked", reason: "no_embedding_route" })).toBeNull();
  });

  it("covers an empty library, and otherwise the share of notes with a vector", () => {
    expect(coverageShare({ notes: 0, embedded: 0, queued: 0 })).toBe(1);
    expect(coverageShare({ notes: 200, embedded: 190, queued: 10 })).toBe(0.95);
  });
});

describe("the route's space resolver (D26)", () => {
  const route = (overrides: Partial<ActiveEmbeddingSpace> = {}): ActiveEmbeddingSpace => ({
    spaceKey: "space-b",
    profileId: "profile",
    provider: "local",
    modelId: "embedding-b",
    local: true,
    dimensions: 256,
    newestNoteSpaceKey: "space-a",
    confirmed: false,
    ...overrides
  });
  /** A pool whose note-vector identity read answers `rows` (one per call, then the last). */
  function pool(...answers: unknown[][]) {
    const query = vi.fn(async () => ({
      rows: answers.length > 1 ? answers.shift()! : answers[0]!
    }));
    return { pool: { query } as unknown as PgPool, query };
  }

  it("resolves the route's key without a call, with the identity its stored vectors carry", async () => {
    const stored = { provider: "local-mlx", model: "embedding-b", runtime: "mlx", dimensions: 256 };
    const { pool: db, query } = pool([], [{ ...stored, strategy: "native-v2:space-b" }]);
    const ai = { activeEmbeddingSpace: vi.fn(async () => route()) };
    const resolver = createRouteSpaceResolver({ getPool: () => db, ai });
    // No note has a vector of the route's space yet: known by its key, and local.
    await expect(resolver.resolve()).resolves.toEqual({
      kind: "unembedded",
      spaceKey: "space-b",
      local: true
    });
    // The first re-embedded note gives the space its identity; it is not read again afterwards.
    const ready = {
      kind: "ready",
      local: true,
      space: { spaceKey: "space-b", ...stored }
    };
    await expect(resolver.resolve()).resolves.toEqual(ready);
    await expect(resolver.resolve()).resolves.toEqual(ready);
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]).toEqual([expect.any(String), ["native-v2:space-b"]]);
    expect(ai.activeEmbeddingSpace).toHaveBeenCalledTimes(3);
  });

  it("reports no route when none is configured or it cannot be resolved", async () => {
    const { pool: db } = pool([]);
    const none = createRouteSpaceResolver({
      getPool: () => db,
      ai: { activeEmbeddingSpace: async () => null }
    });
    await expect(none.resolve()).resolves.toEqual({
      kind: "blocked",
      reason: "no_embedding_route"
    });
    const broken = createRouteSpaceResolver({
      getPool: () => db,
      ai: {
        activeEmbeddingSpace: async () => {
          throw new Error("errors.localModels.notReady");
        }
      },
      logger: { warn: () => undefined }
    });
    await expect(broken.resolve()).resolves.toEqual({
      kind: "blocked",
      reason: "no_embedding_route"
    });
    const closed = createRouteSpaceResolver({
      getPool: () => null,
      ai: { activeEmbeddingSpace: async () => route() }
    });
    await expect(closed.resolve()).resolves.toEqual({
      kind: "blocked",
      reason: "waiting_for_embeddings"
    });
  });
});
