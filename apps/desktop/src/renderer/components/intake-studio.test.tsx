import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { ManualContentComposer } from "./ManualContentComposer";
import { SourceMetadataPreview } from "./SourceMetadataPreview";
import { CreatorFields, creatorRows } from "./CreatorFields";
import { ParentPicker, suggestedFileType, suggestSourceTitle } from "./ImportView";
import { StructureReview } from "./StructureReview";
import { fileMetadataExtractionResultSchema } from "../../shared/ipc";

describe("intake studio", () => {
  it("suggests hierarchical types from actual file metadata", () => {
    const base = { fileToken: "00000000-0000-4000-8000-000000000001", fileName: "file.pdf", mimeType: "application/pdf", draft: { sourceType: "GenericDocument" as const, values: {}, provenance: {}, warnings: [] } };
    expect(suggestedFileType(base)).toBe("GenericDocument");
    expect(suggestedFileType({ ...base, mimeType: "application/epub+zip" })).toBe("Book");
    expect(suggestedFileType({ ...base, draft: { ...base.draft, values: { isbn13: "9780306406157" } } })).toBe("Book");
    expect(suggestedFileType({ ...base, draft: { ...base.draft, values: { doi: "10.5555/example" } } })).toBe("AcademicPaper");
  });
  it("makes an empty file preview explicit without pretending to import it", () => {
    const html = renderToString(<StructureReview structure={{ rootMarkdown: "Plain source", boundaries: [], divisions: [] }} previewOnly t={createTranslator("en")} busy={false} onSave={async () => {}} onConfirm={async () => {}} />);
    expect(html).toContain("Only the complete source will be imported");
    expect(html).toContain("Confirm selection (0)");
    expect(html).not.toContain("Save draft");
  });
  it.each(["BookChapter", "DocumentSection"] as const)("offers a compatible parent search and creation for %s", (sourceType) => {
    const html = renderToString(<ParentPicker sourceType={sourceType} values={{}} onChange={() => {}} t={createTranslator("en")} />);
    expect(html).toContain('id="parent-source"');
    expect(html).toContain("Search by title");
    expect(html).toContain("Create parent");
    expect(html).toContain(sourceType === "BookChapter" ? "Book" : "Academic paper");
  });
  it("suggests a bounded title from the first nonempty line", () => {
    expect(suggestSourceTitle("\n## A useful idea\n\nDetails")).toBe("A useful idea");
    expect(suggestSourceTitle("  \n ")).toBe("");
    expect(suggestSourceTitle("x".repeat(300))).toHaveLength(160);
  });
  it("retains creator roles and affiliations in editable rows", () => {
    expect(creatorRows("editor: Ana Costa | University\nBruno Lima\nauthor: ")).toEqual([
      { name: "Ana Costa", affiliation: "University", role: "editor" },
      { name: "Bruno Lima", affiliation: "", role: "author" },
      { name: "", affiliation: "", role: "author" }
    ]);
  });
  it.each(supportedLanguageCodes)("offers both views and localized controls in %s", (locale) => {
    const t = createTranslator(locale);
    for (const mode of ["document", "subitems"] as const) {
      const html = renderToString(<ManualContentComposer t={t} sourceType="Book" content="Source draft" onContent={() => {}} mode={mode} onMode={() => {}} subitems={[{ id: "one", title: "Chapter", content: "Chapter draft" }]} onSubitems={() => {}} />);
      expect(html).toContain(t("intake.sourceView"));
      expect(html).toContain(t("intake.subitemsView"));
      expect(html).toContain(mode === "document" ? "Source draft" : "Chapter draft");
      expect(html).not.toContain("missing:");
    }
    expect(renderToString(<CreatorFields value="" onChange={() => {}} t={t} />)).not.toContain("missing:");
  });
  it("shows true text evidence safely and distinguishes missing previews", () => {
    const t = createTranslator("en");
    const text = "# Study\n<script>alert('no')</script>\nEvidence";
    const html = renderToString(<SourceMetadataPreview text={text} values={{ title: "Study", doi: "not in text" }} t={t} onApply={() => {}} truncated />);
    expect(html).toContain("Find Title in text");
    expect(html).not.toContain("Find DOI in text");
    expect(html).not.toContain("<script>");
    expect(html).toContain(t("intake.previewTruncated"));
    expect(html).toContain('disabled=""');
    const empty = renderToString(<SourceMetadataPreview text="" values={{}} t={t} onApply={() => {}} />);
    expect(empty).toContain(t("intake.previewEmpty"));
  });
  it("validates and bounds previews at the IPC boundary", () => {
    const data = { fileToken: "00000000-0000-4000-8000-000000000001", fileName: "sample.md", mimeType: "text/markdown", draft: { sourceType: "GenericDocument", values: {}, provenance: {}, warnings: [] } };
    expect(fileMetadataExtractionResultSchema.parse({ ...data, preview: { text: "start", truncated: false } }).preview?.text).toBe("start");
    expect(() => fileMetadataExtractionResultSchema.parse({ ...data, preview: { text: "x".repeat(20_001), truncated: true } })).toThrow();
    expect(() => fileMetadataExtractionResultSchema.parse({ ...data, preview: { text: "start", truncated: false, path: "/private/file" } })).toThrow();
  });
});
