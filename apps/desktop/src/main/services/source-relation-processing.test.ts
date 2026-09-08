import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { createHash } from "node:crypto";
import { defaultSourceRelationSettings } from "@app/domain";
import type { SourceRelationChunk, SourceRelationNote, PgPool } from "@app/db";
import { matchSources, parseSourceRelations, rankSourceCandidates, sourceRelationPrompt, type SourceRelationContext } from "./source-relation-processing.js";

const mocks = vi.hoisted(() => ({ repository: {} as Record<string,Mock<(...args: any[]) => any>>, selection: vi.fn() }));
vi.mock("@app/db",() => ({ createSourceRelationRepository:() => mocks.repository,createAiConfigRepository:() => ({getDefaultTask:mocks.selection}) }));
const a: SourceRelationChunk = {id:"a",sourceItemId:"A",documentId:"ad",sourceSpanId:null,content:"Retrieval strengthens durable learning.",contentHash:"ah",title:"A",summary:"Retrieval mechanisms",rootId:"root-A"};
const b: SourceRelationChunk = {...a,id:"b",sourceItemId:"B",documentId:"bd",contentHash:"bh",title:"B",rootId:"root-B"};
const note: SourceRelationNote = {id:"note-relation",type:"supports",sourceNoteId:"an",targetNoteId:"bn",sourceChunkId:"a",targetChunkId:"b",sourceItemId:"A",targetSourceItemId:"B",sourceIdea:a.content,targetIdea:b.content,fingerprint:"n1"};
const context: SourceRelationContext = {chunks:[a,b],notes:[note],existing:[]};
const proposal = () => ({source:"s1",target:"s2",type:"supports",sourceIdea:a.content,targetIdea:b.content,explanation:"The explanation connects mechanisms of retention.",
  importance:0.9,confidence:0.9,durable:true,grounded:true,sourceEvidence:["c1"],targetEvidence:["c2"],noteRelations:[],discovery:"source_analysis",existing:null});
const parse = (relations: unknown[], ctx = context) => parseSourceRelations({relations},ctx,defaultSourceRelationSettings,4);

