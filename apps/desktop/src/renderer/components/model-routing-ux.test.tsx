import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { createTranslator } from '@app/i18n';
import { ConsultationInputSchema, OrganizationStartSchema, ProcessingPlanRequestSchema } from '@app/domain';
import { ProfilePicker } from './OrganizationView';
import type { AiProfile } from '../../shared/ipc';

const id='00000000-0000-4000-8000-000000000001';
const profiles=[{id,name:'Configured model',modelId:'test-model',status:'active',capabilities:['structured-output']}] as AiProfile[];
describe('router-first model controls',()=>{
  it('hides the model selector by default in every locale',()=>{
    for(const locale of ['en','pt-BR','it','fr','es'] as const){
      const t=createTranslator(locale),html=renderToString(<ProfilePicker profiles={profiles} value="" onChange={()=>{}} t={t}/>);
      expect(html).toContain('role="switch"');expect(html).toContain(t('organization.routerHint'));expect(html).not.toContain('<select');expect(html).not.toContain(t('organization.offline'));
    }
  });
  it('preserves a saved override and offers the routed default',()=>{
    const t=createTranslator('pt-BR'),html=renderToString(<ProfilePicker profiles={profiles} value={id} onChange={()=>{}} t={t}/>);
    expect(html).toContain('<select');expect(html).toContain(t('organization.defaultModel'));expect(html).toContain('selected=""');expect(html).toContain('Configured model');
  });
  it('shows a useful empty state',()=>{
    const t=createTranslator('en'),html=renderToString(<ProfilePicker profiles={[]} value="" onChange={()=>{}} t={t}/>);
    expect(html).toContain('role="status"');expect(html).toContain(t('organization.noModel'));
  });
  it('accepts routed consultation, organization and batch requests without an override',()=>{
    expect(ConsultationInputSchema.parse({requestId:id,question:'What is this?'}).profileId).toBeUndefined();
    expect(OrganizationStartSchema.parse({title:'Topic',sourceIds:[id]}).profileId).toBeUndefined();
    expect(ProcessingPlanRequestSchema.parse({preset:'custom',requestedStages:['organizeKnowledge'],organization:{title:'Topic',privacy:'allow_remote'}}).organization?.profileId).toBeUndefined();
  });
});
