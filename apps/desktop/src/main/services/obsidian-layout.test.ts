import { describe,it,expect } from 'vitest';
import { portableName,pathIdentity,sourceLayoutPath } from './obsidian-layout-paths.js';
import { renderMirrorTarget } from './obsidian-layout-migration.js';
import { parseObsidianMarkdown,sourceOriginal,replaceSourceOriginal,wikiGeneratedStart,wikiGeneratedEnd } from '@app/integration-contracts';
import { validateEditorialChange } from './obsidian-editorial-content.js';
import { ObsidianLayoutMigration } from './obsidian-layout-migration.js';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageSettings } from '../../shared/ipc.js';
const id='00000000-0000-4000-8000-000000000001';
describe('portable canonical layout',()=>{
  it('uses canonical type and actual ancestry, not extension or an invented date',()=>{
    const book={id,title:'Mémoire 日本語.pdf',type:'Book',metadata:{creators:[{name:'Author'}]}},child={id:id.replace(/1$/,'2'),parentId:id,title:'Opening',type:'BookChapter',position:1};
    expect(sourceLayoutPath('Memora',book,[book,child],'pt-BR')).toBe('Memora/Fontes/Livros/Author — Mémoire 日本語.pdf/Mémoire 日本語.pdf.md');
    expect(sourceLayoutPath('Memora',child,[book,child],'pt-BR')).toContain('/Capítulos/02 — Opening.md');
    expect(sourceLayoutPath('Memora',{...book,type:'DailyNote'},[],'en')).toBe('Memora/Sources/Daily/Mémoire 日本語.pdf.md');
    expect(sourceLayoutPath('Memora',{...book,type:'DailyNote',metadata:{date:'2024-03-20'}},[],'en')).toContain('/Daily/2024/03/');
    expect(sourceLayoutPath('Memora',{...book,type:'AcademicPaper'},[],'en')).toContain('/Sources/Articles/Academic/');
  });
  it('preserves Unicode, detects normalization/case collisions and bounds reserved filenames',()=>{
    expect(portableName('CON')).toBe('_CON');expect(portableName('é')).toBe('é');expect(pathIdentity('Café.md')).toBe(pathIdentity('CAFE\u0301.md'));
    expect(Buffer.byteLength(portableName('日本語'.repeat(300)))).toBeLessThanOrEqual(150);expect(portableName('../a:[b]#')).not.toMatch(/[/:\[\]#]/);
  });
});
it('never overwrites a late save to a captured inode when the original path is recreated',async()=>{
  const vault=await mkdtemp(join(tmpdir(),'memora-a6-capture-'));
  try{
    await mkdir(join(vault,'Memora'));await writeFile(join(vault,'Memora','old.md'),'original');
    const settings={obsidianVaultPath:vault,managedRoot:'Memora'} as StorageSettings;
    const migration=new ObsidianLayoutMigration({getPool:()=>null,getStorageSettings:async()=>settings,wiki:{} as never,write:async()=>{}});
    await migration['retire'](settings,'Memora/old.md','original','Memora/captured.md');
    await writeFile(join(vault,'Memora','captured.md'),'late human editor save');
    await writeFile(join(vault,'Memora','old.md'),'original');
    await expect(migration['retire'](settings,'Memora/old.md','original','Memora/captured.md')).rejects.toThrow();
    expect(await readFile(join(vault,'Memora','captured.md'),'utf8')).toBe('late human editor save');
    expect(await readFile(join(vault,'Memora','old.md'),'utf8')).toBe('original');
  }finally{await rm(vault,{recursive:true,force:true});}
});
describe('format 2 editable source boundary',()=>{
  const original='Original hard break.  \n\n```md\n<!-- memora:generated:start -->\n```';
  const target={id,type:'source_item' as const,revision:'revision',title:'Title',path:'Memora/Sources/Title.md',sourceId:id,documentId:id,layout:{version:2 as const,language:'en' as const,attachments:'omit' as const},editorial:`# Title\n\n<!-- memora:original:start -->\n${original}\n<!-- memora:original:end -->\n\n`,generated:'Bibliography\n\nGenerated summary'};
  const raw=renderMirrorTarget(target,1,'tags: [personal]');
  it('retains exact originals, user YAML, fenced examples and separates summaries',()=>{
    const parsed=parseObsidianMarkdown(raw)!;expect(parsed.userFrontmatter).toBe('tags: [personal]');expect(sourceOriginal(parsed.bodyMarkdown)!.original).toBe(original);
    expect(validateEditorialChange(raw,raw.replace('Original hard break.','Human revision.'),raw,'source_item')).toContain('Human revision.');
    expect(validateEditorialChange(raw,raw.replace('Generated summary','Fake original'),raw,'source_item')).toBeNull();
    expect(validateEditorialChange(raw,raw.replace('# Title','# New title'),raw,'source_item')).toBeNull();
  });
  it('rejects future formats and unknown control markers without unmanaged fallback',()=>{
    expect(parseObsidianMarkdown(raw.replace('memora_layout: 2','memora_layout: 3'))).toBeNull();
    expect(parseObsidianMarkdown(raw.replace('memora_wiki_schema: 2','memora_wiki_schema: 9'))).toBeNull();
    expect(parseObsidianMarkdown(raw.replace(wikiGeneratedEnd,'<!-- memora:future -->\n'+wikiGeneratedEnd))).toBeNull();
    expect(parseObsidianMarkdown(raw.replace(wikiGeneratedStart+'\n\nBibliography',wikiGeneratedStart+'\n'+wikiGeneratedStart+'\n\nBibliography'))).toBeNull();
  });
  it('keeps independently changed original and generated current bytes while refusing overlap',()=>{
    const current=raw.replace('Generated summary','Updated generated summary'),local=raw.replace('Original hard break.','Human revision.');
    expect(validateEditorialChange(raw,local,current,'source_item')).toContain('Updated generated summary');
    expect(validateEditorialChange(raw,local,raw.replace('Original hard break.','Concurrent original.'),'source_item')).toBeNull();
    expect(replaceSourceOriginal(parseObsidianMarkdown(raw)!.bodyMarkdown,'New')).toContain('Generated summary');
  });
});
