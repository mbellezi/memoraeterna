import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownPreview } from "./MarkdownEditor";
import libraryView from "./LibraryView.tsx?raw";
import reviewQueueView from "./ReviewQueueView.tsx?raw";
import searchView from "./SearchView.tsx?raw";

const sources: Record<string, string> = {
  "LibraryView.tsx": libraryView,
  "SearchView.tsx": searchView,
  "ReviewQueueView.tsx": reviewQueueView
};

describe("reading surfaces use the serif reading token", () => {
  it("renders Markdown previews (source reader, wiki pages, answers) in the reading face", () => {
    const html = renderToString(
      <MarkdownPreview markdown={"First paragraph.\n\nSecond paragraph."} emptyLabel="Nothing" />
    );
    expect(html).toContain("font-reading");
    expect(html).toContain("text-reading");
    expect(html).toContain("First paragraph.");
  });

  it("keeps the empty state in the interface face", () => {
    const html = renderToString(<MarkdownPreview markdown="" emptyLabel="Nothing to preview" />);
    expect(html).toContain("Nothing to preview");
    expect(html).not.toContain("font-reading");
  });

  it.each(["LibraryView.tsx", "SearchView.tsx", "ReviewQueueView.tsx"])(
    "draws every note idea statement in %s in the reading face",
    (file) => {
      const statements = [
        ...sources[file]!.matchAll(/className="([^"]*)">\s*\{(?:note|result)\.ideaStatement\}/gu)
      ];
      expect(statements.length).toBeGreaterThan(0);
      for (const [, className] of statements) expect(className).toContain("font-reading");
    }
  );

  it("draws source chunk text in the reading face", () => {
    const chunks = [...libraryView.matchAll(/className="([^"]*)">\{chunk\.content\}/gu)];
    expect(chunks.length).toBeGreaterThan(0);
    for (const [, className] of chunks) expect(className).toContain("font-reading");
  });
});
