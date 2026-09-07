import { describe, expect, it } from "vitest";

import type { JobRecord } from "../../shared/ipc";
import { collapsePreparationStages, groupJobs, listActivityJobs, type JobCardModel } from "./jobs-view-model";
import { jobRecordSchema } from "../../shared/ipc";

describe("jobs view model", () => {
  it.each(["atomicNoteMatching","sourceMatching"])("keeps %s cards independent after ingestion jobs finish",(stage) => {
    const jobs=["completed","running","waiting_for_batch","failed","canceled"].map((status,index) => jobRecordSchema.parse({
      id:`00000000-0000-4000-8000-00000000000${index}`,type:"ingestion",status:"succeeded",progress:1,
      attempts:1,maxAttempts:3,canCancel:false,canRetry:true,error:null,errorHistory:[],aiExecution:null,
      createdAt:"2026-07-18T20:12:52.308Z",updatedAt:"2026-07-18T20:12:52.560Z",
      ingestionRun:{id:`00000000-0000-4000-8000-00000000001${index}`,status:"succeeded",currentStage:stage,
        effectiveStages:[stage],stagesCheckpoint:{[stage]:{status,progress:0.5,metadata:{completed:index,total:8}}}}
    }));
    const cards=groupJobs(jobs);
    expect(cards.map(card => card.status)).toEqual(["succeeded","running","queued","failed","canceled"]);
    expect(cards[0]?.progress).toBe(1);
    expect(cards[1]!.progress).toBeLessThan(1);
    expect(cards[2]!.progress).toBeLessThan(cards[1]!.progress);
  });
  it("does not repeat the root ingestion job in processing activity", () => {
    const ingestion = { id: "ingestion-job", type: "ingestion" } as JobRecord;
    const summarization = { id: "summary-job", type: "summarization" } as JobRecord;
    const card = {
      mainJob: ingestion,
      jobs: [ingestion, summarization]
    } as JobCardModel;

    expect(listActivityJobs(card)).toEqual([summarization]);
  });

  it("keeps a standalone non-ingestion job in processing activity", () => {
    const download = { id: "download-job", type: "local-model-download" } as JobRecord;
    const card = { mainJob: download, jobs: [download] } as JobCardModel;

    expect(listActivityJobs(card)).toEqual([download]);
  });

  it("collapses the completed import preparation stages into one timeline step", () => {
    expect(collapsePreparationStages([
      "conversion",
      "structureDetection",
      "structureReview",
      "materialization",
      "chunking",
      "summarization"
    ])).toEqual(["preparation", "chunking", "summarization"]);
  });
});
