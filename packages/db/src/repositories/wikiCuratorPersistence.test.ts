import { describe, expect, it } from "vitest";
import { wikiAreaIds } from "@app/domain";

import type { PgClient } from "../client.js";
import { initialParentId } from "./wikiCuratorPersistence.js";
import { wikiAreaForRole } from "./wikiRepository.js";

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
const draft = (role: { kind: string; role?: string }, initialParent: unknown = null) =>
  ({ role, initialParent }) as Parameters<typeof initialParentId>[1];

describe("automatic page parents", () => {
  it("maps each automatic role to its area", () => {
    expect(wikiAreaForRole({ kind: "topic" })).toBe(wikiAreaIds.themes);
    expect(wikiAreaForRole({ kind: "entity" })).toBe(wikiAreaIds.entities);
    expect(wikiAreaForRole({ kind: "collection" })).toBe(wikiAreaIds.maps);
    expect(wikiAreaForRole({ kind: "synthesis", role: "synthesis" })).toBe(wikiAreaIds.syntheses);
    expect(wikiAreaForRole({ kind: "synthesis", role: "investigation" })).toBe(
      wikiAreaIds.investigations
    );
  });

  it("keeps a proposed parent without consulting the areas", async () => {
    const { db, asked } = database([]);
    const parent = { reference: "proposed", handle: "new_parent" };
    expect(await initialParentId(db, draft({ kind: "topic" }, parent), resolve)).toBe(
      proposedParent
    );
    expect(asked).toHaveLength(0);
  });

  it("never lets a draft without a parent become a root while its area exists", async () => {
    const { db } = database(Object.values(wikiAreaIds));
    expect(await initialParentId(db, draft({ kind: "topic" }), resolve)).toBe(wikiAreaIds.themes);
    expect(await initialParentId(db, draft({ kind: "entity" }), resolve)).toBe(
      wikiAreaIds.entities
    );
    expect(await initialParentId(db, draft({ kind: "collection" }), resolve)).toBe(
      wikiAreaIds.maps
    );
  });

  it("places synthesis and investigation drafts in the areas that save would choose", async () => {
    const { db } = database(Object.values(wikiAreaIds));
    expect(
      await initialParentId(db, draft({ kind: "synthesis", role: "synthesis" }), resolve)
    ).toBe(wikiAreaIds.syntheses);
    expect(
      await initialParentId(db, draft({ kind: "synthesis", role: "investigation" }), resolve)
    ).toBe(wikiAreaIds.investigations);
  });

  it("does not reference an area that was never created", async () => {
    const { db } = database([]);
    expect(await initialParentId(db, draft({ kind: "topic" }), resolve)).toBeNull();
  });

  it("leaves a hierarchy draft without a parent as a root, as explicit placement always has", async () => {
    // The hierarchy decides every parent itself; save() also skips the area default for it.
    const { db, asked } = database(Object.values(wikiAreaIds));
    for (const role of [
      { kind: "topic" },
      { kind: "collection", role: "map" },
      { kind: "synthesis", role: "investigation" }
    ])
      expect(await initialParentId(db, draft(role), resolve, { explicitParent: true })).toBeNull();
    expect(asked).toHaveLength(0);
    // A parent it proposes is still honored.
    const parent = { reference: "proposed", handle: "category" };
    expect(
      await initialParentId(db, draft({ kind: "topic" }, parent), resolve, {
        explicitParent: true
      })
    ).toBe(proposedParent);
  });
});
