import {describe,it,expect}from'vitest';
import {renderToString}from'react-dom/server';
import {createTranslator}from'@app/i18n';
import {WikiThemeTree}from'./WikiThemeTree';
import {visibleWikiNavigation}from'./wiki-navigation';
import {AutomaticWikiDialog}from'./AutomaticWikiDialog';
const page=(id:string,parentId:string|null=null,archived=false)=>({id,parentId,title:id,archived,position:0});
describe('automatic wiki native surfaces',()=>{
 it('expands only the requested normalized branch, retaining orphan and archived-parent children',()=>{const pages=[page('parent'),page('child','parent'),page('gone',null,true),page('orphan','missing'),page('survivor','gone')];expect(visibleWikiNavigation(pages,new Set()).map(r=>r.page.id)).toEqual(['orphan','parent','survivor']);expect(visibleWikiNavigation(pages,new Set(['parent'])).map(r=>r.page.id)).toEqual(['orphan','parent','child','survivor']);});
 it('retains the normalized root for cyclic old data instead of hiding the entire component',()=>{const rows=visibleWikiNavigation([page('a','b'),page('b','a')],new Set());expect(rows).toHaveLength(1);expect(rows[0]?.parentId).toBeNull();expect(visibleWikiNavigation([page('a','b'),page('b','a')],new Set(['a','b']))).toHaveLength(2);});
 it.each(['en','pt-BR','it','fr','es']as const)('has localized loading/no-model setup and an accessible tree in %s',locale=>{const t=createTranslator(locale),tree=renderToString(<WikiThemeTree pages={[page('parent'),page('child','parent')]} selected="parent" disabled={false} onOpen={()=>{}} t={t}/>);expect(tree).toContain('role="tree"');expect(tree).toContain('role="treeitem"');expect(tree).toContain('aria-expanded="false"');expect(tree).toContain('id="wiki-leaf-parent"');expect(tree.match(/tabindex="0"/g)).toHaveLength(1);expect(tree).not.toContain('wiki-leaf-child');const setup=renderToString(<AutomaticWikiDialog t={t} onClose={()=>{}} onChanged={()=>{}}/>);expect(setup).toContain('role="status"');expect(setup).toContain('max-h-[calc(100dvh-2rem)]');expect(setup).not.toContain('[[missing:');expect(setup).toContain(t('automaticWiki.title'));});
});
