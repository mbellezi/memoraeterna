import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createTranslator } from '@app/i18n';
import { KnowledgeAutomationView } from './KnowledgeAutomationView';
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
