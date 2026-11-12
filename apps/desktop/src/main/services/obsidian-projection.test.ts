import { describe, expect, it } from "vitest";
import { normalizeMemoraLink } from "@app/domain";

import {
  appendObsidianRelations,
  collisionFileName,
  onlyLinksThisNote,
  parseManagedMarkdown,
  projectionLink,
  projectionObjectAddress,
  renderObsidianProjection,
  stripObsidianRelations
} from "./obsidian-projection.js";

const sourceId = "967fca99-270a-4309-bff8-cad98f24a670";
const documentId = "83f7509d-71ea-4276-922c-c305eb9f7420";
const contentHash = "a".repeat(64);

describe("Obsidian projection", () => {
  it("creates a human web path and complete managed frontmatter", () => {
    const rendered = renderObsidianProjection({
      managedRoot: "Memora",
      memoraId: sourceId,
      memoraType: "source_item",
      sourceItemId: sourceId,
      documentId,
      title: "A Useful Article",
      bodyMarkdown: "# Content",
      contentHash,
      syncVersion: 3,
      sourceType: "WebArticle",
      sourceUri: "https://example.com/articles/one",
      date: new Date("2026-05-10T12:00:00Z")
    });
    expect(rendered.relativeDirectory).toBe("Memora/Sources/Web/2026/05/example.com");
    expect(rendered.baseFileName).toBe("a-useful-article.md");
    expect(rendered.markdown).toContain(`memora_document_id: "${documentId}"`);
    expect(parseManagedMarkdown(rendered.markdown)?.frontmatter.memoraSyncVersion).toBe(3);
  });

  it("applies date, counter, and short-id collision suffixes", () => {
    const date = new Date("2026-05-10T00:00:00Z");
    expect(collisionFileName("title.md", date, 0, sourceId)).toBe("title.md");
    expect(collisionFileName("title.md", date, 1, sourceId)).toBe("title--20260510.md");
    expect(collisionFileName("title.md", date, 2, sourceId)).toBe("title--20260510-02.md");
    expect(collisionFileName("title.md", date, 100, sourceId)).toBe("title--967FCA.md");
  });

  it("appends related note links grouped by relation type", () => {
    const body = appendObsidianRelations("# Main note\n\nBody", "en", [
      { relationType: "supports", title: "Second note", target: "Memora/Atomic/second-note" },
      { relationType: "contrasts", title: "Other | note", target: "Memora/Atomic/other-note" },
      { relationType: "supports", title: "First note", target: "Memora/Atomic/first-note" }
    ]);

    expect(body).toContain("## Note relations");
    expect(body).toContain("### Contrasts\n\n- [[Memora/Atomic/other-note|Other \\| note]]");
    expect(body).toContain(
      "### Supports\n\n- [[Memora/Atomic/first-note|First note]]\n- [[Memora/Atomic/second-note|Second note]]"
    );
    expect(stripObsidianRelations(body)).toBe("# Main note\n\nBody");
  });

  it("lists a relation of a directed type nobody gave this note as its subject as linked, in every language (decision 31b)", () => {
    const related = [
      { relationType: "extends", title: "Given", target: "Memora/Atomic/given" },
      { relationType: "extends", title: "Linked", target: "Memora/Atomic/linked", linked: true },
      { relationType: "same_as", title: "Same", target: "Memora/Atomic/same" }
    ];
    const body = appendObsidianRelations("# Main", "en", related);
    // The subject's own relations keep the type heading; the rest only link the two notes.
    expect(body).toContain("### Extends\n\n- [[Memora/Atomic/given|Given]]");
    expect(body).toContain("### Linked: Extends\n\n- [[Memora/Atomic/linked|Linked]]");
    expect(stripObsidianRelations(body)).toBe("# Main");
    for (const locale of ["en", "pt-BR", "es", "fr", "it"]) {
      const text = appendObsidianRelations("# Main", locale, related);
      expect(text, locale).not.toContain("knowledge.relations");
      expect(text, locale).not.toMatch(/[{}]/u);
      const headings = text.split("\n").filter((line) => line.startsWith("### "));
      expect(new Set(headings).size, locale).toBe(headings.length);
    }
    expect(appendObsidianRelations("# Main", "pt-BR", related)).toContain("### Ligadas: Amplia");
  });

  it("links a note to a relation only when it is not the relation's given subject (decision 31b)", () => {
    // The lower note is the subject of a `lo_to_hi` relation; the higher note is only linked to it.
    expect(onlyLinksThisNote("extends", "lo_to_hi", true)).toBe(false);
    expect(onlyLinksThisNote("extends", "lo_to_hi", false)).toBe(true);
    expect(onlyLinksThisNote("supports", "hi_to_lo", false)).toBe(false);
    expect(onlyLinksThisNote("supports", "hi_to_lo", true)).toBe(true);
    // Nobody gave it a direction: both notes are only linked.
    for (const noteIsLow of [true, false]) {
      expect(onlyLinksThisNote("extends", "unknown", noteIsLow)).toBe(true);
      expect(onlyLinksThisNote("depends_on", "unknown", noteIsLow)).toBe(true);
    }
    // A type that reads both ways, an untyped relation and a legacy neutral type state no direction.
    for (const type of ["same_as", "contradicts", "contrasts", "similar_to", "related", "mentions"])
      expect(onlyLinksThisNote(type, "symmetric", true), type).toBe(false);
  });

  it("keeps the generated relations section on notes without relations", () => {
    const body = appendObsidianRelations("# Nota principal\n\nCorpo", "pt-BR", []);

    expect(body).toContain("## Relações entre notas");
    expect(stripObsidianRelations(body)).toBe("# Nota principal\n\nCorpo");
  });
});

