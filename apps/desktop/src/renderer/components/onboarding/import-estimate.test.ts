import { createTranslator } from "@app/i18n";
import { describe, expect, it, vi } from "vitest";

import { defaultProcessingPlan } from "../ProcessingPlanPicker";
import {
  charactersPerChunk,
  chunksOfText,
  estimateLines,
  importChunkBasis,
  loadImportEstimate,
  planUsesWriter,
  previewCharacterLimit
} from "./import-estimate";

const fullKnowledge = defaultProcessingPlan("full_knowledge");

describe("how big an import is", () => {
  it("counts text in the pipeline's chunks of 1,600 characters, and nothing for no text", () => {
    expect(charactersPerChunk).toBe(1_600);
    expect(chunksOfText("")).toBe(0);
    expect(chunksOfText("   \n")).toBe(0);
    expect(chunksOfText("a".repeat(1_600))).toBe(1);
    expect(chunksOfText("a".repeat(1_601))).toBe(2);
  });

  it("counts pasted text whole", () => {
    expect(importChunkBasis({ origin: "manual", content: "a".repeat(8_000), file: null })).toEqual({
      kind: "known",
      chunks: 5
    });
  });

  it("counts a small file whole and a large one as at least what its preview shows", () => {
    const small = { preview: { text: "a".repeat(3_200), truncated: false } };
    expect(importChunkBasis({ origin: "file", content: "", file: small })).toEqual({
      kind: "known",
      chunks: 2
    });
    const large = { preview: { text: "a".repeat(previewCharacterLimit), truncated: true } };
    expect(importChunkBasis({ origin: "file", content: "", file: large })).toEqual({
      kind: "atLeast",
      chunks: 13
    });
  });

  it("does not know the size of a file that has no preview", () => {
    expect(importChunkBasis({ origin: "file", content: "", file: null })).toEqual({
      kind: "unknown"
    });
    expect(importChunkBasis({ origin: "file", content: "", file: {} })).toEqual({
      kind: "unknown"
    });
  });
});

describe("which plans spend anything", () => {
  it("calls a writing model for the plans that summarize, write notes or build the graph", () => {
    expect(planUsesWriter(fullKnowledge)).toBe(true);
    expect(planUsesWriter(defaultProcessingPlan("summary"))).toBe(true);
  });

  it("calls none for storing and for making a source searchable", () => {
    expect(planUsesWriter(defaultProcessingPlan("import_only"))).toBe(false);
    expect(planUsesWriter(defaultProcessingPlan("search_ready"))).toBe(false);
  });
});

describe("what the chip says of an estimate", () => {
  const known = { kind: "known", chunks: 40 } as const;

  it("says not metered for a subscription route, without a number", () => {
    const lines = estimateLines({ billing: "subscription" }, known, "en");
    expect(lines).toEqual([{ key: "onboarding.estimate.subscription" }]);
    expect(createTranslator("en")(lines[0]!.key)).toContain("Not metered");
  });

  it("says a model on this computer costs nothing, and that no writer means nothing is spent", () => {
    expect(estimateLines({ billing: "local" }, known, "en")).toEqual([
      { key: "onboarding.estimate.local" }
    ]);
    expect(estimateLines({ billing: "none" }, known, "en")).toEqual([
      { key: "onboarding.estimate.none" }
    ]);
  });

  it("gives the amount for a priced route, in the interface language", () => {
    const estimate = {
      billing: "per_token",
      usd: 1.234,
      known: true,
      priceTableVersion: "2026-10"
    } as const;
    expect(estimateLines(estimate, known, "en")).toEqual([
      { key: "onboarding.estimate.perToken", values: { amount: "$1.23" } }
    ]);
    expect(String(estimateLines(estimate, known, "pt-BR")[0]!.values?.amount)).toMatch(
      /^US\$\s1,23$/u
    );
  });

  it("says at least when the file is larger than what was read, and when the price is an estimate", () => {
    const estimate = {
      billing: "per_token",
      usd: 0.5,
      known: false,
      priceTableVersion: "2026-10"
    } as const;
    expect(estimateLines(estimate, { kind: "atLeast", chunks: 13 }, "en")).toEqual([
      { key: "onboarding.estimate.perTokenAtLeast", values: { amount: "$0.50" } },
      { key: "onboarding.estimate.priceEstimated" }
    ]);
  });

  it("never invents an amount for a priced route when the size is not known", () => {
    const estimate = {
      billing: "per_token",
      usd: 0,
      known: true,
      priceTableVersion: "2026-10"
    } as const;
    expect(estimateLines(estimate, { kind: "unknown" }, "en")).toEqual([
      { key: "onboarding.estimate.unknownSize" }
    ]);
  });
});

describe("reading the estimate", () => {
  it("asks nobody for a plan that spends nothing", async () => {
    const estimateImport = vi.fn();
    const state = await loadImportEstimate(
      { estimateImport },
      defaultProcessingPlan("import_only"),
      { kind: "known", chunks: 10 },
      "en"
    );
    expect(state).toEqual({
      status: "ready",
      lines: [{ key: "onboarding.estimate.noWriting" }]
    });
    expect(estimateImport).not.toHaveBeenCalled();
  });

  it("prices the chunk count of the basis, or none when it is unknown", async () => {
    const estimateImport = vi.fn(async () => ({ billing: "subscription" }) as const);
    await loadImportEstimate(
      { estimateImport },
      fullKnowledge,
      { kind: "known", chunks: 40 },
      "en"
    );
    await loadImportEstimate({ estimateImport }, fullKnowledge, { kind: "unknown" }, "en");
    expect(estimateImport.mock.calls).toEqual([[{ chunkCount: 40 }], [{ chunkCount: 0 }]]);
  });

  it("shows the answer for a subscription as not metered", async () => {
    const state = await loadImportEstimate(
      { estimateImport: async () => ({ billing: "subscription" }) },
      fullKnowledge,
      { kind: "known", chunks: 40 },
      "en"
    );
    expect(state).toEqual({
      status: "ready",
      lines: [{ key: "onboarding.estimate.subscription" }]
    });
  });

  it("reports a read that failed, so the chip can offer another try", async () => {
    const state = await loadImportEstimate(
      {
        estimateImport: async () => {
          throw new Error("errors.common.unknown");
        }
      },
      fullKnowledge,
      { kind: "known", chunks: 3 },
      "en"
    );
    expect(state).toEqual({ status: "error" });
  });
});
