import {addWikiDependency,noteFingerprint} from "./wikiContextRepository.js";
import { randomUUID } from 'node:crypto';
import { noteEvolutionReplacementIds,InterpretationRecordSchema, WikiPageContentSchema, type CuratorSnapshot,type CuratorChangeSet,type InterpretationRecord } from '@app/domain';
import type {PgPool,PgClient} from '../client.js';
import {createWikiRepository} from './wikiRepository.js';

export function appendInterpretation(snapshot:CuratorSnapshot,patch:CuratorChangeSet['targets'][number]['sections'][number],previous:InterpretationRecord[]=[]):InterpretationRecord[]|undefined{
 if(!patch.interpretation)return previous.length?previous:undefined;
 if(previous.length>=100)throw new Error('organization.errors.scopeLimit');
 const {originalHandles,...draft}=patch.interpretation;
 const evidence=originalHandles.map(h=>{const {handle:_handle,...e}=snapshot.evidence.find(e=>e.handle===h)!;return e;});
 const superseded=draft.relationships.find(r=>r.kind==='supersedes');
 const prior=superseded?previous.find(r=>r.revisionId===superseded.revisionId):undefined;
 const record=InterpretationRecordSchema.parse({...draft,sourceDates:snapshot.sourceDates?.filter(s=>evidence.some(e=>e.sourceItemId===s.sourceItemId)),version:'knowledge-interpretation-v1',assertionId:prior?.assertionId??randomUUID(),revisionId:randomUUID(),recordedAt:evidence.map(e=>({documentId:e.documentId,at:e.documentCreatedAt})),revisedAt:new Date().toISOString(),evidence});
 return [...previous,record];
}

