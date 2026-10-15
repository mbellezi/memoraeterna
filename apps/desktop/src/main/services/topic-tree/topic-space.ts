// The embedding space of the topic tree (D26). The tree places items only by vectors of its own
// space; vectors of different spaces are never compared (rules/data.md). The active route's space
// comes from an injected `SpaceResolver`: the AI service computes it without a call and confirms
// it against the newest stored note vector (T14). Until that lands, the interim resolver below
// reads the newest stored note vector that names its space.
import { createTopicTreeLoadRepository } from "@app/db";
import type { PgPool, TopicLoadSpace, TopicTreeRecord } from "@app/db";
import type { TopicsBlockedReason } from "@app/domain";

export type TopicEmbeddingSpace = TopicLoadSpace;

/** Why the engine cannot place by the active route's space right now (informative, never fatal). */
export type TopicSpaceBlock = Extract<
  TopicsBlockedReason,
  "no_embedding_route" | "waiting_for_embeddings"
>;

export type SpaceResolution =
  { kind: "ready"; space: TopicEmbeddingSpace } | { kind: "blocked"; reason: TopicSpaceBlock };

/** Resolves the space of the active embedding route without calling a model. */
export interface SpaceResolver {
  resolve(): Promise<SpaceResolution>;
}

/** How the active tree relates to the active route's space. */
export type TopicSpaceState =
  | { kind: "ready"; space: TopicEmbeddingSpace }
  | { kind: "blocked"; reason: TopicSpaceBlock }
  /** The route moved to another space: PLACE of new-space items waits for the rebuild (T19b). */
  | { kind: "space_changed"; tree: TopicEmbeddingSpace; active: TopicEmbeddingSpace };

/** The space a tree was built in. */
export function treeSpace(tree: TopicTreeRecord): TopicEmbeddingSpace {
  return {
    spaceKey: tree.spaceKey,
    provider: tree.embeddingProvider,
    model: tree.embeddingModel,
    runtime: tree.embeddingRuntime,
    dimensions: tree.dimensions
  };
}

/** One space identity: the key names the model, revision, runtime and parameters (D26). */
export function sameSpace(a: TopicEmbeddingSpace, b: TopicEmbeddingSpace): boolean {
  return a.spaceKey === b.spaceKey && a.dimensions === b.dimensions;
}

/**
 * Compares the tree's space with the route's. A blocked route leaves an existing tree usable in
 * its own space: its stored vectors are still exact, and nothing new can be embedded anyway.
 */
export function compareTreeSpace(
  tree: TopicTreeRecord,
  resolution: SpaceResolution
): TopicSpaceState {
  const own = treeSpace(tree);
  if (resolution.kind === "blocked") return { kind: "ready", space: own };
  if (sameSpace(own, resolution.space)) return { kind: "ready", space: own };
  return { kind: "space_changed", tree: own, active: resolution.space };
}

/**
 * Interim resolver (until T14): the space of the newest stored note vector that names one. A
 * library whose notes have no such vector yet is waiting for embeddings; it cannot tell a missing
 * route apart without a model call, which this resolver never makes.
 */
export function createStoredVectorSpaceResolver(getPool: () => PgPool | null): SpaceResolver {
  return {
    async resolve() {
      const pool = getPool();
      if (!pool) return { kind: "blocked", reason: "waiting_for_embeddings" };
      const space = await createTopicTreeLoadRepository(pool).newestNoteVectorSpace();
      return space
        ? { kind: "ready", space }
        : { kind: "blocked", reason: "waiting_for_embeddings" };
    }
  };
}
