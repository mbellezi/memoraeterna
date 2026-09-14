import {describe,it,expect} from 'vitest';
import {collectionGenerationHash} from './wiki-collection.js';
import {WikiBootstrapCheckpointSchema,CuratorRunSchema,hierarchyResourceDecision} from '@app/domain';
import {curatorSampleSnapshot,curatorSampleCheckpoint} from './prompt-samples.js';
import {defaultPromptPin} from './prompt-runtime.js';
import {expandCuratorDraft,validateCuratorProposal,curatorSupportView} from './wiki-curator.js';
import {planHierarchyRoute,hierarchyRouteProposal} from './wiki-hierarchy-continuation.js';
import {randomUUID} from 'node:crypto';
describe('coverage admission identity',()=>{
 it('preserves dictionary identity across JSONB key ordering without changing array order',()=>{expect(collectionGenerationHash({parameters:{temperature:0.2,maxTokens:2048,nested:{z:1,a:2}},language:'en'})).toBe(collectionGenerationHash({language:'en',parameters:{nested:{a:2,z:1},maxTokens:2048,temperature:0.2}}));expect(collectionGenerationHash({order:[1,2]})).not.toBe(collectionGenerationHash({order:[2,1]}));});
});

it('rejects completion when content, notes or structural work is still pending',()=>{
 const cp={version:'wiki-bootstrap-v1',state:'complete',afterSource:null,sourceId:null,sourceFingerprint:null,afterChunk:null,nextChunk:null,childRunId:null,sourceCovered:0,completedSources:0,catalogedSources:0,completedGroups:0,attentionSources:0,error:null};
 expect(WikiBootstrapCheckpointSchema.safeParse(cp).success).toBe(false);
 const hierarchy={version:'automatic-wiki-v1',fingerprint:{version:'automatic-wiki-v1',branchFingerprint:'branch',scopeFingerprint:'scope',policyRevisionId:randomUUID(),promptFingerprint:'prompt',modelFingerprint:'model'},afterPageId:null,inspectedPages:0,outcome:'no_change',routes:[],counts:{workTargets:0,structuralAncestors:0,changedPages:0},appliedGroupIds:[],decisions:[]};
 const settled={...cp,phase:'structure',contentComplete:true,notesComplete:true,hierarchy};
 expect(WikiBootstrapCheckpointSchema.safeParse(settled).success).toBe(true);
 expect(WikiBootstrapCheckpointSchema.safeParse({...settled,notesComplete:false}).success).toBe(false);
 expect(WikiBootstrapCheckpointSchema.safeParse({...settled,childRunId:randomUUID()}).success).toBe(false);
});

it('plans by bytes and preserves exact pending descendant lineage for prefix support',()=>{
 const snapshot=curatorSampleSnapshot(defaultPromptPin());
 const draft={explanation:'Complete supported path',topics:[{handle:'new_leaf',title:'Leaf',purpose:'Read supplied finding',initialParent:'new_path_19',sections:[{id:null,title:'Finding',markdown:'Original finding [e1]',originalHandles:['e1']}],links:[]}],indexes:[],entities:[],moves:[],ancestors:Array.from({length:20},(_,i)=>({handle:'new_path_'+i,title:'Category '+i,purpose:'Required reading classification '+i,role:{kind:'topic',role:'topic'},initialParent:i?'new_path_'+(i-1):null}))};
 const proposal=expandCuratorDraft(draft,snapshot);validateCuratorProposal(snapshot,proposal);
 const run=CuratorRunSchema.parse({id:randomUUID(),jobId:randomUUID(),status:'failed',snapshot,checkpoint:{...curatorSampleCheckpoint(),calls:1,proposal,error:'organization.errors.scopeLimit'},proposal,receiptRevisionId:null,createdAt:snapshot.admittedAt,updatedAt:snapshot.admittedAt});
 const route=planHierarchyRoute(run,curatorSupportView(snapshot,proposal).associations);
 expect(route.remainingPath.every(p=>p.chunkIds.length===1&&p.chunkIds[0]===snapshot.evidence[0]!.chunkId)).toBe(true);
 const next={...snapshot,groupId:randomUUID(),continuationRoute:route,resources:{...snapshot.resources,maxProposalBytes:1600}};
 const prefix=hierarchyRouteProposal(next,run,p=>hierarchyResourceDecision(p,1600).decision==='fits');
 expect(prefix.targets).toEqual([]);expect(prefix.ancestors.length).toBeGreaterThan(0);expect(prefix.ancestors.length).toBeLessThan(20);validateCuratorProposal(next,prefix);
 const support=curatorSupportView(next,prefix);expect(support.associations.every(a=>a.originalHandles.join()===snapshot.evidence[0]!.handle)).toBe(true);expect(support.originals).toHaveLength(snapshot.evidence.length);
 const fitting=hierarchyRouteProposal({...next,resources:snapshot.resources},run,()=>true);expect(fitting.targets).toHaveLength(1);expect(fitting.ancestors).toHaveLength(20);expect(fitting.continuation).toBeUndefined();
});
