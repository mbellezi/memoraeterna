import { describe,expect,it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createTranslator } from '@app/i18n';
import { promptDefinition,promptDefinitions } from '@app/domain';
import { highlightPromptTokens,buildPromptTree,promptTreeNavigation,PromptField,fieldVariableKeys,filterPromptDefinitions,insertPromptVariable } from './PromptsSettingsView';

describe('prompt catalog editor',()=>{
 it('keeps branch and leaf identities unique across every catalog family',()=>{const root=buildPromptTree(promptDefinitions,'en'),keys:string[]=[];const visit=(node:typeof root)=>{for(const child of node.children.values()){keys.push(child.key);visit(child);}};visit(root);expect(new Set(keys).size).toBe(keys.length);expect(keys).toContain('category:maintenance.weekly');expect(keys).toContain('prompt:maintenance.weekly');});
 it('navigates visible tree siblings, first children and parents with one focus target',()=>{
  const items=[{key:'a',parent:null,expanded:true},{key:'a.one',parent:'a',expanded:null},{key:'a.two',parent:'a',expanded:null},{key:'b',parent:null,expanded:false}];
  expect(promptTreeNavigation(items,'a','ArrowRight')).toEqual({focus:'a.one'});
  expect(promptTreeNavigation(items,'a.one','ArrowLeft')).toEqual({focus:'a'});
  expect(promptTreeNavigation(items,'a','ArrowLeft')).toEqual({focus:'a',toggle:'a'});
  expect(promptTreeNavigation(items,'b','ArrowRight')).toEqual({focus:'b',toggle:'b'});
  expect(promptTreeNavigation(items,'b','ArrowLeft')).toEqual({focus:'b'});
  expect(promptTreeNavigation(items,'a.two','ArrowDown')).toEqual({focus:'b'});
  expect(promptTreeNavigation(items,'a.two','ArrowUp')).toEqual({focus:'a.one'});
  expect(promptTreeNavigation(items,'a.two','Home')).toEqual({focus:'a'});
  expect(promptTreeNavigation(items,'a.two','End')).toEqual({focus:'b'});
  expect(promptTreeNavigation(items,'a.two','Tab')).toBeNull();
 });
 it('documents only tokens present in the field and preserves caret insertion',()=>{
  expect(highlightPromptTokens('%%page_title%% %page_title% %unknown%', ['page_title']).filter(p=>p.variable).map(p=>[p.text,p.known])).toEqual([['%page_title%',true],['%unknown%',false]]);
  expect(fieldVariableKeys('50% and %%escaped%% %page_title%')).toEqual(['page_title']);
  expect(insertPromptVariable('before AFTER','content_language',7,12)).toEqual({text:'before %content_language%',cursor:25});
  const definition=promptDefinition('organization.guidance');
  const html=renderToStaticMarkup(<PromptField definition={definition} field={definition.fields[0]!} text="No tokens here" onChange={()=>{}} language="en" t={createTranslator('en')} errors={[]}/>);
  expect(html).toContain('variables-body');expect(html).not.toContain('<dt');
  for(const locale of ['en','pt-BR','it','fr','es']as const){const html=renderToStaticMarkup(<PromptField definition={definition} field={definition.fields[0]!} text="%page_title%" onChange={()=>{}} language={locale} t={createTranslator(locale)} errors={[]}/>);expect(html).toContain(definition.variables.find(v=>v.key==='page_title')!.description[locale]);}
 });
 it('filters saved drafts and invalid leaves without opening their detail',()=>{
  const empty=new Set<string>(),drafts=new Set(['summary.partial']),invalid=new Set(['notes.repair']);
  expect(filterPromptDefinitions(promptDefinitions,'','drafts',empty,drafts,invalid,'en').map(d=>d.id)).toEqual(['summary.partial']);
  expect(filterPromptDefinitions(promptDefinitions,'','invalid',empty,drafts,invalid,'en').map(d=>d.id)).toEqual(['notes.repair']);
 });
});
