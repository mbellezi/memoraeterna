import {describe,expect,it} from 'vitest';
import {visibleWikiNavigation,wikiNavigationOrder} from './wiki-navigation';
const page=(id:string,parentId:string|null,position=0,archived=false)=>({id,parentId,position,archived,title:id});
describe('canonical navigation traversal',()=>{
 it('reveals arbitrarily deep loaded paths without recursion and respects collapsed ancestors',()=>{
  const pages=Array.from({length:12000},(_,i)=>page(String(i),i?String(i-1):null));
  expect(wikiNavigationOrder(pages).at(-1)?.depth).toBe(11999);
  const expanded=new Set(pages.map(p=>p.id));
  expect(visibleWikiNavigation(pages,expanded)).toHaveLength(12000);
  expanded.delete('20');
  const rows=visibleWikiNavigation(pages,expanded);
  expect(rows).toHaveLength(21);expect(rows.at(-1)?.hasChildren).toBe(true);
 });
 it('preserves sibling order and defensive orphan/cycle visibility',()=>{
  const pages=[page('later','root',2),page('root',null),page('early','root',1),page('gone',null,0,true),page('orphan','gone'),page('missing','absent'),page('a','b'),page('b','a')];
  const rows=visibleWikiNavigation(pages,new Set(pages.map(p=>p.id)));
  expect(rows.map(r=>r.page.id)).toEqual(['missing','orphan','root','early','later','a','b']);
  expect(rows.find(r=>r.page.id==='orphan')?.parentId).toBeNull();
  expect(rows.find(r=>r.page.id==='b')?.parentId).toBe('a');
 });
});
