// The embedding space of the topic tree (D26). The tree places items only by vectors of its own
// space; vectors of different spaces are never compared (rules/data.md). The active route's space
// comes from an injected `SpaceResolver`: in the app, the AI service computes the route's space
// key without a call (T14) and the stored note vectors of that key give its identity
// (`createRouteSpaceResolver`); scripts read the newest stored note vector instead.
//
// When the route's space is not the tree's, the tree waits in its own space (`space_changed`):
// PLACE of new-space items waits, and the current notes are re-embedded into the route's space by
// the `note-embedding` jobs, automatically on a local route and through the owner's
// `topics.reembed` on a remote one (Q8). Once `space.reembedCoverage` of the current notes have a
// vector there, `topic-build` rebuilds the tree in the new space and maps it onto the old one by
// Hungarian matching, so topic IDs survive (topic-build.ts).
import {
  createJobRepository,
  createTopicTreeLoadRepository,
  createTopicTreeRepository
} from "@app/db";
import type { PgPool, TopicLoadSpace, TopicSpaceCoverage, TopicTreeRecord } from "@app/db";
import type { TopicReembedResult, TopicsBlockedReason } from "@app/domain";

import type { AiService } from "../ai-service.js";
import type { TopicAiMode } from "./topic-ai.js";

export type TopicEmbeddingSpace = TopicLoadSpace;

/** Why the engine cannot place by the active route's space right now (informative, never fatal). */
export type TopicSpaceBlock = Extract<
  TopicsBlockedReason,
  "no_embedding_route" | "waiting_for_embeddings"
>;

export type SpaceResolution =
  /** `local`: the route's model runs on this machine; absent when the resolver cannot tell. */
  | { kind: "ready"; space: TopicEmbeddingSpace; local?: boolean }
  | { kind: "blocked"; reason: TopicSpaceBlock }
  /** The route's space is known by its key only: no note has a vector of it yet. */
  | { kind: "unembedded"; spaceKey: string; local: boolean };

/** Resolves the space of the active embedding route without calling a model. */
export interface SpaceResolver {
  resolve(): Promise<SpaceResolution>;
}

/** The route's space as far as it is known (D26). */
export interface RouteSpace {
  spaceKey: string;
  /** Its stored identity (model, runtime, dimensions) once a note has a vector of it. */
  space: TopicEmbeddingSpace | null;
  /** A re-embedding costs nothing on this machine (Q8); null when the resolver cannot tell. */
  local: boolean | null;
}

/** How the active tree relates to the active route's space. */
export type TopicSpaceState =
  | { kind: "ready"; space: TopicEmbeddingSpace }
  | { kind: "blocked"; reason: TopicSpaceBlock }
  /** The route moved to another space: PLACE of new-space items waits for the rebuild. */
  | { kind: "space_changed"; tree: TopicEmbeddingSpace; route: RouteSpace };

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

/** The route's space of a resolution; null while the route cannot be resolved. */
export function routeSpaceOf(resolution: SpaceResolution): RouteSpace | null {
  switch (resolution.kind) {
    case "blocked":
      return null;
    case "ready":
      return {
        spaceKey: resolution.space.spaceKey,
        space: resolution.space,
        local: resolution.local ?? null
      };
    case "unembedded":
      return { spaceKey: resolution.spaceKey, space: null, local: resolution.local };
  }
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
  const route = routeSpaceOf(resolution);
  if (!route) return { kind: "ready", space: own };
  const same = route.space ? sameSpace(own, route.space) : route.spaceKey === own.spaceKey;
  return same ? { kind: "ready", space: own } : { kind: "space_changed", tree: own, route };
}

/**
 * Script resolver: the space of the newest stored note vector that names one. A library whose
 * notes have no such vector yet is waiting for embeddings; it cannot tell a missing route apart
 * without a model call, which this resolver never makes.
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

/** What the route resolver needs of the AI service. */
export type SpaceAi = Pick<AiService, "activeEmbeddingSpace">;

/**
 * The app's resolver (D26): the routed embedding model's space key, computed without a call, with
 * the identity its stored note vectors carry. A key with no stored note vector yet is
 * `unembedded`; a route that cannot be resolved is `no_embedding_route`.
 */
export function createRouteSpaceResolver(options: {
  getPool: () => PgPool | null;
  ai: SpaceAi;
  logger?: Pick<Console, "warn">;
}): SpaceResolver {
  // A space key always names the same identity: once found, it is not read again.
  const known = new Map<string, TopicEmbeddingSpace>();
  return {
    async resolve() {
      const pool = options.getPool();
      if (!pool) return { kind: "blocked", reason: "waiting_for_embeddings" };
      let route;
      try {
        route = await options.ai.activeEmbeddingSpace();
      } catch (error) {
        options.logger?.warn("The embedding route's space could not be resolved", error);
        return { kind: "blocked", reason: "no_embedding_route" };
      }
      if (!route) return { kind: "blocked", reason: "no_embedding_route" };
      let space = known.get(route.spaceKey) ?? null;
      if (!space) {
        space = await createTopicTreeLoadRepository(pool).noteVectorSpace(route.spaceKey);
        if (space) known.set(route.spaceKey, space);
      }
      return space
        ? { kind: "ready", space, local: route.local }
        : { kind: "unembedded", spaceKey: route.spaceKey, local: route.local };
    }
  };
}

