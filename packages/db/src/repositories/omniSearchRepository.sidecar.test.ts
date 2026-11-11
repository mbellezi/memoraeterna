import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import {
  compareOmniHits,
  formatObjectAddress,
  rrfScore,
  type ObjectKind,
  type OmniArmRank
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { omniArms } from "../objectSearchArms.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  createOmniSearchRepository,
  omniSearchStatement,
  type OmniQueryEmbedding,
  type OmniSearchHit,
  type OmniSearchInput
} from "./omniSearchRepository.js";
import { createQuestionRepository } from "./questionRepository.js";
import { createTopicTreeRepository } from "./topicTreeRepository.js";

// `search.omni` on a real PostgreSQL (F5 T127, D12): every arm alone and fused against T117's arm
// statements, accents and case, the kind filters Cmd-K's `#` and `@` send, entity aliases,
// visibility, a topic scope, full mode with and without the query's vector, and the plan.
const workspace = resolve(import.meta.dirname, "../../../..");
const migrationsFolder = join(workspace, "packages/db/drizzle");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const at = (kind: ObjectKind, id: string, passage?: string) =>
  formatObjectAddress({ kind, id, ...(passage ? { anchor: { passage } } : {}) });

/** A 256-dimension vector pointing mostly along `axis`. */
const along = (axis: number, tilt = 0) =>
  Array.from({ length: 256 }, (_, index) => (index === axis ? 1 : index === 255 ? tilt + 0.01 : 0));

