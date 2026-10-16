// The import of the zero-config end-to-end test (F2 T32) as the Import screen drives it: pick the
// file in the open dialog, import it with the contract's default processing plan, review the
// detected structure as detected and confirm it. Everything goes through the product's IPC
// handlers, so the counters see exactly what a user's session would have called.
import { join } from "node:path";

import { DocumentDivisionCandidateSchema, SourceDescriptorSchema } from "@app/domain";
import type { SourceDescriptor } from "@app/domain";

import { fileImportInputSchema, ipcChannels } from "../../../shared/ipc.js";
import type { IngestionResult } from "../../../shared/ipc.js";
import type { GoldenManifest } from "../golden-runner.js";
import type { RecordingIpc } from "./ipc-counters.js";

export interface PaperSource {
  key: string;
  path: string;
  descriptor: SourceDescriptor;
}

type GoldenFileEntry = Extract<GoldenManifest["sources"][number], { import: "file" }>;

/** The golden manifest entry of the paper and the descriptor a user would have filled in. */
export function paperFromManifest(
  manifest: GoldenManifest,
  key: string,
  repositoryRoot: string
): PaperSource {
  const entry = manifest.sources.find((source) => source.key === key);
  if (!entry) throw new Error(`The golden manifest has no source ${key}`);
  if (entry.kind !== "document" || entry.import !== "file")
    throw new Error(`${key} is not a file the harness can import`);
  const file: GoldenFileEntry = entry;
  const extension = { pdf: ".pdf", html: ".html", markdown: ".md", text: ".txt" }[file.format];
  return {
    key,
    path: join(repositoryRoot, ".cache", "golden", "sources", `${file.key}${extension}`),
    descriptor: SourceDescriptorSchema.parse({
      ...file.descriptor,
      title: file.title,
      language: file.language
    })
  };
}

export interface ImportOutcome {
  sourceItemId: string;
  batchId: string;
  /** The structure review the Import screen shows for hierarchical types, confirmed as detected. */
  structureConfirmed: boolean;
  divisions: number;
}

interface StructureView {
  id: string;
  divisions: Array<Record<string, unknown>>;
}

/** Imports one file and queues its processing with the default plan. */
export async function importPaper(
  ipc: Pick<RecordingIpc, "invoke">,
  choose: (path: string | null) => void,
  paper: PaperSource
): Promise<ImportOutcome> {
  // The default plan is the contract's own default (full knowledge), not a copy of it.
  const input = fileImportInputSchema.parse({ descriptor: paper.descriptor });
  choose(paper.path);
  const result = await ipc.invoke<IngestionResult | null>(ipcChannels.ingestionImportFile, {
    descriptor: input.descriptor,
    duplicatePolicy: input.duplicatePolicy
  });
  if (!result) throw new Error("The open dialog did not return the file");
  if (result.duplicate)
    throw new Error(`${paper.key} is already in the library; the test needs an empty database`);
  if (!result.requiresStructureReview || !result.structureId) {
    if (!result.batchId) throw new Error("The import queued no processing batch");
    return {
      sourceItemId: result.sourceItemId,
      batchId: result.batchId,
      structureConfirmed: false,
      divisions: 0
    };
  }
  const structure = await ipc.invoke<StructureView | null>(
    ipcChannels.ingestionStructureGet,
    result.structureId
  );
  if (!structure) throw new Error(`Structure ${result.structureId} disappeared`);
  const confirmed = await ipc.invoke<{ batchId: string }>(ipcChannels.ingestionStructureConfirm, {
    structureId: structure.id,
    divisions: structure.divisions.map(candidateOf),
    plan: input.processingPlan
  });
  return {
    sourceItemId: result.sourceItemId,
    batchId: confirmed.batchId,
    structureConfirmed: true,
    divisions: structure.divisions.length
  };
}

/** A division of the shown structure as the review sends it back (the fields of the candidate). */
export function candidateOf(division: Record<string, unknown>) {
  const optional = (name: string) =>
    division[name] === undefined ? {} : { [name]: division[name] };
  return DocumentDivisionCandidateSchema.parse({
    id: division.id,
    parentId: division.parentId,
    kind: division.kind,
    title: division.title,
    level: division.level,
    position: division.position,
    startSelector: division.startSelector,
    endSelector: division.endSelector,
    ...optional("startPage"),
    ...optional("endPage"),
    ...optional("markdownStart"),
    ...optional("markdownEnd"),
    confidence: division.confidence,
    evidence: division.evidence,
    reviewStatus: division.reviewStatus,
    isProcessable: division.isProcessable,
    metadata: division.metadata
  });
}
