import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TopicItemVectors, TopicLoadSpace, TopicSkeleton } from "@app/db";
import { defaultTopicTreeConfig } from "@app/domain/topic-tree";

import { loadReplayDataset } from "./datasets.js";
import { exportUsage, parseExportArgs } from "./export.js";
import { readReplayStore, replayStorePaths } from "./export-vectors.js";
import {
  exportTopicTree,
  primaryLanguage,
  type ExportNote,
  type TopicExportSource
} from "./export-tree.js";

const dim = 256;
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const space: TopicLoadSpace = {
  spaceKey: "test-space",
  provider: "test",
  model: "test-embed",
  runtime: "gguf",
  dimensions: dim
};
const treeId = uuid(1);
const [rootId, topicA, topicB] = [uuid(10), uuid(11), uuid(12)];
const notes: ExportNote[] = [
  note(101, "Spaced repetition", "pt-BR", 21, "Memory book"),
  note(102, "Forgetting curve", "pt-BR", 21, "Memory book"),
  note(103, "Sourdough starter", "en", 22, "Baking"),
  // No vector yet, and no placement.
  note(104, "Unembedded", "en", 22, "Baking")
];
const roots = [
  { id: uuid(21), title: "Memory book", type: "Book", createdAt: "2026-10-01T10:00:00.000Z" },
  { id: uuid(22), title: "Baking", type: "WebArticle", createdAt: "2026-10-02T10:00:00.000Z" }
];

function note(n: number, title: string, language: string, rootN: number, rootTitle: string) {
  return {
    id: uuid(n),
    title,
    language,
    createdAt: `2026-10-0${n - 100}T12:00:00.000Z`,
    rootSourceId: uuid(rootN),
    rootTitle
  } satisfies ExportNote;
}

function unitVector(seed: number): Float32Array {
  const data = new Float32Array(dim);
  let sum = 0;
  for (let k = 0; k < dim; k += 1) {
    data[k] = Math.sin(seed * 12.9898 + k * 78.233);
    sum += (data[k] as number) ** 2;
  }
  for (let k = 0; k < dim; k += 1) data[k] = (data[k] as number) / Math.sqrt(sum);
  return data;
}

function topic(id: string, parentId: string | null, title: string | null, position: number) {
  return {
    id,
    parentId,
    role: parentId === null ? ("root" as const) : ("topic" as const),
    title,
    nameState: title === null ? ("unnamed" as const) : ("named" as const),
    nameSource: title === null ? null : ("llm" as const),
    nameLanguage: title === null ? null : "pt-BR",
    namedChangeSetId: null,
    description: null,
    aliases: [],
    management: "ai" as const,
    position,
    retiredAt: null,
    redirectTo: null,
    createdChangeSetId: null,
    stats: {
      spaceKey: space.spaceKey,
      n: 2,
      ls: new Float64Array(dim),
      cosSqSum: 1.8,
      lowCosPercentiles: new Float32Array(11),
      coherence: 0.9,
      directItems: 2,
      children: parentId === null ? 2 : 0,
      health: "good" as const,
      violations: [],
      dirty: false,
      lastRepairAt: null,
      repairClock: 0,
      computedAt: "2026-10-05T00:00:00.000Z"
    }
  };
}

function placement(n: number, item: string, topicId: string, kind: "note" | "source" = "note") {
  return {
    id: uuid(500 + n),
    itemKind: kind,
    itemId: item,
    key: `${kind}:${item}`,
    topicId,
    rank: 0,
    management: "ai" as const,
    decidedBy: "build" as const,
    itemFingerprint: `hash-${item.slice(-3)}`,
    score: 0.9,
    margin: 0.2,
    centrality: 0.8,
    needsGate: false,
    needsSplitCheck: false,
    needsVector: false,
    movedFromTopicId: null,
    movedAt: null,
    changeSetId: uuid(900)
  };
}

