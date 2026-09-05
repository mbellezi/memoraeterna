import { describe, expect, it } from "vitest";

import { aggregateSourceEmbedding, createCatalogMetadataChunk, participatesInAtomicNoteMatching } from "./job-supervisor.js";
import {
  buildCatalogMetadataMarkdown,
  canReuseArtifactStage,
  catalogMetadataStages,
  splitHierarchicalProcessingTargets
} from "./hierarchical-ingestion-service.js";

describe("hierarchical processing scope", () => {
  it("queues root summarization even when a previous hierarchical summary exists", () => {
    expect(canReuseArtifactStage("summarization", true)).toBe(false);
    expect(canReuseArtifactStage("summarization", false)).toBe(true);
    expect(canReuseArtifactStage("embedding", true)).toBe(true);
  });

  it("keeps complete knowledge stages on children and limits the root to catalog embedding and graph", () => {
    const stages = catalogMetadataStages([
      "chunking",
      "embedding",
      "summarization",
      "atomicNotes",
      "knowledgeGraph",
      "atomicNoteMatching"
    ]);

    expect(stages).toEqual(["chunking", "embedding", "knowledgeGraph"]);
    expect(stages).not.toContain("summarization");
    expect(stages).not.toContain("atomicNotes");
    expect(stages).not.toContain("atomicNoteMatching");
    expect(participatesInAtomicNoteMatching(stages)).toBe(false);
    expect(participatesInAtomicNoteMatching(["atomicNotes", "atomicNoteMatching"])).toBe(true);
  });

  it("moves a selected hierarchy root to catalog processing when one of its children is selected", () => {
    const targets = splitHierarchicalProcessingTargets(
      ["book", "chapter-1", "standalone"],
      new Map([
        ["book", [{ id: "book" }]],
        ["chapter-1", [{ id: "book" }, { id: "chapter-1" }]],
        ["standalone", [{ id: "standalone" }]]
      ])
    );

    expect(targets.contentSourceItemIds).toEqual(["chapter-1", "standalone"]);
    expect(targets.catalogParentIds).toEqual(["book"]);
  });

  it("builds one catalog chunk from title, creators, and safe descriptor metadata", () => {
    const markdown = buildCatalogMetadataMarkdown({
      type: "Book",
      title: "The Book",
      subtitle: "A subtitle",
      sourceUri: null,
      language: "en",
      summary: "An aggregate summary of every selected chapter.",
      metadata: {
        descriptor: {
          type: "Book",
          title: "The Book",
          subtitle: "A subtitle",
          creators: [{ name: "Ada Author", role: "author" }],
          isbn13: "9780000000000",
          publisher: "Example Press",
          provenance: { title: { source: "manual" } },
          cover: { assetId: "cover-id" }
        }
      }
    });
    const catalog = JSON.parse(markdown) as Record<string, unknown>;
    const chunk = createCatalogMetadataChunk(markdown);

    expect(catalog).toMatchObject({
      sourceType: "Book",
      title: "The Book",
      creators: [{ name: "Ada Author", role: "author" }],
      summary: "An aggregate summary of every selected chapter.",
      metadata: { isbn13: "9780000000000", publisher: "Example Press" }
    });
    expect(markdown).not.toContain("provenance");
    expect(markdown).not.toContain("cover-id");
    expect(chunk.metadata).toEqual({ processingMode: "catalog_metadata" });
    expect(chunk.span.selector).toBe("catalog-metadata");
    expect(chunk.content).toBe(markdown);
  });

  it("combines metadata and segmented content into one normalized source embedding", () => {
    const embedding = aggregateSourceEmbedding([[1, 0]], [[0, 1], [0, 1]]);
    expect(embedding).not.toBeNull();
    expect(embedding?.[1]).toBeGreaterThan(embedding?.[0] ?? 0);
    expect(Math.hypot(...(embedding ?? []))).toBeCloseTo(1);
    expect(aggregateSourceEmbedding([], [])).toBeNull();
  });
});
