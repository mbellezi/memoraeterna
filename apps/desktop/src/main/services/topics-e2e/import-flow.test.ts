import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { processingPresetStages, resolveProcessingPlan } from "@app/domain";
import { describe, expect, it } from "vitest";

import { ipcChannels } from "../../../shared/ipc.js";
import { goldenManifestSchema } from "../golden-runner.js";
import { candidateOf, importPaper, paperFromManifest } from "./import-flow.js";
import type { PaperSource } from "./import-flow.js";

const repositoryRoot = resolve(import.meta.dirname, "../../../../../..");
const manifest = goldenManifestSchema.parse(
  JSON.parse(readFileSync(resolve(repositoryRoot, "scripts/golden/manifest.json"), "utf8"))
);

describe("the paper of the test", () => {
  it("is the PLOS paper of the golden manifest, with the descriptor the user would have filled in", () => {
    const paper = paperFromManifest(manifest, "plos-one-murre-dros-2015", "/repo");
    expect(paper.path).toBe("/repo/.cache/golden/sources/plos-one-murre-dros-2015.pdf");
    expect(paper.descriptor).toMatchObject({
      type: "AcademicPaper",
      title: "Replication and Analysis of Ebbinghaus' Forgetting Curve",
      language: "en",
      doi: "10.1371/journal.pone.0120644"
    });
  });

  it("refuses a key that is not in the manifest or not a file", () => {
    expect(() => paperFromManifest(manifest, "nope", "/repo")).toThrow(/no source nope/);
    expect(() => paperFromManifest(manifest, "wikipedia-en-forgetting-curve", "/repo")).toThrow(
      /not a file/
    );
  });
});

interface Call {
  channel: string;
  payload: unknown;
}

function fakeIpc(answers: Record<string, unknown>) {
  const calls: Call[] = [];
  return {
    calls,
    ipc: {
      invoke: async (channel: string, payload?: unknown) => {
        calls.push({ channel, payload });
        return answers[channel] as never;
      }
    }
  };
}

const paper: PaperSource = {
  ...paperFromManifest(manifest, "plos-one-murre-dros-2015", "/repo")
};
const division = {
  id: "11111111-1111-4111-8111-111111111111",
  parentId: null,
  kind: "section",
  title: "Introduction",
  level: 1,
  position: 1,
  startSelector: { type: "heading", text: "Introduction" },
  endSelector: { type: "end" },
  startPage: 1,
  confidence: 0.9,
  evidence: [],
  reviewStatus: "proposed",
  isProcessable: true,
  metadata: {},
  childSourceItemId: null,
  childDocumentId: null
};

describe("importing the paper through the Import handlers", () => {
  it("picks the file, imports it with the default plan, reviews the structure as detected and confirms it", async () => {
    const chosen: Array<string | null> = [];
    const { ipc, calls } = fakeIpc({
      [ipcChannels.ingestionImportFile]: {
        sourceItemId: "s1",
        documentId: "d1",
        ingestionRunId: null,
        jobId: null,
        batchId: null,
        structureId: "22222222-2222-4222-8222-222222222222",
        requiresStructureReview: true,
        duplicate: false
      },
      [ipcChannels.ingestionStructureGet]: {
        id: "22222222-2222-4222-8222-222222222222",
        divisions: [division]
      },
      [ipcChannels.ingestionStructureConfirm]: { batchId: "b1", queued: [] }
    });
    const outcome = await importPaper(ipc, (path) => chosen.push(path), paper);
    expect(outcome).toEqual({
      sourceItemId: "s1",
      batchId: "b1",
      structureConfirmed: true,
      divisions: 1
    });
    expect(chosen).toEqual([paper.path]);
    expect(calls.map((call) => call.channel)).toEqual([
      ipcChannels.ingestionImportFile,
      ipcChannels.ingestionStructureGet,
      ipcChannels.ingestionStructureConfirm
    ]);
    // The import sends no plan of its own: the contract's default (full knowledge) applies.
    expect(calls[0]!.payload).toEqual({ descriptor: paper.descriptor, duplicatePolicy: "ignore" });
    const confirm = calls[2]!.payload as {
      structureId: string;
      divisions: Array<Record<string, unknown>>;
      plan: Parameters<typeof resolveProcessingPlan>[0];
    };
    expect(confirm.structureId).toBe("22222222-2222-4222-8222-222222222222");
    expect(confirm.divisions[0]).not.toHaveProperty("childSourceItemId");
    expect(confirm.divisions[0]).toMatchObject({ title: "Introduction", startPage: 1 });
    expect(resolveProcessingPlan(confirm.plan).effectiveStages).toEqual(
      processingPresetStages.full_knowledge
    );
  });

  it("takes the batch of the import itself when no structure review is needed", async () => {
    const { ipc, calls } = fakeIpc({
      [ipcChannels.ingestionImportFile]: {
        sourceItemId: "s1",
        batchId: "b7",
        requiresStructureReview: false,
        structureId: null,
        duplicate: false
      }
    });
    expect(await importPaper(ipc, () => undefined, paper)).toEqual({
      sourceItemId: "s1",
      batchId: "b7",
      structureConfirmed: false,
      divisions: 0
    });
    expect(calls).toHaveLength(1);
  });

  it("fails on a duplicate, a canceled dialog and an import that queued nothing", async () => {
    await expect(
      importPaper(
        fakeIpc({ [ipcChannels.ingestionImportFile]: { sourceItemId: "s1", duplicate: true } }).ipc,
        () => undefined,
        paper
      )
    ).rejects.toThrow(/empty database/);
    await expect(
      importPaper(fakeIpc({ [ipcChannels.ingestionImportFile]: null }).ipc, () => undefined, paper)
    ).rejects.toThrow(/did not return the file/);
    await expect(
      importPaper(
        fakeIpc({
          [ipcChannels.ingestionImportFile]: { sourceItemId: "s1", batchId: null, duplicate: false }
        }).ipc,
        () => undefined,
        paper
      )
    ).rejects.toThrow(/no processing batch/);
  });
});

describe("a division of the shown structure", () => {
  it("goes back as a candidate without the fields only the view has", () => {
    const candidate = candidateOf(division);
    expect(candidate).not.toHaveProperty("childSourceItemId");
    expect(candidate).not.toHaveProperty("childDocumentId");
    expect(candidate).not.toHaveProperty("endPage");
    expect(candidate).toMatchObject({ id: division.id, startPage: 1, isProcessable: true });
  });
});
