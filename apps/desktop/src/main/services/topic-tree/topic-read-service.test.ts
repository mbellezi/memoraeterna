import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import type { TopicAncestry, TopicPageRows } from "@app/db";
import type { TopicTree } from "@app/domain";

const repository = vi.hoisted(() => ({
  readTree: vi.fn(),
  readPath: vi.fn(),
  readItems: vi.fn(),
  readPage: vi.fn(),
  readShape: vi.fn(),
  readChangeSet: vi.fn(),
  readAncestry: vi.fn(),
  readStatusCounts: vi.fn()
}));
vi.mock("@app/db", () => {
  class TopicReadError extends Error {
    readonly code = "invalidCursor";
  }
  return { createTopicReadRepository: () => repository, TopicReadError };
});

const { TopicReadService } = await import("./topic-read-service.js");
const { TopicReadError } = await import("@app/db");

// The SQL runs against a real database in `topicReadRepository.test.ts`; these tests pin the boundary:
// what is validated and refused, how neighbours are lifted to the page's level, and what a status says.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const at = "2026-10-15T12:00:00.000Z";
const pool = {} as PgPool;

const nodeRow = (n: number, parentId: string | null, extra: Record<string, unknown> = {}) => ({
  id: id(n),
  parentId,
  title: `Topic ${n}`,
  nameState: "named",
  management: "ai",
  items: 10,
  directItems: 0,
  unsorted: 0,
  children: 0,
  health: "good",
  newThisWeek: 0,
  position: 0,
  updatedAt: at,
  ...extra
});

// root 1 > areas 2 and 3 > leaves 4, 5 under area 2 and leaf 6 under 3; leaf 7 is deeper (3 > 6 > 7).
const ancestry = (generation = 4): TopicAncestry => ({
  treeId: id(900),
  generation,
  rootId: id(1),
  topics: [
    { id: id(1), parentId: null, title: null, depth: 0 },
    { id: id(2), parentId: id(1), title: "Area two", depth: 1 },
    { id: id(3), parentId: id(1), title: "Area three", depth: 1 },
    { id: id(4), parentId: id(2), title: "Leaf four", depth: 2 },
    { id: id(5), parentId: id(2), title: "Leaf five", depth: 2 },
    { id: id(6), parentId: id(3), title: "Leaf six", depth: 2 },
    { id: id(7), parentId: id(6), title: "Leaf seven", depth: 3 },
    { id: id(8), parentId: id(3), title: null, depth: 2 }
  ]
});

const pageRows = (overrides: Partial<TopicPageRows> = {}): TopicPageRows => ({
  generation: 4,
  treeId: id(900),
  topic: {
    ...nodeRow(4, id(2)),
    description: null,
    aliases: [],
    nameLanguage: "en",
    coherence: 0.8
  } as TopicPageRows["topic"],
  redirectedFrom: null,
  path: [
    { id: id(1), title: null },
    { id: id(2), title: "Area two" },
    { id: id(4), title: "Leaf four" }
  ],
  counts: { notes: 5, sources: 1, subtopics: 0 },
  subtopics: [],
  centralNotes: [],
  moreNotes: 5,
  sources: [],
  relatedLeaves: [],
  relationStances: {
    supports: 0,
    contrasts: 0,
    extends: 0,
    similar_to: 0,
    depends_on: 0,
    clarifies: 0,
    mentions: 0,
    related: 0
  },
  lastChange: null,
  ...overrides
});

beforeEach(() => {
  for (const mock of Object.values(repository)) mock.mockReset();
});

