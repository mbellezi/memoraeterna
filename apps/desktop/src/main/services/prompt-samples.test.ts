import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { promptDefinitions,PromptSampleProgressSchema } from '@app/domain';
import { defaultPromptPin,promptAudit } from './prompt-runtime.js';
import { runPromptSamples,promptSampleLimits,promptSampleCases } from './prompt-samples.js';
function model(){const calls:Array<{id:string,input:string}>=[];return {calls,describePromptRoute:vi.fn(async()=>({provider:'openai-codex',modelId:'qwen3-embedding-fixture',repository:'fixture'})),runDefaultTask:vi.fn(async(task:string,input:string)=>{
 const id=promptAudit(input)[0]?.promptId??'';calls.push({id,input});let output:unknown;
 if(task==='embedding')output=[1,...Array(255).fill(0)];
 else if(task==='text-generation')output='OK';
 else if(id.startsWith('summary.'))output={summary:'A fictional study qualified the role of feedback.',concepts:[]};
 else if(id.startsWith('notes.')&&id!=='notes.match')output={notes:[]};
 else if(id==='notes.match')output={results:[{candidateAlias:'c1',score:0,relationType:'related',explanation:'The supplied claims describe different conditions.'}]};
 else if(id.includes('_identity'))output={matches:[['r1','c1']]};
 else if(id==='graph.relation_labels')output={labels:[{key:'r1',displayLabel:'Improves recall'}]};
 else if(id.startsWith('graph.'))output={entities:[],claims:[],relations:[]};
 else if(id==='sources.match')output={relations:[]};
 else if(id.startsWith('consultation.'))output={change:{meaningful:false,explanation:[]},paragraphs:[{markdown:'Feedback qualified the benefit [e1].',citations:['e1'],contextIds:[]}],gaps:[]};
 else if(id.startsWith('maintenance.'))output={operations:[],explanation:'No structural improvement is warranted.'};
 else if(id==='organization.curator.support')output={supported:true,checkedTargets:['new_topic','new_index'],issues:[]};
 else if(id==='organization.curator')output={explanation:'Read complementary materials',topics:[{handle:'new_topic',title:'Recall with feedback',purpose:'Explain specific conditions for recall',sections:[{id:null,title:'Conditions',markdown:'Feedback qualifies recall [e1].',originalHandles:['e1']}],links:['new_index']}],indexes:[{handle:'new_index',title:'Original materials',purpose:'Read sources supporting this topic',owner:{topic:'new_topic'},groups:[{id:null,title:'Sources',explanation:null,originalHandles:[],targets:['r1','r2']}]}]};
 else if(id==='organization.legacy_synthesis'){
  const transcript=JSON.parse(input.split('PREVIOUS TOOLS: ')[1]!.split('\nRemaining tools:')[0]!) as Array<{action:{tool:string;handle?:string}|null}>;
  const read=transcript.filter(row=>row.action?.tool==='readRevision').map(row=>row.action!.handle);
  output=!transcript.some(row=>row.action?.tool==='searchEvidence')?{tool:'searchEvidence',query:'',limit:20}:!read.includes('e1')?{tool:'readRevision',handle:'e1',selector:'full'}:!read.includes('e2')?{tool:'readRevision',handle:'e2',selector:'full'}:{tool:'proposePageChange',target:'page',expectedRevisionId:null,explanation:'A qualified comparison',sections:[{sectionId:null,title:'Feedback',markdown:'The studies qualify the effect of feedback.',citations:['e1','e2'],contextIds:[]}]};
 }else throw new Error('Untested sample '+id);
 return {taskType:task as any,output,providerId:'fixture',modelId:'fixture',runtime:'remote' as const,durationMs:1,aiTaskRunId:randomUUID(),profileId:randomUUID(),outputLanguage:'en'};
 })};}
describe('bounded catalog sample runner',()=>{
 it('executes every registered required variant with real builders and validators, including exact same-root repair and local diagnostics',async()=>{
  const ai=model(),pin=defaultPromptPin(),ids=promptDefinitions.map(d=>d.id);let progress=PromptSampleProgressSchema.parse({});
  for(let batch=0;batch<10;batch++){progress=await runPromptSamples(ai,[{pin,ids}],{progress});if(progress.error!=='prompts.errors.partial')break;}
  expect(progress.error).toBeNull();expect(progress.completedKeys).toHaveLength(promptSampleCases(ids).length);expect(progress.inapplicable).toEqual({});expect(progress.calls).toBe(ai.calls.length);expect(progress.auditIds).toHaveLength(ai.calls.length);
  expect(progress.completedKeys.some(key=>key.startsWith('organization.repair:'))).toBe(true);expect(progress.completedKeys.some(key=>key.startsWith('sources.repair.same_root:'))).toBe(true);
  expect(ai.calls.some(c=>c.input.includes('SAME root/work'))).toBe(true);for(const id of ['diagnostics.local_generation','diagnostics.local_embedding'])expect(ai.calls.some(c=>c.id===id)).toBe(true);
 });
 it('resumes after twelve admissions without rerunning completed compositions and retains reservations on failure',async()=>{
  const ai=model(),contexts=Array.from({length:15},(_,i)=>{const pin=defaultPromptPin();pin.entries.find(e=>e.id==='summary.short')!.fields.body+='\nVariant '+i;return {pin,ids:['summary.short']};}),saved:any[]=[];
  const first=await runPromptSamples(ai,contexts,{onProgress:async value=>{saved.push(structuredClone(value));}});expect(first.error).toBe('prompts.errors.partial');expect(first.calls).toBe(12);expect(first.completedKeys).toHaveLength(12);expect(saved.some(v=>v.calls===1&&v.auditIds.length===0)).toBe(true);
  const second=await runPromptSamples(ai,contexts,{progress:JSON.parse(JSON.stringify(first))});expect(second.error).toBeNull();expect(second.calls).toBe(15);expect(ai.calls).toHaveLength(15);expect(new Set(ai.calls.map(c=>c.input)).size).toBe(15);
  const failing=model();failing.runDefaultTask.mockRejectedValueOnce(Object.assign(new Error('model failed'),{aiTaskRunId:randomUUID()}));const failure=await runPromptSamples(failing,[contexts[0]!]);expect(failure.calls).toBe(1);expect(failure.outputTokensReserved).toBe(4096);expect(failure.completedKeys).toEqual([]);expect(failure.auditIds).toHaveLength(1);
 });
 it('enforces the cumulative ceiling and never certifies a non-Codex route for adapter wording',async()=>{
  const ai=model(),pin=defaultPromptPin();const budget=await runPromptSamples(ai,[{pin,ids:['summary.short']}],{progress:PromptSampleProgressSchema.parse({calls:promptSampleLimits.totalCalls})});expect(budget.error).toBe('prompts.errors.budget');expect(ai.runDefaultTask).not.toHaveBeenCalled();
  ai.describePromptRoute.mockResolvedValue({provider:'local',modelId:'fixture',repository:'fixture'});const result=await runPromptSamples(ai,[{pin,ids:['shared.codex_adapter_instruction','summary.short']}]);expect(result.error).toBe('prompts.errors.model');expect(result.completedKeys).toEqual([]);expect(Object.values(result.inapplicable)).toEqual(['provider:local']);expect(ai.runDefaultTask).not.toHaveBeenCalled();
 });
});
