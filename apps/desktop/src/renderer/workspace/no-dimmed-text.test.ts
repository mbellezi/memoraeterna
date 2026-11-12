import { describe, expect, it } from "vitest";

/**
 * The design has "no opacity on text and no .dim rule" (docs/design/f5-workspace.md, tokens): a row
 * or a summary at 60% reads at 3.7:1 or less in light and fails AA, and the contrast scan (X12) sees
 * it the moment a journey peeks or filters. These three surfaces dimmed what they showed while the
 * next read was on its way; they keep full contrast and say `aria-busy` instead. Inactive controls
 * (a disabled field, inert chips) may be dimmed: WCAG exempts them.
 */
const sources = import.meta.glob<string>(
  ["./QuickLook.tsx", "./palette/Palette.tsx", "./destinations/library/LibraryGrid.tsx"],
  { query: "?raw", import: "default", eager: true }
);

describe("live text is never dimmed with opacity", () => {
  it("reads the three surfaces", () => {
    expect(Object.keys(sources)).toHaveLength(3);
  });

  it.each(Object.entries(sources))("%s draws what it shows at full contrast", (_file, source) => {
    expect(source.match(/\bopacity-\d+\b/gu) ?? []).toEqual([]);
  });
});
