import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { createPgPool, closePgPool, createMatchingEvaluationRepository } from "../packages/db/src/index.ts";
import { SettingsService } from "../apps/desktop/src/main/services/settings-service.ts";

const directory=resolve(".cache/matching-benchmark");
const manifest=JSON.parse(await readFile(join(directory,"manifest.json"),"utf8"));
const phase=z.enum(["prepare","baseline","economy","coverage","validate"]).parse(process.argv[2]);
const state=manifest.phases[phase];
if(!state) throw Error("Requested phase has not started");
const descriptor=z.object({developmentOnly:z.literal(true),connectionString:z.string()}).parse(JSON.parse(await readFile(join(homedir(),"Library/Application Support/@app/desktop/database/dev-connection.json"),"utf8")));
if(!["127.0.0.1","localhost"].includes(new URL(descriptor.connectionString).hostname))throw Error("Loopback DEV required");
const pool=createPgPool({connectionString:descriptor.connectionString,max:1});
try {
  const repository=createMatchingEvaluationRepository(pool);
  const since=phase==="validate"?manifest.phases["holdout-extraction"].startedAt:state.startedAt;
  const snapshot=await repository.snapshot(Object.values(manifest.ids) as string[],since);
  const progress=await repository.progress(state.batchId??"00000000-0000-0000-0000-000000000000",manifest.startedAt);
  const target=join(directory,phase);await mkdir(target,{recursive:true});
  await writeFile(join(target,"results.json"),JSON.stringify({capturedAt:new Date().toISOString(),phaseVerified:Boolean(state.verifiedAt),...snapshot},null,2));
  const settings=await new SettingsService(join(homedir(),"Library/Application Support/@app/desktop"),{getDatabasePool:()=>pool,requireDatabase:true}).getApp();
  await writeFile(join(target,"settings.json"),JSON.stringify(settings,null,2));
  await writeFile(join(target,"progress.json"),JSON.stringify(progress,null,2));
  console.log(JSON.stringify({phase,counts:Object.fromEntries(Object.entries(snapshot).map(([k,v])=>[k,v.length])),totalUsage:progress.usage}));
} finally {await closePgPool(pool);}
