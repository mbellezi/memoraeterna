import { readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";

const directory = resolve(".cache/matching-pilot", process.argv.includes("--baseline") ? "baseline" : ".");
const read = async (path: string) => JSON.parse(await readFile(path, "utf8"));
const [corpus, manifest, results, settings] = await Promise.all([read("scripts/fixtures/matching-pilot.json"), read(join(directory,"manifest.json")), read(join(directory,"results.json")), read(join(directory,"settings-run.json"))]);
const keys = new Map<string,string>(Object.entries(manifest.ids).map(([key,id]) => [String(id),key]));
const sources = new Map<string,any>(results.sources.map((row:any) => [row.id,row]));
const notes = new Map<string,any>(results.notes.map((row:any) => [row.id,row]));
const pair = (a:string,b:string) => [a,b].sort().join("/");
const root = (id:string):string => {
  const visited = new Set<string>();
  while(sources.get(id)?.parent_source_item_id) {
    if(visited.has(id)) throw new Error("Hierarchy cycle"); visited.add(id); id=sources.get(id).parent_source_item_id;
  }
  return keys.get(id) ?? id;
};
const expected = new Set<string>(corpus.expectedRootPairs.map(([a,b]:string[]) => pair(a!,b!)));
const forbidden = new Set<string>(corpus.forbiddenRootPairs.map(([a,b]:string[]) => pair(a!,b!)));
const sourceRelations = results.sourceRelations.map((r:any) => {
  const a=root(r.source_item_id),b=root(r.target_source_item_id),key=pair(a,b);
  return { id:r.id,source:keys.get(r.source_item_id),target:keys.get(r.target_source_item_id),roots:key,
    classification:a===b?"same_root_violation":expected.has(key)?"expected_pair":forbidden.has(key)||corpus.zeroNoteSources.includes(a)||corpus.zeroNoteSources.includes(b)?"forbidden_pair":"requires_review",
    type:r.relation_type,sourceIdea:r.source_idea,targetIdea:r.target_idea,explanation:r.explanation,importance:r.importance,confidence:r.confidence };
});
const discovered = new Set(sourceRelations.map((r:any)=>r.roots));
const noteRelations = results.noteRelations.map((r:any)=>{
  const a=notes.get(r.source_atomic_note_id),b=notes.get(r.target_atomic_note_id);
  return { id:r.id,source:keys.get(a?.created_from_source_item_id),target:keys.get(b?.created_from_source_item_id),
    sourceTitle:a?.title,targetTitle:b?.title,sourceIdea:a?.idea_statement,targetIdea:b?.idea_statement,
    type:r.relation_type,score:r.final_score,rerank:r.rerank_score,
    semanticSource:notes.get(r.metadata?.semanticSourceAtomicNoteId)?.title,
    semanticTarget:notes.get(r.metadata?.semanticTargetAtomicNoteId)?.title };
});
const identityChecks=results.entities.filter((e:any)=> /ana costa/i.test(e.canonical_name) || /aurora/i.test(e.canonical_name)).map((e:any)=>({id:e.id,name:e.canonical_name,type:e.type,identity:e.identity_description,sources:e.sources.map((id:string)=>keys.get(id))}));
const thresholds=[0.5,0.55,0.6,0.65,0.7,0.72,0.75];
const gates=settings.atomicNoteMatchingSettings;
const sweep=thresholds.map(threshold=>{
  const passing=results.diagnostics.filter((r:any)=>Number(r.final_score)>=threshold
    && (r.rerank_score===null ? !gates.requireReranking : Number(r.rerank_score)>0&&Number(r.rerank_score)>=gates.minRerankScore)
    && (gates.includeWeakTypes || !['related','mentions'].includes(r.metadata?.relationType)));
  return {threshold,candidateDecisionsPassing:passing.length,uniquePairsPassing:new Set(passing.map((r:any)=>pair(r.source_note_id,r.target_id))).size};
});
const sourceSweep=[0.75,0.8,0.85,0.9].map(minimumImportance=>{
  const passing=sourceRelations.filter((r:any)=>r.importance>=minimumImportance&&r.confidence>=settings.sourceRelationSettings.minConfidence);
  return {minimumImportance,relationsPassing:passing.length,
    expectedPairRelations:passing.filter((r:any)=>r.classification==='expected_pair').length,
    expectedPairsCovered:new Set(passing.filter((r:any)=>r.classification==='expected_pair').map((r:any)=>r.roots)).size};
});
const summary={capturedAt:results.capturedAt,sourceCount:results.sources.length,noteCount:results.notes.length,noteRelationCount:noteRelations.length,
  sourceRelationCount:sourceRelations.length,entityCount:results.entities.length,
  expectedPairs:[...expected],coveredExpectedPairs:[...expected].filter(key=>discovered.has(key)),missingExpectedPairs:[...expected].filter(key=>!discovered.has(key)),
  forbiddenSourcePairs:sourceRelations.filter((r:any)=>r.classification==='forbidden_pair'),sameRootViolations:sourceRelations.filter((r:any)=>r.classification==='same_root_violation'),
  unlabelledSourcePairs:sourceRelations.filter((r:any)=>r.classification==='requires_review'),
  zeroNoteSources:corpus.zeroNoteSources.map((key:string)=>({key,count:results.notes.filter((n:any)=>keys.get(n.created_from_source_item_id)===key).length})),
  identityChecks,thresholdSweep:sweep,sourceImportanceSweep:sourceSweep,
  limitations:'Root pairs and candidate counts are screening metrics. They do not establish semantic precision/recall; manually review propositions and evidence. Threshold sweeps reuse recorded candidates only, including reciprocal evaluations, and do not simulate changes to retrieval, prompts, persistence or execution order.'};
await writeFile(join(directory,'analysis.json'),JSON.stringify({summary,sourceRelations,noteRelations,usage:results.usage},null,2));
console.log(JSON.stringify(summary,null,2));
