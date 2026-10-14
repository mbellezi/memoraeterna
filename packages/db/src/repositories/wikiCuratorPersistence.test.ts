import { describe, expect, it } from "vitest";
import { wikiAreaIds } from "@app/domain";

import type { PgClient } from "../client.js";
import { initialParentId, wikiAreaForRole } from "./wikiCuratorPersistence.js";

const proposedParent = "00000000-0000-4000-8000-0000000000b1";

function database(existingAreas: readonly string[]) {
  const asked: unknown[][] = [];
  const db = {
    async query(_sql: string, params: unknown[] = []) {
      asked.push(params);
      return { rows: existingAreas.includes(String(params[0])) ? [{ "?column?": 1 }] : [] };
    }
  } as unknown as Pick<PgClient, "query">;
  return { db, asked };
}

const resolve = () => ({ id: proposedParent });
const draft = (kind: string, initialParent: unknown = null) =>
  ({ role: { kind }, initialParent }) as Parameters<typeof initialParentId>[1];

describe("automatic page parents", () => {
  it("maps each automatic role to its area", () => {
    expect(wikiAreaForRole("topic")).toBe(wikiAreaIds.themes);
    expect(wikiAreaForRole("entity")).toBe(wikiAreaIds.entities);
    expect(wikiAreaForRole("collection")).toBe(wikiAreaIds.maps);
  });

  it("keeps a proposed parent without consulting the areas", async () => {
    const { db, asked } = database([]);
    const parent = { reference: "proposed", handle: "new_parent" };
    expect(await initialParentId(db, draft("topic", parent), resolve)).toBe(proposedParent);
    expect(asked).toHaveLength(0);
  });

  it("never lets a draft without a parent become a root while its area exists", async () => {
    const { db } = database(Object.values(wikiAreaIds));
    expect(await initialParentId(db, draft("topic"), resolve)).toBe(wikiAreaIds.themes);
    expect(await initialParentId(db, draft("entity"), resolve)).toBe(wikiAreaIds.entities);
    expect(await initialParentId(db, draft("collection"), resolve)).toBe(wikiAreaIds.maps);
  });

  it("does not reference an area that was never created", async () => {
    const { db } = database([]);
    expect(await initialParentId(db, draft("topic"), resolve)).toBeNull();
  });
});
