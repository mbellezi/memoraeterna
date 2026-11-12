import { describe, expect, it } from "vitest";

import panel from "../source.panel.tsx?raw";
import screen from "../source.screen.tsx?raw";
import pageView from "./SourcePanelView.tsx?raw";
import noteRows from "./source-note-rows.tsx?raw";
import tabBodies from "./source-tab-bodies.tsx?raw";
import tabRow from "./source-tab-row.tsx?raw";
import strip from "./SourceStrip.tsx?raw";

// The panel's own files (the T139 parts the Library still imports keep their old palette until the
// Library goes, T158). Everything here is drawn on the tokens.
const files: Record<string, string> = {
  "source.panel.tsx": panel,
  "source.screen.tsx": screen,
  "SourcePanelView.tsx": pageView,
  "source-note-rows.tsx": noteRows,
  "source-tab-bodies.tsx": tabBodies,
  "source-tab-row.tsx": tabRow,
  "SourceStrip.tsx": strip
};

describe("the Source panel's styles", () => {
  it("looks for the Library import at any depth, and finds one in a sample", () => {
    const libraryImport = /from "(?:\.\.\/)+components\/LibraryView"/u;
    expect(libraryImport.test('import { X } from "../../components/LibraryView";')).toBe(true);
    expect(libraryImport.test('import { X } from "../../../components/LibraryView";')).toBe(true);
  });

  it("use tokens only: no raw palette classes, hex colours, rgba or arbitrary font sizes", () => {
    for (const [file, source] of Object.entries(files)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky|indigo|teal|orange|fuchsia)-\d{2,3}\b/u
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(source, file).not.toMatch(/rgba?\(/u);
      expect(source, file).not.toMatch(/text-\[/u);
    }
  });

  it("have no timer that asks again, no dialog and no path to the Library or the window history", () => {
    for (const [file, source] of Object.entries(files)) {
      expect(source, file).not.toContain("setInterval");
      expect(source, file).not.toMatch(/\b(?:window\.)?(?:confirm|alert|prompt)\s*\(/u);
      expect(source, file).not.toContain("window.history");
      expect(source, file).not.toMatch(/from "(?:\.\.\/)+components\/LibraryView"/u);
    }
  });
});