describe("source relation semantics",() => {
  it("resolves textual aliases to stable source-reference tags in semantic endpoint order",() => {
    const result=parse([{...proposal(),source:"s2",target:"s1",sourceEvidence:["c2"],targetEvidence:["c1"],
      sourceIdea:"s2 gives evidence.",explanation:"s2 supports s1; s1 remains qualified."}]);
    expect(result.relations[0]).toMatchObject({sourceItemId:"B",targetSourceItemId:"A",
      sourceIdea:'<source-ref id="B" /> gives evidence.',
      explanation:'<source-ref id="B" /> supports <source-ref id="A" />; <source-ref id="A" /> remains qualified.'});
    expect(() => parse([{...proposal(),explanation:"s30 supports s1."}])).toThrow();
    expect(() => parse([{...proposal(),explanation:'<source-ref id="unknown" /> supports s1.'}])).toThrow();
  });
  it("allows zero output and rejects event-only, ungrounded, weak and low-importance proposals",() => {
    expect(parse([]).relations).toEqual([]);
    for (const fields of [{durable:false},{grounded:false},{importance:0.1},{confidence:0.1},{type:"related"},{type:"mentions"}]) {
      expect(parse([{...proposal(),...fields}]).relations).toEqual([]);
    }
  });
  it("retains distinct ideas and types between the same sources",() => {
    const result = parse([proposal(),{...proposal(),sourceIdea:"Feedback corrects retrieval errors."},{...proposal(),type:"extends"}]);
    expect(result.relations).toHaveLength(3);
  });
  it("consolidates the same connection from both routes without boosting confidence",() => {
    const result = parse([proposal(),{...proposal(),discovery:"atomic_notes",noteRelations:["n1"]}]);
    expect(result.relations).toHaveLength(1);expect(result.relations[0]?.evidence).toHaveLength(2);
    expect(result.relations[0]?.confidence).toBe(0.9);
  });
  it("requires evidence from the correct owners and known aliases on both sides",() => {
    for (const fields of [{sourceEvidence:["c2"]},{targetEvidence:["unknown"]},{source:"unknown"},{source:"s2",target:"s2"},
      {discovery:"atomic_notes"},{discovery:"atomic_notes",noteRelations:["n9"]},{noteRelations:["n1"]}]) {
      expect(() => parse([{...proposal(),...fields}])).toThrow();
    }
    expect(() => parse([proposal()],{...context,chunks:[a,{...b,rootId:a.rootId}]})).toThrow();
  });
  it("does not reverse directional note relationships or change their type",() => {
    expect(() => parse([{...proposal(),discovery:"atomic_notes",noteRelations:["n1"],type:"extends"}])).toThrow();
    expect(() => parse([{...proposal(),discovery:"atomic_notes",noteRelations:["n1"],source:"s2",target:"s1",sourceEvidence:["c2"],targetEvidence:["c1"]}])).toThrow();
  });
  it("preserves reviewed propositions and never resurrects rejected matches",() => {
    const existing = {id:"existing",sourceItemId:"A",targetSourceItemId:"B",relationType:"supports",sourceIdea:"Reviewed idea",targetIdea:b.content,status:"accepted"};
    const result = parse([{...proposal(),existing:"r1"}],{...context,existing:[existing]});
    expect(result).toEqual({proposals:0,relations:[]});
    expect(parse([{...proposal(),existing:"r1"}],{...context,existing:[{...existing,status:"rejected"}]}).relations).toEqual([]);
    expect(() => parse([{...proposal(),existing:"r2"}],{...context,existing:[existing]})).toThrow();
  });
  it("excludes exact saved connections without an alias but keeps new ideas between the same sources",() => {
    for (const status of ["pending_review","accepted","rejected"]) {
      const existing = {id:"existing",sourceItemId:"A",targetSourceItemId:"B",relationType:"supports",sourceIdea:a.content,targetIdea:b.content,status};
      const ctx = {...context,existing:[existing]};
      const result = parse([proposal(),{...proposal(),sourceIdea:"A different mechanism."}],ctx);
      expect(result.proposals).toBe(1);
      expect(result.relations).toHaveLength(1);
      expect(result.relations[0]?.sourceIdea).toBe("A different mechanism.");
      expect(sourceRelationPrompt(ctx,4,false)).toContain("EXCLUSION LIST, never candidates for ranking or enrichment");
    }
  });
  it("enforces the remaining global allowance before persistence",() => {
    expect(() => parseSourceRelations({relations:[proposal(),proposal()]},context,defaultSourceRelationSettings,1)).toThrow();
  });
  it("keeps note reuse and direct discovery in every shortlist prefix",() => {
    const candidates = Array.from({length:40},(_,i) => ({id:String(i),textScore:1-i/50,vectorScore:0.8,graphScore:0,noteScore:i<20 ? 1 : 0}));
    const selected = rankSourceCandidates(candidates,40).slice(0,8);
    expect(selected.filter((candidate) => candidate.noteScore > 0)).toHaveLength(4);
    expect(selected.filter((candidate) => candidate.noteScore === 0)).toHaveLength(4);
  });
  it("uses compact aliases and explicitly treats summaries and old note links as hypotheses",() => {
    const prompt = sourceRelationPrompt(context,4,false);
    expect(prompt).toContain("Summaries are navigation aids, NEVER evidence");
    expect(prompt).toContain("hypotheses, NOT proof");expect(prompt).toContain("Return ZERO to 4");
    expect(prompt).not.toContain("note-relation");expect(prompt).toContain("beyond a specific event");
  });
  it("exposes shared roots while retaining chapter endpoints and rejecting same-work relations",() => {
    const sibling = {...a,id:"c",sourceItemId:"C",title:"Another chapter"};
    const ctx = {...context,chunks:[a,b,sibling]};
    const prompt = sourceRelationPrompt(ctx,4,false);
    expect(prompt).toContain('"key":"s1","root":"w1"');
    expect(prompt).toContain('"key":"s2","root":"w2"');
    expect(prompt).toContain('"key":"s3","root":"w1"');
    expect(prompt).toContain("DIFFERENT roots");
    expect(() => parse([{...proposal(),target:"s3",targetEvidence:["c3"]}],ctx)).toThrow("source_relation_same_root");
    expect(parse([proposal()],ctx).relations).toHaveLength(1);
  });
});

