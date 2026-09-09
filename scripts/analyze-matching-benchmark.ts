import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const phase=process.argv[2]??"baseline";
if(!["prepare","baseline","economy","coverage","validate"].includes(phase))throw Error("Invalid phase");
const directory=".cache/matching-benchmark";
const read=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const [corpus,manifest,results,settings]=await Promise.all([read("scripts/fixtures/matching-benchmark.json"),read(join(directory,"manifest.json")),read(join(directory,phase,"results.json")),read(join(directory,phase,"settings.json"))]);
const keys=new Map<string,string>(Object.entries(manifest.ids).map(([k,v])=>[String(v),k]));
const sources=new Map<string,any>(results.sources.map((s:any)=>[s.id,s]));
const notes=new Map<string,any>(results.notes.map((n:any)=>[n.id,n]));
const pair=(a:string,b:string)=>[a,b].sort().join("/");
const root=(id:string):string=>{const seen=new Set();while(sources.get(id)?.parent_source_item_id){if(seen.has(id))throw Error("Hierarchy cycle");seen.add(id);id=sources.get(id).parent_source_item_id;}const key=keys.get(id);if(!key)throw Error("Unknown source ID");return key;};
const partition=phase==="validate"?"holdout":"tuning";
const expected=new Set<string>(corpus.expectedRootPairs.filter((r:any)=>r.partition===partition).map((r:any)=>pair(...r.pair as [string,string])));
const forbidden=new Set<string>(corpus.forbiddenRootPairs.filter((r:any)=>r.partition===partition).map((r:any)=>pair(...r.pair as [string,string])));
const holdout=new Set<string>(corpus.sources.filter((s:any)=>s.partition==="holdout").map((s:any)=>s.key));
const nonConceptual=new Set<string>(corpus.zeroNoteSources);
const selectedPair=(a:string,b:string)=>partition==="tuning"?!holdout.has(a)&&!holdout.has(b):holdout.has(a)||holdout.has(b);
const classify=(key:string)=>expected.has(key)?"expected":forbidden.has(key)?"forbidden":"unlabelled";
const sourceRelations=results.sourceRelations.map((r:any)=>{const a=root(r.source_item_id),b=root(r.target_source_item_id);return{...r,sourceKey:keys.get(r.source_item_id),targetKey:keys.get(r.target_source_item_id),roots:pair(a,b),sameRoot:a===b,inPartition:selectedPair(a,b),classification:classify(pair(a,b))};}).filter((r:any)=>r.inPartition);
const noteRelations=results.noteRelations.map((r:any)=>{const a=notes.get(r.metadata?.semanticSourceAtomicNoteId??r.source_atomic_note_id),b=notes.get(r.metadata?.semanticTargetAtomicNoteId??r.target_atomic_note_id);const x=root(a.created_from_source_item_id),y=root(b.created_from_source_item_id);return{...r,sourceKey:keys.get(a.created_from_source_item_id),targetKey:keys.get(b.created_from_source_item_id),sourceIdea:a.idea_statement,targetIdea:b.idea_statement,roots:pair(x,y),inPartition:selectedPair(x,y),classification:classify(pair(x,y))};}).filter((r:any)=>r.inPartition);
const evaluated=new Set<string>((results.sourceDecisions??[]).map((r:any)=>pair(root(r.source_root_id),root(r.target_root_id))));
const measure=(relations:any[])=>{
  const found=new Set<string>(relations.map(r=>r.roots));
  return{relations:relations.length,uniquePairs:found.size,expectedPairsFound:[...expected].filter(p=>found.has(p)),missingExpectedPairs:[...expected].filter(p=>!found.has(p)),forbiddenPairsFound:[...forbidden].filter(p=>found.has(p)),expectedRelations:relations.filter(r=>r.classification==="expected").length,forbiddenRelations:relations.filter(r=>r.classification==="forbidden").length,nonConceptualRelations:relations.filter(r=>r.roots.split('/').some((k:string)=>nonConceptual.has(k))).length,unlabelledRelations:relations.filter(r=>r.classification==="unlabelled").length};
};
const gates=settings.atomicNoteMatchingSettings;
const replayNotes=(threshold:number,rerankerWeight:number)=>{
  const score=(r:any)=>typeof r.metadata?.baseScore==='number'&&r.rerank_score!==null?(1-rerankerWeight)*r.metadata.baseScore+rerankerWeight*Number(r.rerank_score):Number(r.final_score);
  const rows=results.diagnostics.filter((r:any)=>r.source_note_id&&notes.has(r.source_note_id)&&notes.has(r.target_id)&&score(r)>=threshold&&(r.rerank_score===null?!gates.requireReranking:Number(r.rerank_score)>0&&Number(r.rerank_score)>=gates.minRerankScore)&&(gates.includeWeakTypes||!["mentions","related"].includes(r.metadata?.relationType)))
    .map((r:any)=>{const a=root(notes.get(r.source_note_id).created_from_source_item_id),b=root(notes.get(r.target_id).created_from_source_item_id);return{roots:pair(a,b),classification:classify(pair(a,b)),inPartition:selectedPair(a,b),id:pair(r.source_note_id,r.target_id)};}).filter((r:any)=>r.inPartition);
  const unique=[...new Map(rows.map((r:any)=>[r.id,r])).values()];return{threshold,rerankerWeight,...measure(unique)};
};
const noteSweep=[0.5,0.55,0.6,0.625,0.65,0.7].map(threshold=>replayNotes(threshold,gates.rerankerWeight));
const weightSweep=[0.3,0.4,0.5,0.6].flatMap(weight=>[0.55,0.6,0.65].map(threshold=>replayNotes(threshold,weight)));
const sourceSweep=[0.75,0.8,0.825,0.85,0.875,0.9].filter(t=>t>=settings.sourceRelationSettings.minImportance).map(minimumImportance=>({minimumImportance,...measure(sourceRelations.filter((r:any)=>r.importance>=minimumImportance&&r.confidence>=settings.sourceRelationSettings.minConfidence))}));
const usage=results.usage.reduce((a:any,r:any)=>({calls:a.calls+r.calls,inputTokens:a.inputTokens+Number(r.input_tokens??0),outputTokens:a.outputTokens+Number(r.output_tokens??0),reportedTokens:a.reportedTokens+Number(r.input_tokens??0)+Number(r.output_tokens??0),callsWithoutInput:a.callsWithoutInput+(r.input_tokens===null?r.calls:0)}),{calls:0,inputTokens:0,outputTokens:0,reportedTokens:0,callsWithoutInput:0});
const degreeStats=(ids:string[],edges:[string,string][])=>{
  const degree=new Map(ids.map(id=>[id,0]));
  for(const edge of edges)for(const id of edge)if(degree.has(id))degree.set(id,degree.get(id)!+1);
  const ranked=[...degree].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  return{nodes:ids.length,isolated:ranked.filter(([,n])=>n===0).length,meanDegree:ids.length?ranked.reduce((sum,[,n])=>sum+n,0)/ids.length:0,maxDegree:ranked[0]?.[1]??0,top:ranked.slice(0,10).map(([id,n])=>({id,degree:n}))};
};
const selectedNotes=results.notes.filter((n:any)=>partition==="tuning"?!holdout.has(root(n.created_from_source_item_id)):holdout.has(root(n.created_from_source_item_id))).map((n:any)=>n.id);
const selectedRoots=corpus.sources.filter((s:any)=>s.partition===partition&&manifest.ids[s.key]).map((s:any)=>s.key);
const noteDegrees=degreeStats(selectedNotes,noteRelations.map((r:any)=>[r.source_atomic_note_id,r.target_atomic_note_id]));
const sourceDegrees=degreeStats(selectedRoots,[...new Set<string>(sourceRelations.map((r:any)=>r.roots))].map(p=>p.split('/') as [string,string]));
const summary={phase,partition,capturedAt:results.capturedAt,sourceRecords:results.sources.length,rootCount:results.sources.filter((s:any)=>!s.parent_source_item_id).length,notes:results.notes.length,entities:results.entities.length,
  expectedPairCases:expected.size,forbiddenPairCases:forbidden.size,source:measure(sourceRelations),note:measure(noteRelations),evaluatedExpectedPairs:[...expected].filter(p=>evaluated.has(p)),unassessedExpectedPairs:[...expected].filter(p=>!evaluated.has(p)),sameRootViolations:sourceRelations.filter((r:any)=>r.sameRoot).length,
  zeroNoteChecks:corpus.zeroNoteSources.filter((k:string)=>manifest.ids[k]&&(partition==="tuning"?!holdout.has(k):holdout.has(k))).map((key:string)=>({key,notes:results.notes.filter((n:any)=>n.created_from_source_item_id===manifest.ids[key]).map((n:any)=>({title:n.title,idea:n.idea_statement}))})),
  identityChecks:results.entities.filter((e:any)=>/ana costa|marina lopes/i.test(e.canonical_name)).map((e:any)=>({...e,sources:e.sources.map((s:string)=>keys.get(s))})),
  usage,noteDegrees,sourceDegrees,noteThresholdSweep:noteSweep,noteWeightSweep:weightSweep,sourceImportanceSweep:sourceSweep,
  limitations:"Pair labels are screening cases, not exhaustive semantic precision/recall. Unlabelled bridges require proposition/evidence review. Sweeps filter observed decisions only, not new retrieval or persistence order. Identity extraction is held constant across tuning presets."};
await writeFile(join(directory,phase,"analysis.json"),JSON.stringify({summary,sourceRelations,noteRelations,usage:results.usage},null,2));
console.log(JSON.stringify({phase,roots:summary.rootCount,notes:summary.notes,sourceRelations:summary.source.relations,expected:`${summary.source.expectedPairsFound.length}/${expected.size}`,forbidden:summary.source.forbiddenPairsFound,unassessed:summary.unassessedExpectedPairs,tokens:usage.reportedTokens}));
