// The import plan chip's estimate (F4 D14, spec 3.3; rendered by T96): what an import would cost on
// the route that writes. The price is the main process's (`budget.estimateImport` prices a chunk
// count on the route's price entry); this module turns the size of what the person is importing
// into that count, decides when the plan spends anything, and words the answer. A subscription
// route reads "not metered", a local one costs nothing, and a source whose size is not known yet
// never gets an invented number.
import {
  resolveProcessingPlan,
  type ImportEstimate,
  type ProcessingPlanRequest,
  type ProcessingStage
} from "@app/domain";

import type { DesktopApi, FileMetadataExtractionResult } from "../../../shared/ipc";
import { formatUsd, type OnboardingMessage } from "./onboarding-model";

/**
 * The size of a chunk the pipeline cuts a source into, in characters
 * (`packages/conversion/src/chunking.ts`, `targetCharacters`).
 */
export const charactersPerChunk = 1_600;

/** The preview of a picked file stops here (`fileMetadataExtractionResultSchema`). */
export const previewCharacterLimit = 20_000;

/** How many chunks the import has, as far as it is known. */
export type ChunkBasis =
  | { kind: "known"; chunks: number }
  /** The preview ended before the file did: the import has at least this many. */
  | { kind: "atLeast"; chunks: number }
  | { kind: "unknown" };

export function chunksOfText(text: string): number {
  return text.trim() === "" ? 0 : Math.ceil(text.length / charactersPerChunk);
}

/**
 * The basis of an import from what the form holds: pasted or written text is counted whole; a
 * picked file is counted from its preview, which is the whole file when it was not truncated.
 */
export function importChunkBasis(input: {
  origin: "manual" | "file";
  content: string;
  file: Pick<FileMetadataExtractionResult, "preview"> | null;
}): ChunkBasis {
  if (input.origin === "manual") return { kind: "known", chunks: chunksOfText(input.content) };
  const preview = input.file?.preview;
  if (!preview) return { kind: "unknown" };
  return preview.truncated
    ? { kind: "atLeast", chunks: Math.max(chunksOfText(preview.text), 1) }
    : { kind: "known", chunks: chunksOfText(preview.text) };
}

/** The stages whose calls a writing model makes (the others embed, rank or store). */
const writerStages: ReadonlySet<ProcessingStage> = new Set<ProcessingStage>([
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "sourceMatching"
]);

/** Whether the plan calls a writing model at all: a plan without such a stage spends nothing. */
export function planUsesWriter(plan: ProcessingPlanRequest): boolean {
  return resolveProcessingPlan(plan).effectiveStages.some((stage) => writerStages.has(stage));
}

/** The lines the chip shows for an answer of `budget.estimateImport`. */
export function estimateLines(
  estimate: ImportEstimate,
  basis: ChunkBasis,
  locale: string
): OnboardingMessage[] {
  switch (estimate.billing) {
    case "subscription":
      return [{ key: "onboarding.estimate.subscription" }];
    case "local":
      return [{ key: "onboarding.estimate.local" }];
    case "none":
      return [{ key: "onboarding.estimate.none" }];
    case "per_token": {
      if (basis.kind === "unknown") return [{ key: "onboarding.estimate.unknownSize" }];
      const amount = formatUsd(locale, estimate.usd);
      const lines: OnboardingMessage[] = [
        {
          key:
            basis.kind === "atLeast"
              ? "onboarding.estimate.perTokenAtLeast"
              : "onboarding.estimate.perToken",
          values: { amount }
        }
      ];
      if (!estimate.known) lines.push({ key: "onboarding.estimate.priceEstimated" });
      return lines;
    }
  }
}

export type ChipState =
  { status: "loading" } | { status: "error" } | { status: "ready"; lines: OnboardingMessage[] };

export type EstimateApi = Pick<DesktopApi["budget"], "estimateImport">;

/** The chip for a plan and a basis: no call when the plan spends nothing, one call otherwise. */
export async function loadImportEstimate(
  api: EstimateApi,
  plan: ProcessingPlanRequest,
  basis: ChunkBasis,
  locale: string
): Promise<ChipState> {
  if (!planUsesWriter(plan))
    return { status: "ready", lines: [{ key: "onboarding.estimate.noWriting" }] };
  try {
    const estimate = await api.estimateImport({
      chunkCount: basis.kind === "unknown" ? 0 : basis.chunks
    });
    return { status: "ready", lines: estimateLines(estimate, basis, locale) };
  } catch {
    return { status: "error" };
  }
}