const skeleton: TopicSkeleton = {
  tree: {
    id: treeId,
    status: "active",
    space,
    config: defaultTopicTreeConfig,
    configHash: "config-hash",
    seed: 7,
    generation: 3,
    createdAt: "2026-10-05T00:00:00.000Z",
    activatedAt: "2026-10-05T00:00:01.000Z",
    retiredAt: null
  },
  topics: [
    topic(rootId, null, null, 0),
    topic(topicA, rootId, "Memory", 0),
    topic(topicB, rootId, "Baking", 1)
  ],
  placements: [
    placement(1, notes[0]!.id, topicA),
    placement(2, notes[1]!.id, topicA),
    placement(3, notes[2]!.id, topicB)
  ]
};

function fakeSource(overrides: Partial<TopicExportSource> = {}): TopicExportSource {
  return {
    loadSkeleton: async () => skeleton,
    listNotes: async () => notes,
    rootSources: async () => roots,
    loadNoteVectors: async (_space, ids) => {
      const present = ids.filter((id) => id !== notes[3]!.id);
      const data = new Float32Array(present.length * dim);
      present.forEach((id, row) => data.set(unitVector(Number(id.slice(-3))), row * dim));
      const loaded: TopicItemVectors = {
        dim,
        keys: present.map((id) => `note:${id}`),
        contentHashes: present.map((id) => `content-${id.slice(-3)}`),
        matrix: { dim, count: present.length, data },
        missing: ids.filter((id) => !present.includes(id)).map((id) => `note:${id}`),
        stale: []
      };
      return loaded;
    },
    gateDecisions: async () => [
      {
        id: uuid(700),
        itemKind: "note",
        itemId: notes[2]!.id,
        itemHash: "item-hash",
        descriptorSetHash: "set-hash",
        deciderKey: "ranker",
        candidates: [{ topicId: topicB, logOdds: 3.2 }],
        chosenTopicId: topicB,
        noneOfThese: false,
        createdAt: "2026-10-05T01:00:00.000Z"
      }
    ],
    changeSets: async () => ({
      total: 3,
      byOrigin: { build: 1, place: 2 },
      byStatus: { applied: 3 },
      items: [
        {
          id: uuid(900),
          origin: "build",
          status: "applied",
          risk: "low",
          titleKey: "topics.changeSet.build",
          undoOf: null,
          generation: 1,
          createdAt: "2026-10-05T00:00:00.000Z",
          appliedAt: "2026-10-05T00:00:00.500Z",
          undoneAt: null,
          summary: { topics: 3 }
        }
      ]
    }),
    dailyMetrics: async () => [],
    ...overrides
  };
}

let cache: string;
beforeEach(async () => {
  cache = await mkdtemp(join(tmpdir(), "memora-topic-export-"));
});
afterEach(async () => {
  await rm(cache, { recursive: true, force: true });
});

const fixedNow = () => new Date("2026-10-15T12:00:00.000Z");
const run = (source: TopicExportSource, name = "env-f", extra = {}) =>
  exportTopicTree(source, { name, cacheDirectory: cache, now: fixedNow, ...extra });

