import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  createEntityPageRepository,
  entityCoMentionLimit,
  entityMentionsPageLimit,
  InvalidEntityPageCursorError
} from "./entityPageRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `entities.page` on a real PostgreSQL (F5 T132): header, mentions in pages grouped by topic,
// counts, co-mentions and topics, with superseded and rejected notes never counted.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("entities.page on a real database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let repository: ReturnType<typeof createEntityPageRepository>;

  const rootId = randomUUID();
  const topic = {
    sleep: randomUUID(),
    memory: randomUUID(),
    big: randomUUID(),
    small: randomUUID(),
    unnamed: randomUUID(),
    retired: randomUUID()
  };
  const s = { one: randomUUID(), two: randomUUID() };
  const doc = { one: randomUUID(), two: randomUUID() };
  const chunk = { one: randomUUID(), two: randomUUID() };
  const e = {
    circadian: randomUUID(),
    melatonin: randomUUID(),
    cortisol: randomUUID(),
    adrenaline: randomUUID(),
    ghost: randomUUID(),
    empty: randomUUID(),
    busy: randomUUID(),
    weird: randomUUID()
  };
  const n = {
    alpha: randomUUID(),
    beta: randomUUID(),
    gamma: randomUUID(),
    delta: randomUUID(),
    old: randomUUID(),
    rejected: randomUUID(),
    unnamedTopic: randomUUID(),
    retiredTopic: randomUUID()
  };
  const bigNotes = Array.from({ length: 55 }, () => randomUUID());
  const smallNotes = Array.from({ length: 3 }, () => randomUUID());
  const looseNotes = Array.from({ length: 6 }, () => randomUUID());
  // Wordy: 51 mentions whose 50th (the last of page one) has a very long accented title.
  const wordyId = randomUUID();
  const wordyNotes = Array.from({ length: 51 }, () => randomUUID());
  const longTitle = `Wordy 049 ${"áé".repeat(225)}`;
  // Cap: eleven co-mentioned entities, the last two tied with the first nine at the boundary.
  const capId = randomUUID();
  const capCo = Array.from({ length: 11 }, (_, index) => ({
    id: randomUUID(),
    name: `Co ${String(index + 1).padStart(2, "0")}`
  }));
  const capNotes = [randomUUID(), randomUUID()];

  async function note(
    id: string,
    title: string,
    options: { status?: string; superseded?: boolean; source?: "one" | "two" } = {}
  ) {
    const source = s[options.source ?? "one"];
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language)
       values ($1::uuid, $2, 'Body.', $2, $3, $4, 'source', $5, $5, $6, 'seed', 'seed',
         'local', 'seed', $1::uuid::text, 'en')`,
      [
        id,
        title,
        options.status ?? "active",
        options.superseded ? "superseded" : "current",
        source,
        chunk[options.source ?? "one"]
      ]
    );
  }
  const mention = (noteId: string, entityId: string) =>
    pool.query(
      `insert into atomic_note_entity_links (atomic_note_id, entity_id, confidence) values ($1, $2, 0.8)`,
      [noteId, entityId]
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-entity-page-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_entity_page_test",
        user: "memora_entity_page_test",
        password: `entity-page-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, migrationsFolder);
    repository = createEntityPageRepository(pool);

    for (const [key, title] of [
      ["one", "Sleep book"],
      ["two", "Memory paper"]
    ] as const) {
      await pool.query(
        `insert into source_items (id, type, title, language, content_hash) values ($1, 'Book', $2, 'en', $3)`,
        [s[key], title, `content-${key}`]
      );
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Doc', 'seed', $3)`,
        [doc[key], s[key], `doc-${key}`]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Naps restore focus.', $4)`,
        [chunk[key], doc[key], s[key], `hash-${key}`]
      );
    }

    await note(n.alpha, "Alpha");
    await note(n.beta, "Beta");
    await note(n.gamma, "Gamma", { source: "two" });
    await note(n.delta, "Delta");
    await note(n.old, "Old alpha", { superseded: true });
    await note(n.rejected, "Rejected alpha", { status: "rejected" });
    await note(n.unnamedTopic, "Unnamed topic note");
    await note(n.retiredTopic, "Retired topic note");

    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, aliases, description, confidence, language)
       values ($1, 'concept', 'Circadian rhythm', 'circadian rhythm',
               '["Body clock","Body clock","  ",5,"Biological clock"]'::jsonb, 'The body clock.', 0.9, 'en'),
              ($2, 'compound', 'Melatonin', 'melatonin', '[]'::jsonb, null, 0.9, 'en'),
              ($3, 'compound', 'Cortisol', 'cortisol', '[]'::jsonb, null, 0.9, 'en'),
              ($4, 'compound', 'Adrenaline', 'adrenaline', '[]'::jsonb, null, 0.9, 'en'),
              ($5, 'compound', 'Ghost', 'ghost', '[]'::jsonb, null, 0.9, 'en'),
              ($6, 'person', 'Nobody', 'nobody', '[]'::jsonb, null, 0.9, 'en'),
              ($7, 'concept', 'Busy', 'busy', '[]'::jsonb, null, 0.9, 'en'),
              ($8, 'concept', 'Weird aliases', 'weird aliases', '{"not":"an array"}'::jsonb, null, 0.9, 'und')`,
      [e.circadian, e.melatonin, e.cortisol, e.adrenaline, e.ghost, e.empty, e.busy, e.weird]
    );

    // Circadian rhythm: current notes alpha, beta (Sleep), gamma (Memory), delta (not placed),
    // plus a superseded and a rejected note that must not count.
    for (const id of [
      n.alpha,
      n.beta,
      n.gamma,
      n.delta,
      n.old,
      n.rejected,
      n.unnamedTopic,
      n.retiredTopic
    ])
      await mention(id, e.circadian);
    // Melatonin shares alpha, beta, gamma; Cortisol and Adrenaline share alpha only (a tie broken by
    // name); Ghost shares only the superseded and the rejected notes, so it is not a co-mention.
    for (const id of [n.alpha, n.beta, n.gamma]) await mention(id, e.melatonin);
    await mention(n.alpha, e.cortisol);
    await mention(n.alpha, e.adrenaline);
    await mention(n.old, e.ghost);
    await mention(n.rejected, e.ghost);

    // Busy: 55 notes in one topic, 3 in another, 6 not placed (64 mentions, two pages).
    const stamp = (index: number) => String(index).padStart(3, "0");
    const insertMany = async (ids: string[], prefix: string) => {
      for (const [index, id] of ids.entries()) await note(id, `${prefix} ${stamp(index)}`);
    };
    await insertMany(bigNotes, "Big");
    await insertMany(smallNotes, "Small");
    await insertMany(looseNotes, "Loose");
    for (const id of [...bigNotes, ...smallNotes, ...looseNotes]) await mention(id, e.busy);

    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, aliases, description, confidence, language)
       values ($1, 'concept', 'Wordy', 'wordy', '[]'::jsonb, null, 0.9, 'pt-BR'),
              ($2, 'concept', 'Cap', 'cap', '[]'::jsonb, null, 0.9, 'en')`,
      [wordyId, capId]
    );
    for (const [index, id] of wordyNotes.entries()) {
      await note(id, index === 49 ? longTitle : `Wordy ${String(index).padStart(3, "0")}`);
      await mention(id, wordyId);
    }
    for (const id of capNotes) await note(id, `Cap note ${id.slice(0, 4)}`);
    for (const id of capNotes) await mention(id, capId);
    for (const co of capCo)
      await pool.query(
        `insert into entities (id, type, canonical_name, normalized_name, aliases, description, confidence, language)
         values ($1, 'concept', $2, lower($2), '[]'::jsonb, null, 0.9, 'en')`,
        [co.id, co.name]
      );
    // Every Co entity shares the first note; "Co 11" shares both, so it leads and "Co 10" is the
    // tenth of eleven ties (one shared note each), cut by name.
    for (const co of capCo) await mention(capNotes[0]!, co.id);
    await mention(capNotes[1]!, capCo[10]!.id);

    const trees = createTopicTreeRepository(pool);
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:entity-page:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const named = (id: string, title: string | null) =>
      topicRecord(id, rootId, {
        role: "topic",
        ...(title
          ? { title, nameState: "named" as const, nameSource: "llm" as const, nameLanguage: "en" }
          : {})
      });
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.sleep, "Sleep"),
        named(topic.memory, "Memory"),
        named(topic.big, "Big topic"),
        named(topic.small, "Small topic"),
        named(topic.unnamed, null),
        named(topic.retired, "Retired")
      ],
      placements: [
        { item: itemKey("note", n.alpha), placement: placementRecord(topic.sleep) },
        { item: itemKey("note", n.beta), placement: placementRecord(topic.sleep) },
        { item: itemKey("note", n.gamma), placement: placementRecord(topic.memory) },
        // A secondary placement never groups a mention.
        { item: itemKey("note", n.delta), placement: placementRecord(topic.memory, { rank: 1 }) },
        { item: itemKey("note", n.unnamedTopic), placement: placementRecord(topic.unnamed) },
        { item: itemKey("note", n.retiredTopic), placement: placementRecord(topic.retired) },
        ...bigNotes.map((id) => ({
          item: itemKey("note", id),
          placement: placementRecord(topic.big)
        })),
        ...smallNotes.map((id) => ({
          item: itemKey("note", id),
          placement: placementRecord(topic.small)
        }))
      ]
    });
    await pool.query("update topics set retired_at = now() where id = $1", [topic.retired]);
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("has no page for an entity that does not exist", async () => {
    expect(await repository.page({ id: randomUUID() })).toBeNull();
  });

  it("reads the header: names, cleaned aliases, description, language", async () => {
    const page = await repository.page({ id: e.circadian });
    expect(page!.entity).toEqual({
      id: e.circadian,
      type: "concept",
      canonicalName: "Circadian rhythm",
      aliases: ["Body clock", "Biological clock"],
      description: "The body clock.",
      language: "en"
    });
    const weird = await repository.page({ id: e.weird });
    expect(weird!.entity.aliases).toEqual([]);
    expect(weird!.entity.description).toBeNull();
  });

  it("counts the current notes and the sources that own them, never a superseded or rejected note", async () => {
    const page = await repository.page({ id: e.circadian });
    // alpha, beta, delta, unnamedTopic, retiredTopic (source one) and gamma (source two).
    expect(page!.counts).toEqual({ notes: 6, sources: 2 });
    expect((await repository.page({ id: e.ghost }))!.counts).toEqual({ notes: 0, sources: 0 });
  });

  it("lists mentions by topic, the densest first, then the notes not placed", async () => {
    const page = await repository.page({ id: e.circadian });
    const rows = page!.mentions.items.map((item) => [item.title, item.topicTitle, item.topicNotes]);
    expect(rows).toEqual([
      ["Alpha", "Sleep", 2],
      ["Beta", "Sleep", 2],
      // An unnamed topic comes back with an empty title, sorts before the named ties and is
      // still a group of its own (its note has a topic id).
      ["Unnamed topic note", "", 1],
      ["Gamma", "Memory", 1],
      // A retired topic is not a place: those notes and the secondary-placed one are not placed.
      ["Delta", "", 0],
      ["Retired topic note", "", 0]
    ]);
    const byTitle = new Map(page!.mentions.items.map((item) => [item.title, item]));
    expect(byTitle.get("Alpha")).toMatchObject({
      noteId: n.alpha,
      sourceId: s.one,
      sourceTitle: "Sleep book",
      topicId: topic.sleep
    });
    expect(byTitle.get("Gamma")).toMatchObject({ sourceId: s.two, sourceTitle: "Memory paper" });
    expect(byTitle.get("Delta")).toMatchObject({ topicId: null, topicNotes: 0 });
    expect(page!.mentions.next).toBeUndefined();
  });

  it("returns an entity with no mentions as an empty page", async () => {
    const page = await repository.page({ id: e.empty });
    expect(page!.mentions).toEqual({ items: [] });
    expect(page!.counts).toEqual({ notes: 0, sources: 0 });
    expect(page!.coMentioned).toEqual([]);
    expect(page!.topics).toEqual({ primary: [], alsoIn: [], alsoInCount: 0 });
  });

  it("pages the mentions at 50 with a cursor that can fall inside a group, without gap or repeat", async () => {
    expect(entityMentionsPageLimit).toBe(50);
    const first = await repository.page({ id: e.busy });
    expect(first!.counts.notes).toBe(64);
    expect(first!.mentions.items).toHaveLength(50);
    expect(first!.mentions.next).toEqual(expect.any(String));
    // The first 50 are all in the densest topic, ordered by title.
    expect(new Set(first!.mentions.items.map((item) => item.topicId))).toEqual(
      new Set([topic.big])
    );
    expect(first!.mentions.items.every((item) => item.topicNotes === 55)).toBe(true);

    const second = await repository.page({ id: e.busy, cursor: first!.mentions.next });
    expect(second!.mentions.items).toHaveLength(14);
    expect(second!.mentions.next).toBeUndefined();
    // A later page carries mentions and the header only.
    expect(second!.topics).toBeUndefined();
    expect(second!.coMentioned).toBeUndefined();
    expect(second!.entity.canonicalName).toBe("Busy");
    expect(second!.counts.notes).toBe(64);

    const all = [...first!.mentions.items, ...second!.mentions.items];
    expect(new Set(all.map((item) => item.noteId)).size).toBe(64);
    expect(all.slice(50).map((item) => item.topicTitle)).toEqual([
      "Big topic",
      "Big topic",
      "Big topic",
      "Big topic",
      "Big topic",
      "Small topic",
      "Small topic",
      "Small topic",
      "",
      "",
      "",
      "",
      "",
      ""
    ]);
    expect(all.slice(0, 55).map((item) => item.title)).toEqual(
      bigNotes.map((_, index) => `Big ${String(index).padStart(3, "0")}`)
    );
  });

  it("pages past a very long note title with a cursor that still fits the bound", async () => {
    const first = await repository.page({ id: wordyId });
    expect(first!.mentions.items).toHaveLength(50);
    expect(first!.mentions.items.at(-1)!.title).toBe(longTitle);
    // The cursor holds ids, so it fits the 1024 characters `EntityPageSchema` allows for `next`.
    expect(first!.mentions.next!.length).toBeLessThan(200);
    const second = await repository.page({ id: wordyId, cursor: first!.mentions.next });
    expect(second!.mentions.items.map((item) => item.title)).toEqual(["Wordy 050"]);
    expect(second!.mentions.next).toBeUndefined();
  });

  it("refuses a cursor it did not write", async () => {
    await expect(repository.page({ id: e.busy, cursor: "not-a-cursor" })).rejects.toBeInstanceOf(
      InvalidEntityPageCursorError
    );
    await expect(
      repository.page({ id: e.busy, cursor: Buffer.from("[1,2]").toString("base64url") })
    ).rejects.toBeInstanceOf(InvalidEntityPageCursorError);
  });

  it("lists the co-mentioned entities by shared current notes, ties by name, capped at ten", async () => {
    expect(entityCoMentionLimit).toBe(10);
    const page = await repository.page({ id: e.circadian });
    expect(page!.coMentioned).toEqual([
      { id: e.melatonin, type: "compound", canonicalName: "Melatonin", sharedNotes: 3 },
      { id: e.adrenaline, type: "compound", canonicalName: "Adrenaline", sharedNotes: 1 },
      { id: e.cortisol, type: "compound", canonicalName: "Cortisol", sharedNotes: 1 }
    ]);
    // The entity is never its own co-mention, and a superseded or rejected note shares nothing.
    expect(page!.coMentioned!.some((item) => item.id === e.circadian)).toBe(false);
    expect(page!.coMentioned!.some((item) => item.id === e.ghost)).toBe(false);
  });

  it("caps the co-mentions at ten and cuts a tie at the boundary by name", async () => {
    const page = await repository.page({ id: capId });
    // "Co 11" shares both notes and leads; the other ten share one, and "Co 10" is cut.
    expect(page!.coMentioned!.map((item) => [item.canonicalName, item.sharedNotes])).toEqual([
      ["Co 11", 2],
      ...capCo.slice(0, 9).map((co) => [co.name, 1])
    ]);
    expect(page!.coMentioned).toHaveLength(entityCoMentionLimit);
  });

  it("takes the topics from locate: the densest place first, the others after it", async () => {
    const page = await repository.page({ id: e.circadian });
    // Sleep holds two of its notes; Memory and the unnamed topic one each (a retired topic is no place).
    expect(page!.topics!.primary.map((item) => item.id)).toEqual([rootId, topic.sleep]);
    expect(page!.topics!.primary.every((item) => item.kind === "topic")).toBe(true);
    expect(page!.topics!.alsoIn.map((item) => item.id)).toEqual([topic.unnamed, topic.memory]);
    expect(page!.topics!.alsoInCount).toBe(2);

    const busy = await repository.page({ id: e.busy });
    expect(busy!.topics!.primary.at(-1)).toEqual({
      kind: "topic",
      id: topic.big,
      title: "Big topic"
    });
    expect(busy!.topics!.alsoIn).toEqual([
      { kind: "topic", id: topic.small, title: "Small topic" }
    ]);
  });
});
