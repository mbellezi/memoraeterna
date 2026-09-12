import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { summaryPrompt, summaryReductionPrompt, buildAggregateSummaryPrompt, buildAtomicNoteGenerationPrompt, buildAtomicNoteRepairPrompt, buildKnowledgeGraphPrompt, buildKnowledgeGraphRepairPrompt, buildBatchRerankPrompt, generateSummaryFromChunks } from "./knowledge-processing.js";
import { buildRelationMatchPrompt, embeddingText } from "./relation-type-resolution.js";
import { identityText } from "./entity-identity-resolution.js";
import { buildRelationLabelPrompt } from "./relation-label-processing.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import { sourceRelationPrompt } from "./source-relation-processing.js";
import { withEmbeddingInputInstruction, withOutputLanguageInstruction } from "./ai-service.js";
import { consultationPrompt } from "./consultation-service.js";
import { OrganizationService } from "./organization-service.js";
import { maintenancePrompt } from "./maintenance-service.js";
import { OrganizationSnapshotSchema, OrganizationCheckpointSchema, MaintenanceSnapshotSchema, MaintenanceCheckpointSchema, MaintenancePolicySchema, resolveOrganizationInstructions } from "@app/domain";
const id = (n:number) => `00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const chunks = [{ id:id(1), content:"In this fictional classroom retrieval before rereading improved next-week recall with feedback. Literal %question% remains evidence." }];
const source = { title:"Synthetic learning", language:"en" };
const notes = [{id:id(2),title:"Recall",ideaStatement:"Retrieval with feedback improved later recall in the fictional trial.",bodyMarkdown:chunks[0]!.content,evidenceChunkIds:[id(1)]}];
const instructions = resolveOrganizationInstructions({global:{},pageSynthesis:{},domains:[]},null,source.title,"en");
const snapshot = OrganizationSnapshotSchema.parse({version:"wiki-three-tools-v1",targetId:id(3),expectedRevisionId:null,targetHuman:false,baseContent:{title:source.title,kind:"topic"},sourceIds:[id(4)],profile:{profileId:id(5),providerConfigId:null,localModelId:id(6),provider:"local",modelId:"synthetic",runtime:"test",revision:null,privacy:"offline_only",parameters:{},identityHash:"synthetic",contextWindow:8192},contentLanguage:"en",configurationId:null,configurationHash:"synthetic",instructions,limits:{},policy:"human_review",sample:true,evidence:[{handle:"e1",chunkId:id(1),sourceItemId:id(4),documentId:id(7),sourceSpanId:null,contentHash:"synthetic-original-r1",excerpt:chunks[0]!.content,sourceTitle:source.title,documentCreatedAt:"2026-09-01T00:00:00Z",locator:"paragraph 1"}],relations:[]});
const checkpoint = OrganizationCheckpointSchema.parse({tools:0,calls:0,repairs:0,startedAt:null,readHandles:[],discoveredHandles:[],transcript:[],reportedInputTokens:0,reportedOutputTokens:0,costEstimate:0,usageIncomplete:false,callPending:false,error:null});

describe("A0 legacy rendered prompt goldens (no model or database)", () => {
  it("captures actual summary, extraction, matching, query and language builder outputs", () => {
    const rows = [{key:"r1",predicate:"supports",definition:"provides evidence supporting",candidates:[{key:"c1",predicate:"corroborates",definition:"provides independent supporting evidence"}]}];
    const output: Record<string,unknown> = {
      "summary.short":summaryPrompt(chunks,false), "summary.partial":summaryPrompt(chunks,true),
      "summary.reduce":summaryReductionPrompt(["A reports retrieval helped.","B reports spacing helped."]),
      "summary.aggregate":buildAggregateSummaryPrompt({kind:"Book",title:source.title},[{title:"Chapter A",summary:"Retrieval helped with feedback."}]),
      "notes.extract":buildAtomicNoteGenerationPrompt(source,chunks),
      "notes.repair":buildAtomicNoteRepairPrompt('{"notes":', [id(1)],new Error("invalid JSON")),
      "notes.match":buildBatchRerankPrompt(notes[0]!,[{alias:"c1",title:"Spacing",ideaStatement:"Distributed practice helped in the fictional comparison."}]),
      "graph.relation_identity":buildRelationMatchPrompt(rows), "graph.entity_identity":buildRelationMatchPrompt(rows,true),
      "graph.relation_labels":buildRelationLabelPrompt([{subject:"Practice",predicate:"supports",object:"Recall"}],"en"),
      "embedding.relation_type":embeddingText({predicate:"supports_recall",definition:"Provides support for recall."}),
      "embedding.entity":identityText({type:"concept",canonicalName:"Retrieval",identityDescription:"Recall of studied material."}),
      "embedding.catalog":buildCatalogMetadataMarkdown({type:"Book",title:source.title,subtitle:null,sourceUri:null,language:"en",summary:null,metadata:{descriptor:{creators:[{name:"Synthetic Author",role:"author"}],isbn:"synthetic-no-identifier"}}}),
      "source.match":sourceRelationPrompt({chunks:[],notes:[],existing:[]},3,false),
      "embedding.qwen_query":withEmbeddingInputInstruction("recall %question%","Qwen3-Embedding",null,"query"),
      "embedding.qwen_document":withEmbeddingInputInstruction(chunks[0]!.content,"Qwen3-Embedding",null,"document"),
      "embedding.other_query":withEmbeddingInputInstruction("recall","other-model",null,"query")
    };
    for (const language of ["en","pt-BR","it","fr","es"]) output[`shared.language.${language}`]=withOutputLanguageInstruction("Synthetic prompt.",language);
    for (const kind of ["atomic_notes","source_chunks","catalog_metadata"] as const) {
      output[`graph.${kind}`]=buildKnowledgeGraphPrompt(source,notes,undefined,kind);
      output[`graph.${kind}.repair`]=buildKnowledgeGraphRepairPrompt(source,notes,new Map([["c1",id(1)]]),"{",new Error("invalid JSON"),kind);
    }
    expect(output).toMatchSnapshot();
  });
  it("captures actual legacy organization state, consultation and routine compositions", () => {
    const service = Object.create(OrganizationService.prototype) as {prompt:(s:typeof snapshot,c:typeof checkpoint)=>string};
    const output: Record<string,unknown> = { "consultation.answer":consultationPrompt(snapshot,"What helped recall?",[]) };
    for (const [stage,c] of Object.entries({discover:checkpoint,read:{...checkpoint,discoveredHandles:["e1"]},propose:{...checkpoint,discoveredHandles:["e1"],readHandles:["e1"]}})) output[`organization.${stage}`]=service.prompt(snapshot,c);
    for (const routine of ["weekly","monthly","cleanup"] as const) {
      const policy=MaintenancePolicySchema.parse({name:"Synthetic routine",routine,cadence:{timezone:"Europe/London"},scope:{wholeLibrary:true},categories:["navigation","evidence"]});
      const s=MaintenanceSnapshotSchema.parse({version:"wiki-maintenance-v1",policy,configurationId:null,configurationHash:"synthetic",instructions:resolveOrganizationInstructions({global:{},pageSynthesis:{},domains:[]},null,"Synthetic routine","en",routine),profile:null,language:"en",scopeKey:"synthetic",period:"2026-09",cutoff:"2026-09-01T00:00:00Z"});
      output[`maintenance.${routine}`]=maintenancePrompt({snapshot:s,checkpoint:MaintenanceCheckpointSchema.parse({})});
    }
    expect(output).toMatchSnapshot();
  });
  it("spies on the real map/reduce caller and freezes complete admitted input", async () => {
    const calls: string[]=[];
    await generateSummaryFromChunks([...chunks,{id:id(8),content:"B reports that spaced practice improved next-week recall under the same fictional conditions."}],async input=>{
      calls.push(input);return {output:JSON.stringify({summary:"Synthetic partial summary.",concepts:[]}),profileId:id(5),aiTaskRunId:id(9),providerId:"fixture",modelId:"fixture",runtime:"fixture"};
    },50,0);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls).toMatchSnapshot();
  });
});

const root=process.cwd();
const ownerFiles=["knowledge-processing","knowledge-service","relation-type-resolution","entity-identity-resolution","relation-label-processing","source-relation-processing","organization-service","consultation-service","maintenance-service","ai-service","canonical-embedding","job-supervisor","hierarchical-ingestion-service","search-service","matching-benchmark"];
const paths=[...ownerFiles.map(name=>`apps/desktop/src/main/services/${name}.ts`),"packages/domain/src/organization.ts","packages/ai/src/openai-codex.ts"];
function walkFiles(dir:string):string[]{return readdirSync(dir,{withFileTypes:true}).flatMap(entry=>entry.isDirectory()?walkFiles(join(dir,entry.name)):entry.name.endsWith(".ts")&&!entry.name.endsWith(".test.ts")?[join(dir,entry.name)]:[]);}
it("inventories every direct application AI callsite and freezes inline wording/repair/serializer fragments",()=>{
  const calls: Record<string,string[]>={};
  for(const file of walkFiles(join(root,"apps/desktop/src/main"))) {
    const code=readFileSync(file,"utf8"),tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);
    const visit=(node:ts.Node)=>{
      if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&["runDefaultTask","runOrganizationTask","runConsultationEmbedding","generateEmbedding","tryRunDefaultTask"].includes(node.expression.name.text)) {
        const key=relative(root,file);(calls[key]??=[]).push(node.expression.getText(tree)+"("+node.arguments.slice(0,2).map(a=>a.getText(tree)).join(", ")+")");
      }
      ts.forEachChild(node,visit);
    };visit(tree);
  }
  expect(calls).toMatchSnapshot("all direct AI callers, including DEV and transport forwarding");
  const fragments:Record<string,string[]>={};
  for(const file of paths) {
    const code=readFileSync(join(root,file),"utf8"),tree=ts.createSourceFile(file,code,ts.ScriptTarget.Latest,true);
    const visit=(node:ts.Node)=>{
      // Full template expressions retain serializers, aliases and interpolation order;
      // literal prose retains private inline repairs and adapter-owned instructions.
      if(ts.isTemplateExpression(node)||(ts.isStringLiteralLike(node)&&(node.text.length>=35 || /Reply with|helpful assistant|smoke test/.test(node.text)))) {
        (fragments[file]??=[]).push(node.getText(tree));
        if(ts.isTemplateExpression(node)) return;
      }
      ts.forEachChild(node,visit);
    };visit(tree);
  }
  expect(fragments).toMatchSnapshot("exact legacy source fragments (not runtime execution evidence)");
});
