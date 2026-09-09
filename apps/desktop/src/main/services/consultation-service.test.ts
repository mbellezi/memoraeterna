import {organizationCheckpointWithUsage} from "./organization-service.js";
import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {OrganizationCheckpointSchema,OrganizationActionSchema,OrganizationSnapshotSchema,WikiPageContentSchema,resolveOrganizationInstructions,OrganizationConfigurationSchema,resolveProcessingPlan} from '@app/domain';
import {parseConsultationAnswer,rankConsultationCandidates,packConsultationSnapshot,consultationPrompt,consultationUsage,consultationSaveProposal} from './consultation-service.js';
import {organizationReadiness} from './organization-participation.js';
const fixture=()=>({evidence:[{handle:'e1'},{handle:'e2'}],contexts:[{id:randomUUID(),handles:['e1','e2']}],relations:[]}) as unknown as ReturnType<typeof OrganizationSnapshotSchema.parse>;
describe('bounded cited consultation',()=>{
 it('preserves known query usage and unknown cost in saved/sample checkpoints and reconciles older zero snapshots from linked audits',()=>{
   const usage=consultationUsage([{inputTokens:3699,outputTokens:262}]);expect(usage).toEqual({reportedInputTokens:3699,reportedOutputTokens:262,costEstimate:0,usageCounts:{input:1,output:1,cost:0},usageIncomplete:true});
   const old=OrganizationCheckpointSchema.parse({tools:1,calls:1,repairs:0,startedAt:null,readHandles:[],discoveredHandles:[],transcript:[],reportedInputTokens:0,reportedOutputTokens:0,costEstimate:0,usageIncomplete:false,callPending:false,error:null});
   const restored=organizationCheckpointWithUsage(old,{inputTokens:3699,outputTokens:262,costEstimate:0,knownInputCalls:1,knownOutputCalls:1,knownCostCalls:0,incomplete:true});expect(restored).toMatchObject(usage);
   expect(consultationUsage([{inputTokens:100,outputTokens:20,costEstimate:0},{outputTokens:10}])).toMatchObject({reportedInputTokens:100,reportedOutputTokens:30,usageCounts:{input:1,output:2,cost:1},usageIncomplete:true});
 });
 it('keeps every epistemic gap with original citation/context provenance and the content-language heading within the six-section contract',()=>{
   const context=randomUUID(),gap='As passagens não estabelecem quais níveis de dificuldade produzem o maior benefício.';
   const proposal=consultationSaveProposal({question:'Limites',answer:{paragraphs:[{markdown:'Síntese [e1] [e2]',citations:['e1','e2'],contextIds:[context]}],gaps:[gap]}},'pt-BR');
   expect(proposal.sections[0]?.markdown).toContain(gap);expect(proposal.sections[0]?.markdown).toContain('Lacunas e limites das evidências');expect(proposal.sections[0]?.citations).toEqual(['e1','e2']);expect(proposal.sections[0]?.contextIds).toEqual([context]);expect(OrganizationActionSchema.safeParse(proposal).success).toBe(true);
   const gaps=Array.from({length:8},(_,i)=>String(i)+'x'.repeat(999));
   for(const count of [1,6]){const bounded=consultationSaveProposal({question:'Bounded',answer:{paragraphs:Array.from({length:count},()=>({markdown:'x'.repeat(6000),citations:['e1'],contextIds:[]})),gaps}},'en');expect(bounded.sections.length).toBeLessThanOrEqual(6);expect(OrganizationActionSchema.safeParse(bounded).success).toBe(true);for(const gap of gaps)expect(bounded.sections.some(s=>s.markdown.includes(gap))).toBe(true);}
 });
 it('requires supplied original handles and two-sided context, rejecting forged tools and duplicate citations',()=>{
  const snapshot=fixture(),answer={paragraphs:[{markdown:'Qualified comparison [e1] [e2]',citations:['e1','e2'],contextIds:[snapshot.contexts[0]!.id]}],gaps:['Conditions differ.']};
  expect(parseConsultationAnswer(JSON.stringify(answer),snapshot)).toEqual(answer);
  expect(()=>parseConsultationAnswer({...answer,tool:'matchSourceRelations'},snapshot)).toThrow();
  expect(()=>parseConsultationAnswer({paragraphs:[{...answer.paragraphs[0],citations:['e1']}],gaps:[]},snapshot)).toThrow();
  expect(()=>parseConsultationAnswer({paragraphs:[{markdown:'Unsupported [e9]',citations:['e1'],contextIds:[]}],gaps:[]},snapshot)).toThrow();
  expect(()=>parseConsultationAnswer({paragraphs:[{markdown:'Repeated',citations:['e1','e1']}],gaps:[]},snapshot)).toThrow();
 });
 it('rejects irrelevant candidates and weak uncorroborated vectors while preserving independently hydrated vector hits',()=>{
  const rows=[{chunkId:'a',sourceItemId:'one',text:1},{chunkId:'b',sourceItemId:'two',text:0},{chunkId:'c',sourceItemId:'three',text:0}];
  expect(rankConsultationCandidates(rows,[{id:'b',score:.47},{id:'c',score:.49}]).map(r=>r.chunkId)).toEqual(['a','c']);
  expect(rankConsultationCandidates([{chunkId:'z',sourceItemId:'x',text:0}],[])).toEqual([]);
 });
 it('reserves other works while retaining useful same-book chapters and avoids derivative vote multiplication',()=>{
  const rows=[{chunkId:'a1',sourceItemId:'chapter1',rootId:'book',text:5,note:5,concept:5},{chunkId:'a2',sourceItemId:'chapter2',rootId:'book',text:4},{chunkId:'b',sourceItemId:'paper',rootId:'paper',text:3}];
  expect(rankConsultationCandidates(rows,[],2).map(r=>r.chunkId)).toEqual(['a1','b']);
  expect(rankConsultationCandidates(rows,[],3).map(r=>r.chunkId)).toEqual(['a1','b','a2']);
 });
 it('packs complete passages for an 8192-token profile before generation and discloses bounded coverage through a smaller manifest',()=>{
  const sources=[randomUUID(),randomUUID()],snapshot=OrganizationSnapshotSchema.parse({version:'wiki-three-tools-v1',targetId:randomUUID(),expectedRevisionId:null,targetHuman:false,baseContent:WikiPageContentSchema.parse({title:'Question',kind:'synthesis'}),sourceIds:sources,profile:{profileId:randomUUID(),providerConfigId:null,localModelId:randomUUID(),provider:'fixture',modelId:'fixture',runtime:'test',revision:null,privacy:'offline_only',parameters:{},identityHash:'fixture',contextWindow:8192},contentLanguage:'en',configurationId:null,configurationHash:'fixture',instructions:resolveOrganizationInstructions({global:{},pageSynthesis:{},domains:[]},null,'Question','en','consultation'),limits:{},policy:'human_review',sample:false,relations:[],evidence:Array.from({length:12},(_,i)=>({handle:`e${i+1}`,chunkId:randomUUID(),sourceItemId:sources[i%2],documentId:randomUUID(),sourceSpanId:null,contentHash:'original',excerpt:'x'.repeat(2500),sourceTitle:'Original',documentCreatedAt:new Date().toISOString(),locator:null}))});
  const packed=packConsultationSnapshot(snapshot,'Question');expect(packed.evidence.length).toBeLessThan(12);expect(packed.evidence.length).toBeGreaterThanOrEqual(2);expect(new Set(packed.evidence.map(e=>e.sourceItemId)).size).toBe(2);expect(packed.evidence.every(e=>e.excerpt.length===2500)).toBe(true);expect(consultationPrompt(packed,'Question').length).toBeLessThanOrEqual(12288);
 });
 it('keeps legacy advanced synthesis instructions away from consultation until a deliberate versioned activation',()=>{
  const old=OrganizationConfigurationSchema.parse({global:{advanced:'Write page {{title}}',guidance:'Global guidance'},pageSynthesis:{guidance:'Page only'},domains:[]});
  const query=resolveOrganizationInstructions(old,null,'Topic','en','consultation');
  expect(query.slots.advanced).not.toBe('Write page Topic');expect(query.slots.guidance).toBe('Global guidance');
  expect(resolveOrganizationInstructions({...old,functionsVersion:2,consultation:{guidance:'Answer only'}},null,'Topic','en','consultation').slots).toEqual({guidance:'Answer only',advanced:'Write page Topic'});
 });
 it('adds only segmentation prerequisites to explicit organization; named and immutable legacy plans stay unchanged',()=>{
  const base={preset:'custom' as const,requestedStages:['organizeKnowledge' as const],scope:'source_only' as const,targetSourceItemIds:[],forceRegeneration:false,previousArtifactPolicy:'reuse_valid' as const};
  expect(resolveProcessingPlan(base).effectiveStages).toEqual(['conversion','structureDetection','structureReview','materialization','chunking','organizeKnowledge']);
  expect(resolveProcessingPlan({...base,preset:'full_knowledge'}).effectiveStages).not.toContain('organizeKnowledge');
  expect(resolveProcessingPlan({...base,preset:'import_only'}).effectiveStages).not.toContain('organizeKnowledge');
 });
});
describe('organization checkpoint barrier',()=>{
 const run=(stages:Record<string,string>,status='succeeded')=>({id:randomUUID(),sourceItemId:randomUUID(),status:status as 'succeeded',effectiveStages:[...Object.keys(stages),'organizeKnowledge'],stagesCheckpoint:Object.fromEntries(Object.entries(stages).map(([k,status])=>[k,{status}]))});
 it('never equates an ended parent with selected matching completion',()=>{
  expect(organizationReadiness([run({chunking:'completed',atomicNotes:'completed',atomicNoteMatching:'waiting_for_batch',sourceMatching:'pending'})],false).ready).toBe(false);
  expect(organizationReadiness([run({chunking:'completed',sourceMatching:'completed'})],true).ready).toBe(false);
 });
 it('admits terminal partial inputs after both matching barriers and the final catalog job settle',()=>{
  const successful=run({chunking:'completed',atomicNotes:'completed',atomicNoteMatching:'completed',sourceMatching:'completed'}),failed=run({chunking:'completed',knowledgeGraph:'failed'},'failed');
  const before=structuredClone(successful),state=organizationReadiness([successful,failed],false);
  expect(state.ready).toBe(true);expect(state.omissions).toEqual([{sourceItemId:failed.sourceItemId,stage:'knowledgeGraph',status:'failed'}]);expect(successful).toEqual(before);
  expect(organizationReadiness([successful,failed],true).ready).toBe(false);
 });
});
