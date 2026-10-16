// The topic service's in-memory copy of the active tree, valid for one tree generation: the engine
// state rebuilt from the stored records, the current vectors of its items in the tree's space and
// statistics recomputed exactly from them (D7). Engine runs mutate it and the repository then
// commits the same events; any doubt (a failed commit, a generation another writer moved, a
// cascade that removed items) drops it, and the next run loads it again.
import { createHash } from "node:crypto";

import {
  TopicSkeletonUnstableError,
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  stateFromRecords
} from "@app/db";
import type {
  PgPool,
  TopicItemData,
  TopicItemInfo,
  TopicItemSource,
  TopicItemVectors,
  TopicTreeRecord,
  TopicTreeRecords
} from "@app/db";
import {
  TopicTreeConfigSchema,
  defaultTopicTreeConfig,
  isLive,
  itemKey,
  notesByRootSource,
  parseItemKey,
  placementRecordFields,
  primaryPlacement,
  recomputeSubtree,
  rootSourceVectorFromState,
  topicRecordOf
} from "@app/domain/topic-tree";
import type {
  EmbeddingMatrix,
  ItemKey,
  ItemVectorSource,
  PlacementRecord,
  RootVector,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

import { attachTopicLabels } from "./topic-labels.js";
import { treeSpace } from "./topic-space.js";
import type { TopicEmbeddingSpace } from "./topic-space.js";

/**
 * Item vectors that grow as items arrive: notes keep their stored vector, a root source the D8
 * vector it is placed by. Rows are unit Float32 vectors in the tree's dimension; the matrix object
 * stays the same while its buffer grows, so engine calls always read the current rows.
 */
export class ItemVectorStore implements ItemVectorSource {
  private readonly rows = new Map<string, number>();
  private readonly free: number[] = [];
  private readonly shape: { dim: number; count: number; data: Float32Array };

  public constructor(
    public readonly dim: number,
    capacity = 64
  ) {
    this.shape = { dim, count: 0, data: new Float32Array(Math.max(1, capacity) * dim) };
  }

  public get matrix(): EmbeddingMatrix {
    return this.shape;
  }

  public get size(): number {
    return this.rows.size;
  }

  public rowOf(item: string): number | undefined {
    return this.rows.get(item);
  }

  public get(item: string): Float32Array | undefined {
    const row = this.rows.get(item);
    return row === undefined
      ? undefined
      : this.shape.data.subarray(row * this.dim, (row + 1) * this.dim);
  }

  /** True when the item has exactly this vector (bit for bit). */
  public holds(item: string, vector: ArrayLike<number>): boolean {
    const current = this.get(item);
    if (!current || current.length !== vector.length) return false;
    for (let k = 0; k < current.length; k += 1) {
      if (!Object.is(current[k], Math.fround(vector[k] as number))) return false;
    }
    return true;
  }

  public set(item: string, vector: ArrayLike<number>): void {
    if (vector.length !== this.dim) {
      throw new RangeError(`Vector has ${vector.length} dimensions, expected ${this.dim}`);
    }
    let row = this.rows.get(item);
    if (row === undefined) {
      row = this.free.pop() ?? this.shape.count;
      if (row === this.shape.count) this.grow(row + 1);
      this.rows.set(item, row);
    }
    this.shape.data.set(vector, row * this.dim);
  }

  public delete(item: string): void {
    const row = this.rows.get(item);
    if (row === undefined) return;
    this.rows.delete(item);
    this.shape.data.fill(0, row * this.dim, (row + 1) * this.dim);
    this.free.push(row);
  }

  private grow(count: number): void {
    if (count * this.dim > this.shape.data.length) {
      const next = new Float32Array(Math.max(count, this.shape.count * 2) * this.dim);
      next.set(this.shape.data.subarray(0, this.shape.count * this.dim));
      this.shape.data = next;
    }
    this.shape.count = count;
  }
}

/** The fingerprint a root source's placement records: the basis and the vector's bytes (D8). */
export function rootVectorFingerprint(vector: RootVector): string | null {
  if (!vector.vector) return null;
  const bytes = Buffer.from(
    vector.vector.buffer,
    vector.vector.byteOffset,
    vector.vector.byteLength
  );
  return `${vector.basis}:${createHash("sha256").update(bytes).digest("hex").slice(0, 40)}`;
}

export interface TopicTreeCache {
  tree: TopicTreeRecord;
  config: TopicTreeConfig;
  space: TopicEmbeddingSpace;
  state: TopicTreeState;
  vectors: ItemVectorStore;
  /** The D8 vector each placed root source was last decided with, while this process knows it. */
  placedRootVectors: Map<ItemKey, Float32Array>;
  /** Live topics whose stored statistics are flagged dirty or differ from the exact ones. */
  staleStoredStats: string[];
}

/** The configuration a tree was created with; a stored one the schema no longer reads is replaced. */
export function treeConfig(tree: TopicTreeRecord, logger?: Pick<Console, "warn">): TopicTreeConfig {
  const parsed = TopicTreeConfigSchema.safeParse(tree.config);
  if (parsed.success) return parsed.data;
  logger?.warn(
    `Topic tree ${tree.id} has a configuration this version cannot read; using defaults`
  );
  return defaultTopicTreeConfig;
}

/** Notes keyed by item key: content hash of the stored vector (or "" without one) and vector rows. */
export function noteEntries(
  vectors: TopicItemVectors,
  owners: ReadonlyMap<string, { rootSourceId: string | null }>
): Map<ItemKey, { info: TopicItemInfo; vector: Float32Array | null }> {
  const output = new Map<ItemKey, { info: TopicItemInfo; vector: Float32Array | null }>();
  const rowOf = new Map(vectors.keys.map((key, row) => [key, row]));
  const add = (key: ItemKey) => {
    const parsed = parseItemKey(key);
    if (!parsed || output.has(key)) return;
    const row = rowOf.get(key);
    const root = owners.get(parsed.id)?.rootSourceId ?? null;
    output.set(key, {
      info: {
        kind: "note",
        contentHash: row === undefined ? "" : (vectors.contentHashes[row] as string),
        rootSource: root ? itemKey("source", root) : null
      },
      vector:
        row === undefined
          ? null
          : vectors.matrix.data.slice(row * vectors.dim, (row + 1) * vectors.dim)
    });
  };
  for (const key of vectors.keys) add(key);
  for (const key of [...vectors.missing, ...vectors.stale]) add(key);
  return output;
}

function placementOf(source: PlacementRecord): PlacementRecord {
  const record = {} as Record<string, unknown>;
  for (const field of placementRecordFields) record[field] = source[field];
  return record as unknown as PlacementRecord;
}

function sameBits(a: Float64Array, b: Float64Array): boolean {
  if (a.length !== b.length) return false;
  const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  return Buffer.compare(left, right) === 0;
}

/**
 * Loads the cache of one tree: the skeleton (one generation), the owners and vectors of every
 * placed item, the D8 vectors of placed roots and exact statistics. Null when the tree is gone.
 * `inSpace` loads the same structure with the vectors of another embedding space (the rebuild of
 * a space change, D26): the cache's tree then carries that space.
 */
export async function loadTopicTreeCache(
  pool: PgPool,
  treeId: string,
  logger?: Pick<Console, "warn">,
  inSpace?: TopicEmbeddingSpace
): Promise<TopicTreeCache | null> {
  const repository = createTopicTreeRepository(pool);
  const loader = createTopicTreeLoadRepository(pool);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const record = await repository.tree(treeId);
    if (!record) return null;
    const skeleton = await loader.loadSkeleton(treeId);
    if (!skeleton) return null;
    if (skeleton.tree.generation !== record.generation) continue;
    const tree: TopicTreeRecord = inSpace
      ? {
          ...record,
          spaceKey: inSpace.spaceKey,
          embeddingProvider: inSpace.provider,
          embeddingModel: inSpace.model,
          embeddingRuntime: inSpace.runtime,
          dimensions: inSpace.dimensions
        }
      : record;
    const config = treeConfig(tree, logger);
    const space = treeSpace(tree);
    const records: TopicTreeRecords = {
      tree,
      topics: skeleton.topics.map((topic) => topicRecordOf(topic)),
      placements: skeleton.placements.map((placement) => ({
        item: placement.key,
        placement: placementOf(placement)
      }))
    };
    const keys = [...new Set(records.placements.map((entry) => entry.item))];
    const parsed = keys.map((key) => parseItemKey(key)).filter((key) => key !== null);
    const noteIds = parsed.filter((key) => key.kind === "note").map((key) => key.id);
    const sourceIds = parsed.filter((key) => key.kind === "source").map((key) => key.id);
    const [owners, noteVectors, composites] = await Promise.all([
      loader.itemOwners({ noteIds, sourceIds }),
      loader.loadItemVectors(
        space,
        noteIds.map((id) => ({ kind: "note" as const, id }))
      ),
      loader.loadItemVectors(
        space,
        sourceIds.map((id) => ({ kind: "source" as const, id }))
      )
    ]);
    const notes = noteEntries(noteVectors, owners.notes);
    const entries = new Map<ItemKey, TopicItemInfo>();
    for (const [key, note] of notes) entries.set(key, note.info);
    for (const id of sourceIds) {
      entries.set(itemKey("source", id), {
        kind: "source",
        contentHash: owners.sources.get(id)?.contentHash ?? "",
        rootSource: null
      });
    }
    const vectors = new ItemVectorStore(space.dimensions, keys.length + 16);
    const state = stateFromRecords(records, { entries, vectors });
    for (const [key, note] of notes) if (note.vector) vectors.set(key, note.vector);
    const compositeRows = new Map(composites.keys.map((key, row) => [key, row]));
    const byRoot = notesByRootSource(state);
    const placedRootVectors = new Map<ItemKey, Float32Array>();
    for (const id of sourceIds) {
      const key = itemKey("source", id);
      const row = compositeRows.get(key);
      const composite =
        row === undefined
          ? null
          : composites.matrix.data.slice(row * composites.dim, (row + 1) * composites.dim);
      const vector = rootSourceVectorFromState(
        state,
        vectors,
        key,
        composite,
        config,
        byRoot.get(key) ?? []
      );
      if (vector.vector) vectors.set(key, vector.vector);
      const primary = primaryPlacement(state, key);
      if (vector.vector && primary && primary.itemFingerprint === rootVectorFingerprint(vector)) {
        placedRootVectors.set(key, vector.vector.slice());
      }
    }
    recomputeSubtree(state, vectors);
    // Label vectors (T18) are optional bookkeeping for label mixing; a failed read keeps none.
    await attachTopicLabels(pool, space, state, logger);
    const stored = new Map(skeleton.topics.map((topic) => [topic.id, topic.stats]));
    const staleStoredStats: string[] = [];
    for (const node of state.topics.values()) {
      if (!isLive(node)) continue;
      const stats = stored.get(node.id) ?? null;
      node.control.repairClock = stats?.repairClock ?? null;
      if (
        !stats ||
        stats.dirty ||
        stats.n !== node.stats.n ||
        !Object.is(stats.cosSqSum, node.stats.cosSqSum) ||
        !sameBits(stats.ls, node.stats.ls)
      ) {
        staleStoredStats.push(node.id);
      }
    }
    return {
      tree,
      config,
      space,
      state,
      vectors,
      placedRootVectors,
      staleStoredStats: staleStoredStats.sort()
    };
  }
  throw new TopicSkeletonUnstableError(`Topic tree ${treeId} kept changing while it was loaded.`);
}

/** The item data an exact recompute in the repository reads (D7): the cache's own items. */
export function cacheItemSource(cache: TopicTreeCache): TopicItemSource {
  return {
    async load(keys: readonly ItemKey[]): Promise<TopicItemData> {
      const entries = new Map<ItemKey, TopicItemInfo>();
      for (const key of keys) {
        const entry = cache.state.items.get(key);
        if (entry) {
          entries.set(key, {
            kind: entry.kind,
            contentHash: entry.contentHash,
            rootSource: entry.rootSource
          });
        }
      }
      return { entries, vectors: cache.vectors };
    }
  };
}
