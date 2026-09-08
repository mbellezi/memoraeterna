import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { PgPool } from "../client.js";
import { createMatchingEvaluationRepository } from "./matchingEvaluationRepository.js";
const ids = Array.from({length:20},()=>randomUUID());
function setup(check: {total:number;selected:number;reviewed:number;active:number}) {
  const query=vi.fn(async(text:string)=>text.includes('as reviewed')?{rows:[check],rowCount:1}:{rows:[],rowCount:2});
  const release=vi.fn();const pool={connect:async()=>({query,release})} as unknown as PgPool;
  return {repository:createMatchingEvaluationRepository(pool),query,release};
}
describe("synthetic pilot rematch boundary",()=>{
  it("rejects restoring reviewed or unrelated evidence before any reset",async()=>{
    const {repository,query}=setup({total:20,selected:20,reviewed:0,active:0});
    await expect(repository.resetPilotMatching(ids,20,{noteRelations:[],sourceRelations:[{id:randomUUID(),source_item_id:ids[0],target_source_item_id:ids[1],status:'accepted'}],sourceEvidence:[]})).rejects.toThrow();
    await expect(repository.resetPilotMatching(ids,20,{noteRelations:[],sourceRelations:[],sourceEvidence:[{id:randomUUID(),relation_id:randomUUID(),note_relation_id:null}]})).rejects.toThrow("unrelated relationships");
    expect(query).not.toHaveBeenCalled();
  });
  it("requires the full expanded fixture identity set before resetting a tuning graph",async()=>{
    const expanded=Array.from({length:62},()=>randomUUID());
    const valid=setup({total:62,selected:62,reviewed:0,active:0});
    await expect(valid.repository.resetPilotMatching(expanded,62)).resolves.toEqual({noteRelations:2,sourceRelations:2});
    const contaminated=setup({total:63,selected:62,reviewed:0,active:0});
    await expect(contaminated.repository.resetPilotMatching(expanded,62)).rejects.toThrow("Pilot rematch refuses");
    expect(contaminated.query.mock.calls.some(([sql])=>sql.startsWith('delete'))).toBe(false);
    await expect(valid.repository.resetPilotMatching([...expanded.slice(1),expanded[1]!],62)).rejects.toThrow("Expected exactly");
  });
  it.each([{total:21,selected:20,reviewed:0,active:0},{total:20,selected:19,reviewed:0,active:0},{total:20,selected:20,reviewed:1,active:0},{total:20,selected:20,reviewed:0,active:1}])("refuses unrelated, reviewed or active data: %j",async(check)=>{
    const {repository,query,release}=setup(check);
    await expect(repository.resetPilotMatching(ids)).rejects.toThrow("Pilot rematch refuses");
    expect(query.mock.calls.some(([sql])=>sql.startsWith('delete'))).toBe(false);
    expect(query).toHaveBeenCalledWith('rollback');expect(release).toHaveBeenCalledOnce();
  });
  it("clears only scoped derived matching state under a transaction and preserves source/note/profile data",async()=>{
    const {repository,query,release}=setup({total:20,selected:20,reviewed:0,active:0});
    expect(await repository.resetPilotMatching(ids)).toEqual({noteRelations:2,sourceRelations:2});
    const deletes=query.mock.calls.filter(([sql])=>sql.startsWith('delete')).map(([sql])=>sql);
    expect(deletes).toHaveLength(4);
    expect(deletes.every(sql=>sql.includes('any($1::uuid[])'))).toBe(true);
    expect(deletes.some(sql=>/delete from (source_items|atomic_notes|ai_profile_sets|entities|source_summaries)\b/.test(sql))).toBe(false);
    expect(query).toHaveBeenCalledWith('commit');expect(release).toHaveBeenCalledOnce();
  });
});
