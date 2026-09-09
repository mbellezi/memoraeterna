import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { AtomicNoteRelationReferenceText } from "./AtomicNoteRelationReferenceText";

it("renders canonical note references by identity even when endpoint order is reversed", () => {
  const html = renderToStaticMarkup(<AtomicNoteRelationReferenceText
    text={'<note-ref id="b" /> supports <note-ref id="a" />. <script>alert(1)</script>'}
    sourceId="a" targetId="b" sourceTitle="First" targetTitle="Second" />);
  expect(html.indexOf('aria-label="2: Second"')).toBeLessThan(html.indexOf('aria-label="1: First"'));
  expect(html).toContain("border-cyan");
  expect(html).toContain("border-violet");
  expect(html).not.toContain("<note-ref");
  expect(html).not.toContain("<script>");
  expect(html).toContain("&lt;script&gt;");
});
