import {app,BrowserWindow} from 'electron';
import {build} from 'vite';
import {mkdtempSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
app.setPath('userData',mkdtempSync(join(tmpdir(),'memora-prompt-layout-')));
const root=resolve(import.meta.dirname,'..');
const fixture=String.raw`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {PromptField} from ${JSON.stringify(join(root,'apps/desktop/src/renderer/components/PromptsSettingsView.tsx'))};
import {promptDefinition} from '@app/domain';import {createTranslator} from '@app/i18n';
export async function verify(){
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host),d=promptDefinition('organization.curator');const results=[];
 const frame=()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
 for(const width of [520,900])for(const sample of [d.fields[0].template,'Unicode 😀 %%escaped%% 50%\\nPOLICY: %policy%\\n'+('long words '.repeat(45))+'%group_id%\\n'+('line\\n'.repeat(20))+'%current_page%\\n']){
  host.style.width=width+'px';const text=sample.replaceAll('\\n','\n');
  flushSync(()=>root.render(React.createElement(PromptField,{definition:d,field:d.fields[0],text,onChange:()=>{},language:'en',t:createTranslator('en'),errors:[]})));await frame();
  const input=host.querySelector('textarea'),pre=host.querySelector('pre');input.style.height='270px';await frame();
  for(const position of [0,120,100000]){
   input.scrollTop=position;input.dispatchEvent(new Event('scroll',{bubbles:true}));await frame();
   if(input.clientWidth!==pre.clientWidth||input.clientHeight!==pre.clientHeight)throw new Error('Highlight viewport differs from textarea');
   if(pre.textContent!==text+'\n'||input.value!==text)throw new Error('Editor changed prompt bytes');
   if(Math.abs(pre.scrollTop-input.scrollTop)>1)throw new Error('Scroll mismatch');
   const mirror=pre.cloneNode(false),node=document.createTextNode(text+'\n');mirror.append(node);pre.parentNode.append(mirror);mirror.scrollTop=input.scrollTop;mirror.scrollLeft=input.scrollLeft;
   let offset=0;for(const mark of pre.querySelectorAll('mark')){const start=text.indexOf(mark.textContent,offset);offset=start+mark.textContent.length;const range=document.createRange();range.setStart(node,start);range.setEnd(node,offset);const expected=Array.from(range.getClientRects()),actual=Array.from(mark.getClientRects());
    if(expected.length!==actual.length||actual.some((r,i)=>['x','y','width','height'].some(k=>Math.abs(r[k]-expected[i][k])>1)))throw new Error('Misaligned variable '+mark.textContent+' at width '+width);
   }mirror.remove();results.push({width,scroll:input.scrollTop,variables:pre.querySelectorAll('mark').length});
  }
 }
 root.unmount();return {passed:true,results};
}`;
async function verify(){
let win;const timeout=setTimeout(()=>app.exit(1),30000);
try{const result=await build({configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},esbuild:{jsx:'automatic'},build:{write:false,minify:false,lib:{entry:'prompt-layout-fixture',name:'PromptLayout',formats:['iife']}},plugins:[{name:'fixture',resolveId(id){if(id==='prompt-layout-fixture'||id.endsWith('/prompt-layout-fixture'))return '\0prompt-layout-fixture';},load(id){if(id==='\0prompt-layout-fixture')return fixture;}}]});
const code=(Array.isArray(result)?result[0]:result).output.find(x=>x.type==='chunk').code;
const assets=join(root,'apps/desktop/out/renderer/assets'),css=readdirSync(assets).filter(x=>x.endsWith('.css')).map(x=>readFileSync(join(assets,x),'utf8')).join('\n');
await app.whenReady();app.dock?.hide();win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{offscreen:true,sandbox:true,contextIsolation:true}});
await win.loadURL('data:text/html,'+encodeURIComponent('<html><head><style>'+css+'</style></head><body></body></html>'));
console.log(JSON.stringify(await win.webContents.executeJavaScript(code+'\nPromptLayout.verify()')));
}catch(e){console.error(e);process.exitCode=1;}finally{clearTimeout(timeout);win?.destroy();app.exit(process.exitCode??0);}

}
void verify();