describe("topics:export", () => {
  it("writes the tree, placements, gate log, change-sets and audit", async () => {
    const result = await run(fakeSource(), "env-f", {
      label: "ENV-F",
      database: { host: "127.0.0.1", port: 5432, name: "memora_app" }
    });
    expect(result.exportPath).toBe(join(cache, "topics", "exports", "env-f", "export.json"));
    expect(result.summary).toMatchObject({
      treeId,
      generation: 3,
      topics: 3,
      liveTopics: 3,
      placements: 3,
      notes: 4,
      vectorRows: 3,
      notesWithoutVector: 1,
      gateDecisions: 1,
      changeSets: 3
    });
    const document = JSON.parse(await readFile(result.exportPath, "utf8"));
    expect(document).toMatchObject({
      format: "memora-topic-export",
      version: 1,
      name: "env-f",
      label: "ENV-F",
      createdAt: "2026-10-15T12:00:00.000Z",
      database: { host: "127.0.0.1", port: 5432, name: "memora_app" },
      tree: { id: treeId, configHash: "config-hash", generation: 3, space },
      library: { notes: 4, rootSources: 2 }
    });
    expect(document.topics.map((entry: { title: string | null }) => entry.title)).toEqual([
      null,
      "Memory",
      "Baking"
    ]);
    expect(document.topics[1].stats).toMatchObject({ n: 2, coherence: 0.9, health: "good" });
    expect(document.roots.map((root: { notes: number }) => root.notes)).toEqual([2, 2]);
    expect(document.placements).toHaveLength(3);
    expect(document.placements[0]).toMatchObject({
      item: `note:${notes[0]!.id}`,
      topicId: topicA,
      decidedBy: "build",
      fingerprint: expect.stringMatching(/^hash-/u)
    });
    expect(document.gateDecisions[0]).toMatchObject({
      chosenTopicId: topicB,
      deciderKey: "ranker"
    });
    expect(document.changeSets).toMatchObject({ total: 3, listed: 1, byOrigin: { build: 1 } });
    // The audit counts the whole library as expected: 4 notes and 2 root sources, 3 are placed.
    expect(document.audit).toMatchObject({ items: 6, reachable: 3, reachability: 0.5 });
    expect(document.audit.violations.hard).toContain(`I1 item-unplaced note:${notes[3]!.id}`);
    expect(document.vectors).toMatchObject({
      dataset: "env-f",
      dim,
      rows: 3,
      notesWithoutVector: 1
    });
    // The header never carries a connection string.
    expect(JSON.stringify(document)).not.toMatch(/postgres(ql)?:\/\//u);
  });

  it("writes a replay store that round-trips into the offline replay loader", async () => {
    const result = await run(fakeSource());
    const vectors = join(cache, "topics", "vectors");
    expect(result.vectorsDirectory).toBe(vectors);
    expect((await readdir(vectors)).sort()).toEqual([
      "env-f.f32",
      "env-f.index.jsonl",
      "env-f.meta.json"
    ]);
    const store = await readReplayStore(vectors, "env-f");
    expect(store.meta).toMatchObject({
      dataset: "env-f",
      count: 3,
      dim,
      runtime: "gguf",
      spaceKey: "test-space",
      model: { name: "test-embed" },
      treeId,
      generation: 3
    });
    // Notes with a vector, in import order (root first, then note), the vector's content hash as key.
    expect(store.rows.map((row) => [row.id, row.kind, row.lang, row.group, row.order])).toEqual([
      [notes[0]!.id, "note", "pt", roots[0]!.id, 0],
      [notes[1]!.id, "note", "pt", roots[0]!.id, 1],
      [notes[2]!.id, "note", "en", roots[1]!.id, 2]
    ]);
    expect(store.rows.map((row) => row.contentHash)).toEqual([
      "content-101",
      "content-102",
      "content-103"
    ]);
    expect(store.rows.map((row) => row.rootSourceId)).toEqual([
      roots[0]!.id,
      roots[0]!.id,
      roots[1]!.id
    ]);
    const expected = await fakeSource().loadNoteVectors(
      space,
      notes.map((entry) => entry.id)
    );
    expect(Array.from(store.matrix.data)).toEqual(Array.from(expected.matrix.data));
    // The T09 loader reads the dataset by name from the vectors folder.
    const dataset = await loadReplayDataset("env-f", { dirs: [vectors], twins: false });
    expect(dataset.rows).toHaveLength(3);
    expect(dataset.matrix).toMatchObject({ count: 3, dim });
    expect(dataset.meta.spaceKey).toBe("test-space");
    expect(new Set(dataset.labels.group).size).toBe(2);
  });

  it("is deterministic: two exports of the same tree are byte-equal", async () => {
    const other = await mkdtemp(join(tmpdir(), "memora-topic-export-"));
    try {
      await run(fakeSource());
      await exportTopicTree(fakeSource(), { name: "env-f", cacheDirectory: other, now: fixedNow });
      for (const file of [
        "exports/env-f/export.json",
        "vectors/env-f.f32",
        "vectors/env-f.index.jsonl"
      ])
        expect(await readFile(join(cache, "topics", file))).toEqual(
          await readFile(join(other, "topics", file))
        );
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it("lists the written files with their sizes and checksums", async () => {
    const result = await run(fakeSource());
    expect(result.files.map((file) => file.path)).toEqual([
      "vectors/env-f.f32",
      "vectors/env-f.index.jsonl",
      "vectors/env-f.meta.json"
    ]);
    const paths = replayStorePaths(join(cache, "topics", "vectors"), "env-f");
    expect(result.files[0]!.bytes).toBe((await readFile(paths.vectors)).byteLength);
    expect(result.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256))).toBe(true);
  });

  it("writes the JSON only with vectors off", async () => {
    const result = await run(fakeSource(), "env-g", { vectors: false });
    expect(result.vectorsDirectory).toBeNull();
    expect(result.files).toEqual([]);
    expect(JSON.parse(await readFile(result.exportPath, "utf8")).vectors).toBeNull();
    await expect(readdir(join(cache, "topics", "vectors"))).rejects.toThrow();
  });

  it("refuses an existing export unless forced, and a bad name or a missing tree", async () => {
    await run(fakeSource());
    await expect(run(fakeSource())).rejects.toThrow("already exists");
    await expect(run(fakeSource(), "env-f", { force: true })).resolves.toBeDefined();
    // The JSON-only export checks its own file; the store of the same name is not in the way.
    await expect(run(fakeSource(), "env-f", { vectors: false })).rejects.toThrow("already exists");
    for (const name of ["", "Env-F", "../x", "a b", "-x", "x".repeat(65)])
      await expect(run(fakeSource(), name)).rejects.toThrow("export name must match");
    await expect(run(fakeSource({ loadSkeleton: async () => null }), "none")).rejects.toThrow(
      "no active topic tree"
    );
    await expect(
      run(fakeSource({ loadSkeleton: async () => null }), "none", { treeId: uuid(5) })
    ).rejects.toThrow(`Topic tree ${uuid(5)} does not exist`);
  });

  it("derives the primary language subtag", () => {
    expect([
      primaryLanguage("pt-BR"),
      primaryLanguage("EN"),
      primaryLanguage("und"),
      primaryLanguage("")
    ]).toEqual(["pt", "en", "und", "und"]);
  });
});

describe("topics:export arguments", () => {
  it("parses a run and applies the defaults", () => {
    const command = parseExportArgs(["--db", "dev-connection.json", "--name", "env-f"]);
    expect(command).toMatchObject({
      kind: "run",
      db: "dev-connection.json",
      name: "env-f",
      label: null,
      treeId: null,
      vectors: true,
      force: false
    });
    expect(
      parseExportArgs([
        "--db",
        "postgres://u:p@127.0.0.1:5432/db",
        "--name",
        "env-c",
        "--tree",
        uuid(1).toUpperCase(),
        "--no-vectors",
        "--force",
        "--cache",
        "/tmp/cache",
        "--label",
        "ENV-C"
      ])
    ).toMatchObject({
      treeId: uuid(1),
      vectors: false,
      force: true,
      cache: "/tmp/cache",
      label: "ENV-C"
    });
  });

  it("answers --help and rejects missing or invalid arguments", () => {
    expect(parseExportArgs(["--help"])).toEqual({ kind: "help" });
    expect(exportUsage).toContain("--no-vectors");
    expect(() => parseExportArgs(["--name", "env-f"])).toThrow("--db is required");
    expect(() => parseExportArgs(["--db", "x"])).toThrow("--name is required");
    expect(() => parseExportArgs(["--db", "x", "--name", "Bad Name"])).toThrow("export name");
    expect(() => parseExportArgs(["--db", "x", "--name", "ok", "--tree", "nope"])).toThrow(
      "--tree must be a UUID"
    );
    expect(() => parseExportArgs(["--db", "x", "--name", "ok", "--unknown"])).toThrow();
  });
});
