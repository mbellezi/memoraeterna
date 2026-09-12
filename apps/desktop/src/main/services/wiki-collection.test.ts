import {describe,it,expect} from 'vitest';
import {collectionGenerationHash} from './wiki-collection.js';
describe('coverage admission identity',()=>{
 it('preserves dictionary identity across JSONB key ordering without changing array order',()=>{expect(collectionGenerationHash({parameters:{temperature:0.2,maxTokens:2048,nested:{z:1,a:2}},language:'en'})).toBe(collectionGenerationHash({language:'en',parameters:{nested:{a:2,z:1},maxTokens:2048,temperature:0.2}}));expect(collectionGenerationHash({order:[1,2]})).not.toBe(collectionGenerationHash({order:[2,1]}));});
});
