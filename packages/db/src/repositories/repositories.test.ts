import type { QueryResult, QueryResultRow } from "pg";
import { describe, expect, it } from "vitest";

import { createSettingsRepository } from "./settingsRepository.js";
import { createSourceItemRepository } from "./sourceItemRepository.js";
import type { Queryable } from "./types.js";

class FakeQueryable implements Queryable {
  readonly queries: Array<{ text: string; values: readonly unknown[] }> = [];
  private readonly rows: QueryResultRow[][];

  constructor(rows: QueryResultRow[][]) {
    this.rows = rows;
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<T>> {
    this.queries.push({ text, values });
    const rows = (this.rows.shift() ?? []) as T[];
    return {
      command: "SELECT",
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows
    };
  }
}

describe("repositories", () => {
  it("creates source items with parameterized SQL and maps records", async () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          id: "source-1",
          type: "WebArticle",
          title: "Example",
          sourceUri: "https://example.test",
          externalId: null,
          metadata: { capturedBy: "test" },
          createdAt: now,
          updatedAt: now
        }
      ]
    ]);

    const repo = createSourceItemRepository(db);
    const record = await repo.create({
      type: "WebArticle",
      title: "Example",
      sourceUri: "https://example.test",
      metadata: { capturedBy: "test" }
    });

    expect(record.id).toBe("source-1");
    expect(db.queries[0]?.text).toContain("insert into source_items");
    expect(db.queries[0]?.text).toContain("$1");
    expect(db.queries[0]?.values).toEqual([
      "WebArticle",
      "Example",
      "https://example.test",
      null,
      { capturedBy: "test" }
    ]);
  });

  it("upserts settings by key", async () => {
    const now = new Date("2026-07-05T10:00:00.000Z");
    const db = new FakeQueryable([
      [
        {
          key: "ui.locale",
          value: "pt-BR",
          updatedAt: now
        }
      ]
    ]);

    const repo = createSettingsRepository(db);
    const setting = await repo.set("ui.locale", "pt-BR");

    expect(setting).toEqual({
      key: "ui.locale",
      value: "pt-BR",
      updatedAt: now
    });
    expect(db.queries[0]?.text).toContain("on conflict (key) do update");
  });
});
