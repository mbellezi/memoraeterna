import { randomUUID } from 'node:crypto';
import { describe,it,expect,vi } from 'vitest';
import { OrganizationCheckpointSchema,MaintenanceSnapshotSchema,MaintenanceCheckpointSchema,MaintenancePolicySchema,WikiPageContentSchema,type PromptPin } from '@app/domain';
import { defaultPromptPin,withPromptPin,installPromptPin } from './prompt-runtime.js';
import { generateSummaryFromChunks,generateAtomicNoteCandidates,generateKnowledgeGraphFromAtomicNotes } from './knowledge-processing.js';
import { promptSampleSnapshot,promptSampleCheckpoint } from './prompt-samples.js';
import { ConsultationService } from './consultation-service.js';
import { OrganizationService } from './organization-service.js';
import { MaintenanceService,maintenanceDiagnostic } from './maintenance-service.js';
const id=randomUUID(),source={title:'Fictional feedback study',language:'en'},chunks=[{id,content:'Retrieval with feedback improved delayed recall in a fictional classroom study.'}];
const execution=(output:unknown)=>({output,taskType:'structured-output' as const,aiTaskRunId:randomUUID(),profileId:id,providerId:'fixture',modelId:'fixture',runtime:'fixture',durationMs:1,inputTokens:10,outputTokens:10,costEstimate:0,outputLanguage:'en'});
function marked(ids:string[]):PromptPin{const pin=defaultPromptPin();for(const id of ids)pin.entries.find(e=>e.id===id)!.fields.body=`CATALOG:${id}\n`+pin.entries.find(e=>e.id===id)!.fields.body;return pin;}
describe('actual catalog family callers with deterministic model doubles',()=>{
 it('uses current short, partial and reduction templates in the real summary executor',async()=>{
  const run=vi.fn(async()=>execution({summary:'Synthetic summary',concepts:[]}));
  await withPromptPin(marked(['summary.short','summary.partial','summary.reduce']),async()=>{await generateSummaryFromChunks(chunks,run,3500,0);await generateSummaryFromChunks([...chunks,{id:randomUUID(),content:chunks[0]!.content}],run,50,0);});
  const text=run.mock.calls.map(c=>(c as unknown as [string])[0]);for(const id of ['summary.short','summary.partial','summary.reduce'])expect(text.some(t=>t.startsWith('CATALOG:'+id))).toBe(true);
 });
 it('the actual note repair caller keeps its admitted template after activation',async()=>{
  const pin=marked(['notes.extract','notes.repair']);let count=0;const run=vi.fn(async(_input:string)=>{installPromptPin(marked(['summary.short']));return execution(++count===1?'{':{notes:[]});});
  const result=await withPromptPin(pin,()=>generateAtomicNoteCandidates(source,chunks,run));expect(result?.output.notes).toEqual([]);expect(run.mock.calls.map(c=>c[0].split('\n')[0])).toEqual(['CATALOG:notes.extract','CATALOG:notes.repair']);installPromptPin(defaultPromptPin());
 });
 it.each(['atomic_notes','source_chunks','catalog_metadata']as const)('routes real %s graph extraction and repair through both catalog leaves',async kind=>{
  let count=0;const run=vi.fn(async(_input:string)=>execution(++count===1?'{':{entities:[],claims:[],relations:[]}));
  const result=await withPromptPin(marked([`graph.${kind}`,`graph.${kind}.repair`]),()=>generateKnowledgeGraphFromAtomicNotes(source,[{id:randomUUID(),title:'Feedback',ideaStatement:chunks[0]!.content,bodyMarkdown:chunks[0]!.content,evidenceChunkIds:[id]}],run,12000,{inputKind:kind}));
  expect(result?.batches).toHaveLength(1);expect(run.mock.calls.map(c=>c[0].split('\n')[0])).toEqual([`CATALOG:graph.${kind}`,`CATALOG:graph.${kind}.repair`]);
 });
 it('executes consultation repair using the persisted pin even when active settings changed',async()=>{
  const pin=marked(['consultation.answer','consultation.repair']),snapshot=promptSampleSnapshot(pin,'consultation');let count=0;
  const runOrganizationTask=vi.fn(async()=>{installPromptPin(defaultPromptPin());return execution(++count===1?'{':{paragraphs:[{markdown:'Feedback qualified the observed benefit [e1].',citations:['e1'],contextIds:[]}],gaps:[]});});
  const service=new ConsultationService({getPool:()=>null,ai:{runOrganizationTask},contentLanguage:async()=> 'en'}as any) as any;
  const answer=await service.generate(JSON.parse(JSON.stringify(snapshot)),'What helped?',[],new AbortController().signal);
  expect(answer.auditIds).toHaveLength(2);const calls=runOrganizationTask.mock.calls as unknown as Array<[unknown,string]>;expect(calls[0]![1]).toContain('CATALOG:consultation.answer');expect(calls[1]![1]).toContain('CATALOG:consultation.repair');
 });
 it('executes all three organization states plus repair from a restarted persisted snapshot',async()=>{
  const pin=marked(['organization.legacy_synthesis','organization.state.discover','organization.state.read','organization.state.propose','organization.repair']);
  const snapshot=JSON.parse(JSON.stringify(promptSampleSnapshot(pin)));const checkpoint=promptSampleCheckpoint();const run:any={id,status:'queued',snapshot,checkpoint,receiptRevisionId:null};
  const actions=['{',{tool:'searchEvidence',query:'',limit:20},{tool:'readRevision',handle:'e1',selector:'full'},{tool:'readRevision',handle:'e2',selector:'full'},{tool:'proposePageChange',target:'page',expectedRevisionId:null,explanation:'A bounded comparison',sections:[{sectionId:null,title:'Feedback',markdown:'The two studies qualify the role of feedback.',citations:['e1','e2'],contextIds:[]}]}];
  const runOrganizationTask=vi.fn(async()=>{installPromptPin(defaultPromptPin());return execution(actions.shift());});
  const service=new OrganizationService({getPool:()=>null,ai:{runOrganizationTask},contentLanguage:async()=> 'en',wake:()=>{},cancelJob:async()=>null}as any) as any;
  service.get=async()=>run;service.repo=()=>({checkpoint:async(_id:string,status:string,c:unknown)=>{run.status=status;run.checkpoint=structuredClone(c);},step:async()=>{},propose:async()=>{run.status='succeeded';}});
  await service.execute({id:randomUUID(),payload:{organizationRunId:id}},new AbortController().signal);
  expect(run.status).toBe('succeeded');expect(runOrganizationTask).toHaveBeenCalledTimes(5);const inputs=(runOrganizationTask.mock.calls as unknown as Array<[unknown,string]>).map(c=>c[1]);for(const id of ['organization.legacy_synthesis','organization.state.discover','organization.state.read','organization.state.propose','organization.repair'])expect(inputs.some(t=>t.includes('CATALOG:'+id))).toBe(true);
 });
 it.each(['weekly','monthly','cleanup']as const)('executes the admitted %s maintenance catalog from a stored run',async routine=>{
  const pin=marked(['maintenance.'+routine]),profile=promptSampleSnapshot(pin).profile;
  const snapshot=MaintenanceSnapshotSchema.parse({promptPin:pin,version:'wiki-maintenance-v1',policy:MaintenancePolicySchema.parse({name:'Synthetic',routine,modelEnabled:true,scope:{wholeLibrary:true},categories:['navigation','knowledge','evidence'],cadence:{timezone:'UTC'}}),profile,configurationId:null,configurationHash:'fixture',instructions:promptSampleSnapshot(pin).instructions,language:'en',scopeKey:'sample',period:'sample',cutoff:new Date().toISOString(),sample:true});
  const candidates=['Learning','Recall'].map((title,i)=>maintenanceDiagnostic({id:randomUUID(),title,revisionId:randomUUID(),fingerprint:'fixture',manual:!!i,children:0,path:[],content:WikiPageContentSchema.parse({title,kind:i?'collection':'topic'})},'page'));
  const run:any={id,status:'queued',snapshot,checkpoint:MaintenanceCheckpointSchema.parse({cursor:{kind:'done',id:null},total:2,inspected:2,findings:1,candidates})};
  const runOrganizationTask=vi.fn(async()=>execution({operations:[],explanation:'No structural improvement is warranted.'}));
  const service=new MaintenanceService({getPool:()=>null,ai:{runOrganizationTask},contentLanguage:async()=> 'en',wake:()=>{},cancelJob:async()=>null}as any) as any;
  service.get=async()=>run;service.repo=()=>({reservePeriod:async()=>{},blockers:async()=>null,decisions:async()=>[],checkpoint:async()=>{},settle:async()=>{}});
  await service.execute({id:randomUUID(),payload:{maintenanceRunId:id}},new AbortController().signal);
  expect(runOrganizationTask).toHaveBeenCalledTimes(1);expect((runOrganizationTask.mock.calls as unknown as Array<[unknown,string]>)[0]![1]).toContain('CATALOG:maintenance.'+routine);
 });
});
