import { describe, it, expect } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createTranslator } from '@app/i18n';
import { initialCuratorLimits } from '@app/domain';
import { KnowledgeBudgetSettings, parseCuratorBudget, curatorBudgetFields } from './KnowledgeBudgetSettings';
const values = Object.fromEntries(curatorBudgetFields.map(key=>[key,String(initialCuratorLimits[key]/(key==='deadlineMs'?1000:1))])) as Parameters<typeof parseCuratorBudget>[0];
describe('knowledge budget controls',()=>{
  it('requires a complete synthesis/support unit and repair margin before submitting',()=>{
    expect(parseCuratorBudget({...values,modelCalls:'1',repairs:'0'})).toBeNull();
    expect(parseCuratorBudget({...values,modelCalls:'2',repairs:'0'})).toMatchObject({modelCalls:2,repairs:0});
    expect(parseCuratorBudget({...values,modelCalls:'3',repairs:'1'})).toBeNull();
    expect(parseCuratorBudget({...values,modelCalls:'4',repairs:'1',deadlineMs:'90'})).toMatchObject({modelCalls:4,deadlineMs:90000});
  });
  it('rejects empty, fractional, nonfinite and out-of-bound limits',()=>{
    for(const patch of [{modelCalls:''},{repairs:'0.5'},{deadlineMs:'601'},{tools:'Infinity'},{targets:'4'},{originalPassages:'0'}])expect(parseCuratorBudget({...values,...patch})).toBeNull();
  });
  it.each(['en','pt-BR','es','fr','it']as const)('explains separate budgets and loading in %s',locale=>{
    const t=createTranslator(locale),html=renderToString(<KnowledgeBudgetSettings policyId="00000000-0000-4000-8000-000000000001" t={t} onSaved={async()=>{}} onSchedules={()=>{}}/>);
    for(const key of ['budget.title','budget.monthly','budget.curator','budget.monthlyHint','budget.curatorHint']as const)expect(html).toContain(t(key));
    expect(html).toContain('role="status"');expect(html).not.toContain('[[missing:');
    for(const key of curatorBudgetFields){expect(t(`budget.fields.${key}`)).not.toContain('[[missing:');expect(t(`budget.hints.${key}`)).not.toContain('[[missing:');}
  });
});
