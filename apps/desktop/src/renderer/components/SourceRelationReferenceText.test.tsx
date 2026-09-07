import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceRelationReferenceText } from "./SourceRelationReferenceText";

describe("source reference markers",() => {
  const relation={sourceItemId:"B",targetSourceItemId:"A",sourceTitle:"First source",targetTitle:"Second source"};
  it("renders real endpoint IDs as numbered circles in the text",() => {
    const html=renderToStaticMarkup(<SourceRelationReferenceText relation={relation} text={'The idea in <source-ref id="A" /> qualifies <source-ref id="B" />.'} />);
    expect(html).toContain('aria-label="2: Second source"');
    expect(html).toContain('aria-label="1: First source"');
    expect(html.indexOf('2: Second source')).toBeLessThan(html.indexOf('1: First source'));
    expect(html).not.toContain("source-ref");
  });
  it("escapes model markup and never guesses unknown source IDs",() => {
    const html=renderToStaticMarkup(<SourceRelationReferenceText relation={relation} text={'<script>alert(1)</script> <source-ref id="unknown" /> ordinary prose'} />);
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('aria-label=');
    expect(html).toContain("ordinary prose");
  });
});
