import { randomUUID } from "node:crypto";
import { afterEach,beforeEach,describe,expect,it,vi } from "vitest";
import { AiService } from "./ai-service.js";
const state=vi.hoisted(()=>({selection:null as any,record:vi.fn(async()=> '00000000-0000-4000-8000-000000000001')}));
vi.mock('@app/db',async()=>({...await vi.importActual('@app/db'),createAiConfigRepository:()=>({getDefaultTask:vi.fn(async()=>state.selection),ensureRemoteRerankingCapabilities:async()=>{},recordTaskRun:state.record})}));
function service(){return new AiService({userDataPath:'/tmp/organization-ai-test',getPool:()=>({}) as any,workspaceRoot:'/tmp',resourcesPath:'/tmp',isPackaged:false});}
beforeEach(()=>{state.record.mockClear();state.selection={profileId:randomUUID(),privacyMode:'allow_remote',providerConfigId:randomUUID(),localModelId:null,provider:'test',credentialRef:null,baseUrl:'https://provider.test',modelId:'model',runtime:'remote',managedPath:null,repository:null,revision:'1',quantization:null,requiredCapabilities:['structured-output'],parameters:{temperature:.2,maxTokens:4096},modelDefaultParameters:{},providerMetadata:{},outputLanguage:'en'};});
afterEach(()=>vi.unstubAllGlobals());
describe('organization profile pinning and shared inference queue',()=>{
  it('rejects local-only remote profiles before adapter/provider exposure',async()=>{
    const s=service(),fetch=vi.fn();vi.stubGlobal('fetch',fetch);const adapter=vi.spyOn(s as any,'createAdapter');
    await expect(s.pinOrganizationProfile(state.selection.profileId,'offline_only')).rejects.toThrow('organization.errors.privacy');
    state.selection.privacyMode='offline_only';await expect(s.pinOrganizationProfile(state.selection.profileId,'allow_remote')).rejects.toThrow('organization.errors.privacy');expect(adapter).not.toHaveBeenCalled();expect(fetch).not.toHaveBeenCalled();
  });
  it('preserves pinned parameters while waiting in the same FIFO and cancels queued work without invoking a model',async()=>{
    const s=service();const pinned=await s.pinOrganizationProfile(state.selection.profileId,'allow_remote');let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(r=>entered=r),blocked=new Promise<void>(r=>release=r);const requests:any[]=[];
    const run=vi.fn(async(request:any)=>{requests.push(request);if(requests.length===1){entered();await blocked;}return {taskType:request.taskType,output:'{}',providerId:'test',modelId:'model',runtime:'remote',durationMs:1,inputTokens:2,outputTokens:1};});
    const adapter={describe:()=>({providerId:'test',modelId:'model',capabilities:['structured-output'],parameterCapabilities:{temperature:{min:0,max:2},maxTokens:{min:1,max:8192}}}),run,canHandle:()=>true};
    vi.spyOn(s as any,'createAdapter').mockImplementation(async()=> (s as any).registerAdapter(adapter));
    const one=s.runOrganizationTask(pinned,'first',{},new AbortController().signal,4096);await waiting;
    const controller=new AbortController();const canceled=s.runOrganizationTask(pinned,'must not execute',{},controller.signal,4096);const rejected=expect(canceled).rejects.toBeDefined();controller.abort();await rejected;
    const two=s.runOrganizationTask(pinned,'second',{},new AbortController().signal,4096);state.selection.parameters={temperature:1.9,maxTokens:1000};release();await Promise.all([one,two]);expect(run).toHaveBeenCalledTimes(2);expect(requests[1].parameters).toMatchObject({temperature:.2,maxTokens:4096});expect(state.record).toHaveBeenCalledTimes(2);
  });
  it('checks consultation input freshness inside FIFO before adapter exposure and suppresses ineligible query embeddings',async()=>{
    const s=service(),pinned=await s.pinOrganizationProfile(state.selection.profileId,'allow_remote'),adapter=vi.spyOn(s as any,'createAdapter');
    const guard=vi.fn(async()=>{throw new Error('organization.errors.evidence');});
    await expect(s.runOrganizationTask(pinned,'question',{},new AbortController().signal,2048,guard)).rejects.toThrow('organization.errors.evidence');expect(guard).toHaveBeenCalledOnce();expect(adapter).not.toHaveBeenCalled();
    state.selection.requiredCapabilities=['embedding'];
    expect(await s.runConsultationEmbedding('private query','offline_only',[],new AbortController().signal)).toBeNull();expect(adapter).not.toHaveBeenCalled();
  });
  it('rejects changed model identity before creating an adapter',async()=>{
    const s=service(),pinned=await s.pinOrganizationProfile(state.selection.profileId,'allow_remote'),adapter=vi.spyOn(s as any,'createAdapter');state.selection.modelId='replacement';await expect(s.runOrganizationTask(pinned,'private prompt',{},new AbortController().signal,4096)).rejects.toThrow('organization.errors.modelChanged');expect(adapter).not.toHaveBeenCalled();
  });
});
