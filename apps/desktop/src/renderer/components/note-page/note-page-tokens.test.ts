import { describe, expect, it } from "vitest";

import glyphs from "../glyphs.tsx?raw";
import stanceLabel from "../RelationStanceLabel.tsx?raw";

const pageSources = import.meta.glob<string>(["./*.tsx", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true
});
const files: Record<string, string> = {
  ...pageSources,
  "../glyphs.tsx": glyphs,
  "../RelationStanceLabel.tsx": stanceLabel
};

describe("Note page styles", () => {
  it("use tokens only: no raw palette classes, hex colours, rgba or arbitrary font sizes", () => {
    expect(Object.keys(files).length).toBeGreaterThan(8);
    for (const [file, source] of Object.entries(files)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky)-\d{2,3}\b/
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/rgba?\(/);
      expect(source, file).not.toMatch(/text-\[/);
    }
  });

  it("never touch the window history or the Library", () => {
    for (const [file, source] of Object.entries(files)) {
      expect(source, file).not.toContain("window.history");
      expect(source, file).not.toMatch(/from "\.\.\/LibraryView"/);
      expect(source, file).not.toContain("setInterval");
    }
  });
});