describe("TopicReadService", () => {
  it("answers topics.unavailable while the database is not ready", async () => {
    const service = new TopicReadService({ getPool: () => null });
    await expect(service.tree({})).rejects.toThrow("topics.errors.unavailable");
    await expect(service.status()).rejects.toThrow("topics.errors.unavailable");
  });

  it("validates a request before the repository sees it and fills its defaults", async () => {
    const service = new TopicReadService({ getPool: () => pool });
    await expect(service.tree({ limit: 0 })).rejects.toThrow();
    await expect(service.path({ id: "root" })).rejects.toThrow();
    await expect(service.page({ id: id(1), noteLimit: 99 })).rejects.toThrow();
    await expect(service.shape({ depth: 9 })).rejects.toThrow();
    await expect(service.notes({ id: id(1), extra: true })).rejects.toThrow();
    await expect(service.changeSet({ id: "x" })).rejects.toThrow();
    expect(repository.readTree).not.toHaveBeenCalled();

    repository.readTree.mockResolvedValue(null);
    expect(await service.tree(undefined)).toBeNull();
    expect(repository.readTree).toHaveBeenCalledWith(
      { parentId: null, limit: 100, includeItems: false, itemLimit: 5 },
      expect.objectContaining({ now: expect.any(Date) })
    );
  });

  it("validates what the repository answers before the renderer sees it", async () => {
    const service = new TopicReadService({ getPool: () => pool });
    const tree: TopicTree = {
      generation: 1,
      parent: nodeRow(1, null) as TopicTree["parent"],
      nodes: [],
      items: [],
      moreItems: 0,
      unsorted: 0,
      nextCursor: null
    };
    repository.readTree.mockResolvedValue(tree);
    expect(await service.tree({})).toEqual(tree);
    repository.readTree.mockResolvedValue({ ...tree, rogue: true });
    await expect(service.tree({})).rejects.toThrow();
  });

  it("turns a malformed cursor into a stale answer the caller reloads from", async () => {
    const service = new TopicReadService({ getPool: () => pool });
    repository.readTree.mockRejectedValue(new TopicReadError("invalidCursor", "bad"));
    await expect(service.tree({ cursor: "x" })).rejects.toThrow("topics.errors.stale");
    repository.readItems.mockRejectedValue(new TopicReadError("invalidCursor", "bad"));
    await expect(service.notes({ id: id(1), cursor: "x" })).rejects.toThrow("topics.errors.stale");
    repository.readPage.mockRejectedValue(new Error("connection lost"));
    await expect(service.page({ id: id(1) })).rejects.toThrow("connection lost");
  });

  it("passes the clock to the reads that depend on it", async () => {
    const now = new Date("2026-10-15T09:00:00Z");
    const service = new TopicReadService({ getPool: () => pool, now: () => now });
    repository.readShape.mockResolvedValue(null);
    await service.shape({});
    expect(repository.readShape).toHaveBeenCalledWith(
      { rootId: null, depth: 4, nodeLimit: 2000 },
      { now }
    );
  });

  it("returns null for every missing object", async () => {
    const service = new TopicReadService({ getPool: () => pool });
    for (const mock of [
      repository.readPath,
      repository.readItems,
      repository.readPage,
      repository.readShape,
      repository.readChangeSet
    ]) {
      mock.mockResolvedValue(null);
    }
    expect(await service.path({ id: id(1) })).toBeNull();
    expect(await service.notes({ id: id(1) })).toBeNull();
    expect(await service.page({ id: id(1) })).toBeNull();
    expect(await service.shape({})).toBeNull();
    expect(await service.changeSet({ id: id(1) })).toBeNull();
  });

  describe("neighbouring topics", () => {
    it("lifts deeper neighbours to the page's level, merges them and skips the page, its path and the root pile", async () => {
      repository.readAncestry.mockResolvedValue(ancestry());
      repository.readPage.mockResolvedValue(
        pageRows({
          relatedLeaves: [
            // A sibling at the page's level.
            { topicId: id(5), relationCount: 2 },
            // Two leaves under area three count for the level-2 topics they sit in.
            { topicId: id(6), relationCount: 1 },
            { topicId: id(7), relationCount: 4 },
            { topicId: id(8), relationCount: 1 },
            // The page itself, a note directly on an ancestor and the root's own pile.
            { topicId: id(4), relationCount: 9 },
            { topicId: id(2), relationCount: 9 },
            { topicId: id(1), relationCount: 9 },
            // A topic the cache does not know (it was created after the ancestry was read).
            { topicId: id(77), relationCount: 9 }
          ]
        })
      );
      const service = new TopicReadService({ getPool: () => pool });
      const page = await service.page({ id: id(4) });
      expect(page?.relatedTopics).toEqual([
        // Leaf seven lifts to leaf six, which also has its own relations: 4 + 1.
        { id: id(6), title: "Leaf six", relationCount: 5 },
        { id: id(5), title: "Leaf five", relationCount: 2 },
        { id: id(8), title: null, relationCount: 1 }
      ]);
      expect(page?.overview).toEqual({ status: "absent", canWrite: false });
    });

    it("lifts to the level of an Area page, keeps a shallower neighbour and caps the list at eight", async () => {
      const wide = ancestry();
      for (let n = 20; n < 40; n += 1) {
        wide.topics.push({ id: id(n), parentId: id(1), title: `Area ${n}`, depth: 1 });
      }
      repository.readAncestry.mockResolvedValue(wide);
      repository.readPage.mockResolvedValue(
        pageRows({
          path: [
            { id: id(1), title: null },
            { id: id(2), title: "Area two" }
          ],
          relatedLeaves: [
            { topicId: id(7), relationCount: 3 },
            { topicId: id(3), relationCount: 2 },
            ...Array.from({ length: 20 }, (_, k) => ({ topicId: id(20 + k), relationCount: 1 }))
          ]
        })
      );
      const service = new TopicReadService({ getPool: () => pool });
      const page = await service.page({ id: id(2) });
      expect(page?.relatedTopics).toHaveLength(8);
      // Leaf seven lifts to area three: 3 + 2.
      expect(page?.relatedTopics[0]).toEqual({ id: id(3), title: "Area three", relationCount: 5 });
      expect(page?.relatedTopics.slice(1).every((topic) => topic.relationCount === 1)).toBe(true);
      // Equal counts break by title.
      expect(page?.relatedTopics.slice(1).map((topic) => topic.title)).toEqual(
        page?.relatedTopics
          .slice(1)
          .map((topic) => topic.title)
          .sort((a, b) => (a ?? "").localeCompare(b ?? ""))
      );
    });

    it("reads the ancestry once per generation and again when the tree moved on", async () => {
      repository.readAncestry.mockResolvedValue(ancestry(4));
      repository.readPage.mockResolvedValue(
        pageRows({ relatedLeaves: [{ topicId: id(5), relationCount: 1 }] })
      );
      const service = new TopicReadService({ getPool: () => pool });
      await service.page({ id: id(4) });
      await service.page({ id: id(4) });
      expect(repository.readAncestry).toHaveBeenCalledTimes(1);
      repository.readPage.mockResolvedValue(
        pageRows({ generation: 5, relatedLeaves: [{ topicId: id(5), relationCount: 1 }] })
      );
      repository.readAncestry.mockResolvedValue(ancestry(5));
      await service.page({ id: id(4) });
      expect(repository.readAncestry).toHaveBeenCalledTimes(2);
    });

    it("skips the ancestry when there is nothing to lift and uses the overview the task installed", async () => {
      repository.readPage.mockResolvedValue(pageRows());
      const overview = vi.fn(async () => ({ status: "writing" as const }));
      const service = new TopicReadService({ getPool: () => pool, overview });
      const page = await service.page({ id: id(4) });
      expect(repository.readAncestry).not.toHaveBeenCalled();
      expect(page?.relatedTopics).toEqual([]);
      expect(page?.overview).toEqual({ status: "writing" });
      expect(overview).toHaveBeenCalledWith(id(4));
    });
  });

  describe("status", () => {
    it("derives the phase and the pending count from the database alone", async () => {
      repository.readStatusCounts.mockResolvedValue({
        generation: 3,
        items: 50,
        placed: 38,
        needsGate: 2
      });
      const service = new TopicReadService({ getPool: () => pool });
      expect(await service.status()).toEqual({
        phase: "active",
        counts: { items: 50, placed: 38, pending: 12, needsGate: 2 }
      });
      repository.readStatusCounts.mockResolvedValue(null);
      expect(await service.status()).toEqual({
        phase: "building",
        counts: { items: 0, placed: 0, pending: 0, needsGate: 0 }
      });
    });

    it("adds what only the engine knows and never lets pending go negative", async () => {
      repository.readStatusCounts.mockResolvedValue({
        generation: 3,
        items: 10,
        placed: 12,
        needsGate: 0
      });
      const service = new TopicReadService({
        getPool: () => pool,
        engineStatus: async () => ({
          phase: "building",
          blocked: "space_changed",
          dailyCapReached: true,
          reembedNotes: 40
        })
      });
      expect(await service.status()).toEqual({
        phase: "building",
        blocked: "space_changed",
        counts: { items: 10, placed: 12, pending: 0, needsGate: 0 },
        dailyCapReached: true,
        reembedNotes: 40
      });
    });
  });
});
