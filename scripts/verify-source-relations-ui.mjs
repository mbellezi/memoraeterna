import { app, BrowserWindow } from "electron";
import { build } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporary = mkdtempSync(join(tmpdir(),"memora-source-relations-ui-"));
app.setPath("userData",join(temporary,"profile"));
const component = resolve("apps/desktop/src/renderer/components/SourceRelationsList.tsx");
const graph = resolve("apps/desktop/src/renderer/components/KnowledgeGraphDashboard.tsx");
const styles = resolve("apps/desktop/src/renderer/styles.css");
const fixture = `
import React from "react";
import {createRoot} from "react-dom/client";
import {createTranslator} from "@app/i18n";
import {SourceRelationsList} from ${JSON.stringify(component)};
import {drawFadingEdgeLabel} from ${JSON.stringify(graph)};
import ${JSON.stringify(styles)};
const t=createTranslator("pt-BR");
let mode="success",version=0,lastOffset=0,openedNote=null;
const relationships=Array.from({length:3},(_,i)=>({
  id:String(i),sourceItemId:"A",targetSourceItemId:"B",sourceTitle:"Livro: Mecanismos de aprendizagem",targetTitle:"Artigo: Recuperação ativa e memória",
  relationType:["supports","contrasts","extends"][i],sourceIdea:"A recuperação ativa fortalece a retenção.",targetIdea:"O esforço de recordar favorece a aprendizagem.",
  explanation:["Sustenta o benefício da recuperação ativa para a retenção de longo prazo, quando há oportunidade de corrigir erros.","Contrasta quanto à necessidade de feedback imediato: as fontes descrevem condições diferentes para consolidar a aprendizagem.","Amplia a explicação dos mecanismos ao relacionar o esforço de recordar à correção de erros."][i],
  importance:0.9,confidence:0.9,status:"pending_review",current:true,updatedAt:"2026-09-07T00:00:00.000Z",
  evidence:[{id:"e"+i,origin:i===0?"atomic_notes":"source_analysis",current:true,sourceChunkId:"c1",targetChunkId:"c2",sourceSpanId:null,targetSpanId:null,
    sourceExcerpt:"A recuperação ativa promove a retenção. O efeito depende de tentativas de recordar acompanhadas de oportunidades de corrigir interpretações equivocadas.",
    targetExcerpt:"O esforço de recordar favorece a aprendizagem. As condições experimentais devem ser preservadas ao comparar os resultados.",sourceNoteId:i===0?"note-A":null,targetNoteId:i===0?"note-B":null,noteRelationId:null}]
}));
window.app={knowledge:{listSourceRelations:async(input)=>{lastOffset=input.offset;await new Promise(r=>setTimeout(r,60));if(mode==="error")throw new Error("fixture");return mode==="empty"?{relations:[],hasMore:false,total:0}:{relations:relationships,hasMore:input.offset===0,total:33};},
 reviewSourceRelation:async(input)=>{const row=relationships.find(r=>r.id===input.id);row.status=input.status;return true;}}};
const root=createRoot(document.querySelector("#root"));
function render(){root.render(React.createElement(SourceRelationsList,{key:version++,sourceItemId:"A",targetSourceItemId:"B",t,onOpenNote:(source,id)=>{openedNote=[source,id];}}));}
async function waitFor(test){for(let i=0;i<100;i++){if(test())return;await new Promise(r=>setTimeout(r,20));}throw new Error("UI state timed out");}
export async function verify(){
 render();await waitFor(()=>document.querySelectorAll("article").length===3);
 const cards=[...document.querySelectorAll("article")].map(el=>el.getBoundingClientRect());
 if(cards.some((card,i)=>i>0&&card.top<cards[i-1].bottom))throw new Error("Cards overlap");
 if(document.querySelector("#root").scrollWidth>document.querySelector("#root").clientWidth+1)throw new Error("Horizontal overflow");
 document.querySelector("summary").click();
 await waitFor(()=>document.querySelector("details").open);
 const noteButton=[...document.querySelectorAll("button")].find(el=>el.textContent.includes("Ver nota"));noteButton.click();
 if(JSON.stringify(openedNote)!=='["A","note-A"]')throw new Error("Wrong note navigation target");
 const accept=[...document.querySelectorAll("button")].find(el=>el.textContent.includes("Aceitar"));accept.click();
 await waitFor(()=>document.querySelector("article").textContent.includes("Aceita"));
 const next=[...document.querySelectorAll("button")].find(el=>el.textContent.includes("Próxima"));next.click();await waitFor(()=>lastOffset===30);
 mode="empty";render();await waitFor(()=>document.body.textContent.includes("Ainda não há relações qualificadas"));
 mode="error";render();await waitFor(()=>document.querySelector('[role="alert"]'));
 mode="success";render();await waitFor(()=>document.querySelectorAll("article").length===3);
 const canvas=document.querySelector("canvas"),ctx=canvas.getContext("2d");
 ctx.strokeStyle="#475569";ctx.beginPath();ctx.moveTo(25,35);ctx.lineTo(375,35);ctx.stroke();
 drawFadingEdgeLabel(ctx,{label:"relations",kind:"source_connection",labelOpacity:1,sourceRelations:[{kind:"source_relation",relationType:"supports",weight:3},{kind:"source_relation",relationType:"extends",weight:1},{kind:"source_relation",relationType:"contrasts",weight:1}]},{x:25,y:35},{x:375,y:35},{});
 return {cards:cards.length,overlap:false,review:true,pagination:true,empty:true,error:true,noteNavigation:true};
}
`;
async function verify(){
  let window;
  const deadline=setTimeout(()=>{console.error("Source relation UI timed out");app.exit(1);},45000);
  try {
    const bundle=await build({configFile:false,logLevel:"silent",esbuild:{jsx:"automatic"},define:{"process.env.NODE_ENV":"\"production\""},
      build:{write:false,minify:false,lib:{entry:"source-relations-ui",name:"SourceRelationsUI",formats:["iife"]}},
      plugins:[tailwindcss(),{name:"fixture",resolveId(id){if(id==="source-relations-ui"||id.endsWith("/source-relations-ui"))return "\0source-relations-ui";},load(id){if(id==="\0source-relations-ui")return fixture;}}]});
    const output=(Array.isArray(bundle)?bundle[0]:bundle).output;
    const code=output.find(item=>item.type==="chunk")?.code;
    const css=output.filter(item=>item.type==="asset"&&item.fileName.endsWith(".css")).map(item=>item.source).join("\n");
    if(!code)throw new Error("Missing UI bundle");
    await app.whenReady();app.dock?.hide();
    window=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{offscreen:true,backgroundThrottling:false,sandbox:true,contextIsolation:true}});
    await window.loadURL("data:text/html;charset=utf-8,"+encodeURIComponent(`<html class="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="margin:0;background:#020617;color:#e2e8f0"><h2 style="padding:20px 24px 0;font-size:18px;font-weight:600">Relações entre ideias</h2><canvas width="400" height="70" style="margin-left:20px"></canvas><div id="root" style="height:730px;overflow:auto;padding:0 12px"></div></body></html>`));
    const result=await window.webContents.executeJavaScript("(async()=>{try{"+code+"\nreturn await SourceRelationsUI.verify();}catch(error){return {failure:String(error),stack:error.stack};}})()");
    if(result.failure)throw new Error(JSON.stringify(result));
    await window.webContents.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
    await window.webContents.executeJavaScript("document.fonts.ready");
    window.webContents.invalidate();
    await new Promise(resolve=>setTimeout(resolve,250));
    const image=await window.webContents.capturePage();const screenshot=join(temporary,"source-relations.png");writeFileSync(screenshot,image.toPNG());
    console.log(JSON.stringify({passed:true,...result,screenshot}));
  }catch(error){console.error(error);process.exitCode=1;}finally{clearTimeout(deadline);window?.destroy();app.exit(process.exitCode??0);}
}
void verify();
