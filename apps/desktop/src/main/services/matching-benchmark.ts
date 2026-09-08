import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { sha256 } from "@app/conversion";
import { createAiConfigRepository, createEmbeddingRepository, createKnowledgeGraphRepository, createMatchingEvaluationRepository } from "@app/db";
import { ProcessingPlanRequestSchema } from "@app/domain";
import { appSettingsSchema, containerSourceInputSchema, manualIngestionInputSchema, type AppSettings, type AppSettingsUpdate } from "../../shared/ipc.js";
import type { AiService } from "./ai-service.js";
import { isMatchingPilotComplete, type runMatchingPilot } from "./matching-pilot.js";

const documentSchema = z.object({ key:z.string(),title:z.string(),content:z.string(),ideas:z.array(z.string()) });
const sourceSchema = z.union([documentSchema,z.object({key:z.string(),title:z.string(),chapters:z.array(documentSchema).length(2)})]);
const corpusSchema = z.object({version:z.literal("matching-benchmark-v1"),sources:z.array(z.intersection(sourceSchema,z.object({partition:z.enum(["tuning","holdout"]),family:z.string()}))).length(60)});
const phaseSchema = z.enum(["prepare","baseline","economy","coverage","validate","stop"]);
type Phase = z.infer<typeof phaseSchema>;
const phaseStateSchema = z.object({startedAt:z.string(),batchId:z.string().uuid().nullable(),status:z.enum(["running","completed","failed"]),backup:z.string().optional(),error:z.string().optional(),verifiedAt:z.string().datetime().optional()});
const manifestSchema = z.object({version:z.literal("matching-benchmark-v1"),startedAt:z.string(),ids:z.record(z.string(),z.string().uuid()),phases:z.record(z.string(),phaseStateSchema),warmedNotes:z.array(z.string()),initialBackup:z.string(),fixtureHash:z.string()});
const sleep = (ms:number) => new Promise<void>(done=>setTimeout(done,ms));

export function benchmarkConfiguration(reference:AppSettings, variant:"baseline"|"economy"|"coverage"):AppSettingsUpdate {
  const base = {atomicNoteRelationThreshold:reference.atomicNoteRelationThreshold,
    atomicNoteMatchingSettings:reference.atomicNoteMatchingSettings,canonicalMatchingSettings:reference.canonicalMatchingSettings,
    entityIdentitySimilarityThreshold:reference.entityIdentitySimilarityThreshold,relationTypeSimilarityThreshold:reference.relationTypeSimilarityThreshold,
    sourceRelationSettings:reference.sourceRelationSettings};
  if (variant === "economy") return {...base,atomicNoteMatchingSettings:{...base.atomicNoteMatchingSettings,textCandidateLimit:20,vectorCandidateLimit:20,graphCandidateLimit:10,fusedCandidateLimit:20,minimumGraphOnlyCandidates:3},
    sourceRelationSettings:{...base.sourceRelationSettings,maxCandidates:30,maxPairs:6,evidenceChunksPerSource:2,evidenceMaxCharacters:800,summaryMaxCharacters:1000,noteRelationsPerPair:4}};
  if (variant === "coverage") return {...base,atomicNoteMatchingSettings:{...base.atomicNoteMatchingSettings,textCandidateLimit:50,vectorCandidateLimit:50,graphCandidateLimit:30,fusedCandidateLimit:40,minimumGraphOnlyCandidates:8},
    sourceRelationSettings:{...base.sourceRelationSettings,maxCandidates:60,maxPairs:12,evidenceChunksPerSource:4,noteRelationsPerPair:8}};
  return base;
}

