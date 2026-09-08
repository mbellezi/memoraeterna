import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPgPool, closePgPool, PostgresSidecarManager, resolvePostgresSidecarPaths, runMigrations,
  createSourceItemRepository, createDocumentRepository, createChunkRepository, createAtomicNoteRelationRepository,
  createMatchingEvaluationRepository, createHierarchicalIngestionRepository, createIngestionRunRepository } from "../index.js";

const root=resolve(import.meta.dirname,"../../../..");
const work=await mkdtemp(join(tmpdir(),"memora-matching-benchmark-"));
const paths=resolvePostgresSidecarPaths({cwd:root,env:process.env});
const manager=new PostgresSidecarManager({binDir:paths.binDir,dataDir:join(work,"data"),database:"benchmark_test",user:"benchmark_test",password:randomUUID(),startupTimeoutMs:30000,shutdownTimeoutMs:10000});
let pool;
try {
  const connection=await manager.start();pool=createPgPool({connectionString:connection.connectionString,max:2});
  await runMigrations(pool,join(root,"packages/db/drizzle"),{seedFolder:join(root,"packages/db/seed")});
  const sources=createSourceItemRepository(pool),ids:string[]=[];
  for(let i=0;i<62;i++)ids.push((await sources.create({type:"StandaloneArticle",title:`Synthetic ${i}`})).id);
  const hierarchy=createHierarchicalIngestionRepository(pool),runs=createIngestionRunRepository(pool);
  const emptyDocument=await createDocumentRepository(pool).create({sourceItemId:ids[2]!,title:"Index",canonicalMarkdown:"# Index",contentHash:"empty-content-hash"});
  const revision=await hierarchy.ensureCurrentDocumentRevision(emptyDocument.id,emptyDocument.contentHash);
  const emptyRun=await runs.create({sourceItemId:ids[2]!,inputDocumentRevisionId:revision,inputHashes:{contentHash:"empty-content-hash"},requestedStages:["atomicNotes","summarization"],effectiveStages:["atomicNotes","summarization"]});
  await runs.initializeStages(emptyRun.id,["atomicNotes","summarization"],["atomicNotes","summarization"]);
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).summarization,false);
  await runs.completeStage(emptyRun.id,"summarization",{configured:true,generated:false,skippedReason:"non_content"});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).summarization,true,"A validated non-content summary outcome is reusable");
  await runs.completeStage(emptyRun.id,"summarization",{configured:true,generated:false,skippedReason:"too_short"});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).summarization,false,"Word-count policy is re-evaluated independently");
  await runs.completeStage(emptyRun.id,"summarization",{configured:false,generated:false,skippedReason:"non_content"});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).summarization,false);
  await runs.completeStage(emptyRun.id,"summarization",{configured:true,generated:false,skippedReason:"non_content"});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).atomicNotes,false);
  await hierarchy.createKnowledgeGeneration({sourceItemId:ids[2]!,documentRevisionId:revision,stage:"atomicNotes",ingestionRunId:emptyRun.id,inputHash:"empty-content-hash",metadata:{promptVersion:"test"}});
  await runs.completeStage(emptyRun.id,"atomicNotes",{configured:true,generatedCount:0,noteIds:[]});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).atomicNotes,true,"A completed, validated zero-note result is reusable");
  await runs.failStage(emptyRun.id,"atomicNotes","invalid output");
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).atomicNotes,false,"Invalid output is not an empty result");
  await runs.completeStage(emptyRun.id,"atomicNotes",{configured:false,generatedCount:0,noteIds:[]});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).atomicNotes,false,"An unavailable model is not a validated empty result");
  await runs.completeStage(emptyRun.id,"atomicNotes",{configured:true,generatedCount:0,noteIds:[]});
  await createDocumentRepository(pool).update(emptyDocument.id,{contentHash:"changed-content-hash",canonicalMarkdown:"Changed source"});
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).atomicNotes,false,"Changed content invalidates an empty result");
  assert.equal((await hierarchy.getArtifactState(ids[2]!,emptyDocument.id)).summarization,false,"Changed content invalidates a non-content classification");
  const noteIds=[randomUUID(),randomUUID()].sort(),chunkIds:string[]=[];
  for(const [i,id] of ids.slice(0,2).entries()){
    const content=`A synthetic evidence proposition ${i}`;
    const document=await createDocumentRepository(pool).create({sourceItemId:id,title:content,canonicalMarkdown:content,contentHash:content});
    const chunkId=randomUUID(),spanId=randomUUID();chunkIds.push(chunkId);
    await createChunkRepository(pool).replaceDocumentChunks(document.id,id,[{id:chunkId,sourceSpanId:spanId,chunkIndex:0,content,contentHash:content,span:{id:spanId,startOffset:0,endOffset:content.length}}]);
    await pool.query(`insert into atomic_notes (id,title,body_markdown,idea_statement,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key)
      values ($1,$2,$2,$2,$3,$4,'test','test','local','test',$1::uuid::text)`,[noteIds[i],content,id,chunkId]);
  }
  const relation=await createAtomicNoteRelationRepository(pool).upsert({sourceAtomicNoteId:noteIds[0]!,targetAtomicNoteId:noteIds[1]!,relationType:"supports",finalScore:0.9,explanation:"Synthetic evidence"});
  const sourceId=randomUUID();
  await pool.query(`insert into source_relations (id,source_item_id,target_source_item_id,identity_key,relation_type,source_idea,target_idea,explanation,importance,confidence)
    values ($1,$2,$3,'synthetic','supports','A','B','Evidence',0.9,0.9)`,[sourceId,ids[0],ids[1]]);
  await pool.query(`insert into source_relation_evidence (relation_id,evidence_key,origin,source_chunk_id,target_chunk_id,note_relation_id,snapshot,metadata)
    values ($1,'synthetic','atomic_notes',$2,$3,$4,'{}','{}')`,[sourceId,chunkIds[0],chunkIds[1],relation.id]);
  const repository=createMatchingEvaluationRepository(pool);
  const fingerprint=await repository.canonicalFingerprint(ids);
  const snapshot=await repository.snapshot(ids,new Date().toISOString());
  await repository.resetPilotMatching(ids,62);
  assert.equal((await repository.snapshot(ids,new Date().toISOString())).noteRelations?.length,0);
  await repository.resetPilotMatching(ids,62,snapshot);
  const restored=await repository.snapshot(ids,new Date().toISOString());
  for(const table of ["noteRelations","sourceRelations","sourceEvidence"])assert.deepEqual(restored[table],snapshot[table]);
  assert.deepEqual(await repository.canonicalFingerprint(ids),fingerprint);
  const malformed=structuredClone(snapshot);(malformed.sourceEvidence![0] as Record<string,unknown>).source_chunk_id=randomUUID();
  await assert.rejects(repository.resetPilotMatching(ids,62,malformed));
  assert.deepEqual((await repository.snapshot(ids,new Date().toISOString())).sourceEvidence,snapshot.sourceEvidence,"A failed restore must roll back the reset too");
  await pool.query("update source_relations set status='accepted' where id=$1",[sourceId]);
  await assert.rejects(repository.resetPilotMatching(ids,62,snapshot),/reviewed relationships/);
  assert.equal((await pool.query("select status from source_relations where id=$1",[sourceId])).rows[0].status,"accepted");
  console.log("Verified validated empty-note reuse and invalidation; exact 62-source reset; full relationship/evidence restoration with stable IDs; canonical preservation; rollback on invalid evidence; refusal of reviewed data in isolated PostgreSQL.");
} finally {if(pool)await closePgPool(pool);await manager.stop();await rm(work,{recursive:true,force:true});}
