import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { SourceDescriptorSchema } from "@app/domain";
import { createTranslator } from "@app/i18n";
import { childSourceType, ImportView, preserveDescriptorDetails } from "./ImportView";
import { Tabs } from "./ui/tabs";
import { libraryBrowseInputSchema, savedProcessingPresetSchema, sourceDetailSchema, sourceEditInputSchema } from "../../shared/ipc";

const id = "00000000-0000-4000-8000-000000000001";
describe("source workspace", () => {
  it("bounds catalog queries and never stores targets or destructive policy in a preset", () => {
    expect(libraryBrowseInputSchema.parse({ query: "ISBN" })).toMatchObject({ limit: 48, offset: 0 });
    expect(libraryBrowseInputSchema.safeParse({ limit: 5000 }).success).toBe(false);
    expect(savedProcessingPresetSchema.safeParse({ id, name: "Summary", requestedStages: ["summarization"], forceRegeneration: true }).success).toBe(false);
    expect(sourceEditInputSchema.safeParse({ sourceItemId: id }).success).toBe(false);
  });

  it("preserves creator identifiers when editing unrelated metadata", () => {
    const original = { type: "Book", title: "Book", creators: [{ name: "Author", role: "author", externalIds: { orcid: "test" } }] };
    const next = SourceDescriptorSchema.parse({ ...original, creators: [{ name: "Author", role: "author" }] });
    expect(preserveDescriptorDetails(next, original, { creators: "author: Author" }).creators[0]?.externalIds).toEqual({ orcid: "test" });
  });

  it("opens a contextual chapter form with inherited language and a fixed parent", () => {
    const html = renderToString(<ImportView t={createTranslator("pt-BR")} parent={{ id, type: "Book", title: "Parent book", language: "pt-BR" }} />);
    expect(html).toContain("Parent book");
    expect(html).toContain('value="pt-BR" selected');
    expect(html).not.toContain('id="parent-source"');
    expect(childSourceType("Book")).toBe("BookChapter");
    expect(childSourceType("Video")).toBeNull();
  });

  it("opens the editor from a catalog container without requiring a document", () => {
    const detail = sourceDetailSchema.parse({ id, type: "Book", title: "Catalog book", subtitle: null, sourceUri: null,
      language: "en", summary: null, metadata: { descriptor: { type: "Book", title: "Catalog book" } },
      updatedAt: new Date().toISOString(), assets: [], documents: [], summaries: [], atomicNotes: [], relations: [] });
    const html = renderToString(<ImportView t={createTranslator("en")} editing={detail} />);
    expect(html).toContain("Catalog book");
    expect(html).toContain("Saving preserves earlier content");
  });

  it("connects the active tab to its panel with one keyboard entry point", () => {
    const html = renderToString(<Tabs label="Source" value="content" onChange={() => undefined} items={[
      { id: "overview", label: "Overview" }, { id: "content", label: "Content" }
    ]}>Source content</Tabs>);
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-selected="true" tabindex="0"');
    expect(html).toContain('aria-selected="false" tabindex="-1"');
  });
});