describe("source matching budget and recovery",() => {
  let states: Map<string,unknown>, decisions: Map<string,Record<string,unknown>>;
  beforeEach(() => {
    states = new Map();decisions = new Map();
    mocks.selection.mockReset().mockResolvedValue({profileId:"profile",providerConfigId:"provider",modelId:"model",runtime:"local",localModelId:null,revision:"r1",parameters:{},modelDefaultParameters:{}});
    mocks.repository = {
      roots:vi.fn().mockResolvedValue(["root-A"]),fingerprint:vi.fn(async(id:string) => id),
      candidates:vi.fn().mockResolvedValue([{id:"root-B",textScore:1,vectorScore:0,graphScore:0,noteScore:1}]),
      pairNotes:vi.fn().mockResolvedValue([note]),pairChunks:vi.fn().mockResolvedValue([a,b]),existing:vi.fn().mockResolvedValue([]),
      runState:vi.fn(async(key:string) => structuredClone(states.get(key) ?? null)),
      saveRun:vi.fn(async(key:string,_root:string,state:unknown) => {states.set(key,structuredClone(state));}),
      decision:vi.fn(async(key:string) => decisions.get(key) ?? null),
      commitDecision:vi.fn(async(key:string,_a:string,_b:string,relations:unknown[],metadata:Record<string,unknown>) => {
        decisions.set(key,{...metadata,persistedCount:relations.length});return relations.length;
      })
    };
  });
  const run = (ai: Mock<(...args: any[]) => any>, key="run", settings={...defaultSourceRelationSettings,maxInputTokens:200000}) => matchSources({pool:{} as PgPool,ai:{runDefaultTask:ai},sourceIds:["A"],runKey:key,settings,contentLanguage:"en"});
  const execution = (output:unknown) => ({output,profileId:"profile",modelId:"model",providerId:"provider",runtime:"local",aiTaskRunId:"execution",inputTokens:100,outputTokens:20});
  it("reports planned and completed pair counts, counting a repair only once",async() => {
    const onProgress=vi.fn();
    const ai=vi.fn().mockResolvedValueOnce(execution("invalid")).mockResolvedValue(execution({relations:[]}));
    const result=await matchSources({pool:{} as PgPool,ai:{runDefaultTask:ai},sourceIds:["A"],runKey:"progress",
      settings:{...defaultSourceRelationSettings,maxInputTokens:200000},contentLanguage:"en",onProgress});
    expect(onProgress.mock.calls[0]).toEqual([0,{completed:0,total:1}]);
    expect(onProgress.mock.calls.at(-1)).toEqual([1,{completed:1,total:1}]);
    expect(result).toMatchObject({completed:1,total:1});
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("keeps partial counts across resume instead of inventing completed analyses",async() => {
    mocks.repository.candidates!.mockResolvedValue(["one","two"].map(id => ({id,textScore:1,vectorScore:0,graphScore:0,noteScore:0})));
    const ai=vi.fn().mockResolvedValue({...execution({relations:[]}),inputTokens:2500});
    const settings={...defaultSourceRelationSettings,maxInputTokens:2000};
    expect(await run(ai,"partial",settings)).toMatchObject({completed:1,total:2,partial:true});
    expect(await run(ai,"partial",settings)).toMatchObject({completed:1,total:2,partial:true});
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("counts a reciprocal pair only once across a collective batch",async() => {
    mocks.repository.roots!.mockResolvedValue(["root-A","root-B"]);
    mocks.repository.candidates!.mockImplementation(async(root:string) => [{id:root === "root-A" ? "root-B" : "root-A",textScore:1,vectorScore:0,graphScore:0,noteScore:1}]);
    const ai=vi.fn().mockResolvedValue(execution({relations:[]}));
    expect(await run(ai)).toMatchObject({completed:1,total:1,rootCount:2});
    expect(ai).toHaveBeenCalledTimes(1);
    expect(await run(ai)).toMatchObject({completed:1,total:1});
  });
  it("caches negative decisions across executions without more model calls",async() => {
    const ai=vi.fn().mockResolvedValue(execution({relations:[]}));
    await run(ai);expect(await run(ai,"second")).toMatchObject({completed:0,total:0});expect(ai).toHaveBeenCalledTimes(1);
  });
  it("counts actual usage from the original call and its repair",async() => {
    const ai=vi.fn().mockImplementationOnce(async() => {
      expect((states.get("run:root-A") as {inputTokens:number}).inputTokens).toBe(0);
      return execution("invalid");
    }).mockResolvedValue(execution({relations:[proposal()]}));
    const result=await run(ai);expect(ai).toHaveBeenCalledTimes(2);expect(result.persistedCount).toBe(1);
    expect(result.inputTokens).toBe(200);
    expect(ai.mock.calls[0]?.[4]).toEqual({maxOutputTokens:3300});
  });
  it.each([0,100,15000])("records actual input usage %s",async(inputTokens) => {
    const ai=vi.fn().mockResolvedValue({...execution({relations:[]}),inputTokens});
    expect((await run(ai)).inputTokens).toBe(inputTokens);
    expect(states.get("run:root-A")).toMatchObject({inputTokens});
  });
  it.each([undefined,null,NaN,-1,1.5,Infinity])("does not estimate unavailable or invalid usage: %s",async(inputTokens) => {
    const ai=vi.fn().mockResolvedValue({...execution({relations:[]}),inputTokens});
    expect((await run(ai)).inputTokens).toBe(0);
  });
  it("does not invent consumption for an interrupted call without usage",async() => {
    const ai=vi.fn().mockRejectedValue(new Error("interrupted"));
    await expect(run(ai)).rejects.toThrow("interrupted");
    expect((states.get("run:root-A") as {inputTokens:number}).inputTokens).toBe(0);
  });
  it("finishes all six affordable analyses without estimating usage",async() => {
    mocks.repository.candidates!.mockResolvedValue(Array.from({length:6},(_,index) => ({id:`candidate-${index}`,textScore:1,vectorScore:0,graphScore:0,noteScore:0})));
    const ai=vi.fn().mockResolvedValue(execution({relations:[]}));
    expect(await run(ai,"six",{...defaultSourceRelationSettings,maxInputTokens:20000})).toMatchObject({completed:6,total:6,inputTokens:600,partial:false});
    expect(ai).toHaveBeenCalledTimes(6);
  });
  it("allows a call at the exact limit and blocks the next after actual overrun",async() => {
    mocks.repository.candidates!.mockResolvedValue(["one","two","three"].map(id => ({id,textScore:1,vectorScore:0,graphScore:0,noteScore:0})));
    const ai=vi.fn().mockResolvedValue({...execution({relations:[]}),inputTokens:2000});
    expect(await run(ai,"limit",{...defaultSourceRelationSettings,maxInputTokens:2000})).toMatchObject({completed:2,total:3,inputTokens:4000,partial:true});
    expect(ai).toHaveBeenCalledTimes(2);
  });
  it("blocks a repair after the original response exceeds the real budget",async() => {
    const ai=vi.fn().mockResolvedValue({...execution("invalid"),inputTokens:2500});
    expect(await run(ai,"repair",{...defaultSourceRelationSettings,maxInputTokens:2000})).toMatchObject({completed:0,total:1,inputTokens:2500,partial:true});
    expect(ai).toHaveBeenCalledTimes(1);
  });
  it("recovers a committed decision before a checkpoint write without exceeding the proposal cap",async() => {
    const ai=vi.fn().mockResolvedValue(execution({relations:[proposal()]}));
    const original=mocks.repository.saveRun!;
    mocks.repository.saveRun=vi.fn(async(key:string,root:string,state:{completed:string[]}) => {
      if(state.completed.length) throw new Error("checkpoint interrupted");
      return original(key,root,state);
    });
    await expect(run(ai)).rejects.toThrow("checkpoint interrupted");
    mocks.repository.saveRun=original;
    const result=await run(ai);expect(ai).toHaveBeenCalledTimes(1);expect(result.persistedCount).toBe(1);
    expect(result).toMatchObject({completed:1,total:1});
    expect((states.get("run:root-A") as {proposals:number}).proposals).toBe(1);
  });
  it("does not silently degrade to generic links after invalid output",async() => {
    const ai=vi.fn().mockResolvedValue(execution("invalid"));
    await expect(run(ai)).rejects.toThrow("errors.sourceRelations.invalidOutput");
    expect(ai).toHaveBeenCalledTimes(2);expect(mocks.repository.commitDecision).not.toHaveBeenCalled();
  });
  it("explains same-root rejection in the bounded repair and accepts a negative decision",async() => {
    mocks.repository.pairChunks!.mockResolvedValue([a,b,{...a,id:"c",sourceItemId:"C"}]);
    const ai=vi.fn().mockResolvedValueOnce(execution({relations:[{...proposal(),target:"s3",targetEvidence:["c3"]}]}))
      .mockResolvedValueOnce(execution({relations:[]}));
    const result = await run(ai);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1]?.[1]).toContain("Rejected: source and target belong to the SAME root/work");
    expect(result.persistedCount).toBe(0);
    expect(mocks.repository.commitDecision!.mock.calls[0]?.[3]).toEqual([]);
  });
  it("excludes the current root before ranking, evidence retrieval and model execution",async() => {
    mocks.repository.candidates!.mockResolvedValue([{id:"root-A",textScore:1,vectorScore:1,graphScore:1,noteScore:1}]);
    const ai=vi.fn();
    await run(ai);
    expect(mocks.repository.pairNotes).not.toHaveBeenCalled();
    expect(mocks.repository.pairChunks).not.toHaveBeenCalled();
    expect(ai).not.toHaveBeenCalled();
  });
  it("upgrades v1 failed checkpoints without losing spent budgets or completed decisions",async() => {
    const settings={...defaultSourceRelationSettings,maxInputTokens:200000};
    const configuration=createHash("sha256").update(JSON.stringify({version:"source-relations-v1",language:"en",settings,
      profile:"profile",provider:"provider",model:"model",runtime:"local",localModel:null,revision:"r1",parameters:{},defaults:{}})).digest("hex");
    states.set("run:root-A",{settings,configuration,pairs:["done","failed"],completed:["done"],attempts:{done:1,failed:2},
      inputTokens:10000,proposals:1,persistedCount:1,partial:false,finished:false});
    const ai=vi.fn().mockResolvedValue(execution({relations:[]}));
    const result=await run(ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(result.inputTokens).toBeGreaterThan(10000);
    expect(result.persistedCount).toBe(1);
    expect(states.get("run:root-A")).toMatchObject({completed:["done",expect.any(String)],proposals:1,attempts:{failed:2}});
  });
});

it("forbids lexical disambiguation and proper-name reinterpretation as conceptual clarification", () => {
  const prompt = sourceRelationPrompt(context,4,false);
  expect(prompt).toContain("Merely distinguishing homonyms or unrelated senses");
  expect(prompt).toContain("must never be reinterpreted as an abstract definition");
});
