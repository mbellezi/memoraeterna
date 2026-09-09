import {EvidenceScopePicker} from "./OrganizationView";
import { describe,it,expect } from "vitest";
import {renderToString} from "react-dom/server";
import {createTranslator} from "@app/i18n";
import type {MaintenanceRun} from "@app/domain";
import {MaintenanceExplanation,MaintenanceView,formatOccurrence,maintenancePreviewPath} from "./MaintenanceView";
describe('maintenance settings presentation',()=>{
 it('discloses inspection and an explicit add action with loading state in every locale',()=>{for(const locale of ['en','pt-BR','it','fr','es'] as const){const t=createTranslator(locale),html=renderToString(<MaintenanceView t={t} pages={[]} profiles={[]} domains={[]}/>);expect(html).toContain(t('maintenance.title'));expect(html).toContain(t('maintenance.add'));expect(html).toContain('role="status"');expect(html).not.toContain('maintenance.description');}});
 it('does not throw while a timezone is partially typed',()=>{expect(formatOccurrence('2026-09-09T09:00Z','Europe/','pt-BR')).toBe('');expect(formatOccurrence('2026-09-09T09:00Z','UTC','pt-BR')).toContain('09/09/2026');});
 it('composes all simultaneous moves and retains outside ancestor paths',()=>{const run={checkpoint:{candidates:[{id:'a',title:'A',content:{parentId:null},path:[{id:'a',title:'A'}]},{id:'b',title:'B',content:{parentId:null},path:[{id:'b',title:'B'}]},{id:'c',title:'C',content:{parentId:'root'},path:[{id:'root',title:'Root'},{id:'c',title:'C'}]}]},proposal:{operations:[{type:'reparent',pageId:'a',parentId:'b'},{type:'reparent',pageId:'b',parentId:'c'}]}} as unknown as MaintenanceRun;expect(maintenancePreviewPath(run,'a').map(p=>p.title)).toEqual(['Root','C','B','A']);});
});

describe('maintenance no-change explanation',()=>{
 it('shows escaped model explanations but hides internal no-model messages',()=>{
  const run={status:'no_change',checkpoint:{calls:1},proposal:{operations:[],explanation:'No move is justified. <script>unsafe()</script>'}} as unknown as MaintenanceRun;
  const html=renderToString(<MaintenanceExplanation run={run}/>);expect(html).toContain('No move is justified.');expect(html).toContain('&lt;script&gt;');expect(html).not.toContain('<script>');
  expect(renderToString(<MaintenanceExplanation run={{...run,checkpoint:{...run.checkpoint,calls:0}}}/>)).toBe('');
 });
});

it('uses a maintenance source hint without changing the organization picker default',()=>{const t=createTranslator('en');const maintenance=renderToString(<EvidenceScopePicker selected={[]} onChange={()=>{}} t={t} hint="maintenance.sourceSelection"/>),organization=renderToString(<EvidenceScopePicker selected={[]} onChange={()=>{}} t={t}/>);expect(maintenance).toContain(t('maintenance.sourceSelection'));expect(maintenance).not.toContain('12,000');expect(organization).toContain('12,000');});
