import { describe, expect, it } from "vitest";

import { bandVisibility, chooseVisibility, legacyVisibility } from "./relation-visibility.ts";

describe("the relation visibility clause", () => {
  it("reads a relation by its counted statuses on a library without bands", () => {
    const visibility = legacyVisibility(["accepted", "pending_review"]);
    expect(visibility.id).toBe("legacy-status");
    expect(visibility.shown("r")).toBe("r.status::text in ('accepted', 'pending_review')");
    expect(visibility.applied("rel")).toBe("rel.status::text in ('accepted', 'pending_review')");
    expect(legacyVisibility([]).shown("r")).toBe("false");
  });

  it("refuses statuses and aliases that are not plain identifiers", () => {
    expect(() => legacyVisibility(["accepted'; drop table x;--"])).toThrow("Relation statuses");
    expect(() => legacyVisibility(["accepted"]).shown("r; drop")).toThrow("Unsafe SQL alias");
    expect(() => bandVisibility().applied("1r")).toThrow("Unsafe SQL alias");
  });

  it("follows decision D9 once the band columns exist", () => {
    const visibility = bandVisibility();
    expect(visibility.id).toBe("v2-band");
    expect(visibility.requires).toEqual([
      "atomic_note_relations.band",
      "atomic_note_relations.vetoed_at"
    ]);
    // Applied: a human accept, or an unvetoed pending relation with band apply or no band.
    const applied = visibility.applied("r");
    expect(applied).toContain("r.status::text = 'accepted'");
    expect(applied).toContain("r.vetoed_at is null");
    expect(applied).toContain("r.band = 'apply' or r.band is null");
    // Shown adds the unvetoed suggestions.
    const shown = visibility.shown("r");
    expect(shown).toContain(applied);
    expect(shown).toContain("r.band = 'suggest'");
  });

  it("chooses the band reading only when both columns are there", () => {
    const columns = new Set(["atomic_note_relations.band", "atomic_note_relations.vetoed_at"]);
    const has = (table: string, column: string) => columns.has(`${table}.${column}`);
    expect(chooseVisibility(has, ["accepted"]).id).toBe("v2-band");
    columns.delete("atomic_note_relations.vetoed_at");
    expect(chooseVisibility(has, ["accepted"]).id).toBe("legacy-status");
    expect(chooseVisibility(() => false, ["rejected"]).shown("r")).toBe(
      "r.status::text in ('rejected')"
    );
  });
});
