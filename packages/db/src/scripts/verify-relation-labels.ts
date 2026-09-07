import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository,
  createKnowledgeGraphRepository, createKnowledgeGraphDashboardRepository, createJobRepository
} from "../index.js";

const root = resolve(import.meta.dirname, "../../../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-relation-labels-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({ binDir: sidecar.binDir, dataDir: join(workDir, "data"),
  database: "relation_labels_test", user: "relation_labels_test", password: randomUUID(), startupTimeoutMs: 30_000, shutdownTimeoutMs: 10_000 });
let pool;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
  await runMigrations(pool, resolve(root, "packages/db/drizzle"), { seedFolder: resolve(root, "packages/db/seed") });
  const graph = createKnowledgeGraphRepository(pool);
  const sources = createSourceItemRepository(pool);
  const source = await sources.create({ type: "PersonalNote", title: "Evidence source" });
  const other = await sources.create({ type: "PersonalNote", title: "Other evidence" });
  for (const item of [source, other]) {
    const doc = await createDocumentRepository(pool).create({ sourceItemId: item.id, title: item.title, canonicalMarkdown: "Evidence was used to accuse a person.", contentHash: "a".repeat(64) });
    const chunkId = randomUUID(), spanId = randomUUID();
    await createChunkRepository(pool).replaceDocumentChunks(doc.id, item.id, [{ id: chunkId, sourceSpanId: spanId,
      chunkIndex: 0, content: doc.canonicalMarkdown, contentHash: "a".repeat(64), span: { id: spanId, startOffset: 0, endOffset: 36 } }]);
    await graph.replaceSourceExtraction({ sourceItemId: item.id, language: "pt-BR", generation: { displayLanguage: "pt-BR", promptVersion: "knowledge-graph-v6", retained: "evidence" }, batches: [{
      entities: ["Evidence", "Person"].map((name, index) => ({ key: `e${index + 1}`, type: "Concept", canonicalName: name, aliases: [], confidence: 0.9, evidenceChunkIds: [chunkId] })),
      claims: [], relations: [{ subjectEntityKey: "e1", predicate: "used_to_accuse", displayLabel: "Foi usado para acusar", objectEntityKey: "e2", confidence: 0.9, evidenceChunkIds: [chunkId] }]
    }] });
  }
  const beforeRows = await pool.query("select * from entity_relations order by id");
  assert.equal(beforeRows.rows[0].metadata.displayLabel, "Foi usado para acusar");
  const firstId = beforeRows.rows[0].id as string;
  await pool.query("update entity_relations set metadata = metadata - 'displayLabel' where id = $1", [firstId]);
  const [jobId, duplicateId] = await Promise.all([graph.queueRelationLabels({ mode: "missing", contentLanguage: "pt-BR" }), graph.queueRelationLabels({ mode: "missing", contentLanguage: "pt-BR" })]);
  assert.equal(jobId, duplicateId);
  const job = await createJobRepository(pool).findById(jobId);
  const selection = { jobId, mode: "missing" as const, before: String(job!.payload.before) };
  assert.equal(await graph.countRelationLabels(selection), 1);
  assert.deepEqual((await graph.listRelationLabels(selection)).map((row) => row.id), [firstId]);
  await graph.saveRelationLabels([{ id: firstId, displayLabel: "Foi usado para acusar" }], { displayLanguage: "pt-BR", labelJobId: jobId });
  assert.equal(await graph.relationLabelProgress(jobId), 1);
  assert.deepEqual(await graph.listRelationLabels(selection), []);
  const changed = await pool.query("select * from entity_relations order by id");
  for (const [index, row] of changed.rows.entries()) {
    const prior = beforeRows.rows[index];
    for (const key of ["id", "predicate", "subject_entity_id", "object_entity_id", "source_item_id", "evidence_chunk_id", "source_span_id", "confidence"]) assert.equal(row[key], prior[key]);
    assert.equal(row.metadata.retained, "evidence");
  }
  await graph.saveRelationLabels(changed.rows.map((row) => ({ id: row.id as string, displayLabel: "Was used to accuse" })), { displayLanguage: "en", labelJobId: "second-job" });
  const elements = await graph.listSourceElements(source.id);
  assert.equal(elements.relations[0]?.predicate, "used_to_accuse");
  assert.equal(elements.relations[0]?.displayLabel, "Was used to accuse");
  assert.equal(elements.sourceConnections.find((row) => row.predicate !== "shared_entity")?.displayLabel, "Was used to accuse");
  const dashboard = createKnowledgeGraphDashboardRepository(pool);
  const details = await dashboard.getSourceConnectionDetails(source.id, other.id);
  assert.equal(details.relations[0]?.label, "Was used to accuse");
  assert(details.semanticRelations.every((value) => value.includes("Was used to accuse")));
  await dashboard.get("sources");
  await graph.searchElements({ text: "Evidence", limit: 10 });
  const history = await pool.query("select count(*)::int as count from drizzle.__drizzle_migrations");
  console.log(`Verified real PostgreSQL: ${history.rows[0].count} baseline migrations; description persistence, missing/all selection, duplicate job prevention, restart checkpoints, preserved IDs/evidence, source details and dashboard queries.`);
} finally {
  if (pool) await closePgPool(pool);
  await manager.stop();
  await rm(workDir, { recursive: true, force: true });
}
