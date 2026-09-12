import { afterEach,beforeEach,describe,it,expect,vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { AiService } from './ai-service.js';
import { summaryPrompt } from './knowledge-processing.js';
import { defaultPromptPin,withPromptPin,renderPrompt,installPromptPin } from './prompt-runtime.js';
const state=vi.hoisted(()=>({selection:{} as any,model:{} as any,record:vi.fn(),select:vi.fn()}));
vi.mock('@app/db',async()=>({...await vi.importActual('@app/db'),createAiConfigRepository:()=>({ensureRemoteRerankingCapabilities:async()=>{},getDefaultTask:async(...args:unknown[])=>{state.select(...args);return state.selection;},recordTaskRun:state.record}),createLocalModelRepository:()=>({findById:async()=>state.model})}));
const uuid='00000000-0000-4000-8000-000000000001';
function pin(marker:string,sameText=false){const p=defaultPromptPin();for(const id of ['summary.short','shared.output_language','shared.codex_adapter_instruction','diagnostics.local_generation','diagnostics.local_embedding']){const entry=p.entries.find(e=>e.id===id)!;if(!sameText)entry.fields.body=marker+' '+entry.fields.body;entry.revisions.push({id,revisionId:marker});}return p;}
function service(run:(request:any,signal?:AbortSignal)=>Promise<unknown>){const s=new AiService({userDataPath:'/tmp/prompt-ai-tests',getPool:()=>({}) as any,workspaceRoot:'/tmp',resourcesPath:'/tmp',isPackaged:false});const adapter={describe:()=>({providerId:state.selection.provider,modelId:state.selection.modelId,capabilities:['offline','summarization','text-generation','structured-output','embedding','atomic-note-generation','reranking'],parameterCapabilities:{maxTokens:{min:1,max:16384},temperature:{min:0,max:2}}}),canHandle:()=>true,run:vi.fn(async(request:any,signal?:AbortSignal)=>({taskType:request.taskType,output:await run(request,signal),providerId:state.selection.provider,modelId:state.selection.modelId,runtime:'fixture',durationMs:1,inputTokens:2,outputTokens:1}))};vi.spyOn(s as any,'createAdapter').mockImplementation(async()=>(s as any).registerAdapter(adapter));vi.spyOn(s as any,'createLocalAdapter').mockImplementation(async()=>(s as any).registerAdapter(adapter));return {s,adapter};}
beforeEach(()=>{state.record.mockReset().mockImplementation(async()=>randomUUID());state.select.mockReset();state.selection={profileId:uuid,providerConfigId:uuid,localModelId:null,provider:'openai-codex',modelId:'fixture',runtime:'fixture',revision:'1',repository:null,quantization:null,baseUrl:'https://fixture.invalid',parameters:{temperature:.2},modelDefaultParameters:{},requiredCapabilities:['summarization','structured-output','embedding','text-generation']};state.model={id:uuid,modelId:'fixture',runtime:'gguf',capabilities:['text-generation'],defaultParameters:{},repository:null,revision:'1',quantization:null};});
afterEach(()=>installPromptPin(defaultPromptPin()));
describe('canonical prompt audit and FIFO callers',()=>{
 it('pins active body, shared language and adapter instructions before FIFO, and retains them for later repairs',async()=>{
  const gate=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();let n=0;const requests:any[]=[];
  const {s}=service(async request=>{requests.push(request);if(++n===1){started.resolve();await gate.promise;}return 'Summary';});
  const old=pin('OLD'),next=pin('NEW');
  const first=withPromptPin(old,()=>s.runDefaultTask('summarization',summaryPrompt([{id:uuid,content:'First synthetic source.'}],false)));
  await started.promise;
  const second=withPromptPin(old,()=>s.runDefaultTask('summarization',summaryPrompt([{id:uuid,content:'Second synthetic source.'}],false)));
  installPromptPin(next);for(let i=0;i<5000;i++)renderPrompt('embedding.query',{query:String(i)});gate.resolve();await Promise.all([first,second]);
  await s.runDefaultTask('summarization',summaryPrompt([{id:uuid,content:'Future synthetic source.'}],false));
  expect(requests[1].input).toContain('OLD Produce');expect(requests[1].input).toContain('OLD Summarize');expect(requests[1].metadata.applicationInstruction).toContain('OLD You are');expect(requests[2].input).toContain('NEW Summarize');
  const audits=state.record.mock.calls.map(c=>c[0]);for(const audit of audits.slice(0,2))expect(audit.promptCompositions.flatMap((c:any)=>c.revisions).some((r:any)=>r.revisionId==='NEW')).toBe(false);
  expect(audits[1].promptCompositions.some((c:any)=>c.promptId==='shared.codex_adapter_instruction')).toBe(true);expect(audits[2].promptCompositions.flatMap((c:any)=>c.revisions).some((r:any)=>r.revisionId==='NEW')).toBe(true);
 });
 it('does not borrow revisions for identical bytes and audits started failure/cancellation only',async()=>{
  const {s}=service(async(_request,signal)=>{if(signal)throw new Error('interrupted');throw new Error('failed');});
  for(const marker of ['REVISION_A','REVISION_B'])await expect(withPromptPin(pin(marker,true),()=>s.runDefaultTask('summarization',summaryPrompt([{id:uuid,content:'Same text'}],false)))).rejects.toThrow('failed');
  const rows=state.record.mock.calls.map(c=>c[0]);expect(rows).toHaveLength(2);expect(rows[0].status).toBe('failed');expect(rows[0].promptCompositions[0].revisions.some((r:any)=>r.revisionId==='REVISION_A')).toBe(true);expect(rows[1].promptCompositions[0].revisions.some((r:any)=>r.revisionId==='REVISION_B')).toBe(true);
  const controller=new AbortController();const {s:cancelService}=service(async()=>{controller.abort();throw new Error('interrupted');});await expect(withPromptPin(pin('CANCELED'),()=>cancelService.runDefaultTask('summarization',summaryPrompt([{id:uuid,content:'Canceled'}],false),{},controller.signal))).rejects.toThrow('interrupted');expect(state.record.mock.calls.at(-1)![0]).toMatchObject({status:'canceled',promptCompositions:expect.any(Array)});
 });
 it('applies each registered content serializer once and separates only changed embedding input spaces',async()=>{
  state.selection.provider='fixture';state.selection.modelId='qwen3-embedding-fixture';const requests:any[]=[];const {s}=service(async request=>{requests.push(request);return [1,...Array(255).fill(0)];});
  const p=defaultPromptPin();p.entries.find(e=>e.id==='embedding.content.note')!.fields.body='NOTE %note_title% | %note_idea% | %note_body%';p.entries.find(e=>e.id==='embedding.content.chunk')!.fields.body='CHUNK %source_text%';
  const baseline=await withPromptPin(defaultPromptPin(),()=>s.runDefaultTask('embedding','text',{},undefined));
  const language=pin('LANGUAGE');const unchanged=await withPromptPin(language,()=>s.runDefaultTask('embedding','text',{},undefined));expect(unchanged!.embeddingSpaceKey).toBe(baseline!.embeddingSpaceKey);
  const note=await withPromptPin(p,()=>s.runDefaultTask('embedding',renderPrompt('embedding.content.note',{note_title:'Title',note_idea:'Idea',note_body:'Literal %query%'})));
  await withPromptPin(p,()=>s.runDefaultTask('embedding','passage',{embeddingInputType:'document'}));
  expect(requests[2].input).toBe('NOTE Title | Idea | Literal %query%');expect(requests[3].input).toBe('CHUNK passage');expect(note!.embeddingSpaceKey).not.toBe(baseline!.embeddingSpaceKey);
  const audit=state.record.mock.calls[2]![0].promptCompositions;expect(audit.some((c:any)=>c.promptId==='embedding.content.note')).toBe(true);expect(audit.some((c:any)=>c.promptId==='embedding.content.chunk')).toBe(false);
 });
 it('local generation and embedding diagnostic callers resolve their catalog leaf and record it',async()=>{
  state.selection.provider='fixture';const requests:any[]=[];const {s}=service(async request=>{requests.push(request);return request.taskType==='embedding'?[1,...Array(255).fill(0)]:'OK';});
  await withPromptPin(pin('TEST'),()=>s.testLocalModel(uuid));state.model.capabilities=['embedding'];await withPromptPin(pin('TEST'),()=>s.testLocalModel(uuid));
  expect(requests[0].input).toBe('TEST Reply with exactly: OK');expect(requests[1].input).toBe('TEST query: local embedding smoke test');expect(state.record.mock.calls[0]![0].promptCompositions[0].promptId).toBe('diagnostics.local_generation');expect(state.record.mock.calls[1]![0].promptCompositions[0].promptId).toBe('diagnostics.local_embedding');
 });
});
