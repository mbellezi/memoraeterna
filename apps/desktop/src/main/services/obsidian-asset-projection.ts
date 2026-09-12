import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile, link, unlink } from 'node:fs/promises';
import { posix } from 'node:path';
import { createObsidianLayoutRepository, createObsidianSyncRepository, createObsidianWikiRepository, type PgPool } from '@app/db';
import type { ObsidianLayoutConfig } from '@app/integration-contracts';
import type { StorageSettings } from '../../shared/ipc.js';
import { safeVaultPath } from '../workers/obsidian-sync.worker.js';
import { layoutLabels } from './obsidian-layout-paths.js';
import type { MirrorAsset } from './obsidian-mirror.js';

export const assetHash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
export async function inspectMirrorAssets(pool:PgPool,s:StorageSettings,sourceIds:string[],config:ObsidianLayoutConfig,roots:Record<string,string>,migrate=false):Promise<MirrorAsset[]> {
  const rows=await createObsidianLayoutRepository(pool).assets(sourceIds),sync=createObsidianSyncRepository(pool),assets:MirrorAsset[]=[];
  if(rows.length>1000||rows.reduce((n,r)=>n+Number(r.sizeBytes),0)>100_000_000)throw new Error('obsidianWiki.errors.limit');
  for(const row of rows){
    const old=await sync.findByMemoraId(row.id),extension=posix.extname(row.originalFileName).replace(/[^.a-z0-9]/gi,'').slice(0,12);
    const path=old&&!migrate?old.relativePath:posix.join(s.managedRoot,layoutLabels(config.language).assets,row.id+extension);
    let available=false;
    if(config.attachments==='copy'&&roots[row.storageBase])try{const full=await safeVaultPath(roots[row.storageBase]!,row.relativePath);if((await stat(full)).size<=16_000_000)available=assetHash(await readFile(full))===row.sha256;}catch{/* Explicit unavailable coverage; no download. */}
    assets.push({...row,sizeBytes:Number(row.sizeBytes),path,available});
  }return assets;
}
export async function readMirrorAsset(asset:MirrorAsset,roots:Record<string,string>){const root=roots[asset.storageBase];if(!root)throw new Error('obsidianWiki.errors.binding');const full=await safeVaultPath(root,asset.relativePath);if((await stat(full)).size>16_000_000)throw new Error('obsidianWiki.errors.limit');const data=await readFile(full);if(assetHash(data)!==asset.sha256)throw new Error('obsidianWiki.errors.conflict');return data;}
/** Immutable binary copies are never overwritten. Existing identical registered assets are reused. */
export async function writeMirrorAsset(vault:string,path:string,data:Uint8Array){
  const full=await safeVaultPath(vault,path);await mkdir(posix.dirname(full),{recursive:true});
  try{const current=await readFile(full);if(assetHash(current)!==assetHash(data))throw new Error('obsidianWiki.errors.conflict');return;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const temporary=full+'.incoming-'+randomUUID();try{await writeFile(temporary,data,{flag:'wx',mode:0o600});await link(temporary,full);}finally{await unlink(temporary).catch(()=>undefined);}
}
export async function projectMirrorAssets(pool:PgPool,s:StorageSettings,assets:MirrorAsset[],roots:Record<string,string>,assertActive:()=>Promise<void>){
  const sync=createObsidianSyncRepository(pool);
  for(const asset of assets.filter(a=>a.available))await createObsidianWikiRepository(pool).withTargetLock(asset.id,async()=>{
    await assertActive();const old=await sync.findByMemoraId(asset.id);if(old?.metadata.layoutMigration||old?.status==='deleted')return;
    if(!old){try{await stat(await safeVaultPath(s.obsidianVaultPath!,asset.path));throw new Error('obsidianWiki.errors.conflict');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await sync.create({memoraId:asset.id,entityId:asset.id,entityType:'document_asset',memoraType:'attachment',sourceItemId:asset.sourceId,documentId:asset.documentId,relativePath:asset.path,frontmatterHash:asset.sha256,contentHash:asset.sha256,mtimeMs:0,status:'pending',metadata:{projectionFormat:2,asset:true}});
    }
    await assertActive();await writeMirrorAsset(s.obsidianVaultPath!,asset.path,await readMirrorAsset(asset,roots));const registered=await sync.findByMemoraId(asset.id);await sync.update(registered!.id,{status:'synced',mtimeMs:Math.trunc((await stat(await safeVaultPath(s.obsidianVaultPath!,asset.path))).mtimeMs)});
  });
}
