import { describe, expect, it } from "vitest";

import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import type { JobRecord } from "../../shared/ipc";
import {
  collapsePreparationStages,
  groupJobs,
  jobTypeMessageKey,
  listActivityJobs,
  sourceRelationCoverageNotice,
  type JobCardModel
} from "./jobs-view-model";
import { jobRecordSchema } from "../../shared/ipc";

describe("jobs view model", () => {
  it.each(["queued", "running", "succeeded", "failed", "canceled"] as const)(
    "leaves %s automation dispatchers to the canonical task view",
    (status) => {
      const dispatchers = ["maintenance", "organization"].map(
        (type, index) => ({ id: "dispatcher-" + index, type, status }) as JobRecord
      );
      expect(groupJobs(dispatchers)).toEqual([]);
    }
  );
  it.each(["atomicNoteMatching", "sourceMatching"])(
    "keeps %s cards independent after ingestion jobs finish",
    (stage) => {
      const jobs = ["completed", "running", "waiting_for_batch", "failed", "canceled"].map(
        (status, index) =>
          jobRecordSchema.parse({
            id: `00000000-0000-4000-8000-00000000000${index}`,
            type: "ingestion",
            status: "succeeded",
            progress: 1,
            attempts: 1,
            maxAttempts: 3,
            canCancel: false,
            canRetry: true,
            error: null,
            errorHistory: [],
            aiExecution: null,
            createdAt: "2026-07-18T20:12:52.308Z",
            updatedAt: "2026-07-18T20:12:52.560Z",
            ingestionRun: {
              id: `00000000-0000-4000-8000-00000000001${index}`,
              status: "succeeded",
              currentStage: stage,
              effectiveStages: [stage],
              stagesCheckpoint: {
                [stage]: { status, progress: 0.5, metadata: { completed: index, total: 8 } }
              }
            }
          })
      );
      const cards = groupJobs(jobs);
      expect(cards.map((card) => card.status)).toEqual([
        "succeeded",
        "running",
        "queued",
        "failed",
        "canceled"
      ]);
      expect(cards[0]?.progress).toBe(1);
      expect(cards[1]!.progress).toBeLessThan(1);
      expect(cards[2]!.progress).toBeLessThan(cards[1]!.progress);
    }
  );
  it("shows a run whose source stage waits for its link job as running (F3 D24)", () => {
    const [card] = groupJobs([
      jobRecordSchema.parse({
        id: "00000000-0000-4000-8000-000000000101",
        type: "ingestion",
        status: "succeeded",
        progress: 1,
        attempts: 1,
        maxAttempts: 3,
        canCancel: false,
        canRetry: false,
        error: null,
        errorHistory: [],
        aiExecution: null,
        createdAt: "2026-10-17T20:12:52.308Z",
        updatedAt: "2026-10-17T20:12:52.560Z",
        ingestionRun: {
          id: "00000000-0000-4000-8000-000000000102",
          status: "running",
          currentStage: "sourceMatching",
          effectiveStages: ["atomicNoteMatching", "sourceMatching"],
          stagesCheckpoint: {
            atomicNoteMatching: { status: "completed" },
            sourceMatching: { status: "linking", metadata: { rootId: "root" } }
          }
        }
      })
    ]);
    expect(card).toMatchObject({ status: "running", currentStage: "sourceMatching" });
    expect(card!.progress).toBeLessThan(1);
  });
  describe("a run stored with the retired organization stage (F2 D14)", () => {
    const storedRun = (
      currentStage: string,
      organizeKnowledge: Record<string, unknown>,
      sourceMatching: Record<string, unknown> = { status: "completed" }
    ) =>
      jobRecordSchema.parse({
        id: "00000000-0000-4000-8000-000000000001",
        type: "ingestion",
        status: "succeeded",
        progress: 1,
        attempts: 1,
        maxAttempts: 3,
        canCancel: false,
        canRetry: false,
        error: null,
        errorHistory: [],
        aiExecution: null,
        createdAt: "2026-09-09T18:00:00Z",
        updatedAt: "2026-09-09T18:00:00Z",
        ingestionRun: {
          id: "00000000-0000-4000-8000-000000000002",
          status: "succeeded",
          currentStage,
          effectiveStages: ["chunking", "sourceMatching", "organizeKnowledge"],
          stagesCheckpoint: { chunking: { status: "completed" }, sourceMatching, organizeKnowledge }
        }
      });

    it.each([
      { status: "failed", error: "organization.errors.context" },
      { status: "waiting_for_batch" },
      { status: "running", progress: 0.5 },
      { status: "pending" }
    ])("reads its $status checkpoint as skipped (retired), never as the card's state", (state) => {
      for (const currentStage of ["completed", "organizeKnowledge"])
        expect(groupJobs([storedRun(currentStage, state)])[0]).toMatchObject({
          status: "succeeded",
          currentStage: "completed",
          stageError: null
        });
      // A finished matching stage completes the card even though the retired stage never ran.
      expect(groupJobs([storedRun("sourceMatching", state)])[0]).toMatchObject({
        status: "succeeded",
        progress: 1,
        currentStage: "sourceMatching"
      });
    });

    it("still shows a pending matching stage of the same run", () => {
      expect(
        groupJobs([
          storedRun("completed", { status: "waiting_for_batch" }, { status: "waiting_for_batch" })
        ])[0]
      ).toMatchObject({ status: "queued", currentStage: "sourceMatching" });
    });
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

  describe("source relation coverage notice", () => {
    const coverage = { judgedPairs: 1, candidatePairs: 2, budgetExhausted: false, promoted: 3 };
    const checkpoint = (
      overrides: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) => ({
      status: "completed",
      metadata: { coverage: { ...coverage, ...overrides }, ...extra }
    });

    it("reads promotion and the nearest sources judged as a neutral line (design E)", () => {
      expect(sourceRelationCoverageNotice(checkpoint({}))).toEqual({
        tone: "neutral",
        messageKey: "sourceRelations.coverage.linked",
        values: { promoted: 3, judged: 1, candidates: 2 }
      });
    });

    it("warns only for an exhausted input budget", () => {
      expect(sourceRelationCoverageNotice(checkpoint({ budgetExhausted: true }))).toEqual({
        tone: "warning",
        messageKey: "sourceRelations.coverage.incomplete",
        values: { promoted: 3, judged: 1, candidates: 2 }
      });
    });

    it("reads a checkpoint written by the shortlist, ignoring its cap flags", () => {
      expect(
        sourceRelationCoverageNotice({
          status: "completed",
          metadata: {
            coverage: {
              judgedPairs: 6,
              candidatePairs: 18,
              capReached: true,
              relationLimitReached: false,
              budgetExhausted: false
            }
          }
        })
      ).toEqual({
        tone: "neutral",
        messageKey: "sourceRelations.coverage.linked",
        values: { promoted: 0, judged: 6, candidates: 18 }
      });
    });

    it("reads the coverage of a run its link job completed, under the discovery summary", () => {
      expect(
        sourceRelationCoverageNotice({
          status: "completed",
          metadata: { linkJobId: "job", typed: 2, discovery: { status: "completed", coverage } }
        })
      ).toEqual({
        tone: "neutral",
        messageKey: "sourceRelations.coverage.linked",
        values: { promoted: 3, judged: 1, candidates: 2 }
      });
      expect(
        sourceRelationCoverageNotice({
          status: "completed",
          metadata: { discovery: { status: "deferred", reason: "daily_cap" } }
        })
      ).toBeNull();
    });

    it("shows nothing when the source linked and judged nothing", () => {
      expect(
        sourceRelationCoverageNotice(checkpoint({ promoted: 0, candidatePairs: 0, judgedPairs: 0 }))
      ).toBeNull();
    });

    it.each([
      undefined,
      null,
      "completed",
      {},
      { status: "completed" },
      { status: "completed", metadata: null },
      { status: "completed", metadata: { partial: true } },
      { status: "completed", metadata: { coverage: { capReached: true } } },
      { status: "completed", metadata: { coverage: { ...coverage, judgedPairs: -1 } } },
      { status: "completed", metadata: { coverage: { ...coverage, promoted: -1 } } }
    ])("shows nothing for a checkpoint without valid coverage: %j", (value) => {
      expect(sourceRelationCoverageNotice(value)).toBeNull();
    });

    it("has a message in every locale for each notice, with its counts filled in", () => {
      for (const locale of supportedLanguageCodes) {
        const translate = createTranslator(locale);
        const linked = translate("sourceRelations.coverage.linked", {
          values: { promoted: 7, judged: 1, candidates: 2 },
          missingKeyBehavior: "throw"
        });
        for (const count of ["7", "1", "2"]) expect(linked).toContain(count);
        const incomplete = translate("sourceRelations.coverage.incomplete", {
          values: { promoted: 7, judged: 1, candidates: 2 },
          missingKeyBehavior: "throw"
        });
        for (const count of ["1", "2"]) expect(incomplete).toContain(count);
        for (const text of [linked, incomplete]) expect(text).not.toContain("{");
      }
    });
  });

  it("collapses the completed import preparation stages into one timeline step", () => {
    expect(
      collapsePreparationStages([
        "conversion",
        "structureDetection",
        "structureReview",
        "materialization",
        "chunking",
        "summarization"
      ])
    ).toEqual(["preparation", "chunking", "summarization"]);
  });
});

describe("the jobs view's label of a relation job", () => {
  it.each(["relation-link", "relation-retype", "relation-promote", "relation-composite"])(
    "names %s in every locale, apart from the ingestion default",
    (type) => {
      const key = jobTypeMessageKey(type);
      expect(key).not.toBe(jobTypeMessageKey("ingestion"));
      for (const locale of supportedLanguageCodes)
        expect(
          createTranslator(locale)(key, { missingKeyBehavior: "throw" }).trim().length,
          `${type} in ${locale}`
        ).toBeGreaterThan(0);
    }
  );

  it("words the composite backfill by what it does for the user, not by its vectors", () => {
    expect(jobTypeMessageKey("relation-composite")).toBe("jobs.relations.composite");
    expect(
      createTranslator("en")("jobs.relations.composite", { missingKeyBehavior: "throw" })
    ).not.toMatch(/vector/i);
  });
});
