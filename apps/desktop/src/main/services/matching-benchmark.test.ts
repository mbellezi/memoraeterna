import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { appSettingsSchema, appSettingsUpdateSchema, defaultAppSettings } from "../../shared/ipc.js";
import { benchmarkConfiguration } from "./matching-benchmark.js";

describe("larger matching benchmark",()=>{
  it("compares bounded retrieval/context presets without changing acceptance or identity safeguards",()=>{
    const pilot=JSON.parse(readFileSync("docs/matching-pilot-settings.json","utf8"));
    const reference=appSettingsSchema.parse({...defaultAppSettings,...pilot.settings,language:"pt-BR",updatedAt:new Date().toISOString()});
    for(const variant of ["baseline","economy","coverage"] as const){
      const settings=appSettingsUpdateSchema.parse(benchmarkConfiguration(reference,variant));
      expect(settings.atomicNoteRelationThreshold).toBe(0.6);
      expect(settings.sourceRelationSettings?.minImportance).toBe(0.8);
      expect(settings.atomicNoteMatchingSettings?.requireReranking).toBe(true);
      expect(settings.entityIdentitySimilarityThreshold).toBe(reference.entityIdentitySimilarityThreshold);
      expect(settings.atomicNoteMatchingSettings?.minimumGraphOnlyCandidates).toBeLessThanOrEqual(settings.atomicNoteMatchingSettings!.fusedCandidateLimit);
    }
    expect(benchmarkConfiguration(reference,"economy").atomicNoteMatchingSettings!.fusedCandidateLimit).toBeLessThan(reference.atomicNoteMatchingSettings.fusedCandidateLimit);
    expect(benchmarkConfiguration(reference,"coverage").sourceRelationSettings!.maxPairs).toBeGreaterThan(reference.sourceRelationSettings.maxPairs);
  });
  it("keeps 20 unseen roots separate and all assessment labels outside ordinary document fields",()=>{
    const corpus=JSON.parse(readFileSync("scripts/fixtures/matching-benchmark.json","utf8"));
    expect(corpus.sources.filter((s:any)=>s.partition==="tuning")).toHaveLength(40);
    expect(corpus.sources.filter((s:any)=>s.partition==="holdout")).toHaveLength(20);
    const keys=new Set(corpus.sources.map((s:any)=>s.key));
    expect(keys.size).toBe(60);
    const ids=corpus.sources.flatMap((s:any)=>[s.key,...(s.chapters??[]).map((c:any)=>c.key)]);
    expect(new Set(ids).size).toBe(82);
    const pair=(p:string[])=>[...p].sort().join("/");
    const expected=new Set(corpus.expectedRootPairs.map((r:any)=>pair(r.pair)));
    for(const row of [...corpus.expectedRootPairs,...corpus.forbiddenRootPairs]){
      expect(row.pair.every((key:string)=>keys.has(key))).toBe(true);
      expect(row.pair[0]).not.toBe(row.pair[1]);
      const held=row.pair.some((key:string)=>corpus.sources.find((s:any)=>s.key===key).partition==="holdout");
      expect(row.partition).toBe(held?"holdout":"tuning");
    }
    expect(corpus.forbiddenRootPairs.some((r:any)=>expected.has(pair(r.pair)))).toBe(false);
  });
});
