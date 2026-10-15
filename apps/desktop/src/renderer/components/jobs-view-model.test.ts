import { describe, expect, it } from "vitest";

import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import type { JobRecord } from "../../shared/ipc";
import {
  collapsePreparationStages,
  groupJobs,
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
    const coverage = {
      judgedPairs: 6,
      candidatePairs: 18,
      capReached: false,
      relationLimitReached: false,
      budgetExhausted: false
    };
    const checkpoint = (
      overrides: Record<string, unknown>,
      extra: Record<string, unknown> = {}
    ) => ({
      status: "completed",
      metadata: { coverage: { ...coverage, ...overrides }, ...extra }
    });

    it("reads the pair cap as a neutral count of analysed candidates", () => {
      expect(sourceRelationCoverageNotice(checkpoint({ capReached: true }))).toEqual({
        tone: "neutral",
        messageKey: "sourceRelations.coverage.analysed",
        values: { judged: 6, candidates: 18 }
      });
    });

    it("reads the relation limit as neutral", () => {
      expect(sourceRelationCoverageNotice(checkpoint({ relationLimitReached: true }))).toEqual({
        tone: "neutral",
        messageKey: "sourceRelations.coverage.relationLimit",
        values: { judged: 6, candidates: 18 }
      });
    });

    it("warns only for an exhausted input budget, whatever else was reached", () => {
      expect(
        sourceRelationCoverageNotice(
          checkpoint({ budgetExhausted: true, capReached: true, relationLimitReached: true })
        )
      ).toEqual({
        tone: "warning",
        messageKey: "sourceRelations.coverage.incomplete",
        values: { judged: 6, candidates: 18 }
      });
    });

    it("shows nothing when every candidate was judged", () => {
      expect(sourceRelationCoverageNotice(checkpoint({ judgedPairs: 18 }))).toBeNull();
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
      { status: "completed", metadata: { coverage: { ...coverage, extra: true } } }
    ])("shows nothing for a checkpoint without valid coverage: %j", (value) => {
      expect(sourceRelationCoverageNotice(value)).toBeNull();
    });

    it("has a message in every locale for each notice, with both counts filled in", () => {
      const keys = [
        "sourceRelations.coverage.analysed",
        "sourceRelations.coverage.relationLimit",
        "sourceRelations.coverage.incomplete"
      ] as const;
      for (const locale of supportedLanguageCodes)
        for (const key of keys) {
          const text = createTranslator(locale)(key, {
            values: { judged: 6, candidates: 18 },
            missingKeyBehavior: "throw"
          });
          expect(text).toContain("6");
          expect(text).toContain("18");
          expect(text).not.toContain("{");
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
