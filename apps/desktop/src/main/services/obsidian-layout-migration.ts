import { assetHash, readMirrorAsset, writeMirrorAsset } from './obsidian-asset-projection.js';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, mkdir, link, rename, writeFile } from 'node:fs/promises';
import { posix } from 'node:path';
import { createObsidianLayoutRepository, createObsidianSyncRepository, createObsidianWikiRepository, createSettingsRepository, type PgPool, type LayoutJournal } from '@app/db';
import { atomicEditorial, outsideCodeFences, obsidianLayoutApplyInputSchema, obsidianLayoutConfigSchema, obsidianLayoutStatusSchema, parseObsidianMarkdown, parseWikiRegions, serializeManagedFrontmatter, wikiGeneratedStart, wikiGeneratedEnd, type ObsidianLayoutConfig } from '@app/integration-contracts';
import type { StorageSettings } from '../../shared/ipc.js';
import { safeVaultPath } from '../workers/obsidian-sync.worker.js';
import { projectionHash, type ObsidianWikiProjection } from './obsidian-wiki-projection.js';
import type { MirrorTarget } from './obsidian-mirror.js';

export function renderMirrorTarget(target:MirrorTarget,version:number,user='') {
  if(!target.layout)throw new Error('obsidianWiki.errors.format');
  const content=serializeManagedFrontmatter({...(target.linkMap?.length?{memoraLinkMap:target.linkMap}:{}),memoraId:target.id,memoraType:target.type,memoraManaged:true,memoraSyncVersion:version,memoraContentHash:projectionHash(target.editorial),memoraWikiSchema:2,memoraLayout:2,memoraLayoutLanguage:target.layout.language,memoraRevisionId:target.revision,...(target.rootSourceId?{memoraRootSourceId:target.rootSourceId}:{}),...(target.divisionId?{memoraDivisionId:target.divisionId}:{}),...(target.documentRevisionId?{memoraDocumentRevisionId:target.documentRevisionId}:{}),...(target.sourceId?{memoraSourceId:target.sourceId}:{}),...(target.documentId?{memoraDocumentId:target.documentId}:{})},user)+'\n'+target.editorial+wikiGeneratedStart+'\n\n'+target.generated+'\n\n'+wikiGeneratedEnd+'\n';
  if(!parseObsidianMarkdown(content))throw new Error('obsidianWiki.errors.format');return content;
}
export class ObsidianLayoutMigration {
  constructor(private readonly options:{legacyClientConnected?:()=>boolean;assetRoots?:()=>Promise<Record<string,string>>;getPool:()=>PgPool|null;getStorageSettings:()=>Promise<StorageSettings>;wiki:ObsidianWikiProjection;write:(input:{vaultPath:string;relativePath:string;content:string;expectedHash:string|null;recoveryId:string;managedRoot:string})=>Promise<unknown>}){}
  private pool(){const pool=this.options.getPool();if(!pool)throw new Error('errors.database.notReady');return pool;}
  private async settings(){const s=await this.options.getStorageSettings();if(!s.obsidianVaultPath)throw new Error('obsidianWiki.errors.binding');return s;}
  private binding(s:StorageSettings){return projectionHash(JSON.stringify([s.obsidianVaultPath,s.managedRoot]));}
  private async active(s:StorageSettings){if(this.options.legacyClientConnected?.())throw new Error('obsidianLayout.legacyConnected');const current=await this.settings();if(!current.obsidianSyncEnabled||current.obsidianSyncPaused)throw new Error('obsidianWiki.errors.paused');if(this.binding(current)!==this.binding(s))throw new Error('obsidianWiki.errors.binding');}
  async status(){const s=await this.options.getStorageSettings();if(!s.obsidianVaultPath)return obsidianLayoutStatusSchema.parse({config:await this.options.wiki.layout(),migrations:[]});return obsidianLayoutStatusSchema.parse({config:await this.options.wiki.layout(),migrations:(await createObsidianLayoutRepository(this.pool()).list(this.binding(s))).map(j=>({id:j.id,status:j.status,createdAt:j.created_at.toISOString(),config:j.config,targets:j.targets.map(t=>({id:t.id,oldPath:t.oldPath,newPath:t.newPath,status:t.status,reason:t.reason,bytes:t.bytes,links:t.links,base:t.binary?null:t.base,local:t.binary?null:t.local,proposed:t.binary?null:t.proposed}))}))});}
  private async observed(s:StorageSettings,path:string,binary=false){try{const full=await safeVaultPath(s.obsidianVaultPath!,path);if((await stat(full)).size>(binary?16_000_000:2_000_000))throw new Error('obsidianWiki.errors.limit');return binary?(await readFile(full)).toString('base64'):await readFile(full,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}}
  private async editorReason(binding:string,id:string,path:string){for(const presence of await createObsidianLayoutRepository(this.pool()).presences(binding)){
    if(presence.report.pendingTargetIds.includes(id))return 'pending';
    if(presence.report.openPaths.includes(path))return 'open';
    if(Date.now()-presence.at>15000)return 'presence';
  }return null;}
  private async unmanagedReferences(s:StorageSettings,targets:Record<string,any>[]){
    let files=0,bytes=0;
    const walk=async(directory:string):Promise<void>=>{
      let entries;try{entries=await readdir(await safeVaultPath(s.obsidianVaultPath!,directory),{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
      for(const entry of entries){if(entry.name.startsWith('.')||entry.isSymbolicLink())continue;const path=posix.join(directory,entry.name);if(entry.isDirectory()){await walk(path);continue;}if(!entry.isFile()||!entry.name.endsWith('.md'))continue;
        if(++files>5000)throw new Error('obsidianWiki.errors.limit');const raw=await this.observed(s,path);if(raw===null)continue;bytes+=Buffer.byteLength(raw);if(bytes>20_000_000)throw new Error('obsidianWiki.errors.limit');
        const frame=parseObsidianMarkdown(raw);let prose=frame?(parseWikiRegions(frame.bodyMarkdown)?.editorial??(frame.frontmatter.memoraType==='atomic_note'?atomicEditorial(frame.bodyMarkdown)?.editorial:frame.bodyMarkdown)??''):raw;
        for(const map of frame?.frontmatter.memoraLinkMap??[])prose=prose.replaceAll(map.rendered,map.canonical);
        for(const match of outsideCodeFences(prose).matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)){
          const reference=match[1]!,qualified=posix.normalize(posix.join(posix.dirname(path),reference)).replace(/\.md$/i,'');
          for(const target of targets){if(!target.oldPath||target.oldPath===target.newPath)continue;const old=target.oldPath.replace(/\.md$/i,'');if(reference.replace(/\.md$/i,'')===old||qualified===old||!reference.includes('/')&&posix.basename(old)===reference)target.links.push(path+' → '+reference);}
        }
      }
    };await walk(s.managedRoot);
    for(const target of targets){target.links=[...new Set(target.links)];if(target.links.length>5000)throw new Error('obsidianWiki.errors.limit');}
  }
  async preview(value:unknown){
    const config=obsidianLayoutConfigSchema.parse(value),s=await this.settings(),binding=this.binding(s),repo=createObsidianLayoutRepository(this.pool());
    if(await repo.active(binding))throw new Error('obsidianWiki.errors.conflict');
    const registry=await createObsidianSyncRepository(this.pool()).list(),plan=await this.options.wiki.mirror(config,true),targets:Record<string,any>[]=[];
    for(const target of plan){
      const old=registry.find(f=>f.memoraId===target.id),local=old?await this.observed(s,old.relativePath):null,delivery=await createObsidianWikiRepository(this.pool()).base(target.id,binding);
      const acknowledged=old?.metadata.editorialBase as {content?:string}|undefined;
      const frame=local===null?null:parseObsidianMarkdown(local);
      const base=acknowledged?.content??delivery?.content??(frame?.frontmatter.memoraId===target.id&&projectionHash(frame.bodyMarkdown)===old?.contentHash?local:null);
      let reason=old?.metadata.editorialTombstone||old?.status==='deleted'?'tombstone':old?.metadata.editorialPending||old?.metadata.projectionWrite?'pending':old&&!local?'missing':local!==base?'dirty':frame&&frame.frontmatter.memoraId!==target.id?'identity':await this.editorReason(binding,target.id,old?.relativePath??target.path);
      if(target.path!==old?.relativePath&&await this.observed(s,target.path)!==null)reason='collision';
      const proposed=renderMirrorTarget(target,(old?.syncVersion??0)+1,frame?.userFrontmatter??'');
      targets.push({id:target.id,oldPath:old?.relativePath??null,newPath:target.path,status:'planned',reason,bytes:Buffer.byteLength(proposed),links:[...target.generated.matchAll(/\[\[([^|\]#]+)/g)].map(m=>m[1]),base,local,proposed,oldRegistry:old??null,target,admittedTarget:target,deliveryId:randomUUID(),backupPath:posix.join(s.managedRoot,'.memora-recovery','layout-'+randomUUID()+'.md')});
    }
    for(const asset of await this.options.wiki.assets(config,true)) {
      if(!asset.available)continue;
      const old=registry.find(f=>f.memoraId===asset.id),local=old?await this.observed(s,old.relativePath,true):null,data=await readMirrorAsset(asset,await this.options.assetRoots?.()??{}),proposed=data.toString('base64');
      let reason=old&&local===null?'missing':local!==null&&assetHash(Buffer.from(local,'base64'))!==old?.contentHash?'dirty':null;
      if(asset.path!==old?.relativePath&&await this.observed(s,asset.path,true)!==null)reason='collision';
      targets.push({id:asset.id,oldPath:old?.relativePath??null,newPath:asset.path,status:'planned',reason,bytes:data.length,links:[],base:local,local,proposed,binary:true,asset,oldRegistry:old??null,backupPath:posix.join(s.managedRoot,'.memora-recovery','layout-'+randomUUID()+'.bin')});
    }
    // Retained out-of-scope identities are visible exclusions, never inferred deletions.
    for(const old of registry.filter(f=>!targets.some(t=>t.id===f.memoraId)))targets.push({id:old.memoraId,oldPath:old.relativePath,newPath:old.relativePath,status:'excluded',reason:'scope',bytes:0,links:[],base:null,local:null,proposed:null,oldRegistry:old});
    if(targets.length>5000||targets.reduce((sum,t)=>sum+t.bytes+Buffer.byteLength(t.local??'')+Buffer.byteLength(t.base??''),0)>60_000_000)throw new Error('obsidianWiki.errors.limit');
    await this.unmanagedReferences(s,targets);
    await repo.create(binding,config,await this.options.wiki.layout(),targets);return this.status();
  }
  async apply(value:unknown){const input=obsidianLayoutApplyInputSchema.parse(value),s=await this.settings();await this.active(s);const repo=createObsidianLayoutRepository(this.pool());
    return createObsidianWikiRepository(this.pool()).withTargetLock('layout:'+this.binding(s),async()=>{
      const journal=await repo.get(input.id);if(!journal||journal.binding!==this.binding(s)||!['preview','quiescing','partial','applying'].includes(journal.status))throw new Error('obsidianWiki.errors.binding');
      const other=await repo.active(journal.binding);if(other&&other!==journal.id)throw new Error('obsidianWiki.errors.conflict');
      for(const target of journal.targets)if(input.excludeIds.includes(target.id)&&target.status==='planned')target.status='excluded';
      if(journal.status==='preview'&&journal.targets.some(t=>t.status==='planned'&&t.reason&&!input.excludeIds.includes(t.id)))throw new Error('obsidianWiki.errors.conflict');
      const excluded=new Set(journal.targets.filter(t=>t.status==='excluded').map(t=>String(t.id)));
      const canonical=await this.options.wiki.mirror(obsidianLayoutConfigSchema.parse(journal.config),true);
      for(const target of journal.targets.filter(t=>!t.binary&&!['done','excluded'].includes(t.status))){const fresh=canonical.find(t=>t.id===target.id),admitted=target.admittedTarget??target.target;if(!fresh||['revision','editorial','generated','path'].some(key=>(fresh as unknown as Record<string,unknown>)[key]!==admitted[key]))throw new Error('obsidianWiki.errors.conflict');}
      const current=await this.options.wiki.mirror(obsidianLayoutConfigSchema.parse(journal.config),true,excluded);
      for(const target of journal.targets.filter(t=>!t.binary&&t.status==='planned')){
        const fresh=current.find(t=>t.id===target.id);if(!fresh||fresh.revision!==target.target.revision)throw new Error('obsidianWiki.errors.conflict');
        // Final rendered link map respects explicitly excluded physical identities.
        target.proposed=renderMirrorTarget(fresh,(target.oldRegistry?.syncVersion??0)+1,parseObsidianMarkdown(target.local??'')?.userFrontmatter??'');target.target=fresh;
      }
      await repo.update(journal.id,'quiescing',journal.targets);
      for(let attempt=0;attempt<24;attempt++){const presences=await repo.presences(journal.binding);if(presences.every(p=>p.report.quiescedMigrationIds?.includes(journal.id)))break;if(attempt===23)throw new Error('obsidianLayout.presence');await new Promise(resolve=>setTimeout(resolve,250));}
      await repo.update(journal.id,'applying',journal.targets);
      for(const target of journal.targets.filter(t=>!['done','excluded'].includes(t.status)).slice(0,100)){
        try{await createObsidianWikiRepository(this.pool()).withTargetLock(target.id,async()=>{
          await this.active(s);const reason=await this.editorReason(journal.binding,target.id,target.oldPath??target.newPath);if(reason)throw new Error(reason);
          const sync=createObsidianSyncRepository(this.pool()),registered=await sync.findByMemoraId(target.id);
          if(registered?.metadata.editorialPending)throw new Error('pending');
          if(target.status==='planned'){
            if((registered?.relativePath??null)!==target.oldPath||(registered?.syncVersion??0)!==(target.oldRegistry?.syncVersion??0))throw new Error('conflict');
            if(target.oldPath&&await this.observed(s,target.oldPath,target.binary)!==target.local)throw new Error('dirty');
            // Durable SQL snapshots precede independent filesystem backup and promotion.
            if(target.local!==null){const backup=await safeVaultPath(s.obsidianVaultPath!,target.backupPath);await mkdir(posix.dirname(backup),{recursive:true});try{await writeFile(backup,target.binary?Buffer.from(target.local,'base64'):target.local,{flag:'wx',mode:0o600});}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST'||(target.binary?(await readFile(backup)).toString('base64'):await readFile(backup,'utf8'))!==target.local)throw e;}}
            if(registered)await sync.update(registered.id,{metadata:{...registered.metadata,layoutMigration:journal.id}});
            target.status='backed_up';await repo.update(journal.id,'applying',journal.targets);
          }
          const observed=await this.observed(s,target.newPath,target.binary);
          if(target.binary){if(observed!==target.proposed)await writeMirrorAsset(s.obsidianVaultPath!,target.newPath,Buffer.from(target.proposed,'base64'));}
          else if(observed!==target.proposed)await this.options.write({vaultPath:s.obsidianVaultPath!,relativePath:target.newPath,content:target.proposed,expectedHash:target.newPath===target.oldPath&&target.local!==null?projectionHash(target.local):null,recoveryId:target.deliveryId,managedRoot:s.managedRoot});
          target.status='written';await repo.update(journal.id,'applying',journal.targets);
          if(await this.observed(s,target.newPath,target.binary)!==target.proposed)throw new Error('dirty');
          if(target.oldPath&&target.oldPath!==target.newPath)await this.retire(s,target.oldPath,target.local,target.backupPath+'.captured',target.binary);
          await this.receipt(s,journal,target,false);target.status='done';target.reason=null;await repo.update(journal.id,'applying',journal.targets);
        });}catch(error){target.reason=/open|pending|presence|dirty|missing/.exec(String(error))?.[0]??((error as NodeJS.ErrnoException).code==='ENOSPC'?'disk':'conflict');await repo.update(journal.id,'partial',journal.targets);}
      }
      if(journal.targets.every(t=>['done','excluded'].includes(t.status)))for(const target of journal.targets.filter(t=>t.status==='done'&&!t.binary)){for(const match of String(target.target.generated).matchAll(/\[\[([^|\]#]+)/g)){const path=match[1]!;if(path.startsWith(s.managedRoot+'/')&&await this.observed(s,path.endsWith('.md')?path:path+'.md')===null){target.status='written';target.reason='missing';break;}}}
      const complete=journal.targets.every(t=>['done','excluded'].includes(t.status));
      if(complete){for(const target of journal.targets.filter(t=>t.status==='excluded')){const sync=createObsidianSyncRepository(this.pool()),old=await sync.findByMemoraId(target.id);if(old)await sync.update(old.id,{metadata:{...old.metadata,layoutExcluded:journal.id}});}await createSettingsRepository(this.pool()).set('obsidian.layout',journal.config);}
      await repo.update(journal.id,complete?'completed':'partial',journal.targets);return this.status();
    });
  }
  /** Capture an inode before removing the old name; a racing edit survives in recovery. */
  private async retire(s:StorageSettings,path:string,expected:string,recovery:string,binary=false){const actual=await this.observed(s,path,binary);if(actual===null)return;if(actual!==expected)throw new Error('dirty');const full=await safeVaultPath(s.obsidianVaultPath!,path),backup=await safeVaultPath(s.obsidianVaultPath!,recovery);await mkdir(posix.dirname(backup),{recursive:true});await mkdir(backup+'.lock',{mode:0o700});try{await stat(backup);throw new Error('obsidianWiki.errors.conflict');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}await rename(full,backup);if((binary?(await readFile(backup)).toString('base64'):await readFile(backup,'utf8'))!==expected){await link(backup,full).catch(()=>undefined);throw new Error('dirty');}}
  private async receipt(s:StorageSettings,journal:LayoutJournal,target:Record<string,any>,rollback:boolean){
    if(target.binary){const sync=createObsidianSyncRepository(this.pool()),old=await sync.findByMemoraId(target.id),path=rollback?target.oldPath:target.newPath;const update={relativePath:path,contentHash:target.asset.sha256,frontmatterHash:target.asset.sha256,mtimeMs:Math.trunc((await stat(await safeVaultPath(s.obsidianVaultPath!,path))).mtimeMs),status:'synced' as const,metadata:rollback?target.oldRegistry.metadata:{projectionFormat:2,asset:true}};if(old)await sync.update(old.id,update);else await sync.create({...update,memoraId:target.id,entityId:target.id,entityType:'document_asset',memoraType:'attachment',sourceItemId:target.asset.sourceId,documentId:target.asset.documentId});return;}
    const content=rollback?target.local:target.proposed,frame=parseObsidianMarkdown(content);if(!frame)throw new Error('obsidianWiki.errors.format');
    const sync=createObsidianSyncRepository(this.pool()),old=await sync.findByMemoraId(target.id),path=rollback?target.oldPath:target.newPath;
    const metadata=rollback?{...target.oldRegistry.metadata}:{...old?.metadata,projectionFormat:2,bindingHash:journal.binding,editorialBinding:journal.binding,editorialBase:{content,revision:target.target.revision,version:frame.frontmatter.memoraSyncVersion,hash:projectionHash(content)}};delete metadata.layoutMigration;if(!rollback)delete metadata.layoutExcluded;
    const update={relativePath:path,memoraType:frame.frontmatter.memoraType,documentId:frame.frontmatter.memoraDocumentId??null,contentHash:frame.frontmatter.memoraContentHash,frontmatterHash:projectionHash(serializeManagedFrontmatter(frame.frontmatter)),syncVersion:frame.frontmatter.memoraSyncVersion,mtimeMs:Math.trunc((await stat(await safeVaultPath(s.obsidianVaultPath!,path))).mtimeMs),status:'synced' as const,metadata};
    if(old)await sync.update(old.id,update);else await sync.create({...update,memoraId:target.id,entityId:target.id,entityType:frame.frontmatter.memoraType,...(frame.frontmatter.memoraSourceId?{sourceItemId:frame.frontmatter.memoraSourceId}:{})});
    const regions=parseWikiRegions(frame.bodyMarkdown),repo=createObsidianWikiRepository(this.pool()),delivery=await repo.prepare({memora_id:target.id,revision_id:frame.frontmatter.memoraRevisionId??target.target.revision,binding_hash:journal.binding,relative_path:path,content,editable_hash:frame.frontmatter.memoraContentHash,generated_hash:projectionHash(rollback?(regions?.generated.slice(wikiGeneratedStart.length+2,-wikiGeneratedEnd.length-3)??''):target.target.generated),rendered_hash:projectionHash(content),base_hash:projectionHash(rollback?target.proposed:target.local??''),before_content:rollback?target.proposed:target.local});await repo.finish(delivery.id,'written');
  }
  async rollback(value:unknown){const input=obsidianLayoutApplyInputSchema.parse(value),s=await this.settings();await this.active(s);const repo=createObsidianLayoutRepository(this.pool());return createObsidianWikiRepository(this.pool()).withTargetLock('layout:'+this.binding(s),async()=>{
    const journal=await repo.get(input.id);if(!journal||journal.binding!==this.binding(s)||!['completed','partial','rolling_back'].includes(journal.status))throw new Error('obsidianWiki.errors.binding');
    await repo.update(journal.id,'rolling_back',journal.targets);
    for(let attempt=0;attempt<24;attempt++){const presences=await repo.presences(journal.binding);if(presences.every(p=>p.report.quiescedMigrationIds?.includes(journal.id)))break;if(attempt===23)throw new Error('obsidianWiki.errors.conflict');await new Promise(resolve=>setTimeout(resolve,250));}
    for(const target of journal.targets.filter(t=>['done','written','backed_up'].includes(t.status)).slice(0,100)){
      if(input.excludeIds.includes(target.id))continue;
      try{await createObsidianWikiRepository(this.pool()).withTargetLock(target.id,async()=>{
        await this.active(s);if(await this.editorReason(journal.binding,target.id,target.newPath))throw new Error('open');
        const actual=await this.observed(s,target.newPath,target.binary);if(actual!==target.proposed)throw new Error('dirty');
        if(target.local!==null){if(target.binary)await writeMirrorAsset(s.obsidianVaultPath!,target.oldPath,Buffer.from(target.local,'base64'));else await this.options.write({vaultPath:s.obsidianVaultPath!,relativePath:target.oldPath,content:target.local,expectedHash:target.oldPath===target.newPath?projectionHash(target.proposed):null,recoveryId:randomUUID(),managedRoot:s.managedRoot});if(target.oldPath!==target.newPath)await this.retire(s,target.newPath,target.proposed,target.backupPath+'.rollback',target.binary);await this.receipt(s,journal,target,true);}
        else {await this.retire(s,target.newPath,target.proposed,target.backupPath+'.rollback',target.binary);const registry=createObsidianSyncRepository(this.pool()),file=await registry.findByMemoraId(target.id);if(file)await registry.update(file.id,{status:'deleted',metadata:{...file.metadata,editorialTombstone:{content:target.proposed,layoutRollback:journal.id}}});}
        target.status='rolled_back';target.reason=null;
      });}catch{target.reason='dirty';}await repo.update(journal.id,'rolling_back',journal.targets);
    }
    const complete=journal.targets.every(t=>['rolled_back','excluded','planned'].includes(t.status));
    if(complete){const settings=createSettingsRepository(this.pool());if(journal.previous_config)await settings.set('obsidian.layout',journal.previous_config);else await settings.delete('obsidian.layout');}
    await repo.update(journal.id,complete?'rolled_back':'rolling_back',journal.targets);return this.status();
  });}
}