describe("the links the projections write open objects by their canonical address (D10)", () => {
  const relationId = "5a2b6c1d-7e8f-4a90-8b12-c3d4e5f60718";
  const topicId = "0d7f2c1e-5a43-4c58-9a0b-3a6f0a6a1b11";

  it("writes a source link in the canonical form, not memora://open/source", () => {
    const body = appendObsidianRelations("# Note", "en", [
      {
        relationType: "supports",
        title: "Other source",
        target: "Memora/Atomic/other",
        appSourceId: sourceId
      }
    ]);
    expect(body).toContain(`- [Other source](memora://source/${sourceId})`);
    expect(body).not.toContain("memora://open");
  });

  it("writes a source relation as the relation anchor of its source", () => {
    expect(projectionObjectAddress("source", sourceId, { relation: relationId })).toBe(
      `memora://source/${sourceId}#relation=${relationId}`
    );
    expect(projectionObjectAddress("source", "not-a-uuid")).toBeNull();
  });

  it("links a page with no file to its object, and keeps a wikilink where the file exists", () => {
    expect(projectionLink(undefined, "Memory", topicId, "topic")).toBe(
      `[Memory](memora://topic/${topicId})`
    );
    expect(projectionLink(undefined, "A source", sourceId)).toBe(
      `[A source](memora://source/${sourceId})`
    );
    expect(projectionLink(undefined, "A note", sourceId, "note")).toBe(
      `[A note](memora://note/${sourceId})`
    );
    expect(projectionLink("Memora/Wiki/Sources/a.md", "A source", sourceId)).toBe(
      "[[Memora/Wiki/Sources/a|A source]]"
    );
  });

  it("keeps the retired wiki's link for an index page that has no object", () => {
    expect(projectionLink(undefined, "Catalog", sourceId, "wiki")).toBe(
      `[Catalog](memora://open/wiki/${sourceId})`
    );
  });

  it("writes only addresses that the one reader accepts, canonical for objects", () => {
    const written = [
      projectionLink(undefined, "A", sourceId),
      projectionLink(undefined, "B", topicId, "topic"),
      projectionLink(undefined, "C", sourceId, "note"),
      `[D](${projectionObjectAddress("source", sourceId, { relation: relationId })})`
    ];
    for (const link of written) {
      const address = /\((memora:\/\/[^)]+)\)/u.exec(link)?.[1] ?? "";
      const normalized = normalizeMemoraLink(address);
      expect(normalized.kind, link).toBe("object");
      expect("legacy" in normalized, link).toBe(false);
    }
  });
});
