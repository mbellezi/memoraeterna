import { describe, expect, it } from "vitest";
import { runIndividualStageBatch } from "./individual-stage-batch.js";

describe("individual source stages", () => {
  it("waits independently, then completes each source before starting the next", async () => {
    const events: string[] = [];
    const states = new Map<string,string>();
    const results = new Map<string,number>();
    await runIndividualStageBatch({
      runs:[{id:"A",total:2},{id:"B",total:5}],signal:new AbortController().signal,
      wait:async(run) => {states.set(run.id,"waiting");events.push(`wait:${run.id}`);},
      start:async(run) => {states.set(run.id,"running");events.push(`start:${run.id}`);},
      process:async(run) => {
        if (run.id === "A") expect(states.get("B")).toBe("waiting");
        else expect(states.get("A")).toBe("completed");
        return run.total;
      },
      complete:async(run,total) => {states.set(run.id,"completed");results.set(run.id,total);events.push(`done:${run.id}`);},
      fail:async() => {throw new Error("Unexpected failure");}
    });
    expect(events).toEqual(["wait:A","wait:B","start:A","done:A","start:B","done:B"]);
    expect([...results]).toEqual([["A",2],["B",5]]);
  });
  it("isolates failures and continues independent sources", async () => {
    const states = new Map<string,string>();
    const failures = await runIndividualStageBatch({
      runs:[{id:"A"},{id:"B"}],signal:new AbortController().signal,
      wait:async(run) => states.set(run.id,"waiting"),start:async(run) => states.set(run.id,"running"),
      process:async(run) => {if(run.id === "A") throw new Error("A failed");return run.id;},
      complete:async(run) => states.set(run.id,"completed"),fail:async(run) => states.set(run.id,"failed")
    });
    expect([...failures.keys()]).toEqual(["A"]);
    expect([...states]).toEqual([["A","failed"],["B","completed"]]);
  });
  it("cancels only active work and leaves pending sources waiting", async () => {
    const controller=new AbortController(), states=new Map<string,string>();
    await expect(runIndividualStageBatch({runs:[{id:"A"},{id:"B"}],signal:controller.signal,
      wait:async(run) => states.set(run.id,"waiting"),start:async(run) => states.set(run.id,"running"),
      process:async() => {controller.abort(new Error("canceled"));controller.signal.throwIfAborted();},
      complete:async(run) => states.set(run.id,"completed"),fail:async(run) => states.set(run.id,"canceled")
    })).rejects.toThrow("canceled");
    expect([...states]).toEqual([["A","canceled"],["B","waiting"]]);
  });
});
