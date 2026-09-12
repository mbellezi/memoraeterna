import { readFileSync } from 'node:fs';
import { describe,it,expect } from 'vitest';
import { renderPromptTemplate,validatePromptGraph,promptDefinitions,promptDefinition,PromptVariableSchema,PromptDefinitionSchema,promptVariablesUsed,PromptTemplateError } from '@app/domain';
import { defaultPromptPin,withPromptPin,renderPrompt,promptAudit,embeddingPromptIdentity,stagePromptFingerprints } from './prompt-runtime.js';
const locales={en:'Synthetic input','pt-BR':'Entrada sintética',it:'Input sintetico',fr:'Entrée synthétique',es:'Entrada sintética'};
const variables=[['question','text',true,null],['max_sections','integer',true,null],['related_knowledge','list',false,'[]']].map(([key,valueType,required,emptyRepresentation])=>PromptVariableSchema.parse({key,description:locales,valueType,scope:'run',required,originResolver:key,example:valueType==='integer'?3:valueType==='list'?[]:'Synthetic question',sensitivity:'source_content',serialization:valueType==='list'?'json':'text',applicablePromptIds:['sample'],emptyRepresentation}));
describe('prompt catalog deterministic renderer',()=>{
 const cases=JSON.parse(readFileSync(new URL('../../../../../scripts/fixtures/automatic-wiki/prompt-variables.json',import.meta.url),'utf8')) as Array<{case:string;template:string;values:Record<string,unknown>;expected?:string;error?:string;requiredContracts?:string[];fragments?:Record<string,string[]>}>;
 for(const fixture of cases)it(fixture.case,()=>{
  const run=()=>{validatePromptGraph(fixture.fragments??{});return renderPromptTemplate(fixture.template,variables,fixture.values,fixture.requiredContracts);};
  if(fixture.error){try{run();throw new Error('Expected failure');}catch(e){expect(e).toBeInstanceOf(PromptTemplateError);expect((e as PromptTemplateError).code).toBe(fixture.error);}}else expect(run()).toBe(fixture.expected);
 });
 it('validates every definition, declared variable, localized description and actual field token',()=>{
  expect(new Set(promptDefinitions.map(d=>d.id)).size).toBe(promptDefinitions.length);
  for(const d of promptDefinitions){for(const metadata of [d.title,d.purpose,...d.variables.map(v=>v.description)])for(const value of Object.values(metadata)){expect(value).not.toContain("[[missing:");expect(value).not.toContain("promptCatalogMetadata.");}expect(PromptDefinitionSchema.safeParse(d).success,d.id).toBe(true);for(const f of d.fields){expect(promptVariablesUsed(f.template).every(key=>d.variables.some(v=>v.key===key)),`${d.id}:${f.id}`).toBe(true);}for(const v of d.variables)for(const value of Object.values(v.description))expect(value).not.toContain('promptCatalogMetadata.');}
  validatePromptGraph(Object.fromEntries(promptDefinitions.map(d=>[d.id,d.fragmentIds])));
 });
 it('renders structured data once and rejects removing enforced contracts in every structured family',()=>{
  const pin=defaultPromptPin();for(const d of promptDefinitions.filter(d=>d.fields.some(f=>f.requiredContractIds.length))){const entry=pin.entries.find(e=>e.id===d.id)!;entry.fields.body='No output contract';expect(()=>withPromptPin(pin,()=>renderPrompt(d.id,{})),d.id).toThrow('prompts.errors.missing_contract');}
  const d=promptDefinition('graph.relation_identity');expect(d.variables.find(v=>v.key==='candidates')).toMatchObject({valueType:'object',serialization:'json'});
 });
 it('pins exact revisions across activations and keeps provenance isolated for identical text',async()=>{
  const a=defaultPromptPin(),b=defaultPromptPin();b.entries.find(e=>e.id==='summary.reduce')!.revisions.push({id:'summary.reduce',revisionId:'different-revision'});
  let release!:()=>void;const wait=new Promise<void>(r=>release=r);
  const first=withPromptPin(a,async()=>{const input=renderPrompt('summary.reduce',{partial_summaries:'Synthetic text'});await wait;return promptAudit(input);});
  const second=withPromptPin(b,()=>{const input=renderPrompt('summary.reduce',{partial_summaries:'Synthetic text'});for(let i=0;i<5000;i++)renderPrompt('embedding.query',{query:String(i)});return promptAudit(input);});release();
  expect((await first)[0]!.revisions.some(r=>r.revisionId==='different-revision')).toBe(false);expect(second[0]!.revisions.some(r=>r.revisionId==='different-revision')).toBe(true);
 });
 it('keeps shipped embedding identity and ignores unrelated generative edits, but changes compatible spaces for real input edits',()=>{
  const pin=defaultPromptPin();expect(embeddingPromptIdentity(pin)).toBeNull();const original=stagePromptFingerprints(pin);
  pin.entries.find(e=>e.id==='shared.output_language')!.fields.body+=' Use concise sentences.';
  expect(embeddingPromptIdentity(pin)).toBeNull();expect(stagePromptFingerprints(pin).embedding).toBe(original.embedding);expect(stagePromptFingerprints(pin).summarization).not.toBe(original.summarization);
  pin.entries.find(e=>e.id==='embedding.query_instruction')!.fields.body+=' Prioritize exact definitions.';expect(embeddingPromptIdentity(pin)).toMatch(/^[a-f0-9]{64}$/);
 });
});

it('only applicable provider wording changes artifact strategy fingerprints',()=>{
 const old=defaultPromptPin(),next=defaultPromptPin();next.entries.find(e=>e.id==='shared.codex_adapter_instruction')!.fields.body+=' Extra provider guidance.';
 expect(stagePromptFingerprints(old,false,'local')).toEqual(stagePromptFingerprints(next,false,'local'));
 expect(stagePromptFingerprints(old,false,'openai-codex').summarization).not.toBe(stagePromptFingerprints(next,false,'openai-codex').summarization);
 expect(stagePromptFingerprints(old,false,'openai-codex').embedding).toBe(stagePromptFingerprints(next,false,'openai-codex').embedding);
});

it('every shipped field has usable typed synthetic examples',()=>{for(const d of promptDefinitions){const values=Object.fromEntries(d.variables.map(v=>[v.key,v.example]));expect(()=>withPromptPin(defaultPromptPin(),()=>renderPrompt(d.id,values)),d.id).not.toThrow();}});