/** Caller holds placement, policy, run, page and original locks. No inference here. */
export async function applyNoteEvolution(db:PgClient,pool:PgPool,runId:string,snapshot:CuratorSnapshot,proposal:CuratorChangeSet,appliedPageIds:string[]=[]){
 const change=proposal.noteEvolution;if(!change)return {notes:[],repairs:[]};
 const rows=(await db.query('select * from atomic_notes where id=any($1::uuid[]) order by id for update',[change.noteIds])).rows;
 if(rows.length!==change.noteIds.length||rows.some(n=>n.supersession_status!=='current'||['rejected','archived'].includes(n.status)))throw new Error('organization.errors.conflict');
 // Lock the complete backlink inventory, not only the pages the model happened to change.
 const affected=(await db.query("select distinct page_id from wiki_memberships where target_kind='atomic_note' and target_id=any($1::uuid[]) union select p.id from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where exists(select 1 from jsonb_array_elements(coalesce(r.content->'automatic'->'links','[]')) l where l->>'kind'='atomic_note' and l->>'id'=any($2::text[]))",[change.noteIds,change.noteIds])).rows.map(r=>r.page_id as string);
 if(affected.length>snapshot.limits.targets||affected.some(id=>!snapshot.pages.some(p=>p.id===id)&&!appliedPageIds.includes(id)))throw new Error('organization.errors.conflict');
 for(const note of rows){
  const before=structuredClone(note);
  const chunkIds=[...new Set([note.evidence_chunk_id,...(await db.query('select chunk_id from atomic_note_source_links where atomic_note_id=$1',[note.id])).rows.map(r=>r.chunk_id)])];
  for(const chunkId of chunkIds){const evidence=snapshot.evidence.find(e=>e.chunkId===chunkId);if(!evidence)throw new Error('organization.errors.evidence');const {handle:_h,...original}=evidence;await db.query('insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) values($1,$2,$3,$4) on conflict do nothing',[note.id,chunkId,evidence.sourceItemId,original]);}
  await db.query("update atomic_notes set ownership='knowledge',supersession_status=$2,updated_at=greatest(clock_timestamp(),updated_at+interval '1 millisecond') where id=$1",[note.id,change.kind==='cross_source'?'current':'superseded']);
  await db.query('update obsidian_sync_files set source_item_id=null,document_id=null where memora_id=$1',[note.id]);
  const after=(await db.query('select * from atomic_notes where id=$1',[note.id])).rows[0];
  await db.query("insert into atomic_note_revisions(note_id,previous,current,origin) values($1,$2,$3,'reviewed_evolution')",[note.id,before,after]);
 }
 const notes:Array<{id:string;title:string}>=[];
 for(const draft of change.notes){const id=randomUUID(),evidence=snapshot.evidence.filter(e=>draft.originalHandles.includes(e.handle)),first=evidence[0]!;
  await db.query(`insert into atomic_notes(id,title,body_markdown,idea_statement,language,created_from_source_item_id,evidence_chunk_id,ownership,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key,generation_profile_id,metadata)
   values($1::uuid,$2,$3,$4,$5,$6,$7,'knowledge',$8,$9,$10,'note-evolution-v1',$1::text,(select id from ai_profile_sets where id=$11),$12)`,[id,draft.title,draft.bodyMarkdown.replace(/\[(e[1-9][0-9]{0,3})\]/g,(_m,h:string)=>'['+(evidence.findIndex(e=>e.handle===h)+1)+']'),draft.ideaStatement,snapshot.contentLanguage,first.sourceItemId,first.chunkId,snapshot.profile.provider,snapshot.profile.modelId,snapshot.profile.runtime,snapshot.profile.profileId,{humanProtected:true,evidenceReview:'needs_review',evolutionRunId:runId}]);
  for(const original of evidence){const {handle:_h,...e}=original;await db.query('insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) values($1,$2,$3,$4)',[id,e.chunkId,e.sourceItemId,e]);await db.query('insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id,source_span_id) values($1,$2,$3,$4)',[id,e.sourceItemId,e.chunkId,e.sourceSpanId]);}
  for(const previousId of change.noteIds)await db.query('insert into atomic_note_evolution(previous_id,next_id,run_id,kind,reason) values($1,$2,$3,$4,$5)',[previousId,id,runId,change.kind,change.reason]);
  const after=(await db.query('select * from atomic_notes where id=$1',[id])).rows[0];await db.query("insert into atomic_note_revisions(note_id,previous,current,origin) values($1,'{}',$2,'reviewed_evolution')",[id,after]);notes.push({id,title:draft.title});
 }
 const repairs=[];
 for(const pageId of affected){const page=(await db.query('select p.id,p.current_revision_id as "revisionId",r.content from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1',[pageId])).rows[0];if(!page)throw new Error('organization.errors.conflict');const content=WikiPageContentSchema.parse(page.content),a=content.automatic;if(!a)continue;
  const replacements=(id:string)=>noteEvolutionReplacementIds(id,change,notes.map(n=>n.id));
  a.links=a.links.flatMap(l=>l.kind==='atomic_note'?replacements(l.id).map(id=>({...l,id})): [l]).filter((l,i,all)=>all.findIndex(x=>x.kind===l.kind&&x.id===l.id)===i);
  a.memberships=a.memberships.flatMap(m=>m.target.kind==='atomic_note'?replacements(m.target.id).map((id,i)=>({...m,id:i?randomUUID():m.id,target:{kind:'atomic_note' as const,id}})):[m]).filter((m,i,all)=>all.findIndex(x=>x.groupId===m.groupId&&x.target.kind===m.target.kind&&x.target.id===m.target.id)===i);
  for(const group of a.groups){const members=a.memberships.filter(m=>m.groupId===group.id);members.forEach((m,i)=>m.order=i);group.membershipIds=members.map(m=>m.id);}
  await createWikiRepository(pool).save({id:page.id,expectedRevisionId:page.revisionId,content,evidenceChunkIds:[]},{transaction:db,origin:'organization',allocatedTarget:false,humanApproved:true});
  const revisionId=(await db.query('select current_revision_id from wiki_pages where id=$1',[pageId])).rows[0].current_revision_id;
  for(const group of a.groups){await db.query("delete from wiki_dependencies where revision_id=$1 and section_id=$2 and kind='atomic_note' and input_id=any($3::uuid[])",[revisionId,group.id,change.kind==='cross_source'?[]:change.noteIds]);for(const member of a.memberships.filter(m=>m.groupId===group.id&&m.target.kind==='atomic_note'&&notes.some(n=>n.id===m.target.id))){const noteId=member.target.id,current=(await db.query(`select n.*,${noteFingerprint('n')} fingerprint from atomic_notes n where id=$1`,[noteId])).rows[0];await addWikiDependency(db,revisionId,group.id,{kind:'atomic_note',id:noteId,fingerprint:current.fingerprint},{noteId,evolutionRunId:runId});for(const original of (await db.query('select snapshot from atomic_note_evidence where note_id=$1',[noteId])).rows.map(r=>r.snapshot))for(const [kind,id]of [['source',original.sourceItemId],['document',original.documentId],['chunk',original.chunkId]])await addWikiDependency(db,revisionId,group.id,{kind,id,fingerprint:original.contentHash},original);}}
  repairs.push({pageId,revisionId});
 }
 return {notes,repairs};
}
