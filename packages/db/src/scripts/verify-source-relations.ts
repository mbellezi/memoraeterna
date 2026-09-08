import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository, createSourceRelationRepository,
  createEntityIdentityRepository, createRelationTypeRepository,
  createAtomicNoteRelationRepository, createKnowledgeGraphDashboardRepository, createEmbeddingRepository,
  listSourceRelations, type SourceRelationChunk, type SourceRelationWrite } from "../index.js";
import { createIngestionRunRepository } from "../repositories/ingestionRunRepository.js";
import { createSourceSummaryRepository } from "../repositories/sourceSummaryRepository.js";

const root = resolve(import.meta.dirname,"../../../..");
const workDir = await mkdtemp(join(tmpdir(),"memora-source-relations-"));
const migrations = join(root,"packages/db/drizzle"), seedFolder = join(root,"packages/db/seed");
const sidecar = resolvePostgresSidecarPaths({cwd:root,env:process.env});
const manager = new PostgresSidecarManager({binDir:sidecar.binDir,dataDir:join(workDir,"data"),database:"relations_test",
  user:"relations_test",password:randomUUID(),startupTimeoutMs:30000,shutdownTimeoutMs:10000});
let pool,emptyPool;
try {
  const connection = await manager.start();
  pool = createPgPool({connectionString:connection.connectionString,max:4});
  const journal = JSON.parse(await readFile(join(migrations,"meta/_journal.json"),"utf8"));
  const prior = journal.entries.filter((entry: {idx:number}) => entry.idx < 22), oldFolder = join(workDir,"old");
  await mkdir(join(oldFolder,"meta"),{recursive:true});
  await writeFile(join(oldFolder,"meta/_journal.json"),JSON.stringify({...journal,entries:prior}));
  for (const entry of prior) await copyFile(join(migrations,`${entry.tag}.sql`),join(oldFolder,`${entry.tag}.sql`));
  await runMigrations(pool,oldFolder);
  const sources = createSourceItemRepository(pool);
  const book = await sources.create({type:"Book",title:"Learning mechanisms"});
  const a = await sources.create({type:"BookChapter",title:"Retrieval and lasting learning"});
  const b = await sources.create({type:"AcademicPaper",title:"Retrieval mechanisms and learning"});
  const sibling = await sources.create({type:"BookChapter",title:"Other learning mechanisms"});
  await pool.query("update source_items set parent_source_item_id = $1 where id = any($2::uuid[])",[book.id,[a.id,sibling.id]]);
  assert.equal((await runMigrations(pool,migrations,{seedFolder})).seed.applied,false);
  assert.equal((await pool.query("select title from source_items where id = $1",[a.id])).rows[0].title,a.title);
  for (const table of ["source_relations","source_relation_evidence","source_matching_decisions","source_matching_runs"]) {
    assert.equal((await pool.query("select count(*)::int as n from information_schema.tables where table_name = $1",[table])).rows[0].n,1);
  }
  const chunk = async (source: typeof a, content: string): Promise<SourceRelationChunk> => {
    const doc = await createDocumentRepository(pool!).create({sourceItemId:source.id,title:source.title,canonicalMarkdown:content,contentHash:content});
    const id = randomUUID(), span = randomUUID();
    await createChunkRepository(pool!).replaceDocumentChunks(doc.id,source.id,[{id,sourceSpanId:span,chunkIndex:0,content,contentHash:content,
      span:{id:span,startOffset:0,endOffset:content.length}}]);
    return {id,sourceItemId:source.id,documentId:doc.id,sourceSpanId:span,content,contentHash:content,title:source.title,summary:content,rootId:source.id === b.id ? b.id : book.id};
  };
  const ac = await chunk(a,"Retrieval practice improves long-term retention through effortful recall.");
  const bc = await chunk(b,"Effortful retrieval strengthens retention; feedback supports correction of errors.");
  const sc = await chunk(sibling,"Feedback mechanisms explain learning errors.");
  await sources.update(a.id,{summary:ac.content});await sources.update(b.id,{summary:bc.content});
  const repository = createSourceRelationRepository(pool);
  assert.equal(await createEmbeddingRepository(pool).hasSourceMatchingCoverage(a.id,ac.documentId),false);
  for (const c of [ac,bc]) await createSourceSummaryRepository(pool).create({sourceItemId:c.sourceItemId,summary:c.content,
    provider:"test",model:"test",runtime:"local",promptVersion:"summary-v3",inputHash:c.contentHash,outputHash:c.contentHash,
    metadata:{concepts:[{idea:"Effortful recall strengthens long-term retention.",evidenceChunkIds:[c.id]}]}});
  assert.deepEqual((await repository.roots([book.id,a.id,sibling.id,b.id])).sort(),[book.id,b.id].sort());
  const fingerprint = await repository.fingerprint(book.id);
  await pool.query("update chunks set chunking_version = 'test-v2' where id = $1",[ac.id]);
  assert.notEqual(await repository.fingerprint(book.id),fingerprint,"Rechunking invalidates cached pair decisions even when the document text is unchanged");
  const found = await repository.candidates(book.id,40);
  assert.ok(found.some((item) => item.id === b.id && item.textScore > 0));
  assert.ok(found.every((item) => item.id === b.id),"Text retrieval excludes the querying root and all its subitems before reranking");
  const evidence = await repository.pairChunks(book.id,b.id,[],4);
  assert.ok(evidence.some((item) => item.id === ac.id && item.rootId === book.id));
  for (const dimensions of [256,768,1024]) {
    const vector = Array.from({length:dimensions},(_,i) => i === 0 ? 1 : 0);
    for (const source of [a,b,sibling]) await createEmbeddingRepository(pool).upsert({targetType:"source_item",targetId:source.id,provider:"test",model:`test-${dimensions}`,
      runtime:"local",strategy:`source-composite-centroid-v2:space-${dimensions}`,contentHash:"test",embedding:vector});
  }
  assert.ok((await repository.candidates(book.id,40)).some((item) => item.id === b.id && item.vectorScore > 0.99));
  assert.ok((await repository.candidates(book.id,40)).every((item) => item.id === b.id),"Even identical sibling vectors cannot retrieve the querying root");
  for (const dimensions of [256,768,1024]) await pool.query(`update embeddings_${dimensions} set strategy = 'source-composite-centroid-v2:different' where target_id = $1`,[b.id]);
  assert.equal((await repository.candidates(book.id,40)).find((item) => item.id === b.id)?.vectorScore,0);
  const beforeVectors=await repository.fingerprint(book.id);
  for (const dimensions of [256,768,1024]) for (const c of [ac,bc]) await createEmbeddingRepository(pool).upsert({targetType:"chunk",targetId:c.id,chunkId:c.id,
    provider:"test",model:`test-${dimensions}`,runtime:"local",strategy:`native-v2:space-${dimensions}`,contentHash:c.contentHash,
    embedding:Array.from({length:dimensions},(_,i)=>i===0?1:0)});
  assert.notEqual(await repository.fingerprint(book.id),beforeVectors,"New compatible vectors invalidate retrieval decisions");
  assert.equal(await createEmbeddingRepository(pool).hasSourceMatchingCoverage(a.id,ac.documentId),true);
  assert.ok((await repository.candidates(book.id,40)).some((item)=>item.id===b.id&&item.vectorScore>0.99),"Chunk vectors independently discover source candidates");
  assert.ok((await repository.pairChunks(book.id,b.id,[],1)).some((item)=>item.id===ac.id));
  const noteIds = [randomUUID(),randomUUID()].sort().reverse();
  for (const [index,c] of [ac,bc].entries()) await pool.query(`insert into atomic_notes
    (id,title,body_markdown,idea_statement,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
    values ($1::uuid,$2,$2,$2,$3,$4,'test','test','local','test',$1::uuid::text)`,[noteIds[index],c.content,c.sourceItemId,c.id]);
  const noteRelation = await createAtomicNoteRelationRepository(pool).upsert({sourceAtomicNoteId:noteIds[0]!,targetAtomicNoteId:noteIds[1]!,relationType:"supports",finalScore:0.95,explanation:"test",
    metadata:{semanticSourceAtomicNoteId:noteIds[0]!,semanticTargetAtomicNoteId:noteIds[1]!}});
  assert.deepEqual(await createAtomicNoteRelationRepository(pool).existingTargets(noteIds[0]!, [noteIds[1]!]), new Set([noteIds[1]!]));
  assert.deepEqual(await createAtomicNoteRelationRepository(pool).existingTargets(noteIds[1]!, [noteIds[0]!]), new Set([noteIds[0]!]));
  const boundedEvidence = await repository.pairChunks(book.id,b.id,[ac.id,sc.id,bc.id],1);
  assert.equal(boundedEvidence.filter((chunk)=>chunk.rootId===book.id).length,1);
  assert.equal(boundedEvidence.filter((chunk)=>chunk.rootId===b.id).length,1);
  const notes = await repository.pairNotes(book.id,b.id);
  assert.equal(notes[0]?.sourceItemId,a.id,"The semantic direction survives sorted UUID storage");
  await pool.query("update atomic_note_relations set relation_type = 'contrasts' where id = $1",[noteRelation.id]);
  const symmetric = (await repository.pairNotes(book.id,b.id))[0]!;
  assert.equal(symmetric.sourceItemId,[a.id,b.id].sort()[0],"Symmetric relationships have one stable orientation");
  await pool.query("update atomic_note_relations set relation_type = 'supports' where id = $1",[noteRelation.id]);
  const relation: SourceRelationWrite = {existingId:null,sourceItemId:a.id,targetSourceItemId:b.id,relationType:"supports",sourceIdea:ac.content,targetIdea:bc.content,
    explanation:"Both describe retention through retrieval.",importance:0.9,confidence:0.95,evidence:[{source:ac,target:bc,note:notes[0]!}]};
  assert.equal(await repository.commitDecision("first",book.id,b.id,[relation],{proposals:1}),1);
  assert.deepEqual(await repository.pairNotes(book.id,b.id),[],"Already represented note relationships are excluded before reranking");
  assert.equal((await repository.candidates(book.id,40)).find((item) => item.id === b.id)?.noteScore,0,"Existing note links no longer promote a reranking candidate");
  assert.equal(await repository.commitDecision("first",book.id,b.id,[relation],{proposals:1}),0);
  let page = await listSourceRelations(pool,book.id,b.id);
  assert.equal(page.relations.length,1);assert.equal(page.relations[0]!.current,true);
  const id = String(page.relations[0]!.id);
  await repository.commitDecision("direct",book.id,b.id,[{...relation,existingId:id,evidence:[{source:ac,target:bc,note:null}]}],{proposals:1});
  page = await listSourceRelations(pool,book.id,b.id);
  assert.equal(page.relations.length,1);assert.equal(page.relations[0]!.evidence.length,2,"Two origins enrich one conceptual relationship");
  let graph = await createKnowledgeGraphDashboardRepository(pool).get("sources","relations");
  assert.equal(graph.edges.length,1,"Repeated evidence never increases prevalence");
  assert.equal(graph.edges[0]!.source,a.id);assert.equal(graph.edges[0]!.label,"supports");
  assert.equal(await repository.review(id,"accepted",page.relations[0]!.updatedAt),true);
  await repository.commitDecision("second-idea",book.id,b.id,[{...relation,sourceIdea:"A distinct idea",evidence:[{source:sc,target:bc,note:null}],sourceItemId:sibling.id}],{proposals:1});
  assert.equal((await listSourceRelations(pool,a.id,b.id)).relations.length,1,"A chapter preview must exclude sibling evidence");
  assert.equal((await listSourceRelations(pool,book.id,b.id,0,1)).hasMore,true);
  await pool.query("update atomic_note_relations set status = 'rejected' where id = $1",[noteRelation.id]);
  page = await listSourceRelations(pool,a.id,b.id);
  assert.equal(page.relations[0]!.current,true,"The independent direct evidence remains current");
  assert.equal(page.relations[0]!.evidence.filter((item: {current:boolean}) => item.current).length,1);
  assert.equal(page.relations[0]!.status,"accepted");
  await pool.query("update documents set metadata = jsonb_build_object('supersededByDocumentId',$2::text) where id = $1",[ac.documentId,randomUUID()]);
  page = await listSourceRelations(pool,a.id,b.id);
  assert.equal(page.relations[0]!.current,false);assert.equal(page.relations[0]!.status,"accepted");
  graph = await createKnowledgeGraphDashboardRepository(pool).get("sources","relations");
  assert.equal(graph.edges.some((edge) => edge.id === id),false,"Superseded evidence is not a live graph edge");
  await assert.rejects(repository.commitDecision("stale",book.id,b.id,[relation],{}));
  assert.equal(await repository.decision("stale"),null,"An invalid batch rolls back its checkpoint");
  await repository.commitDecision("negative",book.id,b.id,[],{proposals:0});assert.ok(await repository.decision("negative"));
  await repository.saveRun("run",book.id,{inputTokens:123,proposals:2});assert.equal((await repository.runState("run"))?.inputTokens,123);
  const runs=createIngestionRunRepository(pool);
  const run=await runs.create({sourceItemId:book.id,effectiveStages:["sourceMatching"],requestedStages:["sourceMatching"]});
  await runs.initializeStages(run.id,["sourceMatching"],["sourceMatching"]);await runs.complete(run.id);
  await runs.updateStageProgress(run.id,"sourceMatching",0.5,{});
  await runs.failStage(run.id,"sourceMatching","synthetic failure");
  const failed=await runs.findById(run.id);
  assert.equal(failed?.status,"succeeded","A collective stage must not reactivate a finished participant's job");
  assert.equal((failed?.stagesCheckpoint.sourceMatching as {status:string}).status,"failed");
  const entityCatalog = createEntityIdentityRepository(pool), typeCatalog = createRelationTypeRepository(pool);
  for (const dimensions of [256,768,1024]) {
    const vector = { embedding: Array.from({length:dimensions},(_,i)=>i===0?1:0), spaceKey: "matching-calibration", contentHash: "fixture", provider: "test", model: "test", runtime: "local", metadata: {} };
    for (let i=0;i<5;i++) {
      const entityId=randomUUID(),typeId=randomUUID();
      await pool.query("insert into entities (id,type,canonical_name,normalized_name,confidence) values ($1,'Concept',$2,$2,1)",[entityId,`candidate-${dimensions}-${i}`]);
      await entityCatalog.saveVector(entityId,vector);
      await pool.query("insert into relation_types (id,predicate,definition) values ($1,$2,'A synthetic calibration definition')",[typeId,`candidate_${dimensions}_${i}`]);
      await typeCatalog.saveVector(typeId,vector);
    }
    assert.equal((await entityCatalog.candidates({type:"Concept",names:[],vector,threshold:0.5,limit:1})).length,1);
    assert.equal((await entityCatalog.candidates({type:"Concept",names:[],vector,threshold:0.5,limit:5})).length,5);
    assert.equal((await typeCatalog.candidates(vector,0.5,1)).length,1);
    assert.equal((await typeCatalog.candidates(vector,0.5,5)).length,5);
  }
  await pool.query("create database relations_empty");
  const url = new URL(connection.connectionString);url.pathname="/relations_empty";
  emptyPool=createPgPool({connectionString:url.toString(),max:2});
  assert.equal((await runMigrations(emptyPool,migrations,{seedFolder})).seed.applied,true);
  assert.equal((await emptyPool.query("select count(*)::int as n from drizzle.__drizzle_migrations")).rows[0].n,journal.entries.length);
  await pool.query("delete from source_items where id = any($1::uuid[])",[[book.id,a.id,sibling.id]]);
  assert.equal((await pool.query("select count(*)::int as n from source_relations")).rows[0].n,0);
  console.log("Verified populated upgrade and empty baseline; all vector spaces; chapter ownership and direction; both origins, deduplication, pagination, review preservation, invalidation, rollback, negative cache, durable budget and deletion; configurable canonical candidate limits, saved note-pair lookup and per-root evidence caps.");
} finally {
  if (emptyPool) await closePgPool(emptyPool);if (pool) await closePgPool(pool);
  await manager.stop();await rm(workDir,{recursive:true,force:true});
}
