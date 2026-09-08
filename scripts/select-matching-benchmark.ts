import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { sha256 } from "../packages/conversion/src/index.ts";
import { createPgPool, closePgPool, createMatchingEvaluationRepository, createKnowledgeGraphRepository } from "../packages/db/src/index.ts";
import { SettingsService } from "../apps/desktop/src/main/services/settings-service.ts";
import { BackupService } from "../apps/desktop/src/main/services/backup-service.ts";
import { benchmarkConfiguration } from "../apps/desktop/src/main/services/matching-benchmark.ts";
import { appSettingsSchema } from "../apps/desktop/src/shared/ipc.ts";

const configuration=z.enum(["baseline","economy","coverage"]).parse(process.argv[2]);
const directory=resolve(".cache/matching-benchmark");
const read=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const manifest=await read(join(directory,"manifest.json"));
if(Object.keys(manifest.ids).length!==62)throw Error("Freeze only before holdout import");
for(const phase of ["baseline","economy","coverage"])if(manifest.phases[phase]?.status!=="completed"||!manifest.phases[phase]?.verifiedAt)throw Error("All training configurations must be verified");
const text=await readFile(join(directory,configuration,"results.json"),"utf8");
const snapshot=JSON.parse(text);
const settings=appSettingsSchema.parse(await read(join(directory,configuration,"settings.json")));
const trainingResultsHash=sha256(text);
const userData=join(homedir(),"Library/Application Support/@app/desktop");
const descriptor=z.object({developmentOnly:z.literal(true),connectionString:z.string(),psqlPath:z.string()}).parse(await read(join(userData,"database/dev-connection.json")));
const url=new URL(descriptor.connectionString);
if(!["127.0.0.1","localhost"].includes(url.hostname))throw Error("Loopback DEV required");
const pool=createPgPool({connectionString:descriptor.connectionString,max:2});
try {
  const repository=createMatchingEvaluationRepository(pool),ids=Object.values(manifest.ids) as string[];
  const canonical=await repository.canonicalFingerprint(ids);
  if(JSON.stringify(canonical)!==JSON.stringify(await read(join(directory,"canonical-reference.json"))))throw Error("Canonical training artifacts changed");
  const selection={frozenAt:new Date().toISOString(),configuration,settings,trainingResultsHash};
  try {await writeFile(join(directory,"selection.json"),JSON.stringify(selection,null,2),{flag:"wx"});}
  catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;const existing=await read(join(directory,"selection.json"));if(existing.configuration!==configuration||existing.trainingResultsHash!==trainingResultsHash)throw Error("A different selection is already frozen");}
  const service=new SettingsService(userData,{getDatabasePool:()=>pool,requireDatabase:true});
  const backup=await new BackupService({getDatabaseContext:()=>({connection:{host:url.hostname,port:Number(url.port),database:decodeURIComponent(url.pathname.slice(1)),user:decodeURIComponent(url.username),password:decodeURIComponent(url.password),connectionString:descriptor.connectionString},pgDumpPath:join(dirname(descriptor.psqlPath),"pg_dump")}),getStorageSettings:()=>service.get()}).create(directory);
  await repository.resetPilotMatching(ids,62,snapshot);
  const restored=await repository.snapshot(ids,new Date().toISOString());
  for(const table of ["noteRelations","sourceRelations","sourceEvidence"]){
    const normalize=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).sort();
    if(JSON.stringify(normalize(restored[table]!))!==JSON.stringify(normalize(snapshot[table])))throw Error(`Restored ${table} differ from selected results`);
  }
  if(JSON.stringify(await repository.canonicalFingerprint(ids))!==JSON.stringify(canonical))throw Error("Restore changed canonical extraction");
  const graph=createKnowledgeGraphRepository(pool);await graph.clearProjection();for(const id of ids)await graph.projectSource(id);
  const saved=await service.updateApp(benchmarkConfiguration(settings,"baseline"));
  await writeFile(join(directory,"settings-selected.json"),JSON.stringify(saved,null,2));
  await writeFile(join(directory,"validation-ready.json"),JSON.stringify({configuration,trainingResultsHash,verifiedAt:new Date().toISOString(),backup:backup.path,counts:{notes:snapshot.noteRelations.length,sources:snapshot.sourceRelations.length,evidence:snapshot.sourceEvidence.length}},null,2));
  console.log({configuration,trainingResultsHash,relations:{notes:snapshot.noteRelations.length,sources:snapshot.sourceRelations.length},backup:backup.path});
}finally{await closePgPool(pool);}
