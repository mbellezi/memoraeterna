import { describe, expect, it } from "vitest";

import type { JobRecord } from "../../shared/ipc";
import { listActivityJobs, type JobCardModel } from "./jobs-view-model";

describe("jobs view model", () => {
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
});
