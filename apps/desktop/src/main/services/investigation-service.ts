import {createHash,randomUUID} from 'node:crypto';
import {createAutomaticMaintenanceRepository,createInvestigationRepository,createWikiCuratorRepository,createWikiRepository,type PgPool} from '@app/db';
import {ConsultationInputSchema,ConsultationResultSchema,FollowInvestigationInputSchema,InvestigationStateInputSchema,WikiPageContentSchema,organizationCitationMarkdown,type OrganizationSnapshot,type ConsultationResult,type AutomaticMaintenanceRun,type WikiPageContent} from '@app/domain';
import {consultationSaveProposal,type ConsultationService} from './consultation-service.js';
import {withPromptPin,promptFingerprint,renderPrompt,withOutputLanguageInstruction} from './prompt-runtime.js';
import {estimateAiPlanningTokens} from './ai-task-parameters.js';
import {withAutomaticMaintenanceClock} from './automatic-maintenance-clock.js';
const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function investigationFingerprint(snapshot:OrganizationSnapshot){return hash({question:snapshot.baseContent.title,evidence:snapshot.evidence.map(e=>[e.chunkId,e.contentHash]).sort(),contexts:snapshot.contexts.map(c=>[c.id,c.text,c.review]).sort(),relations:snapshot.relations.map(r=>[r.id,r.fingerprint]).sort(),language:snapshot.contentLanguage,parameters:snapshot.profile.parameters,model:snapshot.profile.identityHash,prompts:promptFingerprint(['consultation.knowledge'],snapshot.promptPin??undefined,snapshot.profile.provider)});}
export function investigationContent(result:ConsultationResult,previous?:WikiPageContent,language:OrganizationSnapshot['contentLanguage']='en'):WikiPageContent{return WikiPageContentSchema.parse({...(previous?WikiPageContentSchema.strip().parse(previous):{}),title:result.question.slice(0,300),kind:'synthesis',review:'draft',automatic:{version:'automatic-wiki-v1',management:'ai_managed',role:{kind:'synthesis',role:'investigation'},purpose:result.question.slice(0,2000),placementProtected:false,links:[],groups:[],memberships:[]},sections:consultationSaveProposal(result,language).sections.map((p,i)=>({id:previous?.sections[i]?.id??randomUUID(),title:'',kind:'prose',markdown:organizationCitationMarkdown(p),provenance:'generated',protected:false,evidenceReview:'needs_review',evidenceIds:p.citations.map(h=>result.evidence.find(e=>e.handle===h)!.chunkId)}))});}
/** Persistent follow authority, dispatched only inside the existing maintenance owner. */
export class InvestigationService{
 private controllers=new Map<string,AbortController>();private recovered=false;
 constructor(private options:{getPool:()=>PgPool|null;consultation:ConsultationService;wake:()=>void;notify?:(item:{id:string;question:string})=>void}){}
 private pool(){const p=this.options.getPool();if(!p)throw new Error('wiki.errors.unavailable');return p;}
 private repo(){return createInvestigationRepository(this.pool());}
 async initialize(){if(!this.recovered){await this.repo().recover();this.recovered=true;}}
 async list(){return(await this.repo().list()).filter(x=>x!==null);}
 async get(id:string){return this.repo().get(id);}
 async follow(raw:unknown){const input=FollowInvestigationInputSchema.parse(raw),saved=this.options.consultation.retained(input.answerId);if(saved.result.coverage.stale||saved.input.version!=='knowledge-consultation-v2')throw new Error('organization.errors.evidence');const result=await this.repo().follow(saved.input,saved.result,saved.snapshot,input.policyId,investigationContent(saved.result,undefined,saved.snapshot.contentLanguage),investigationFingerprint(saved.snapshot));this.options.wake();return result;}
 async state(raw:unknown){const input=InvestigationStateInputSchema.parse(raw);this.controllers.get(input.id)?.abort();const result=await this.repo().state(input.id,input.expectedRevision,input.state);this.options.wake();return result;}
 async tick(occurrence:AutomaticMaintenanceRun){
  await this.initialize();
  for(const id of await this.repo().candidates(occurrence.snapshot.policy.policyId)){
   if(this.controllers.has(id))continue;const item=await this.repo().get(id);if(!item||item.attention&&!['organization.errors.noEvidence','consultation.errors.noRelevantEvidence'].includes(item.attention)&&!/^(maintenance.errors.(budget|period)|organization.errors.(deadline|context|model|policy))$/.test(item.attention))continue;
   const grant=await createWikiCuratorRepository(this.pool()).policy(item.policyId);if(!grant||grant.state!=='enabled'||grant.revisionId!==item.policyRevisionId||!grant.operations.includes('refresh_investigation')){await this.repo().inspectionFailed(id,item.revision,'organization.errors.policy');continue;}
   const allowed=await this.repo().assertScope(grant,[]);const profile=occurrence.snapshot.profile;if(!profile)continue;
   const controller=new AbortController();this.controllers.set(id,controller);const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(120000)]);
   const deliveries=await this.repo().highWater(id);
   try{await withPromptPin(occurrence.snapshot.promptPin,async()=>{
    const input=ConsultationInputSchema.parse({...item.input,requestId:randomUUID(),mode:'text'});
    let prepared;try{prepared=await this.options.consultation.prepare(input,signal,{profile,language:occurrence.snapshot.contentLanguage,allowed});}catch(e){if(/(?:organization.errors.noEvidence|consultation.errors.noRelevantEvidence)/.test(String(e))){await this.repo().noEvidence(id,item.revision,deliveries);return;}throw e;}
    const {snapshot,metadata}=prepared;snapshot.consultationIntent='investigation';
    const fingerprint=investigationFingerprint(snapshot),composition=promptFingerprint(['consultation.knowledge'],snapshot.promptPin??undefined,snapshot.profile.provider);
    if(fingerprint===item.lastInputFingerprint){await this.repo().acknowledge(id,{kind:'unchanged',inputFingerprint:fingerprint},deliveries);return;}
    const currentPage=await createWikiRepository(this.pool()).get(item.answerPageId);if(!currentPage)throw new Error('wiki.errors.conflict');snapshot.targetId=item.answerPageId;snapshot.expectedRevisionId=currentPage.revisionId;snapshot.baseContent=WikiPageContentSchema.strip().parse(currentPage);
    const evaluation=await this.repo().begin(id,item.revision,fingerprint,composition,snapshot,occurrence.id);if(evaluation.existing)return;
    if("resumedSnapshot" in evaluation)Object.assign(snapshot,evaluation.resumedSnapshot);
    const runId=evaluation.run_id as string;let started=false;
    const guard=()=>this.repo().guard(id,item.revision,runId,occurrence.id);
    try{
     const generated=await withAutomaticMaintenanceClock((at,elapsed,unobserved)=>createAutomaticMaintenanceRepository(this.pool()).heartbeat(occurrence.id,at,elapsed,unobserved),clockSignal=>this.options.consultation.generate(snapshot,input.question,item.current.answer,AbortSignal.any([signal,clockSignal]),{runId,guard,before:async(prompt,sequence)=>{await guard();await createAutomaticMaintenanceRepository(this.pool()).reserve(occurrence.id,runId,sequence,estimateAiPlanningTokens(withOutputLanguageInstruction(prompt,snapshot.contentLanguage),profile.provider==='openai-codex'?renderPrompt('shared.codex_adapter_instruction'):'',2048));await this.repo().pendingCall(runId,sequence,false);},started:async sequence=>{started=true;await this.repo().pendingCall(runId,sequence,true);},settled:async sequence=>{started=false;await this.repo().pendingCall(runId,sequence,false);}}));
     const result=ConsultationResultSchema.parse({...metadata,answer:generated.answer,inputTokens:generated.inputTokens,outputTokens:generated.outputTokens,costEstimate:generated.costEstimate});
     const change=result.answer.change!;const page=await createWikiRepository(this.pool()).get(item.answerPageId);if(!page)throw new Error('wiki.errors.conflict');
     await this.repo().finish(id,item.revision,evaluation.id,runId,occurrence.id,result,investigationContent(result,page as WikiPageContent,snapshot.contentLanguage),change.meaningful?change.explanation:[],deliveries);
     if(change.meaningful)this.options.notify?.({id,question:item.question});
    }catch(e){const error=String(e).match(/(?:organization|maintenance|wiki)\.errors\.[A-Za-z]+/)?.[0]??'organization.errors.failed';await this.repo().failed(evaluation.id,runId,error,started);}
   });}catch(error){await this.repo().inspectionFailed(id,item.revision,String(error).match(/(?:organization|maintenance|wiki|consultation)\.errors\.[A-Za-z]+/)?.[0]??'organization.errors.failed');}finally{this.controllers.delete(id);}
  }
 }
 shutdown(){for(const c of this.controllers.values())c.abort();}
}
