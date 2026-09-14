import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {HierarchyRouteContinuationSchema,CuratorChangeSetSchema,hierarchyResourceDecision,type CuratorRun,type CuratorSnapshot,type CuratorChangeSet,type HierarchyParent} from '@app/domain';
import {curatorHash} from '@app/db';
import {promptFingerprint} from './prompt-runtime.js';

export type HierarchyRoute=NonNullable<CuratorSnapshot['continuationRoute']>;
/** Called only after full content/scope validation of the retained candidate. */
export function planHierarchyRoute(run:CuratorRun,associations:Array<{handle:string;originalHandles:string[]}>):HierarchyRoute{
 const proposal=run.checkpoint.proposal!,snapshot=run.snapshot;
 if(snapshot.intent||!proposal.ancestors.length||proposal.moves.length||proposal.noteEvolution||proposal.targets.some(t=>t.pageId)||snapshot.structuralIntent)throw new Error('organization.errors.scopeLimit');
 const remaining=[...proposal.ancestors],path:typeof remaining=[];
 let parent:HierarchyParent|null=null;
 while(remaining.length){
  const next=remaining.filter(a=>path.length?isDeepStrictEqual(a.initialParent,{reference:'proposed',handle:path.at(-1)!.handle}):a.initialParent?.reference!=='proposed');
  if(next.length!==1)throw new Error('organization.errors.scopeLimit');
  if(!path.length)parent=next[0]!.initialParent;
  path.push(next[0]!);remaining.splice(remaining.indexOf(next[0]!),1);
 }
 const endpoint={reference:'proposed',handle:path.at(-1)!.handle};
 for(const target of proposal.targets){
  const expected=target.role.kind==='collection'&&target.role.role==='topic_toc'&&target.role.owner?.reference==='proposed'&&proposal.targets.some(t=>t.handle===(target.role.kind==='collection'&&target.role.owner?.reference==='proposed'?target.role.owner.handle:''))?target.role.owner:endpoint;
  if(!isDeepStrictEqual(target.initialParent,expected))throw new Error('organization.errors.scopeLimit');
 }
 return HierarchyRouteContinuationSchema.parse({version:'automatic-wiki-v1',routeId:randomUUID(),planningRunId:run.id,
  fingerprint:{version:'automatic-wiki-v1',branchFingerprint:snapshot.placement.fingerprint,scopeFingerprint:snapshot.placement.scopeFingerprint,policyRevisionId:snapshot.policy.revisionId,promptFingerprint:promptFingerprint(['organization.curator','organization.curator.repair','organization.curator.support'],snapshot.promptPin,snapshot.profile.provider),modelFingerprint:curatorHash(snapshot.profile)},
  state:'pending',intendedTargets:proposal.targets.map(t=>({key:t.handle,title:t.title,purpose:t.purpose,role:t.role,resolvedPageId:null})),remainingPath:path.map(a=>({key:a.handle,title:a.title,purpose:a.purpose,role:a.role,chunkIds:associations.find(s=>s.handle===a.handle)!.originalHandles.map(h=>snapshot.evidence.find(e=>e.handle===h)!.chunkId)})),resolvedPrefix:[],destination:parent,reason:'output',completedGroupIds:[],currentChildRunId:null});
}

/** Expand durable planning keys against the freshly pinned canonical prefix. */
export function hierarchyRouteProposal(snapshot:CuratorSnapshot,planning:CuratorRun,fits:(proposal:CuratorChangeSet)=>boolean):CuratorChangeSet{
 const route=snapshot.continuationRoute!,original=planning.checkpoint.proposal!;
 const prefix=route.resolvedPrefix.at(-1);
 let parent:HierarchyParent|null=prefix?{reference:'existing',target:{kind:'page',id:prefix.pageId},expectedRevisionId:prefix.revisionId,fingerprint:prefix.fingerprint}:route.destination;
 const ancestors=route.remainingPath.map(a=>{const value={handle:a.key,title:a.title,purpose:a.purpose,role:a.role,initialParent:parent};parent={reference:'proposed',handle:a.key};return value;});
 const resolved=new Map(route.resolvedPrefix.map(p=>[p.key,p]));
 const rebind=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(rebind);
  if(!value||typeof value!=='object')return value;
  const ref=value as {reference?:string;handle?:string};
  if(ref.reference==='proposed'&&ref.handle&&resolved.has(ref.handle)){const page=resolved.get(ref.handle)!;return{reference:'existing',target:{kind:'page',id:page.pageId},fingerprint:page.revisionId};}
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebind(v)]));
 };
 const targets=original.targets.map(t=>{
  const endpoint=original.ancestors.some(a=>a.handle===(t.initialParent?.reference==='proposed'?t.initialParent.handle:''));
  return rebind({...t,initialParent:endpoint?parent:t.initialParent}) as typeof t;
 });
 const base={...original,groupId:snapshot.groupId,targets,ancestors};
 const complete=CuratorChangeSetSchema.parse(base);
 if(fits(complete))return complete;
 let chosen:CuratorChangeSet|null=null;
 for(let n=1;n<=ancestors.length;n++){
  const candidate=CuratorChangeSetSchema.parse({...base,targets:[],ancestors:ancestors.slice(0,n),continuation:{routeId:route.routeId,fingerprint:route.fingerprint,intendedTargetKeys:route.intendedTargets.filter(t=>!t.resolvedPageId).map(t=>t.key),nextParent:{reference:'proposed',handle:ancestors[n-1]!.handle}}});
  if(!fits(candidate))break;
  chosen=candidate;
 }
 if(!chosen)throw new Error('organization.errors.scopeLimit');
 return chosen;
}

export const proposalFitsBytes=(snapshot:CuratorSnapshot,proposal:CuratorChangeSet)=>hierarchyResourceDecision(proposal,snapshot.resources.maxProposalBytes).decision==='fits';