/** Explicit DEV-only experiment controller. Source assessment labels never enter ingestion or AI inputs. */
export async function runMatchingBenchmark(options:Parameters<typeof runMatchingPilot>[0] & {ai:AiService}) {
  if(options.isPackaged || !resolve(options.userDataPath).endsWith("/@app/desktop")) throw Error("Benchmark requires the unpackaged DEV profile");
  const descriptor = z.object({developmentOnly:z.literal(true)}).parse(JSON.parse(await readFile(join(options.userDataPath,"database/dev-connection.json"),"utf8")));
  if(!descriptor.developmentOnly) throw Error("DEV required");
  const directory=join(options.workspaceRoot,".cache/matching-benchmark");
  await mkdir(directory,{recursive:true});
  const fixtureText=await readFile(join(options.workspaceRoot,"scripts/fixtures/matching-benchmark.json"),"utf8");
  const corpus=corpusSchema.parse(JSON.parse(fixtureText));
  if(corpus.sources.filter(s=>s.partition==="tuning").length!==40 || corpus.sources.filter(s=>s.partition==="holdout").length!==20) throw Error("Invalid benchmark split");
  const allKeys=corpus.sources.flatMap(s=>[s.key,...("chapters" in s?s.chapters.map(c=>c.key):[])]);
  if(new Set(allKeys).size!==82 || allKeys.length!==82) throw Error("Invalid benchmark source identities");
  const reference=appSettingsSchema.parse(JSON.parse(await readFile(join(directory,"settings-before.json"),"utf8")));
  const repository=createMatchingEvaluationRepository(options.pool);
  const manifestPath=join(directory,"manifest.json");
  let manifest:z.infer<typeof manifestSchema>;
  try {manifest=manifestSchema.parse(JSON.parse(await readFile(manifestPath,"utf8")));}
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="ENOENT") throw error;
    const pilot=z.object({ids:z.record(z.string(),z.string().uuid())}).parse(JSON.parse(await readFile(join(options.workspaceRoot,".cache/matching-pilot/manifest.json"),"utf8")));
    const before=await repository.preflight();
    const fingerprint=await repository.canonicalFingerprint(Object.values(pilot.ids));
    if(before.sources!==20 || fingerprint.source_items?.count!==20) throw Error("Benchmark requires the exact existing synthetic pilot library");
    const backup=await options.backup.create(directory);
    manifest={version:corpus.version,startedAt:new Date().toISOString(),ids:pilot.ids,phases:{},warmedNotes:[],initialBackup:backup.path,fixtureHash:sha256(fixtureText)};
    await writeFile(manifestPath,JSON.stringify(manifest,null,2),{flag:"wx"});
  }
  if(manifest.fixtureHash!==sha256(fixtureText)) throw Error("Fixture changed after benchmark started");
  const save=()=>writeFile(manifestPath,JSON.stringify(manifest,null,2));
  const controlPath=join(directory,"control.json");
  const limitsPath=join(directory,"limits.json");
  await writeFile(controlPath,JSON.stringify({phase:"prepare",revision:1}),{flag:"wx"}).catch(e=>{if(e.code!=="EEXIST")throw e;});
  await writeFile(limitsPath,JSON.stringify({maxReportedTokens:5000000}),{flag:"wx"}).catch(e=>{if(e.code!=="EEXIST")throw e;});
  const log=(event:string,data:Record<string,unknown>={})=>console.log("MATCHING_BENCHMARK",JSON.stringify({event,...data}));
  log("ready",{initialBackup:manifest.initialBackup,completed:Object.entries(manifest.phases).filter(([,p])=>p.status==="completed").map(([p])=>p)});
  let previousCommand="";
  for(;;) {
    const control=z.object({phase:phaseSchema,revision:z.number().int().positive()}).parse(JSON.parse(await readFile(controlPath,"utf8")));
    const command=JSON.stringify(control);
    if(command!==previousCommand) {
      previousCommand=command;
      if(control.phase==="stop") {await restoreDiagnostics();return;}
      try {await execute(control.phase);}
      catch(error) {
        const message=error instanceof Error?error.message:String(error);
        await writeFile(join(directory,"error.json"),JSON.stringify({phase:control.phase,at:new Date().toISOString(),message},null,2));
        log("failed",{phase:control.phase,message});
        await restoreDiagnostics();
      }
    }
    await sleep(2000);
  }

  async function execute(phase:Exclude<Phase,"stop">) {
    if(manifest.phases[phase]?.status==="completed"&&manifest.phases[phase]?.verifiedAt) {log("already_completed",{phase});return;}
    await enforceLimit();
    await options.settings.updateApp({debugMode:true,debugFullCapture:false});
    if(phase==="prepare") {
      await importPartition("tuning");
      const roots=corpus.sources.filter(s=>s.partition==="tuning"&&!s.key.startsWith("P")).map(s=>manifest.ids[s.key]!);
      await runBatch("prepare-extraction",roots,["embedding","summarization","atomicNotes","knowledgeGraph"]);
      // Materialize current catalog summaries without replacing their unchanged evidence chunks.
      await runBatch("prepare-catalogs",rootIds("tuning"),["embedding"]);
      await warmNotes();
      const fingerprint=await repository.canonicalFingerprint(Object.values(manifest.ids));
      const canonicalPath=join(directory,"canonical-reference.json");
      try {
        const saved=JSON.parse(await readFile(canonicalPath,"utf8"));
        if(JSON.stringify(saved)!==JSON.stringify(fingerprint))throw Error("Prepared canonical reference changed");
      } catch(error) {
        if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
        await writeFile(canonicalPath,JSON.stringify(fingerprint,null,2),{flag:"wx"});
      }
      manifest.phases.prepare={startedAt:manifest.phases["prepare-extraction"]!.startedAt,batchId:null,status:"completed"};await save();
      await capture("prepare",manifest.phases.prepare.startedAt);
    } else if(phase==="validate") {
      for(const variant of ["baseline","economy","coverage"]) if(manifest.phases[variant]?.status!=="completed"||!manifest.phases[variant]?.verifiedAt) throw Error("Complete and verify all tuning configurations before validation");
      const selection=z.object({frozenAt:z.string().datetime(),configuration:z.enum(["baseline","economy","coverage"]),settings:appSettingsSchema,trainingResultsHash:z.string()})
        .parse(JSON.parse(await readFile(join(directory,"selection.json"),"utf8")));
      const selectedResults=await readFile(join(directory,selection.configuration,"results.json"),"utf8");
      if(sha256(selectedResults)!==selection.trainingResultsHash) throw Error("Selection does not match the frozen training results");
      await options.settings.updateApp({...benchmarkConfiguration(selection.settings,"baseline"),debugMode:true,debugFullCapture:false});
      // The chosen tuning graph must be restored/confirmed before the holdout is admitted.
      const readiness=z.object({configuration:z.string(),trainingResultsHash:z.string()}).parse(JSON.parse(await readFile(join(directory,"validation-ready.json"),"utf8")));
      if(readiness.configuration!==selection.configuration||readiness.trainingResultsHash!==selection.trainingResultsHash) throw Error("Selected tuning graph is not ready");
      await importPartition("holdout");
      await runBatch("holdout-extraction",rootIds("holdout"),["embedding","summarization","atomicNotes","knowledgeGraph"]);
      await warmNotes();
      await runBatch("validate",rootIds("holdout"),["atomicNoteMatching","sourceMatching"]);
      await capture("validate",manifest.phases["holdout-extraction"]!.startedAt);
    } else {
      if(manifest.phases.prepare?.status!=="completed") throw Error("Prepare all tuning artifacts first");
      if(Object.keys(manifest.ids).length!==62) throw Error("Tuning refuses any held-out or unrelated sources");
      await assertCanonical();
      await options.settings.updateApp({...benchmarkConfiguration(reference,phase),debugMode:true,debugFullCapture:false});
      if(!manifest.phases[phase]) {
        const backup=await options.backup.create(directory);
        await repository.resetPilotMatching(Object.values(manifest.ids),62);
        const graph=createKnowledgeGraphRepository(options.pool);
        await graph.clearProjection();
        for(const id of Object.values(manifest.ids)) await graph.projectSource(id);
        manifest.phases[phase]={startedAt:new Date().toISOString(),batchId:null,status:"running",backup:backup.path};await save();
      }
      await runBatch(phase,rootIds("tuning"),["atomicNoteMatching","sourceMatching"]);
      await capture(phase,manifest.phases[phase]!.startedAt);
      await assertCanonical();
    }
    manifest.phases[phase]!.verifiedAt=new Date().toISOString();await save();
    await restoreDiagnostics();
    log("phase_completed",{phase});
  }

  async function runBatch(key:string,roots:string[],stages:string[]) {
    if(manifest.phases[key]?.status==="completed") return;
    let state=manifest.phases[key];
    if(!state) {state={startedAt:new Date().toISOString(),batchId:null,status:"running"};manifest.phases[key]=state;await save();}
    if(!state.batchId) {
      const batch=await options.hierarchy.process({runKind:"missing_stages",plan:ProcessingPlanRequestSchema.parse({preset:"custom",requestedStages:stages,scope:"source_and_children",targetSourceItemIds:roots})});
      state.batchId=batch.batchId;await save();
    }
    log("batch_started",{phase:key,batchId:state.batchId,roots:roots.length});
    let previous="";
    for(;;) {
      const progress=await repository.progress(state.batchId,manifest.startedAt);
      await writeFile(join(directory,"progress.json"),JSON.stringify({phase:key,...progress},null,2));
      const summary={phase:key,completed:progress.runs.filter(r=>r.status==="succeeded"&&!Object.values(r.stages_checkpoint??{}).some(s=>(s as {status?:string}).status==="running")).length,total:progress.runs.length,
        active:progress.runs.filter(r=>r.job_status==="running"||Object.values(r.stages_checkpoint??{}).some(s=>(s as {status?:string}).status==="running")).map(r=>({title:r.title,stage:r.current_stage})),tokens:progress.usage.reported_tokens};
      const changed=JSON.stringify({...summary,tokens:undefined});
      if(changed!==previous){log("progress",summary);previous=changed;}
      if(isMatchingPilotComplete(progress.runs)) {
        const failures=progress.runs.filter(r=>r.status!=="succeeded"||Object.values(r.stages_checkpoint??{}).some(s=>["failed","canceled"].includes(String((s as {status?:string}).status))));
        if(failures.length) {state.status="failed";await save();throw Error(`Recover failed stages before continuing: ${failures.map(r=>r.title).join(", ")}`);}
        state.status="completed";await save();break;
      }
      await enforceLimit();await sleep(5000);
    }
  }
  async function enforceLimit() {
    const control=z.object({phase:phaseSchema}).parse(JSON.parse(await readFile(controlPath,"utf8")));
    if(control.phase==="stop") {await options.jobs.cancelForSources(Object.values(manifest.ids));throw Error("Benchmark stopped by control request");}
    const limit=z.object({maxReportedTokens:z.number().int().positive().max(5000000)}).parse(JSON.parse(await readFile(limitsPath,"utf8")));
    const progress=await repository.progress("00000000-0000-0000-0000-000000000000",manifest.startedAt);
    if(Number(progress.usage.reported_tokens)>=limit.maxReportedTokens) {await options.jobs.cancelForSources(Object.values(manifest.ids));throw Error("Benchmark reported-token allowance exhausted");}
  }
  async function importPartition(partition:"tuning"|"holdout") {
    for(const source of corpus.sources.filter(s=>s.partition===partition)) {
      if("chapters" in source) {
        if(!manifest.ids[source.key]) {const created=await options.ingestion.createContainerSource(containerSourceInputSchema.parse({descriptor:{type:"Book",title:source.title,language:"pt-BR"}}));manifest.ids[source.key]=created.sourceItemId;await save();}
        for(const child of source.chapters) await importDocument(child,manifest.ids[source.key]);
      } else await importDocument(source);
    }
  }
  async function importDocument(document:z.infer<typeof documentSchema>,parentSourceItemId?:string) {
    if(manifest.ids[document.key]) return;
    const created=await options.ingestion.createManual(manualIngestionInputSchema.parse({descriptor:{type:parentSourceItemId?"BookChapter":"StandaloneArticle",title:document.title,language:"pt-BR",...(parentSourceItemId?{parentSourceItemId}:{})},content:document.content,duplicatePolicy:"ignore",processingPlan:{preset:"import_only",requestedStages:[]}}));
    manifest.ids[document.key]=created.sourceItemId;await save();
  }
  function rootIds(partition:"tuning"|"holdout") {return corpus.sources.filter(s=>s.partition===partition).map(s=>manifest.ids[s.key]!);}
  async function warmNotes() {
    const snapshot=await repository.snapshot(Object.values(manifest.ids),new Date().toISOString());
    for(const raw of snapshot.notes!) {
      const note=z.object({id:z.string(),created_from_source_item_id:z.string(),title:z.string(),idea_statement:z.string(),body_markdown:z.string()}).parse(raw);
      if(manifest.warmedNotes.includes(note.id)) continue;
      await enforceLimit();
      const execution=await options.ai.runDefaultTask("embedding",`${note.title}\n\n${note.idea_statement}\n\n${note.body_markdown}`,{operation:"benchmark_note_warmup",stage:"embedding",atomicNoteId:note.id,sourceItemId:note.created_from_source_item_id,sourceItemIds:[note.created_from_source_item_id]});
      if(!execution) throw Error("Configured embedding route required for warmup");
      const embedding=z.array(z.number().finite()).refine(v=>[256,768,1024].includes(v.length)).parse(execution.output);
      await createEmbeddingRepository(options.pool).upsert({targetType:"atomic_note",targetId:note.id,provider:execution.providerId,model:execution.modelId,runtime:execution.runtime,usage:"matching",strategy:"native",contentHash:sha256(`${note.title}\n${note.idea_statement}\n${note.body_markdown}`),embedding});
      manifest.warmedNotes.push(note.id);await save();
    }
    log("notes_warmed",{count:manifest.warmedNotes.length});
  }
  async function assertCanonical() {
    const expected=JSON.parse(await readFile(join(directory,"canonical-reference.json"),"utf8"));
    const actual=await repository.canonicalFingerprint(Object.values(manifest.ids));
    if(JSON.stringify(actual)!==JSON.stringify(expected)) {await writeFile(join(directory,"canonical-mismatch.json"),JSON.stringify({expected,actual},null,2));throw Error("Canonical extraction changed during tuning");}
  }
  async function capture(phase:string,since:string) {
    const target=join(directory,phase);await mkdir(target,{recursive:true});
    const snapshot=await repository.snapshot(Object.values(manifest.ids),since);
    await writeFile(join(target,"results.json"),JSON.stringify({capturedAt:new Date().toISOString(),...snapshot},null,2));
    await writeFile(join(target,"settings.json"),JSON.stringify(await options.settings.getApp(),null,2));
    const routes=[];const ai=createAiConfigRepository(options.pool);
    for(const task of ["embedding","summarization","atomic-note-generation","knowledge-graph-generation","reranking"]) {
      const route=await ai.getDefaultTask(task);if(!route)throw Error(`Missing ${task} route`);
      routes.push({task,profileId:route.profileId,provider:route.provider,model:route.modelId,runtime:route.runtime,parameters:route.parameters,modelDefaults:route.modelDefaultParameters,revision:route.revision});
    }
    await writeFile(join(target,"routes.json"),JSON.stringify(routes,null,2));
    log("captured",{phase,counts:Object.fromEntries(Object.entries(snapshot).map(([key,rows])=>[key,rows.length]))});
  }
  async function restoreDiagnostics(){await options.settings.updateApp({debugMode:reference.debugMode,debugFullCapture:reference.debugFullCapture});}
}
