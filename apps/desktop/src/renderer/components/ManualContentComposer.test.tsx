import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { MarkdownEditor, MarkdownPreview } from "./MarkdownEditor";
import { compileManualSubitems, validateManualSubitems } from "./ManualContentComposer";

describe("manual content composition", () => {
  it("compiles ordered manual subitems into detectable Markdown headings", () => {
    const markdown = compileManualSubitems([
      { id: "one", title: "Arrival", content: "First **chapter**." },
      { id: "two", title: "Departure", content: "Second chapter." }
    ]);

    expect(markdown).toBe("# Arrival\n\nFirst **chapter**.\n\n# Departure\n\nSecond chapter.");
  });

  it("accepts an empty container but rejects partially filled subitems", () => {
    expect(validateManualSubitems([{ id: "empty", title: "", content: "" }])).toBe(true);
    expect(validateManualSubitems([{ id: "partial", title: "Chapter one", content: "" }])).toBe(false);
    expect(validateManualSubitems([{ id: "complete", title: "Chapter one", content: "Body" }])).toBe(true);
  });

  it("renders Markdown as safe semantic content", () => {
    const html = renderToString(<MarkdownPreview
      markdown={"# Heading\n\nA **strong** and ~~revised~~ idea with [evidence](https://example.com).\n\n- [ ] First\n- [x] Second"}
      emptyLabel={createTranslator("en")("markdown.emptyPreview")}
    />);

    expect(html).toContain("<h1");
    expect(html).toContain("<strong>strong</strong>");
    expect(html).toContain("<del>revised</del>");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain("<ul");
    expect(html).toContain('type="checkbox"');
  });

  it("exposes the complete Markdown automation toolbar", () => {
    const html = renderToString(<MarkdownEditor id="content" value="" onChange={() => undefined} t={createTranslator("en")} label="Content" />);

    for (const label of [
      "Main heading", "Section heading", "Bold", "Italic", "Strikethrough", "Link",
      "Bulleted list", "Numbered list", "Checklist", "Quote", "Inline code", "Code block", "Horizontal rule"
    ]) expect(html).toContain(`aria-label="${label}"`);
  });
});
