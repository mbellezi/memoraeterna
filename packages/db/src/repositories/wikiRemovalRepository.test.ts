import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { WikiPageContentSchema } from '@app/domain';
import { recomposeRemovedInputs } from './wikiRemovalRepository.js';

function fixture() {
  const pageId=randomUUID(),groupId=randomUUID(),deleted=randomUUID(),kept=randomUUID(),sectionId=randomUUID();
  const members=[deleted,kept].map((id,order)=>({version:'automatic-wiki-v1',id:randomUUID(),pageId,groupId,target:{kind:'atomic_note',id},purpose:'reading',order,origin:'generated',placementProtected:false,expectedPageRevisionId:randomUUID(),targetFingerprint:id}));
  const content=WikiPageContentSchema.parse({title:'Topic',kind:'collection',sections:[{id:sectionId,title:'Unsupported',markdown:'A removed finding.',protected:false,provenance:'generated',evidenceReview:'needs_review'}],automatic:{version:'automatic-wiki-v1',management:'ai_managed',role:{kind:'collection',role:'map',owner:null},purpose:'Read findings',placementProtected:false,links:[{kind:'atomic_note',id:deleted}],memberships:members,groups:[{version:'automatic-wiki-v1',id:groupId,collectionId:pageId,title:'A specific mechanism',explanation:'A claim from deleted material.',explanationEvidenceIds:[randomUUID()],membershipIds:members.map(m=>m.id),orderProtected:false,origin:'generated'}]}});
  return {content,groupId,sectionId,deleted,kept};
}
describe('wiki recomposition after removal',()=>{
  it('subtracts unsupported generated prose and dead references without mutating the historical revision',()=>{
    const f=fixture(),original=structuredClone(f.content),result=recomposeRemovedInputs(f.content,new Set([f.groupId,f.sectionId]),new Set(['atomic_note:'+f.deleted]),'Referências');
    expect(result.content.sections).toEqual([]);expect(result.content.automatic!.links).toEqual([]);
    expect(result.content.automatic!.memberships.map(m=>m.target.id)).toEqual([f.kept]);
    expect(result.content.automatic!.groups[0]).toMatchObject({id:f.groupId,title:'Referências',explanation:null,explanationEvidenceIds:[]});
    expect(f.content).toEqual(original);
  });
  it('preserves human prose and protected group wording while removing unavailable navigation targets',()=>{
    const f=fixture();f.content.sections[0]!.protected=true;f.content.automatic!.groups[0]!.orderProtected=true;
    const result=recomposeRemovedInputs(f.content,new Set([f.groupId,f.sectionId]),new Set(['atomic_note:'+f.deleted]),'References');
    expect(result.content.sections).toEqual(f.content.sections);expect(result.content.automatic!.groups[0]!.title).toBe('A specific mechanism');
    expect(result.content.automatic!.groups[0]!.membershipIds).toEqual([f.content.automatic!.memberships[1]!.id]);
  });
  it('removes empty generated groups and is idempotent',()=>{
    const f=fixture(),missing=new Set(['atomic_note:'+f.deleted,'atomic_note:'+f.kept]),consumers=new Set([f.groupId,f.sectionId]);
    const first=recomposeRemovedInputs(f.content,consumers,missing,'References');
    expect(first.content.automatic!.groups).toEqual([]);expect(first.content.automatic!.memberships).toEqual([]);
    expect(recomposeRemovedInputs(first.content,consumers,missing,'References').content).toEqual(first.content);
  });
});
