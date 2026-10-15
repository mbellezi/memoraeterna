import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { objectKinds } from "@app/domain";
import { createTranslator } from "@app/i18n";

import { stances } from "../lib/relation-stance";
import { ObjectKindGlyph, StanceGlyph, objectKindTextClass } from "./glyphs";
import { RelationStanceLabel } from "./RelationStanceLabel";

const common = (html: string) => {
  expect(html).toContain('viewBox="0 0 16 16"');
  expect(html).toContain('aria-hidden="true"');
  expect(html).toContain('focusable="false"');
  expect(html).toContain('stroke="currentColor"');
  expect(html).toContain('fill="none"');
  expect(html).toMatch(/<(path|rect|circle)\b/);
};

describe("glyphs", () => {
  it("draws every object kind and stance on the 16 px grid, decorative and in the caller's colour", () => {
    for (const kind of objectKinds) common(renderToString(<ObjectKindGlyph kind={kind} />));
    for (const stance of stances) common(renderToString(<StanceGlyph stance={stance} />));
    expect(
      renderToString(<ObjectKindGlyph kind="note" size={12} className="text-object-note" />)
    ).toMatch(/width="12" height="12"[^>]*class="block flex-none text-object-note"/);
    expect(Object.keys(objectKindTextClass).sort()).toEqual([...objectKinds].sort());
  });

  it("labels a stance with its glyph, its word and its colour", () => {
    const html = renderToString(
      <RelationStanceLabel type="contrasts" t={createTranslator("en")} />
    );
    expect(html).toContain("text-stance-contradicts");
    expect(html).toContain(">contrasts</span>");
    expect(html).toContain("<svg");
    expect(
      renderToString(<RelationStanceLabel type="refutes" t={createTranslator("en")} />)
    ).toContain(">related</span>");
  });
});
