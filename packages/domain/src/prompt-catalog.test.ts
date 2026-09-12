import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PromptDefinitionSchema, PromptVariableSchema, PromptCompositionSnapshotSchema, promptCatalogVersion } from "./prompt-catalog.js";
const labels={en:"Question", "pt-BR":"Pergunta",it:"Domanda",fr:"Question",es:"Pregunta"};
const variable={key:"question",description:labels,valueType:"text",scope:"run",required:true,originResolver:"admitted_question",example:"What did the fictional trial find?",sensitivity:"source_content",serialization:"text",applicablePromptIds:["consultation.answer"],emptyRepresentation:null};
describe("A0 prompt registry contracts",()=>{
  it("requires safe origins, typed variables, localized descriptions and explicit optional defaults",()=>{
    expect(PromptVariableSchema.safeParse(variable).success).toBe(true);
    expect(PromptVariableSchema.safeParse({...variable,key:"API_KEY",sensitivity:"secret"}).success).toBe(false);
    expect(PromptVariableSchema.safeParse({...variable,required:false}).success).toBe(false);
    expect(PromptVariableSchema.safeParse({...variable,required:false,emptyRepresentation:""}).success).toBe(true);
    expect(PromptVariableSchema.safeParse({...variable,description:{en:"Question"}}).success).toBe(false);
  });
  it("keeps fields, declared variables, contracts and active composition snapshots explicit",()=>{
    const definition={version:promptCatalogVersion,id:"consultation.answer",category:["consultation"],title:labels,purpose:labels,caller:"ConsultationService.ask",task:"structured-output",supportsDomain:true,defaultVersion:"1",fields:[{id:"body",template:"Answer %question%",editable:true,variableKeys:["question"],requiredContractIds:["consultation.output"]}],variables:[variable],fragmentIds:[],fixtureIds:["single-pass"]};
    expect(PromptDefinitionSchema.safeParse(definition).success).toBe(true);
    expect(PromptDefinitionSchema.safeParse({...definition,variables:[]}).success).toBe(false);
    const snapshot={version:promptCatalogVersion,promptId:"consultation.answer",revisions:[{id:"consultation.answer",revisionId:"shipped-1"}],compositionHash:"a".repeat(64),templateLanguage:"en",origin:"default",outputContractVersion:"wiki-answer-v1",embeddingStrategyIdentity:null};
    expect(PromptCompositionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(PromptCompositionSnapshotSchema.safeParse({...snapshot,compositionHash:""}).success).toBe(false);
  });
  it("provides a reusable renderer oracle including malicious literal data, escapes and cyclic dependencies",()=>{
    const cases=JSON.parse(readFileSync(new URL("../../../scripts/fixtures/automatic-wiki/prompt-variables.json",import.meta.url),"utf8")) as Array<{case:string;expected?:string;error?:string}>;
    expect(new Set(cases.map(c=>c.case)).size).toBe(cases.length);
    expect(cases.every(c=>(typeof c.expected==="string")!==Boolean(c.error))).toBe(true);
    expect(cases.find(c=>c.case==="single-pass")?.expected).toBe("Read %secret% $(touch x) {{title}}");
    expect(cases.map(c=>c.case)).toEqual(["ordinary-percent","escaped-percent","single-pass","unknown","missing","wrong-type","malformed-key","unterminated","optional","missing-contract","fragment-cycle"]);
    // A1 must run these expected outputs/errors against its renderer. This A0
    // check validates the oracle's integrity, not an unimplemented renderer.
  });
});