describe.skipIf(!sidecarInstalled)("search.omni on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let omni: ReturnType<typeof createOmniSearchRepository>;

  const topic = {
    ferment: randomUUID(),
    bread: randomUUID(),
    stars: randomUUID(),
    retired: randomUUID(),
    stale: randomUUID()
  };
  const w = {
    sFerm: randomUUID(),
    sStar: randomUUID(),
    dFerm: randomUUID(),
    dOld: randomUUID(),
    dStar: randomUUID(),
    cFerm: randomUUID(),
    cOld: randomUUID(),
    cStar: randomUUID(),
    nFerm: randomUUID(),
    nKefir: randomUUID(),
    nDraft: randomUUID(),
    nStar: randomUUID(),
    eCurie: randomUUID(),
    ePasteur: randomUUID(),
    qFerm: "",
    qScoped: ""
  };
  /** What visibility hides: a superseded note, a retired topic and a topic of a retired tree. */
  const hidden = () => new Set([w.nDraft, topic.retired, topic.stale, w.cOld]);

  const embedding: OmniQueryEmbedding = {
    vector: along(0),
    model: "test-embed",
    spaceKey: "test:omni:256",
    provider: "test",
    runtime: "local"
  };

  const search = (input: Partial<OmniSearchInput> & Pick<OmniSearchInput, "query">) =>
    omni.search({ mode: "quick", limit: 50, ...input });
  const addresses = (items: readonly OmniSearchHit[]) => items.map(({ address }) => address);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-omni-search-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_omni_search_test",
        user: "memora_omni_search_test",
        password: `omni-search-${randomUUID()}`,
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
    omni = createOmniSearchRepository(pool);

    // Sources, documents (one superseded) and passages.
    for (const [id, title] of [
      [w.sFerm, "Fermentação lática"],
      [w.sStar, "Stars"]
    ] as const)
      await pool.query(
        `insert into source_items (id, type, title, language, content_hash) values ($1, 'Book', $2, 'pt', $3)`,
        [id, title, `content-${id}`]
      );
    for (const [id, sourceId, metadata] of [
      [w.dFerm, w.sFerm, {}],
      [w.dOld, w.sFerm, { supersededByDocumentId: w.dFerm }],
      [w.dStar, w.sStar, {}]
    ] as const)
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
         values ($1, $2, 'Doc', 'seed', $3, $4)`,
        [id, sourceId, `doc-${id}`, metadata]
      );
    for (const [id, documentId, sourceId, index, content] of [
      [w.cFerm, w.dFerm, w.sFerm, 0, "O kefir passa por uma fermentação lática a frio."],
      [w.cOld, w.dOld, w.sFerm, 0, "A versão antiga também falava de kefir."],
      [w.cStar, w.dStar, w.sStar, 0, "Stars burn hydrogen for billions of years."]
    ] as const)
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, $4, $5, $6)`,
        [id, documentId, sourceId, index, content, `hash-${id}`]
      );

    // Notes: one superseded draft, which no arm may return.
    for (const [id, title, idea, body, sourceId, chunkId, supersession] of [
      [
        w.nFerm,
        "Lactic fermentation",
        "Bacteria turn sugar into lactic acid.",
        "",
        w.sFerm,
        w.cFerm,
        "current"
      ],
      [
        w.nKefir,
        "Cultured milk",
        "Kefir grains culture milk.",
        "Kefir again.",
        w.sFerm,
        w.cFerm,
        "current"
      ],
      [w.nDraft, "Fermentation draft", "An earlier draft.", "", w.sFerm, w.cFerm, "superseded"],
      [w.nStar, "Star formation", "Clouds collapse into stars.", "", w.sStar, w.cStar, "current"]
    ] as const)
      await pool.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
           supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key, language)
         values ($1::uuid, $2, $3, $4, 'active', $5, 'source', $6, $6, $7, 'seed', 'seed', 'local',
           'seed', $1::uuid::text, 'en')`,
        [id, title, body, idea, supersession, sourceId, chunkId]
      );

    // Entities, one with aliases (accented), each mentioned by a note.
    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, aliases, confidence, language)
       values ($1, 'person', 'Marie Curie', 'marie curie', '["Maria Skłodowska", "Madame Curie"]', 0.9, 'en'),
              ($2, 'person', 'Louis Pasteur', 'louis pasteur', '[]', 0.9, 'fr')`,
      [w.eCurie, w.ePasteur]
    );
    await pool.query(
      `insert into atomic_note_entity_links (atomic_note_id, entity_id, confidence)
       values ($1, $2, 0.8), ($3, $4, 0.8)`,
      [w.nStar, w.eCurie, w.nFerm, w.ePasteur]
    );

    // The tree: Fermentação (aliases, description) > Pão; Astronomia; a retired Fermentação antiga.
    const trees = createTopicTreeRepository(pool);
    const rootId = randomUUID();
    const tree = await trees.createTree({
      id: randomUUID(),
      rootId,
      spaceKey: "test:omni:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "test",
      seed: 1
    });
    const named = (id: string, parent: string, title: string, extra = {}) =>
      topicRecord(id, parent, {
        role: "topic",
        title,
        nameState: "named" as const,
        nameSource: "llm" as const,
        nameLanguage: "pt",
        ...extra
      });
    await trees.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: tree.generation,
      titleKey: "topics.changeSets.build",
      topics: [
        named(topic.ferment, rootId, "Fermentação", {
          aliases: ["Lacto-fermentation"],
          description: "Como microrganismos transformam açúcares."
        }),
        named(topic.bread, topic.ferment, "Pão", {
          description: "A fermentação do pão com levedura."
        }),
        named(topic.stars, rootId, "Astronomia", { aliases: ["Stargazing"] }),
        named(topic.retired, rootId, "Fermentação antiga")
      ],
      placements: [
        { item: itemKey("note", w.nFerm), placement: placementRecord(topic.ferment) },
        { item: itemKey("note", w.nKefir), placement: placementRecord(topic.bread) },
        { item: itemKey("note", w.nStar), placement: placementRecord(topic.stars) },
        { item: itemKey("source", w.sFerm), placement: placementRecord(topic.ferment) }
      ]
    });
    await pool.query("update topics set retired_at = now(), redirect_to = $2 where id = $1", [
      topic.retired,
      topic.ferment
    ]);
    // A live-looking topic of a retired tree (an old tree's topics keep `retired_at` null).
    const oldTree = randomUUID();
    const oldRoot = randomUUID();
    await pool.query(
      `insert into topic_trees (id, status, space_key, embedding_provider, embedding_model,
         embedding_runtime, dimensions, config, config_hash, seed, activated_at, retired_at)
       values ($1, 'retired', 'test:omni:old', 'test', 'test', 'none', 256, '{}', 'old', 1, now(), now())`,
      [oldTree]
    );
    await pool.query(
      `insert into topics (id, tree_id, role, parent_id, title, name_state, name_source, name_language, management)
       values ($1, $3, 'root', null, null, 'unnamed', null, null, 'human'),
              ($2, $3, 'topic', $1, 'Fermentação velha', 'named', 'llm', 'pt', 'human')`,
      [oldRoot, topic.stale, oldTree]
    );

    // Questions: one about the library, one asked about the Fermentação topic.
    const questions = createQuestionRepository(pool);
    w.qFerm = (
      await questions.create({
        text: "Como funciona a fermentação?",
        privacy: "offline_only",
        mode: "text"
      })
    ).id;
    w.qScoped = (
      await questions.create({
        text: "Fermentação do pão em casa",
        privacy: "offline_only",
        mode: "text",
        scope: { kind: "topic", topicId: topic.ferment }
      })
    ).id;

    // Vectors of the query's space (and one of another space, which must never be read).
    const vector = async (
      targetType: "atomic_note" | "chunk",
      id: string,
      values: number[],
      space = embedding.spaceKey
    ) =>
      pool.query(
        `insert into embeddings_256 (target_type, target_id, chunk_id, provider, model, runtime,
           strategy, content_hash, embedding)
         values ($1, $2, $3, 'test', $4, 'local', $5, $6, $7::vector)`,
        [
          targetType,
          id,
          targetType === "chunk" ? id : null,
          space === embedding.spaceKey ? embedding.model : "other-model",
          `native-v2:${space}`,
          `hash-${id}-${space}`,
          `[${values.join(",")}]`
        ]
      );
    await vector("atomic_note", w.nStar, along(0, 0.1));
    await vector("atomic_note", w.nFerm, along(1));
    await vector("atomic_note", w.nDraft, along(0));
    await vector("chunk", w.cStar, along(0, 0.2));
    await vector("chunk", w.cOld, along(0));
    await vector("atomic_note", w.nKefir, along(0), "test:other:256");
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  describe("arms alone and fused", () => {
    it("fuses exactly what T117's arm statements return, by reciprocal rank and the tiebreak", async () => {
      const kindOf: Record<string, ObjectKind> = {
        source_items: "source",
        topics: "topic",
        atomic_notes: "note",
        questions: "question",
        entities: "entity"
      };
      const expected = new Map<string, OmniArmRank[]>();
      for (const arm of omniArms.filter(({ quick }) => quick)) {
        const rows = await pool.query<{ id: string }>(arm.sql, ["fermentacao", "'fermentacao':*"]);
        const visible = rows.rows.filter(({ id }) => !hidden().has(id));
        visible.forEach(({ id }, index) => {
          const address = at(kindOf[arm.table]!, id);
          expected.set(address, [
            ...(expected.get(address) ?? []),
            { arm: arm.arm, rank: index + 1 }
          ]);
        });
      }
      const { items } = await search({ query: "fermentacao" });
      expect(new Map(items.map((item) => [item.address, item.arms]))).toEqual(
        new Map(
          [...expected].map(([address, arms]) => [
            address,
            [...arms].sort((a, b) => a.rank - b.rank || a.arm.localeCompare(b.arm))
          ])
        )
      );
      for (const item of items)
        expect(item.score).toBe(rrfScore(item.arms.map(({ rank }) => rank)));
      expect([...items].sort(compareOmniHits)).toEqual(items);
    });

    it("scores a topic found by its title and its full text above one found by full text alone", async () => {
      const { items } = await search({ query: "fermentação", kinds: ["topic"] });
      const ferment = items.find(({ address }) => address === at("topic", topic.ferment))!;
      const bread = items.find(({ address }) => address === at("topic", topic.bread))!;
      expect(ferment.arms.map(({ arm }) => arm).sort()).toEqual(["fts", "title_trgm"]);
      expect(bread.arms.map(({ arm }) => arm)).toEqual(["fts"]);
      expect(items.indexOf(ferment)).toBeLessThan(items.indexOf(bread));
      expect(bread.snippet).toBe("A fermentação do pão com levedura.");
      expect(ferment.snippet).toBeUndefined();
    });

    it("title trigram alone: a source by its title", async () => {
      const { items } = await search({ query: "Stars", kinds: ["source"] });
      expect(items).toEqual([
        {
          address: at("source", w.sStar),
          kind: "source",
          title: "Stars",
          arms: [{ arm: "title_trgm", rank: 1 }],
          score: 1 / 61
        }
      ]);
    });

    it("full text alone: a note whose title does not match shows its idea", async () => {
      const { items } = await search({ query: "kefir", kinds: ["note"] });
      expect(items).toEqual([
        {
          address: at("note", w.nKefir),
          kind: "note",
          title: "Cultured milk",
          snippet: "Kefir grains culture milk.",
          arms: [{ arm: "fts", rank: 1 }],
          score: 1 / 61
        }
      ]);
    });

    it("passage full text alone, in full mode, on the source's address with the passage", async () => {
      const { items } = await search({ query: "kefir", kinds: ["source"], mode: "full" });
      expect(items).toEqual([
        {
          address: at("source", w.sFerm, w.cFerm),
          kind: "source",
          title: "Fermentação lática",
          snippet: "O kefir passa por uma fermentação lática a frio.",
          arms: [{ arm: "chunk_fts", rank: 1 }],
          score: 1 / 61
        }
      ]);
    });

    it("vectors alone: the nearest current notes and passages of the query's space", async () => {
      const outcome = await search({ query: "zzzz", mode: "full", embedding });
      expect(outcome.vectors).toBe(true);
      expect(outcome.items.map(({ address, arms }) => [address, arms])).toEqual([
        [at("source", w.sStar, w.cStar), [{ arm: "ann", rank: 1 }]],
        [at("note", w.nStar), [{ arm: "ann", rank: 1 }]],
        [at("note", w.nFerm), [{ arm: "ann", rank: 2 }]]
      ]);
    });
  });

  it("folds accents and case on both sides", async () => {
    const variants = ["fermentação", "FERMENTACAO", "Fermentacao", "fermentaçÃo"];
    const results = await Promise.all(variants.map((query) => search({ query })));
    for (const result of results.slice(1))
      expect(addresses(result.items)).toEqual(addresses(results[0]!.items));
    expect(addresses(results[0]!.items)).toEqual(
      expect.arrayContaining([
        at("topic", topic.ferment),
        at("topic", topic.bread),
        at("source", w.sFerm),
        at("question", w.qFerm),
        at("question", w.qScoped)
      ])
    );
    // Unaccented text matches accented titles, and accented text unaccented ones.
    const sklodowska = await search({ query: "SKLODOWSKA", kinds: ["entity"] });
    expect(addresses(sklodowska.items)).toEqual([at("entity", w.eCurie)]);
  });

  it("never returns a superseded note, a retired topic, a retired tree's topic or a superseded passage", async () => {
    for (const query of ["fermentação", "draft", "kefir", "velha", "antiga"]) {
      const { items } = await search({ query, mode: "full", embedding });
      const ids = items.flatMap(({ address }) => address.split(/[/=#]/u));
      for (const id of hidden()) expect(ids).not.toContain(id);
    }
  });

  it("`#` asks for topics only and `@` for entities only", async () => {
    const topics = await search({ query: "fermentacao", kinds: ["topic"] });
    expect(new Set(topics.items.map(({ kind }) => kind))).toEqual(new Set(["topic"]));
    expect(addresses(topics.items).sort()).toEqual(
      [at("topic", topic.ferment), at("topic", topic.bread)].sort()
    );
    const entities = await search({ query: "curie", kinds: ["entity"] });
    expect(entities.items).toHaveLength(1);
    expect(entities.items[0]).toMatchObject({
      address: at("entity", w.eCurie),
      title: "Marie Curie"
    });
    // Found by its name and by an alias, so both arms fuse.
    expect(entities.items[0]!.arms.map(({ arm }) => arm).sort()).toEqual([
      "alias_trgm",
      "title_trgm"
    ]);
  });

  it("matches an entity by an alias alone and shows the aliases", async () => {
    const { items } = await search({ query: "Maria Sklodowska" });
    expect(items).toEqual([
      {
        address: at("entity", w.eCurie),
        kind: "entity",
        title: "Marie Curie",
        snippet: "Maria Skłodowska, Madame Curie",
        arms: [{ arm: "alias_trgm", rank: 1 }],
        score: 1 / 61
      }
    ]);
  });

  it("matches a topic's aliases through its full text (weight B), not by a trigram arm", async () => {
    const { items } = await search({ query: "stargazing" });
    expect(items.map(({ address, arms }) => [address, arms])).toEqual([
      [at("topic", topic.stars), [{ arm: "fts", rank: 1 }]]
    ]);
  });

  it("reads only a topic's subtree when scoped", async () => {
    const { items } = await search({ query: "fermentacao", topicId: topic.ferment, mode: "full" });
    const found = new Set(addresses(items));
    expect(found).toEqual(
      new Set([
        at("topic", topic.ferment),
        at("topic", topic.bread),
        at("source", w.sFerm),
        at("source", w.sFerm, w.cFerm),
        at("note", w.nFerm),
        at("question", w.qScoped)
      ])
    );
    const pasteur = await search({ query: "pasteur", topicId: topic.ferment });
    expect(addresses(pasteur.items)).toEqual([at("entity", w.ePasteur)]);
    const curie = await search({ query: "curie", topicId: topic.ferment });
    expect(curie.items).toEqual([]);
  });

  it("full mode without a vector runs the text arms and says the vectors did not run", async () => {
    const outcome = await search({ query: "kefir", mode: "full" });
    expect(outcome.vectors).toBe(false);
    expect(addresses(outcome.items)).toEqual(
      expect.arrayContaining([at("note", w.nKefir), at("source", w.sFerm, w.cFerm)])
    );
    // A vector of a dimension no table stores is no vector either.
    const odd = await search({
      query: "kefir",
      mode: "full",
      embedding: { ...embedding, vector: [1, 0, 0] }
    });
    expect(odd.vectors).toBe(false);
    // Quick mode never reads passages or vectors.
    const quick = await search({ query: "kefir", embedding });
    expect(quick.vectors).toBe(false);
    expect(quick.items.some(({ address }) => address.includes("#passage="))).toBe(false);
  });

  it("answers a query with no word from the trigram arms alone, and quotes or backslashes safely", async () => {
    const symbols = await search({ query: "?!" });
    expect(symbols.fullText).toBe(false);
    expect(symbols.items).toEqual([]);
    for (const query of ["kefir'", "'kefir", "kefir\\", "\\'kefir"]) {
      const outcome = await search({ query });
      expect(outcome.fullText).toBe(true);
      expect(addresses(outcome.items)).toContain(at("note", w.nKefir));
    }
    // A modifier letter that unaccenting may turn into a quote is still only a word.
    await expect(search({ query: "ʼkefir ʻokina" })).resolves.toMatchObject({ fullText: true });
  });

  it("keeps the limit and the order of the fused list", async () => {
    const all = await search({ query: "fermentacao" });
    const two = await search({ query: "fermentacao", limit: 2 });
    expect(all.items.length).toBeGreaterThan(2);
    expect(two.items).toEqual(all.items.slice(0, 2));
  });

  it("plans every arm on its index", async () => {
    // A handful of topics plans as a walk of a b-tree over the live ones; a few thousand (here in
    // the retired tree, so no search sees them) is when the arm's own index has to drive.
    const oldTree = await pool.query<{ id: string; root: string }>(
      `select t.tree_id as id, t.id as root from topics t join topic_trees tr on tr.id = t.tree_id
        where tr.status = 'retired' and t.parent_id is null`
    );
    await pool.query(
      `insert into topics (tree_id, role, parent_id, title, name_state, name_source, name_language, management)
       select $1, 'topic', $2, 'Filler ' || n, 'named', 'llm', 'en', 'human' from generate_series(1, 3000) n`,
      [oldTree.rows[0]!.id, oldTree.rows[0]!.root]
    );
    await pool.query("analyze topics");
    const plan = async (input: OmniSearchInput, settings: string) => {
      const statement = omniSearchStatement(input);
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(settings);
        const rows = await client.query<{ "QUERY PLAN": string }>(
          `explain ${statement.text}`,
          statement.values
        );
        return rows.rows.map((row) => row["QUERY PLAN"]).join("\n");
      } finally {
        await client.query("rollback");
        client.release();
      }
    };
    const quick = await plan(
      { query: "fermentacao", mode: "quick", limit: 20 },
      "set local enable_seqscan = off"
    );
    for (const index of omniArms.filter(({ quick }) => quick).map(({ index }) => index))
      expect(quick).toContain(index);
    expect(quick).not.toContain("CTE Scan on q");
    expect(quick).not.toMatch(
      /Seq Scan on (topics|source_items|atomic_notes|entities|questions) x/u
    );

    const full = await plan(
      { query: "fermentacao", mode: "full", limit: 20, embedding },
      "set local enable_seqscan = off; set local enable_sort = off"
    );
    for (const index of [
      "chunks_search_tsv_idx",
      "embeddings_256_note_hnsw_idx",
      "embeddings_256_embedding_hnsw_idx"
    ])
      expect(full).toContain(index);
  }, 60_000);
});
