import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true
});
const views = Object.fromEntries(
  Object.entries(sources).filter(([file]) => file.endsWith(".tsx") && !file.includes("fixtures"))
);

describe("Topic page styles", () => {
  it("use tokens only: no raw palette classes, hex colours, rgba or arbitrary font sizes", () => {
    expect(Object.keys(views).length).toBeGreaterThanOrEqual(7);
    for (const [file, source] of Object.entries(views)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky)-\d{2,3}\b/
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/rgba?\(/);
      expect(source, file).not.toMatch(/text-\[/);
    }
  });

  it("never touch the window history or the Library, and never poll", () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toContain("window.history");
      expect(source, file).not.toMatch(/from "\.\.\/LibraryView"/);
      expect(source, file).not.toContain("setInterval");
    }
  });
});

describe("Topic page IPC", () => {
  it("reads the tree and undoes one change; only the overview section writes (T31); no search or Ask", () => {
    const calls = new Set<string>();
    for (const source of Object.values(sources))
      for (const match of source.matchAll(/window\.app\.(\w+)/g)) calls.add(match[1]!);
    expect([...calls]).toEqual(["topics"]);
    for (const [file, source] of Object.entries(sources)) {
      const allowed = ["page", "notes", "undo"];
      if (file.endsWith("/topic-overview-controller.ts"))
        allowed.push("overview", "cancelOverview");
      for (const method of source.matchAll(/\bapi\(\)\s*\.(\w+)/g)) {
        expect(allowed, file).toContain(method[1]);
      }
      expect(source, file).not.toMatch(/\.(consultation|ai|search|relations)\./);
    }
  });
});
