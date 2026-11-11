import { describe, expect, it } from "vitest";

import type { AppEventOf } from "../../shared/app-events";
import type { FileImportProgress } from "../../shared/ipc";
import { progressOfImportEvent } from "./ImportView";

const runId = "00000000-0000-4000-8000-0000000000c1";
const started: FileImportProgress = { requestId: runId, stage: "selecting_file", progress: 0.01 };
const event = (
  overrides: Partial<AppEventOf<"import.progress">> = {}
): AppEventOf<"import.progress"> => ({
  type: "import.progress",
  runId,
  fileIndex: 0,
  fraction: 0.4,
  ...overrides
});

describe("the import card follows import.progress on the bus", () => {
  it("takes the stage, the fraction and the page counts of the event", () => {
    expect(
      progressOfImportEvent(
        started,
        event({ stage: "processing_pages", completedPages: 3, totalPages: 10 })
      )
    ).toEqual({
      requestId: runId,
      stage: "processing_pages",
      progress: 0.4,
      completedPages: 3,
      totalPages: 10
    });
  });

  it("keeps the stage already shown when the event names none", () => {
    expect(progressOfImportEvent({ ...started, stage: "converting_document" }, event())).toEqual({
      requestId: runId,
      stage: "converting_document",
      progress: 0.4
    });
  });

  it("shows nothing before the import started or after it ended", () => {
    expect(progressOfImportEvent(null, event())).toBeNull();
  });
});
