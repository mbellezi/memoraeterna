import { describe, expect, it } from "vitest";

const sources = import.meta.glob<string>(
  ["./RelationsTable.tsx", "./lens-controls.tsx", "./table-model.ts"],
  { query: "?raw", import: "default", eager: true }
);

describe("the relations table and its controls", () => {
  it("use tokens only: no raw palette class, hex colour, rgba or arbitrary font size", () => {
    expect(Object.keys(sources)).toHaveLength(3);
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toMatch(
        /\b(slate|gray|zinc|cyan|violet|amber|rose|red|green|blue|emerald|sky)-\d{2,3}\b/u
      );
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
      expect(source, file).not.toMatch(/rgba?\(/u);
      expect(source, file).not.toMatch(/text-\[/u);
    }
  });

  it("never touch the window history, poll or call the main process", () => {
    for (const [file, source] of Object.entries(sources)) {
      expect(source, file).not.toContain("window.history");
      expect(source, file).not.toContain("setInterval");
      expect(source, file).not.toContain("window.app");
    }
  });

  it("never stack two utilities for one property on a row: idle, connected and selected are one class each", () => {
    const table = Object.entries(sources).find(([file]) => file.endsWith("RelationsTable.tsx"))![1];
    expect(table).toContain("function rowClass");
    // The row's own classes carry no background, so none can fight the state's.
    const row = table.slice(table.indexOf("<tr\n      ref={register}"));
    expect(row.slice(0, row.indexOf("rowClass(state)"))).not.toMatch(/\bbg-/u);
  });
});
