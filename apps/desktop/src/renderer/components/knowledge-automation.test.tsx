import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createTranslator } from '@app/i18n';
import { KnowledgeAutomationView } from './KnowledgeAutomationView';
import { AutomationTaskList } from './AutomationTaskList';
import { AutomationImpactDetails } from './AutomationTaskDetail';
import { AutomationTaskSchema } from '@app/domain';
import { ProcessingPlanPicker, defaultProcessingPlan } from './ProcessingPlanPicker';
describe('automatic knowledge UX', () => {
  it.each(['en','pt-BR','es','fr','it'] as const)('offers automatic-only ingestion and accessible dashboard subpages in %s', locale => {
    const t = createTranslator(locale);
    const plan = renderToString(<ProcessingPlanPicker value={defaultProcessingPlan('full_knowledge')} onChange={()=>{}} t={t}/>);
    expect(plan).toContain(t('processing.wiki.hint'));
    expect(plan).not.toContain(t('wiki.pageTitle'));
    expect(plan).not.toContain(t('jobs.stages.obsidianProjection'));
    const view = renderToString(<KnowledgeAutomationView t={t} contentLanguage={locale}/>);
    for (const tab of ['overview','tasks','schedules','budget','decisions','settings'] as const) expect(view).toContain(t(`automation.tabs.${tab}`));
    expect(view).toContain('role="status"');
    expect(view).not.toContain('[[missing:');
  });
});

it.each(['en','pt-BR','es','fr','it'] as const)('keeps impact records out of the execution list and summarizes meaningful diagnostics in %s',locale=>{
 const t=createTranslator(locale),scope=Array.from({length:6},()=>crypto.randomUUID());
 const task=AutomationTaskSchema.parse({id:crypto.randomUUID(),kind:'delivery',title:'First source only',status:'pending',reason:null,updatedAt:'2026-09-14T19:42:20.000Z',policyId:crypto.randomUUID(),sourceIds:scope,version:'impact',detailCount:18});
 const html=renderToString(<AutomationTaskList tasks={[task]} policyId={task.policyId!} revisionId={null} t={t} inspect={()=>{}}/>);
 expect(html).toContain(t('automation.pendingImpactCount',{values:{count:18}}));expect(html).not.toContain('First source only');expect(html).toContain(t('automation.sourceScopeCount',{values:{count:6}}));
 expect(html.indexOf('<details')).toBeLessThan(html.indexOf('<article'));expect(html).not.toContain('<details open');expect(html).not.toContain('>'+t('automation.pending')+'</span>');
 const items=['wiki_page','wiki_section','wiki_section'].map((kind,index)=>({...task,id:crypto.randomUUID(),event:{kind,operation:'update',targetId:crypto.randomUUID(),targetTitle:'Affected target '+index,createdAt:task.updatedAt,causalRunId:null}}));
 const detail=renderToString(<AutomationImpactDetails items={items} t={t} onAnalysis={()=>{}}/>);
 expect(detail).toContain(t('automation.eventTypes.wikiPage'));expect(detail).toContain(t('automation.eventTypes.wikiSection'));expect(detail).toContain('>2</dd>');expect(detail).toContain('>1</dd>');
 expect(detail.indexOf('<details')).toBeLessThan(detail.indexOf('Affected target'));expect(detail).not.toContain('<details open');expect(detail).not.toContain('[[missing:');
 expect(renderToString(<AutomationImpactDetails items={[]} t={t} onAnalysis={()=>{}}/>)).toContain(t('automation.empty'));
 const inspection={...task,kind:'inspection' as const,status:'no_change',version:'wiki-bootstrap-v1',detailCount:74};
 const checks=renderToString(<AutomationTaskList tasks={[inspection]} policyId={task.policyId!} revisionId={null} t={t} inspect={()=>{}}/>);
 expect(checks).toContain(t('automation.inspectionCount',{values:{count:74}}));expect(checks.indexOf('<details')).toBeLessThan(checks.indexOf('<article'));expect(checks).not.toContain('>'+t('organization.applied')+'</span>');expect(checks).not.toContain('[[missing:');
});

import { SourceJourneyContent } from './KnowledgeAutomationView';
it.each(['en','pt-BR','es','fr','it'] as const)('separates source journey loading, failure, retry, empty and retained data in %s',locale=>{
 const t=createTranslator(locale),base={t,data:null,loading:false,failed:false,offset:0,onRetry:()=>{},onPage:()=>{}};
 const loading=renderToString(<SourceJourneyContent {...base} loading/>);expect(loading).toContain(t('shell.states.loading'));expect(loading).not.toContain('role="alert"');
 const failed=renderToString(<SourceJourneyContent {...base} failed/>);expect(failed).toContain(t('automation.journeyError'));expect(failed).toContain(t('shell.actions.retry'));expect(failed).not.toContain(t('shell.states.loading'));
 const empty=renderToString(<SourceJourneyContent {...base} data={{items:[],next:null}}/>);expect(empty).toContain(t('automation.empty'));expect(empty).not.toContain('role="status"');
 const data={items:[{id:crypto.randomUUID(),title:'Source fixture',processing:'imported',wiki:'awaiting',obsidian:'disabled'}],next:null};
 const loaded=renderToString(<SourceJourneyContent {...base} data={data}/>);expect(loaded).toContain('Source fixture');expect(loaded).toContain(t('automation.imported'));expect(loaded).not.toContain('role="alert"');
 const retained=renderToString(<SourceJourneyContent {...base} data={data} failed/>);expect(retained).toContain('Source fixture');expect(retained).toContain(t('automation.journeyError'));expect(retained).not.toContain('[[missing:');
});
