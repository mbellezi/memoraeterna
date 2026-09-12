import {readFile}from'node:fs/promises';
import {randomUUID}from'node:crypto';
import {createSourceItemRepository,createDocumentRepository,createChunkRepository,createWikiRepository,type PgPool}from'../../packages/db/src/index.js';
import {WikiPageContentSchema,CuratorChangeSetSchema,type CuratorSnapshot}from'@app/domain';
/** Versioned synthetic inputs only. Expected outcomes never enter inference context. */
export async function seedAutomaticWikiFixture(pool:PgPool,withNotes:boolean){
 const fixture=JSON.parse(await readFile(new URL('./automatic-wiki/mixed-library.json',import.meta.url),'utf8'));
 const sources=new Map<string,string>(),chunks=new Map<string,string>(),documents=new Map<string,string>();
 for(const source of fixture.sources){const item=await createSourceItemRepository(pool).create({type:source.type,title:source.title,parentSourceItemId:source.parent?sources.get(source.parent)!:null});sources.set(source.key,item.id);if(source.text){const document=await createDocumentRepository(pool).create({sourceItemId:item.id,title:source.title,canonicalMarkdown:source.text,contentHash:source.text});const id=randomUUID(),span=randomUUID();await createChunkRepository(pool).replaceDocumentChunks(document.id,item.id,[{id,sourceSpanId:span,chunkIndex:0,content:source.text,contentHash:source.text,span:{id:span,startOffset:0,endOffset:source.text.length}}]);chunks.set(source.key,id);documents.set(source.key,document.id);}}
 const noteIds:string[]=[];if(withNotes)for(const note of fixture.notes){const id=randomUUID();await pool.query("insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,$2,$3,$3,$4,$5,'synthetic','fixture','test','fixture-v1',$1::text)",[id,note.title,note.text,sources.get(note.source),chunks.get(note.source)]);noteIds.push(id);}
 const humanId=await createWikiRepository(pool).save({expectedRevisionId:null,content:WikiPageContentSchema.parse({title:fixture.existingPages[0].title,kind:'topic',sections:[{id:randomUUID(),title:'Personal interpretation',markdown:fixture.existingPages[0].text}]}),evidenceChunkIds:[]});
 return {sourceIds:fixture.expected.initialSources.map((key:string)=>sources.get(key)!)as string[],noteIds,humanId,sources,chunks,documents,noPrerequisiteStages:fixture.expected.noPrerequisiteStages.map((s:string)=>s==='atomicNoteGeneration'?'atomicNotes':s)as string[]};
}
export async function fixtureCuratorProposal(snapshot:CuratorSnapshot){
 const raw=JSON.parse(await readFile(new URL('./automatic-wiki/first-change-set.json',import.meta.url),'utf8'));raw.groupId=snapshot.groupId;raw.policyRevisionId=snapshot.policy.revisionId;
 const source=snapshot.references.find(r=>r.kind==='source')!,note=snapshot.references.find(r=>r.kind==='atomic_note');
 const replace=(value:any):any=>{if(value&&typeof value==='object'&&value.reference==='existing'){const target=value.target.kind==='atomic_note'?(note??source):source;return{reference:'existing',target:{kind:target.kind,id:target.id},fingerprint:target.fingerprint};}if(Array.isArray(value))return value.map(replace);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,replace(v)]));return value;};
 const result=replace(raw);for(const target of result.targets)for(const group of target.tocGroups){const seen=new Set();group.memberships=group.memberships.filter((m:any)=>{const key=m.target.target.kind+m.target.target.id;if(seen.has(key))return false;seen.add(key);return true;});}
 return CuratorChangeSetSchema.parse(result);
}