/** The share of current notes with a vector of the space; an empty library is covered. */
export function coverageShare(coverage: TopicSpaceCoverage): number {
  return coverage.notes === 0 ? 1 : coverage.embedded / coverage.notes;
}

/** Bounds of the re-embedding requests (engine parameters live in the tree's configuration). */
export const topicSpaceLimits = {
  /** Notes queued per statement. */
  reembedPage: 1_000
} as const;

export interface TopicSpaceChangeOptions {
  getPool: () => PgPool | null;
  spaceResolver: SpaceResolver;
  aiMode: TopicAiMode;
  logger?: Pick<Console, "info" | "warn" | "error">;
  now?: () => Date;
}

/**
 * The re-embedding side of a space change: coverage of the route's space, the `note-embedding`
 * jobs that fill it, the automatic request of a local route and the owner's `topics.reembed`.
 */
export class TopicSpaceChange {
  /** Spaces this process re-embedded on its own: once each, so a drift can never loop. */
  private readonly automatic = new Set<string>();
  /** When this process sent the first note into a space no note had a vector of. */
  private readonly probedAt = new Map<string, Date>();

  public constructor(private readonly options: TopicSpaceChangeOptions) {}

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** The active tree and the route's space, when the route's space is not the tree's. */
  public async changed(): Promise<{ treeId: string; route: RouteSpace } | null> {
    const pool = this.requirePool();
    const tree = await createTopicTreeRepository(pool).activeTree();
    if (!tree) return null;
    const state = compareTreeSpace(tree, await this.options.spaceResolver.resolve());
    return state.kind === "space_changed" ? { treeId: tree.id, route: state.route } : null;
  }

  public coverage(spaceKey: string): Promise<TopicSpaceCoverage> {
    return createTopicTreeLoadRepository(this.requirePool()).spaceCoverage(spaceKey);
  }

  /**
   * Queues a `note-embedding` job naming the space for every current note without a vector of it
   * (a note whose job already waits is skipped), or for the first `limit` of them. Returns the
   * jobs queued.
   */
  public async queue(spaceKey: string, limit = Number.POSITIVE_INFINITY): Promise<number> {
    const pool = this.requirePool();
    const loader = createTopicTreeLoadRepository(pool);
    const jobs = createJobRepository(pool);
    let queued = 0;
    let seen = 0;
    let after: string | null = null;
    do {
      const page = await loader.notesWithoutSpaceVector(spaceKey, {
        after,
        limit: Math.min(topicSpaceLimits.reembedPage, limit - seen)
      });
      seen += page.notes.length;
      queued += await jobs.enqueueNoteEmbeddings(
        page.notes.map((note) => ({ atomicNoteId: note.id, sourceItemId: note.sourceItemId })),
        { spaceKey }
      );
      after = seen < limit ? page.next : null;
    } while (after !== null);
    return queued;
  }

  /**
   * While the tree waits in its old space, a local route re-embeds the library by itself (Q8); a
   * remote route waits for the owner (null), and so does a run without topic AI (G1). Until a note
   * has a vector of the route's space, one note goes first: the library follows only once that
   * vector landed in the space the route was resolved to, so a space key computed without a call
   * that disagreed with the calls could never re-embed the library in vain (it is logged instead).
   * The library is queued once per space and process. Returns the jobs queued.
   */
  public async reembedAutomatically(
    route: RouteSpace,
    coverage: TopicSpaceCoverage
  ): Promise<number | null> {
    if (route.local !== true || this.options.aiMode !== "full") return null;
    const key = route.spaceKey;
    if (this.automatic.has(key)) return 0;
    if (coverage.embedded === 0) {
      const since = this.probedAt.get(key);
      if (!since) {
        this.probedAt.set(key, this.now());
        return this.queue(key, 1);
      }
      const jobs = createJobRepository(this.requirePool());
      // The first note is still on its way: nothing more until its vector lands.
      if ((await jobs.countSpaceEmbeddings(key, since)) === 0) return 0;
      this.automatic.add(key);
      this.options.logger?.error(
        `Re-embedded notes did not land in the embedding space ${key}; the library is not re-embedded`
      );
      return 0;
    }
    this.automatic.add(key);
    let queued: number;
    try {
      queued = await this.queue(key);
    } catch (error) {
      this.automatic.delete(key);
      throw error;
    }
    this.options.logger?.info(
      `Embedding space changed to ${key}: ${queued} notes queued for re-embedding`
    );
    return queued;
  }

  /** `topics.reembed`: the owner re-embeds the library into the route's space (D26, Q8). */
  public async reembed(): Promise<TopicReembedResult> {
    const changed = await this.changed();
    if (!changed) return { queued: 0 };
    return { queued: await this.queue(changed.route.spaceKey) };
  }

  /**
   * For `topics.status`: on a remote route, the notes a re-embedding would cover that no job
   * covers yet; null when the owner has nothing to do (no change, or a local route).
   */
  public async reembedNotes(route: RouteSpace | null | undefined): Promise<number | null> {
    if (!route || route.local === true) return null;
    const coverage = await this.coverage(route.spaceKey);
    return Math.max(0, coverage.notes - coverage.embedded - coverage.queued);
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}
