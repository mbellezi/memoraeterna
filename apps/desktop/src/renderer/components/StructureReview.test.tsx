import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createTranslator } from "@app/i18n";

import type { DocumentStructureView } from "../../shared/ipc";
import { StructureReview } from "./StructureReview";

function createStructure(isProcessable: boolean): DocumentStructureView {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    rootSourceItemId: "00000000-0000-4000-8000-000000000002",
    rootDocumentId: "00000000-0000-4000-8000-000000000003",
    format: "pdf",
    detectorVersion: "test-v1",
    status: "in_review",
    overallConfidence: 0.9,
    revision: 1,
    warnings: [],
    rootMarkdown: "# Chapter 1\n\nFirst section.\n\n# Chapter 2\n\nSecond section.",
    boundaries: [
      { offset: 0, label: "Chapter 1", kind: "heading" },
      { offset: 30, label: "Chapter 2", kind: "heading" },
      { offset: 59, label: "Document end", kind: "division" }
    ],
    divisions: [{
      id: "00000000-0000-4000-8000-000000000004",
      parentId: null,
      childSourceItemId: null,
      childDocumentId: null,
      kind: "section",
      title: "Introduction",
      level: 0,
      position: 0,
      startSelector: { page: 1 },
      endSelector: { page: 2 },
      startPage: 1,
      endPage: 2,
      markdownStart: 0,
      markdownEnd: 59,
      confidence: 0.9,
      evidence: [],
      reviewStatus: "accepted",
      isProcessable,
      metadata: {}
    }],
    createdAt: "2026-07-15T12:00:00.000Z",
    updatedAt: "2026-07-15T12:00:00.000Z"
  };
}

function renderReview(isProcessable: boolean) {
  return renderToStaticMarkup(<StructureReview
    structure={createStructure(isProcessable)}
    t={createTranslator("pt-BR")}
    busy={false}
    onSave={vi.fn()}
    onConfirm={vi.fn()}
  />);
}

function confirmButton(markup: string) {
  return [...markup.matchAll(/<button\b[^>]*>.*?<\/button>/g)]
    .map((match) => match[0])
    .find((button) => button.includes("Importar fonte com"));
}

describe("StructureReview", () => {
  it("renders the single sub-element control and explains why confirmation is disabled", () => {
    const markup = renderReview(false);

    expect(markup).toContain('type="checkbox"');
    expect(markup).toContain('aria-label="Criar como sub-elemento"');
    expect(markup).toContain("Selecione ao menos um item para criar como fonte independente.");
    expect(confirmButton(markup)).toContain(' disabled=""');
  });

  it("enables confirmation when an independent source is selected", () => {
    expect(confirmButton(renderReview(true))).not.toContain(' disabled=""');
  });
});
