import { describe, expect, it, vi } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";

import {
  createTopicNamingRepository,
  topicLabelStrategyPrefix,
  topicLabelTargetType
} from "./topicNamingRepository.js";
import type { TopicLoadSpace } from "./topicTreeLoadRepository.js";
import type { Queryable } from "./types.js";

// The statements run against a real database in the topic naming sidecar test of the desktop app;
// these tests pin how rows become the repository's answers, the paging and what is written.
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space: TopicLoadSpace = {
  spaceKey: "space-a",
  provider: "local",
  model: "embed-4",
  runtime: "mlx",
  dimensions: 256
};

type Handler = (
  text: string,
  values: readonly unknown[]
) => QueryResultRow[] | { rowCount: number };

function stub(handler: Handler) {
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    calls.push({ text, values });
    const answer = handler(text, values);
    return (Array.isArray(answer)
      ? { rows: answer, rowCount: answer.length }
      : { rows: [], ...answer }) as unknown as QueryResult<QueryResultRow>;
  });
  return { db: { query } as unknown as Queryable, calls, query };
}

/** A pgvector `vector_send` payload: int16 dimensions, int16 unused, float32 big-endian values. */
function sendPayload(values: readonly number[]): Buffer {
  const buffer = Buffer.alloc(4 + values.length * 4);
  buffer.writeInt16BE(values.length, 0);
  values.forEach((value, index) => buffer.writeFloatBE(value, 4 + index * 4));
  return buffer;
}

