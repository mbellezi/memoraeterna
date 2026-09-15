import {randomUUID} from 'node:crypto';
import {resolveHierarchyRouteParent,hierarchyContinuationFrontier,HierarchyRouteContinuationSchema,CuratorChangeSetSchema,hierarchyResourceDecision,type CuratorRun,type CuratorSnapshot,type CuratorChangeSet,type HierarchyParent} from '@app/domain';
import {curatorHash} from '@app/db';
import {promptFingerprint} from './prompt-runtime.js';

export type HierarchyRoute=NonNullable<CuratorSnapshot['continuationRoute']>;
/** Called only after full content/scope validation of the retained candidate. */
export function planHierarchyRoute(run:CuratorRun,associations:Array<{handle:string;originalHandles:string[]}>):HierarchyRoute{
 const proposal=run.checkpoint.proposal!,snapshot=run.snapshot;
 if(snapshot.intent||!proposal.ancestors.length||proposal.moves.length||proposal.noteEvolution||proposal.targets.some(t=>t.pageId)||snapshot.structuralIntent)throw new Error('organization.errors.scopeLimit');
 const remaining=[...proposal.ancestors],path:typeof remaining=[];
 const resolved=new Set<string>();
 while(remaining.length){
  const index=remaining.findIndex(a=>a.initialParent?.reference!=='proposed'||resolved.has(a.initialParent.handle));
  if(index<0)throw new Error('organization.errors.scopeLimit');
  const node=remaining.splice(index,1)[0]!;path.push(node);resolved.add(node.handle);
 }
 return HierarchyRouteContinuationSchema.parse({version:'automatic-wiki-v1',routeId:randomUUID(),planningRunId:run.id,
  fingerprint:{version:'automatic-wiki-v1',branchFingerprint:snapshot.placement.fingerprint,scopeFingerprint:snapshot.placement.scopeFingerprint,policyRevisionId:snapshot.policy.revisionId,promptFingerprint:promptFingerprint(['organization.curator','organization.curator.repair','organization.curator.support'],snapshot.promptPin,snapshot.profile.provider),modelFingerprint:curatorHash(snapshot.profile)},
  state:'pending',intendedTargets:proposal.targets.map(t=>({key:t.handle,title:t.title,purpose:t.purpose,role:t.role,initialParent:t.initialParent,resolvedPageId:null})),remainingPath:path.map(a=>({key:a.handle,title:a.title,purpose:a.purpose,role:a.role,initialParent:a.initialParent,chunkIds:associations.find(s=>s.handle===a.handle)!.originalHandles.map(h=>snapshot.evidence.find(e=>e.handle===h)!.chunkId)})),resolvedPrefix:[],reason:'output',completedGroupIds:[],currentChildRunId:null});
}

/** Expand durable planning keys against the freshly pinned canonical prefix. */
export function hierarchyRouteProposal(snapshot:CuratorSnapshot,planning:CuratorRun,fits:(proposal:CuratorChangeSet)=>boolean):CuratorChangeSet{
 const route=snapshot.continuationRoute!,original=planning.checkpoint.proposal!;
 const ancestors=route.remainingPath.map(a=>({handle:a.key,title:a.title,purpose:a.purpose,role:a.role,initialParent:resolveHierarchyRouteParent(a.initialParent,route)}));
 const resolved=new Map(route.resolvedPrefix.map(p=>[p.key,p]));
 const rebind=(value:unknown):unknown=>{
  if(Array.isArray(value))return value.map(rebind);
  if(!value||typeof value!=='object')return value;
  const ref=value as {reference?:string;handle?:string};
  if(ref.reference==='proposed'&&ref.handle&&resolved.has(ref.handle)){const page=resolved.get(ref.handle)!;return{reference:'existing',target:{kind:'page',id:page.pageId},fingerprint:page.revisionId};}
  return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebind(v)]));
 };
 const targets=original.targets.map(t=>({...rebind(t) as typeof t,initialParent:resolveHierarchyRouteParent(route.intendedTargets.find(i=>i.key===t.handle)!.initialParent,route)}));
 const base={...original,groupId:snapshot.groupId,targets,ancestors};
 const complete=CuratorChangeSetSchema.parse(base);
 if(fits(complete))return complete;
 let chosen:CuratorChangeSet|null=null;
 for(let n=1;n<=ancestors.length;n++){
  const candidate=CuratorChangeSetSchema.parse({...base,targets:[],ancestors:ancestors.slice(0,n),continuation:{routeId:route.routeId,fingerprint:route.fingerprint,intendedTargetKeys:route.intendedTargets.filter(t=>!t.resolvedPageId).map(t=>t.key),nextParents:hierarchyContinuationFrontier(ancestors.slice(0,n))}});
  if(!fits(candidate))break;
  chosen=candidate;
 }
 if(!chosen)throw new Error('organization.errors.scopeLimit');
 return chosen;
}

export const proposalFitsBytes=(snapshot:CuratorSnapshot,proposal:CuratorChangeSet)=>hierarchyResourceDecision(proposal,snapshot.resources.maxProposalBytes).decision==='fits';
