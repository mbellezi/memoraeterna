import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
const source=await readFile(new URL('../apps/desktop/out/preload/index.cjs',import.meta.url),'utf8');
const exposed=new Map();
new Script(source,{filename:'sandbox-preload.js'}).runInNewContext({
 require(name){assert.equal(name,'electron',`Sandbox preload cannot resolve external module ${name}`);return {contextBridge:{exposeInMainWorld:(key,api)=>exposed.set(key,api)},ipcRenderer:{invoke:async()=>null,on:()=>{},removeListener:()=>{}}};},
 console,URL,TextEncoder,TextDecoder,setTimeout,clearTimeout
});
assert.equal(typeof exposed.get('app')?.prompts?.command,'function');
console.log('Built sandbox preload initializes with only Electron available and exposes the typed prompt command surface.');
