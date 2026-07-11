import { describe, expect, it } from "vitest";

import {
  appendObsidianRelations,
  collisionFileName,
  parseManagedMarkdown,
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

  it("keeps the generated relations section on notes without relations", () => {
    const body = appendObsidianRelations("# Nota principal\n\nCorpo", "pt-BR", []);

    expect(body).toContain("## Relações entre notas");
    expect(stripObsidianRelations(body)).toBe("# Nota principal\n\nCorpo");
  });
});
