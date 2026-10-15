import { describe, expect, it, vi } from "vitest";
import { legacyContentTables, type PgPool } from "@app/db";

import { KnowledgeAutomation } from "./knowledge-automation.js";

// F2 D3: the legacy areas and the curator policy are installed only on a library that already holds
// legacy content. The real-PostgreSQL behavior (a reset leaves no legacy row) is part of the T04 proof.
const reachedAreas = new Error("reached the legacy area installation");

function setup(counts: Partial<Record<(typeof legacyContentTables)[number], number>>) {
  const row = Object.fromEntries(legacyContentTables.map((table) => [table, counts[table] ?? 0]));
  const query = vi.fn(async () => ({ rows: [row], rowCount: 1 }));
  // `initializeAreas` is the first write: it takes a connection, which this fake refuses.
  const connect = vi.fn(async () => {
    throw reachedAreas;
  });
  const contentLanguage = vi.fn(async () => "en");
  const automation = new KnowledgeAutomation({
    getPool: () => ({ query, connect }) as unknown as PgPool,
    contentLanguage,
    wake: () => {},
    cancelJob: async () => {}
  } as unknown as ConstructorParameters<typeof KnowledgeAutomation>[0]);
  return { automation, query, connect, contentLanguage };
}

describe("legacy knowledge automation initialization", () => {
  it("creates nothing on a library without legacy content", async () => {
    const { automation, query, connect, contentLanguage } = setup({});
    expect(await automation.initialize()).toBeNull();
    // The content check is the only statement: no setting read, no connection, no language lookup.
    expect(query).toHaveBeenCalledOnce();
    expect(connect).not.toHaveBeenCalled();
    expect(contentLanguage).not.toHaveBeenCalled();
  });

  it.each(legacyContentTables)("installs the legacy areas when %s holds a row", async (table) => {
    const { automation, query, connect, contentLanguage } = setup({ [table]: 1 });
    await expect(automation.initialize()).rejects.toBe(reachedAreas);
    expect(query).toHaveBeenCalledOnce();
    expect(contentLanguage).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
  });

  it("still requires the database", async () => {
    const automation = new KnowledgeAutomation({
      getPool: () => null
    } as unknown as ConstructorParameters<typeof KnowledgeAutomation>[0]);
    await expect(automation.initialize()).rejects.toThrow("wiki.errors.unavailable");
  });
});
