import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(["./*.ts", "./*.tsx", "!./*.test.ts", "!./*.test.tsx"], {
  query: "?raw",
  import: "default",
  eager: true
});
const views = Object.fromEntries(Object.entries(sources).filter(([file]) => file.endsWith(".tsx")));

describe("Activity styles and copy", () => {
  it("use tokens only: no raw palette classes, hex colours, rgba or arbitrary font sizes", () => {
    expect(Object.keys(views).length).toBeGreaterThanOrEqual(4);
    for (const [file, source] of Object.entries(views)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky)-\d{2,3}\b/
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source, file).not.toMatch(/rgba?\(/);
      expect(source, file).not.toMatch(/text-\[/);
    }
  });

  it("never build a message key from a variable part", () => {
    for (const [file, source] of Object.entries(sources))
      expect(source, file).not.toMatch(/\bt\(\s*`/);
  });

  it("never poll and never hold the screen with a modal", () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toContain("setInterval");
      expect(source, file).not.toContain("aria-modal");
      expect(source, file).not.toContain("showModal");
      expect(source, file).not.toContain("window.confirm");
    }
  });

  it("reach the main process only through the one API the host hands the controller", () => {
    const users = Object.entries(sources).filter(([, source]) => source.includes("window.app"));
    expect(users.map(([file]) => file)).toEqual(["./ActivityHost.tsx"]);
    const controller = sources["./activity-controller.ts"]!;
    const used = new Set(
      [...controller.matchAll(/\bapp\.(\w+(?:\.\w+)?)/g)].map((match) => match[1])
    );
    expect([...used].sort()).toEqual(
      [
        "ai.subscribeLocalEmbeddingLoadStatus",
        "budget",
        "changes",
        "gardener",
        "inbox",
        "knowledgeControls",
        "onAppEvent"
      ].sort()
    );
  });
});
