import { readFile, stat } from "node:fs/promises";
const path=".cache/matching-benchmark/progress.json";
const progress=JSON.parse(await readFile(path,"utf8"));
const runs=progress.runs as Array<Record<string,any>>;
const stage=(name:string)=>{
  const selected=runs.filter(r=>r.stages_checkpoint?.[name]&&r.stages_checkpoint[name].status!=="skipped");
  return {completed:selected.filter(r=>r.stages_checkpoint[name].status==="completed").length,total:selected.length,
    active:selected.filter(r=>r.stages_checkpoint[name].status==="running").map(r=>r.title)};
};
console.log(JSON.stringify({phase:progress.phase,updatedAt:(await stat(path)).mtime.toISOString(),reportedTokens:Number(progress.usage.reported_tokens??0),
  ingestion:{completed:runs.filter(r=>r.status==="succeeded").length,total:runs.length,active:runs.filter(r=>r.job_status==="running").map(r=>({title:r.title,stage:r.current_stage}))},
  noteMatching:stage("atomicNoteMatching"),sourceMatching:stage("sourceMatching"),
  failures:runs.flatMap(r=>{
    const stages=Object.entries(r.stages_checkpoint??{}).filter(([,s])=>["failed","canceled"].includes((s as any).status))
      .map(([stage,s])=>({title:r.title,jobStatus:r.job_status,stage,error:(s as any).error}));
    return stages.length?stages:r.error?[{title:r.title,jobStatus:r.job_status,error:r.error}]:[];
  }),
  missingInputUsage:progress.usage.missing_input_usage},null,2));
