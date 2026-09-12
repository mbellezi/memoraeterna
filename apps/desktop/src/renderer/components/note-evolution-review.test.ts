import {describe,it,expect} from 'vitest';
import type {CuratorRun} from '@app/domain';
import {finalNoteReviewTargets} from './AutomaticWikiDialog';
describe('reviewed final note membership labels',()=>{
 const targets=[{kind:'atomic_note',id:'a',title:'First old note'},{kind:'atomic_note',id:'b',title:'Second old note'}];
 const run=(kind:string,noteIds:string[],titles:string[])=>({proposal:{noteEvolution:{kind,noteIds,notes:titles.map(title=>({title}))}}}) as CuratorRun;
 it('shows the single deduplicated output in a new merged index',()=>{expect(finalNoteReviewTargets(run('merge',['a','b'],['Merged note']),targets).map(t=>t.title)).toEqual(['Merged note']);});
 it('shows every split output in order',()=>{expect(finalNoteReviewTargets(run('split',['a'],['First output','Second output']),targets).map(t=>t.title)).toEqual(['First output','Second output','Second old note']);});
 it('retains cross-source originals and shows one new shared output',()=>{expect(finalNoteReviewTargets(run('cross_source',['a','b'],['Shared note']),targets).map(t=>t.title)).toEqual(['First old note','Shared note','Second old note']);});
});
