import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository, createRelationTypeRepository,
  createEntityIdentityRepository, createKnowledgeGraphRepository, type RelationTypeVector, type EntityIdentityDecision
} from "../index.js";

const root = resolve(import.meta.dirname, "../../../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-canonical-identities-"));
const migrations = resolve(root, "packages/db/drizzle"), seedFolder = resolve(root, "packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({ binDir: sidecar.binDir, dataDir: join(workDir, "data"), database: "identity_test",
  user: "identity_test", password: randomUUID(), startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
const vector = (size = 256, axis = 0): RelationTypeVector => ({ embedding: Array.from({ length: size }, (_, index) => index === axis ? 1 : 0),
  spaceKey: `test-${size}`, contentHash: "a".repeat(64), provider: "test", model: "test", runtime: "local", metadata: { strategy: "test" } });
let pool, emptyPool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  // Exercise the actual upgrade path with a populated pre-canonicalization database.
  const journal = JSON.parse(await readFile(join(migrations, "meta/_journal.json"), "utf8"));
  const oldEntries = journal.entries.filter((entry: { idx: number }) => entry.idx < 18);
  const oldFolder = join(workDir, "old-migrations");
  await mkdir(join(oldFolder, "meta"), { recursive: true });
  await writeFile(join(oldFolder, "meta/_journal.json"), JSON.stringify({ ...journal, entries: oldEntries }));
  for (const entry of oldEntries) await copyFile(join(migrations, `${entry.tag}.sql`), join(oldFolder, `${entry.tag}.sql`));
  await runMigrations(pool, oldFolder);
  const source = await createSourceItemRepository(pool).create({ type: "PersonalNote", title: "Identity test" });
  const doc = await createDocumentRepository(pool).create({ sourceItemId: source.id, title: source.title, canonicalMarkdown: "Evidence", contentHash: "a".repeat(64) });
  const chunkId = randomUUID(), spanId = randomUUID();
  await createChunkRepository(pool).replaceDocumentChunks(doc.id, source.id, [{ id: chunkId, sourceSpanId: spanId, chunkIndex: 0,
    content: "Evidence", contentHash: "a".repeat(64), span: { id: spanId, startOffset: 0, endOffset: 8 } }]);
  const oldIds = [randomUUID(), randomUUID()];
  for (const [index, id] of oldIds.entries()) await pool.query(`insert into entities (id, type, canonical_name, normalized_name, confidence)
    values ($1, 'Person', $2, $2, 0.9)`, [id, `legacy ${index}`]);
  const oldRelation = randomUUID();
  await pool.query(`insert into entity_relations (id, subject_entity_id, predicate, object_entity_id, source_item_id, evidence_chunk_id, confidence)
    values ($1, $2, 'foi_usado_para_acusar', $3, $4, $5, 0.9)`, [oldRelation, oldIds[0], oldIds[1], source.id, chunkId]);
  assert.equal((await runMigrations(pool, migrations, { seedFolder })).seed.applied, false);
  assert.equal((await pool.query("select predicate from entity_relations where id = $1", [oldRelation])).rows[0].predicate, "foi_usado_para_acusar");
  assert.equal((await pool.query("select count(*)::int as n from entities where id = any($1::uuid[])", [oldIds])).rows[0].n, 2);
  assert.equal((await pool.query("select relation_type_id from entity_relations where id = $1", [oldRelation])).rows[0].relation_type_id, null);
  const types = createRelationTypeRepository(pool);
  const first = await types.commit([{ predicate: "used_to_accuse", definition: "The subject was used to accuse the object.", target: null, vector: vector(), metadata: {} }], await types.revision());
  const type = first!.get("used_to_accuse")!;
  const revision = await types.revision();
  const matched = await types.commit([{ predicate: "utilized_to_accuse", definition: type.definition, target: { id: type.id }, vector: vector(), metadata: { score: 0.99, threshold: 0.92, aiTaskRunId: "test" } }], revision);
  assert.equal(matched!.get("utilized_to_accuse")!.id, type.id);
  assert.equal((await types.findExact(["utilized_to_accuse"])).get("utilized_to_accuse")!.predicate, "used_to_accuse");
  assert.equal(await types.commit([], revision), null, "Stale catalog revisions must retry");
  for (const size of [256, 768, 1024]) {
    await types.saveVector(type.id, vector(size));
    assert.equal((await types.candidates(vector(size), 0.92))[0]?.id, type.id);
    assert.equal((await types.candidates(vector(size, 1), 0.92)).length, 0);
    assert.equal((await types.candidates({ ...vector(size), spaceKey: "different-model" }, 0.92)).length, 0);
  }
  const identities = createEntityIdentityRepository(pool);
  const decision = (key: string, context: string): EntityIdentityDecision => ({ key, fingerprint: key, sourceItemId: source.id, type: "Person", canonicalName: "John Smith",
    identityDescription: context, aliases: [], confidence: 0.9, language: "en", target: null, vector: vector(), metadata: {} });
  const a = decision("a", "Physicist born in 1950"), b = decision("b", "Musician born in 1980");
  const created = await identities.commit([a, b], await identities.revision());
  const aId = created!.get("a")!, bId = created!.get("b")!;
  assert.notEqual(aId, bId, "Homonyms must have independent canonical IDs");
  const merged = await identities.commit([{ ...a, key: "alias", fingerprint: "alias", canonicalName: "J. Smith", target: { id: aId } }], await identities.revision());
  assert.equal(merged!.get("alias"), aId);
  assert.equal((await identities.findResolved(["alias"])).get("alias"), aId);
  assert.equal((await identities.candidates({ type: "Organization", names: ["John Smith"], vector: vector(), threshold: 0.92 })).length, 0);
  assert.equal((await identities.candidates({ type: "Person", names: ["John Smith"], vector: vector(256, 1), threshold: 0.92 })).length, 2, "Exact names are candidates, not automatic merges");
  for (const size of [768, 1024]) { await identities.saveVector(aId, vector(size)); assert.equal((await identities.candidates({ type: "Person", names: [], vector: vector(size), threshold: 0.92 }))[0]?.id, aId); }
  const count = (await pool.query("select count(*)::int as n from entities")).rows[0].n;
  await assert.rejects(identities.commit([{ ...a, key: "rollback", fingerprint: "rollback" }, { ...b, key: "invalid", fingerprint: "invalid", target: { id: randomUUID() } }], await identities.revision()));
  assert.equal((await pool.query("select count(*)::int as n from entities")).rows[0].n, count, "Invalid target must roll back the whole batch");
  const graph = createKnowledgeGraphRepository(pool);
  await graph.replaceSourceExtraction({ sourceItemId: source.id, language: "en", generation: {}, batches: [{ entities: [aId, bId].map((id, index) => ({
    key: `e${index}`, canonicalEntityId: id, type: "Person", canonicalName: "John Smith", aliases: [], confidence: 0.8, evidenceChunkIds: [chunkId] })), claims: [], relations: [{
      subjectEntityKey: "e0", objectEntityKey: "e1", predicate: type.predicate, relationTypeId: type.id, originalPredicate: "utilized_to_accuse", displayLabel: "Was used to accuse", confidence: 0.9, evidenceChunkIds: [chunkId] }] }] });
  const stored = (await pool.query("select * from entity_relations where source_item_id = $1", [source.id])).rows[0];
  assert.equal(stored.relation_type_id, type.id); assert.equal(stored.subject_entity_id, aId); assert.equal(stored.object_entity_id, bId); assert.equal(stored.evidence_chunk_id, chunkId);
  const elements = await graph.listSourceElements(source.id); assert.equal(elements.entities.length, 2); assert.equal(elements.relations[0]?.subjectEntityId, aId);
  await graph.projectSource(source.id);
  const columns = await pool.query("select udt_name from information_schema.columns where table_name = 'entity_relations' and column_name = 'relation_type_id'");
  assert.equal(columns.rows[0]?.udt_name, "uuid");
  assert.equal((await pool.query("select count(*)::int as n from pg_indexes where indexname = 'entities_type_normalized_name_uidx'")).rows[0].n, 0);
  assert.equal((await pool.query("select count(*)::int as n from pg_indexes where indexname = 'entities_type_normalized_name_idx'")).rows[0].n, 1);
  await pool.query("create database identity_empty");
  const url = new URL(connection.connectionString); url.pathname = "/identity_empty";
  emptyPool = createPgPool({ connectionString: url.toString(), max: 2 });
  assert.equal((await runMigrations(emptyPool, migrations, { seedFolder })).seed.applied, true);
  assert.equal((await emptyPool.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0].n, journal.entries.length);
  console.log("Verified populated upgrade and empty baseline, canonical aliases, all vector dimensions/model isolation, homonyms, evidence reuse, rollback, checkpoints, relational endpoints and real AGE projection.");
} finally {
  if (emptyPool) await closePgPool(emptyPool);
  if (pool) await closePgPool(pool);
  await manager.stop(); await rm(workDir, { recursive: true, force: true });
}
