import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { promptDefinitions } from "@app/domain";
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

// A1 retires the A0 source-expression inventory after migrating those expressions.
// The three immutable rendered goldens above remain the byte-equivalence oracle;
// prompt-catalog-callers/ai and the owning service suites execute actual repairs.
it("registers the former inline families and removes their old prose authority",()=>{
 const ids=new Set(promptDefinitions.map(d=>d.id));
 for(const id of ["summary.short","summary.partial","summary.reduce","summary.aggregate","notes.extract","notes.repair","notes.match","graph.atomic_notes","graph.source_chunks","graph.catalog_metadata","graph.atomic_notes.repair","graph.source_chunks.repair","graph.catalog_metadata.repair","graph.entity_identity","graph.entity_identity.repair","graph.relation_identity","graph.relation_identity.repair","graph.relation_labels","graph.relation_labels.repair","sources.match","sources.repair","sources.validation.default","sources.validation.same_root","organization.legacy_synthesis","organization.repair","organization.state.discover","organization.state.read","organization.state.propose","consultation.answer","consultation.repair","maintenance.weekly","maintenance.monthly","maintenance.cleanup","shared.output_language","shared.relation_language","shared.codex_adapter_instruction","embedding.query_instruction","embedding.query","embedding.content.chunk","embedding.content.note","embedding.content.entity","embedding.content.relation","embedding.content.catalog","diagnostics.local_generation","diagnostics.local_embedding"])expect(ids.has(id),id).toBe(true);
 for(const [path,phrase]of [["apps/desktop/src/main/services/organization-service.ts","You are the bounded wiki page synthesis workflow"],["apps/desktop/src/main/services/knowledge-processing.ts","Evaluate whether the source atomic note"],["packages/ai/src/openai-codex.ts","You are a helpful assistant."]])expect(readFileSync(join(process.cwd(),path!),"utf8")).not.toContain(phrase);
});
