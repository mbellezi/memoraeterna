import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { ObjectNeighborhoodSchema } from "@app/domain";

import { ObjectsService } from "./objects-service.js";

// F3 D43 and R30 on a real PostgreSQL database: `objects.neighborhood` draws the shown relations
// (applied, kept, suggested) between current notes and nothing else, ranks them, bounds them and
// adds the second ring at depth 2.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

type Kind = "suggested" | "kept" | "applied" | "legacy" | "withdrawn" | "removed";

describe.skipIf(!sidecarInstalled)("objects.neighborhood on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-object-neighborhood-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_object_neighborhood_test",
        user: "memora_object_neighborhood_test",
        password: `neighborhood-${randomUUID()}`,
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
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = pool!;
    await db.query("delete from atomic_note_relations");
    await db.query("delete from atomic_notes");
    await db.query("delete from source_items");
  });

  /** A source with a document and a chunk, and a note on it with current evidence. */
  const seedNote = async (
    title: string,
    options: { superseded?: boolean; documentSuperseded?: boolean; language?: string } = {}
  ) => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db.query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash, metadata)
       values ($1, $2, $3, 'seed', $4, $5::jsonb)`,
      [
        documentId,
        sourceId,
        title,
        `hash-${documentId}`,
        JSON.stringify(options.documentSuperseded ? { supersededByDocumentId: randomUUID() } : {})
      ]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, language)
       values ($1, $2, $3, $4, 'active', $5, 'source', $6, $6, $7, 'seed', 'seed', 'local', 'seed', $8, $9)`,
      [
        id,
        title,
        `${title} body.`,
        `${title} idea.`,
        options.superseded ? "superseded" : "current",
        sourceId,
        chunkId,
        `key-${id}`,
        options.language ?? "und"
      ]
    );
    return id;
  };

  /** One relation between two notes in the state `kind`; the pair is stored sorted by ID. */
  const relate = async (
    from: string,
    to: string,
    kind: Kind,
    options: { type?: string; probability?: number | null; score?: number } = {}
  ) => {
    const [lo, hi] = from < to ? [from, to] : [to, from];
    const type = options.type ?? "supports";
    const directed = ["supports", "extends", "depends_on", "example_of", "clarifies"].includes(
      type
    );
    const legacy = kind === "legacy";
    const direction = legacy
      ? "unknown"
      : directed
        ? from === lo
          ? "lo_to_hi"
          : "hi_to_lo"
        : "symmetric";
    const row = (
      await pool!.query<{ id: string }>(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id,
           relation_type, direction, band, probability, final_score, explanation, status,
           vetoed_at, veto_source, matching_model)
         values ($1, $2, $3, $4, $5, $6, $7, 'knowledge.relations.explanations.reranked', $8,
                 $9, $10, 'seed')
         returning id`,
        [
          lo,
          hi,
          legacy ? "similar_to" : type,
          direction,
          legacy ? null : kind === "applied" ? "apply" : "suggest",
          legacy ? null : (options.probability ?? 0.5),
          options.score ?? 0.5,
          kind === "kept" ? "accepted" : kind === "removed" ? "rejected" : "pending_review",
          kind === "withdrawn" ? new Date() : null,
          kind === "withdrawn" ? "explainer" : null
        ]
      )
    ).rows[0]!;
    return row.id;
  };

  const service = () => new ObjectsService(() => pool!);

  it("answers null for a note that does not exist", async () => {
    expect(await service().neighborhood({ objectId: randomUUID() })).toBeNull();
  });

  it("draws applied, kept and suggested relations, ranked, and no other; a suggestion says so", async () => {
    const focus = await seedNote("Focus", { language: "en" });
    const [a, b, c, d, e, g, h] = await Promise.all(
      ["A", "B", "C", "D", "E", "G", "H"].map((title) =>
        seedNote(title, {
          superseded: title === "G",
          documentSuperseded: title === "H"
        })
      )
    );
    const suggestion = await relate(focus, a!, "suggested", { probability: 0.6 });
    const kept = await relate(b!, focus, "kept", { probability: 0.9, type: "extends" });
    const legacy = await relate(focus, c!, "legacy", { score: 0.8 });
    await relate(focus, d!, "withdrawn", { probability: 0.99 });
    await relate(focus, e!, "removed", { probability: 0.99 });
    // The endpoint is an earlier version, or its evidence is no longer current: never drawn.
    await relate(focus, g!, "applied", { probability: 0.99 });
    await relate(focus, h!, "applied", { probability: 0.99 });
    // A relation between two neighbours is drawn too, as an edge among the chosen nodes.
    const among = await relate(a!, c!, "applied", { type: "contradicts", probability: 0.7 });

    const answer = ObjectNeighborhoodSchema.parse(
      await service().neighborhood({ objectId: focus })
    );
    expect(answer.focus).toBe(focus);
    expect(answer.depth).toBe(1);
    // Ranked by probability, the unknown (legacy) last; the focus first.
    expect(answer.nodes.map((node) => [node.title, node.depth])).toEqual([
      ["Focus", 0],
      ["B", 1],
      ["A", 1],
      ["C", 1]
    ]);
    expect(answer.nodes[0]).toMatchObject({ language: "en", ideaStatement: "Focus idea." });
    expect(answer.nodes[1]).toMatchObject({ language: null });
    const byId = new Map(answer.edges.map((edge) => [edge.id, edge]));
    expect([...byId.keys()].sort()).toEqual([suggestion, kept, legacy, among].sort());
    expect(byId.get(suggestion)).toMatchObject({
      state: "suggested",
      band: "suggest",
      type: "supports"
    });
    expect(byId.get(kept)).toMatchObject({ state: "kept", type: "extends" });
    expect(byId.get(legacy)).toMatchObject({
      state: "applied",
      band: null,
      direction: "unknown",
      type: "similar_to"
    });
    expect(byId.get(among)).toMatchObject({
      state: "applied",
      direction: "symmetric",
      type: "contradicts"
    });
    // The canonical pair: lo < hi, and the direction reads from the stored pair.
    for (const edge of answer.edges) expect(edge.lo < edge.hi).toBe(true);
    expect(answer.neighbourTotal).toBe(3);
    expect(answer.truncated).toBe(false);
  });

  it("draws nothing around a note that is not current, and only the focus for a lone note", async () => {
    const earlier = await seedNote("Earlier", { superseded: true });
    const other = await seedNote("Other");
    await relate(earlier, other, "applied");
    expect(await service().neighborhood({ objectId: earlier })).toMatchObject({
      nodes: [{ id: earlier, depth: 0 }],
      edges: [],
      neighbourTotal: 0,
      truncated: false
    });
    expect(await service().neighborhood({ objectId: other })).toMatchObject({
      nodes: [{ id: other, depth: 0 }],
      edges: []
    });
  });

  it("bounds the nodes and says how many related notes were left out", async () => {
    const focus = await seedNote("Focus");
    for (let n = 0; n < 6; n += 1) {
      const note = await seedNote(`N${n}`);
      await relate(focus, note, "suggested", { probability: 0.9 - n / 20 });
    }
    const answer = await service().neighborhood({ objectId: focus, limit: 4 });
    expect(answer!.nodes.map((node) => node.title)).toEqual(["Focus", "N0", "N1", "N2"]);
    expect(answer).toMatchObject({ neighbourTotal: 6, truncated: true });
    const alone = await service().neighborhood({ objectId: focus, limit: 1 });
    expect(alone).toMatchObject({
      nodes: [{ id: focus }],
      edges: [],
      neighbourTotal: 6,
      truncated: true
    });
  });

  it("adds the neighbours of the strongest notes at depth 2, once, and never the focus", async () => {
    const focus = await seedNote("Focus");
    const a = await seedNote("A");
    const b = await seedNote("B");
    const x = await seedNote("X");
    const y = await seedNote("Y");
    const hidden = await seedNote("Hidden");
    await relate(focus, a, "suggested", { probability: 0.9 });
    await relate(focus, b, "kept", { probability: 0.8 });
    await relate(a, x, "suggested", { probability: 0.7 });
    await relate(b, x, "suggested", { probability: 0.95 });
    await relate(b, y, "applied", { probability: 0.6 });
    await relate(a, hidden, "withdrawn", { probability: 0.99 });
    const one = await service().neighborhood({ objectId: focus, depth: 1 });
    expect(one!.nodes.map((node) => node.title)).toEqual(["Focus", "A", "B"]);

    const two = ObjectNeighborhoodSchema.parse(
      await service().neighborhood({ objectId: focus, depth: 2 })
    );
    expect(two.depth).toBe(2);
    expect(two.nodes.map((node) => [node.title, node.depth])).toEqual([
      ["Focus", 0],
      ["A", 1],
      ["B", 1],
      ["X", 2],
      ["Y", 2]
    ]);
    // Every shown relation among the chosen nodes: focus-A, focus-B, A-X, B-X, B-Y.
    expect(two.edges).toHaveLength(5);
    expect(two.neighbourTotal).toBe(2);
    expect(two.truncated).toBe(false);
  });
});
