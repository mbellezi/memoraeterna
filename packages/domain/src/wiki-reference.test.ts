import {describe,it,expect} from 'vitest';
import {resolveWikiReference} from './wiki-reference.js';
const id='11111111-1111-4111-8111-111111111111';
describe('canonical inline references',()=>{
 it('binds citations only to the owning section or group original list',()=>{expect(resolveWikiReference('[1]',[id],[])).toEqual({kind:'evidence',id,label:'[1]'});expect(resolveWikiReference('[2]',[id],[])).toBeNull();expect(resolveWikiReference('[e1]',[id],[])?.id).toBe(id);});
 it('resolves a supplied typed target and keeps arbitrary links inert',()=>{expect(resolveWikiReference(`[A](memora:page/${id})`,[],[{kind:'page',id}])?.kind).toBe('target');expect(resolveWikiReference(`[A](memora:source/${id})`,[],[{kind:'page',id}])).toBeNull();expect(resolveWikiReference('[run](javascript:alert(1))',[],[])).toBeNull();expect(resolveWikiReference('[title only]',[],[])).toBeNull();});
});