describe("the topic naming repository", () => {
  it("reads titles, ideas and languages of notes and sources, a page of ids per statement", async () => {
    const { db, calls } = stub((text) =>
      text.includes("from atomic_notes")
        ? [{ id: id(1), title: "Nota", idea: "Ideia", language: "pt-BR" }]
        : [{ id: id(2), title: "Livro", language: "pt-BR" }]
    );
    const found = await createTopicNamingRepository(db).memberTexts([
      { kind: "note", id: id(1).toUpperCase() },
      { kind: "note", id: id(1) },
      { kind: "source", id: id(2) }
    ]);
    expect(found.get(`note:${id(1)}`)).toEqual({
      kind: "note",
      title: "Nota",
      idea: "Ideia",
      language: "pt-BR"
    });
    expect(found.get(`source:${id(2)}`)).toEqual({
      kind: "source",
      title: "Livro",
      idea: null,
      language: "pt-BR"
    });
    // Duplicate ids are asked once, lower-cased.
    expect(calls.map((call) => call.values[0])).toEqual([[id(1)], [id(2)]]);
  });

  it("pages large id lists", async () => {
    const { db, calls } = stub(() => []);
    const ids = Array.from({ length: 2_500 }, (_, index) => ({
      kind: "note" as const,
      id: id(index + 1)
    }));
    await createTopicNamingRepository(db).memberTexts(ids);
    expect(calls.map((call) => (call.values[0] as string[]).length)).toEqual([1_000, 1_000, 500]);
  });

  it("reads change-set summaries by ID", async () => {
    const { db, calls } = stub(() => [{ id: id(9), summary: { sketches: {} } }]);
    const found = await createTopicNamingRepository(db).changeSetSummaries([id(9), id(9)]);
    expect(found.get(id(9))).toEqual({ sketches: {} });
    expect(calls[0]!.values[0]).toEqual([id(9)]);
  });

  it("returns the stored rows of topics with their siblings, or an empty answer for no tree", async () => {
    const row = (n: number, parent: string | null, title: string | null) => ({
      id: id(n),
      parentId: parent,
      role: "topic",
      title,
      nameState: title === null ? "unnamed" : "named",
      nameSource: title === null ? null : "llm",
      nameLanguage: null,
      namedChangeSetId: null,
      description: null,
      aliases: ["a", 2],
      management: "ai",
      position: "3",
      retiredAt: new Date("2026-10-01T00:00:00Z"),
      redirectTo: null,
      createdChangeSetId: null
    });
    const { db } = stub((text) => {
      if (text.includes("from topic_trees")) return [{ status: "active", generation: "12" }];
      if (text.includes("parent_id = any")) {
        return [
          { id: id(1), parentId: id(10), title: "Um" },
          { id: id(2), parentId: id(10), title: null }
        ];
      }
      return [row(1, id(10), "Um"), row(2, id(10), null)];
    });
    const rows = await createTopicNamingRepository(db).topicRows(id(100), [id(1), id(2)]);
    expect(rows.status).toBe("active");
    expect(rows.generation).toBe(12);
    expect(rows.topics.get(id(1))).toMatchObject({
      title: "Um",
      aliases: ["a", "2"],
      position: 3,
      retiredAt: "2026-10-01T00:00:00.000Z"
    });
    expect(rows.siblings.get(id(10))).toEqual([
      { id: id(1), title: "Um" },
      { id: id(2), title: null }
    ]);
    const none = await createTopicNamingRepository(stub(() => []).db).topicRows(id(100), [id(1)]);
    expect(none).toEqual({ status: null, generation: 0, topics: new Map(), siblings: new Map() });
  });

  it("counts the topics that wait for a name and lists them", async () => {
    const { db } = stub((text) =>
      text.includes("count(*)") ? [{ pending: "3", llmNamed: "5" }] : [{ id: id(1) }, { id: id(2) }]
    );
    const repository = createTopicNamingRepository(db);
    await expect(repository.namingNeeds(id(100))).resolves.toEqual({ pending: 3, llmNamed: 5 });
    await expect(repository.pendingNamingTopicIds(id(100))).resolves.toEqual([id(1), id(2)]);
  });

  it("splits label sources into live titled topics and retired ones", async () => {
    const { db } = stub(() => [
      { id: id(1), title: "Um", aliases: ["Uno"], description: "Descrição", retired: false },
      { id: id(2), title: "Dois", aliases: null, description: null, retired: true },
      { id: id(3), title: null, aliases: [], description: null, retired: true }
    ]);
    await expect(createTopicNamingRepository(db).labelSources(id(100))).resolves.toEqual({
      live: [{ id: id(1), title: "Um", aliases: ["Uno"], description: "Descrição" }],
      retired: [id(2), id(3)]
    });
  });

  describe("label vectors", () => {
    it("stores a label under the tree's space, one row per topic and model", async () => {
      const { db, calls } = stub(() => []);
      await createTopicNamingRepository(db).upsertTopicLabel({
        topicId: id(1),
        space,
        contentHash: "hash",
        embedding: Array.from({ length: 256 }, () => 0.0625)
      });
      const [call] = calls;
      expect(call!.text).toContain("insert into embeddings_256");
      expect(call!.text).toContain("on conflict (target_type, target_id, model)");
      expect(call!.values.slice(0, 7)).toEqual([
        topicLabelTargetType,
        id(1),
        "local",
        "embed-4",
        "mlx",
        `${topicLabelStrategyPrefix}space-a`,
        "hash"
      ]);
      expect(String(call!.values[7]).startsWith("[0.0625,")).toBe(true);
    });

    it("refuses a vector of another size or a value that is not finite", async () => {
      const repository = createTopicNamingRepository(stub(() => []).db);
      await expect(
        repository.upsertTopicLabel({
          topicId: id(1),
          space,
          contentHash: "h",
          embedding: [1, 2, 3]
        })
      ).rejects.toThrow(/dimensions/u);
      await expect(
        repository.upsertTopicLabel({
          topicId: id(1),
          space,
          contentHash: "h",
          embedding: Array.from({ length: 256 }, (_, index) => (index === 3 ? Number.NaN : 1))
        })
      ).rejects.toThrow(/non-finite/u);
    });

    it("reads label hashes and unit vectors of the space, and skips a corrupt row", async () => {
      const small: TopicLoadSpace = { ...space, dimensions: 256 };
      const good = Array.from({ length: 256 }, (_, index) =>
        index === 0 ? 3 : index === 1 ? 4 : 0
      );
      const { db, calls } = stub((text) =>
        text.includes("vector_send")
          ? [
              { id: id(1), hash: "h1", vector: sendPayload(good) },
              { id: id(2), hash: "h2", vector: sendPayload([1, 2, 3]) },
              { id: id(3), hash: "h3", vector: sendPayload(Array(256).fill(0)) }
            ]
          : [{ id: id(1), hash: "h1" }]
      );
      const repository = createTopicNamingRepository(db);
      await expect(repository.topicLabelHashes(small, [id(1), id(1)])).resolves.toEqual(
        new Map([[id(1), "h1"]])
      );
      const labels = await repository.loadTopicLabels(small, [id(1), id(2), id(3)]);
      expect([...labels.keys()]).toEqual([id(1)]);
      const vector = labels.get(id(1))!.vector;
      expect(vector[0]).toBeCloseTo(0.6, 6);
      expect(vector[1]).toBeCloseTo(0.8, 6);
      expect(labels.get(id(1))!.textHash).toBe("h1");
      expect(
        calls.every((call) => call.values.includes(`${topicLabelStrategyPrefix}space-a`))
      ).toBe(true);
    });

    it("removes the labels of retired topics from every dimension, and nothing without any", async () => {
      const { db, calls } = stub(() => ({ rowCount: 1 }));
      const repository = createTopicNamingRepository(db);
      await expect(repository.deleteTopicLabels([id(1), id(1)])).resolves.toBe(3);
      expect(calls.map((call) => call.text.match(/embeddings_\d+/u)?.[0])).toEqual([
        "embeddings_256",
        "embeddings_768",
        "embeddings_1024"
      ]);
      calls.length = 0;
      await expect(repository.deleteTopicLabels([])).resolves.toBe(0);
      expect(calls).toHaveLength(0);
    });
  });

  it("never writes a topic table: the engine is their single writer", async () => {
    const { db, calls } = stub(() => []);
    const repository = createTopicNamingRepository(db);
    await repository.namingNeeds(id(1));
    await repository.pendingNamingTopicIds(id(1));
    await repository.labelSources(id(1));
    await repository.topicRows(id(1), [id(2)]);
    await repository.changeSetSummaries([id(3)]);
    const statements = calls.map((call) => call.text.toLowerCase());
    expect(statements.every((text) => /^\s*(select|with)/u.test(text))).toBe(true);
  });
});
