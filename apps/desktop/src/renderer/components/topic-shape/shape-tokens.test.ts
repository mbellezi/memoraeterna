import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true
});
const views = Object.fromEntries(
  Object.entries(sources).filter(([file]) => file.endsWith(".tsx") && !file.includes("fixtures"))
);

describe("Shape styles", () => {
  it("use tokens only: no raw palette classes, hex colours, rgba or arbitrary font sizes", () => {
    expect(Object.keys(views).length).toBeGreaterThanOrEqual(9);
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

describe("Shape IPC", () => {
  it("reads the tree and its change-sets, applies, dismisses and undoes, and calls no AI, search or Ask", () => {
    const calls = new Set<string>();
    const methods = new Set<string>();
    for (const [file, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/window\.app\.(\w+)/g)) calls.add(match[1]!);
      for (const method of source.matchAll(/\bapi\(\)\s*\.(\w+)/g)) methods.add(method[1]!);
      expect(source, file).not.toMatch(/\.(consultation|ai|search|relations)\./);
    }
    expect([...calls]).toEqual(["topics"]);
    expect([...methods].sort()).toEqual([
      "changeSet",
      "review",
      "shape",
      "subscribeChanged",
      "undo"
    ]);
  });
});
