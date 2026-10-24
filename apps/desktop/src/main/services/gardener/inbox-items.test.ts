import { describe, expect, it } from "vitest";

import { inboxVariants } from "@app/domain";

import {
  budgetVariant,
  isUuid,
  obsidianItem,
  parseChangeSetItemId,
  parseQuarantineItemId,
  quarantineVariant
} from "./inbox-items.js";

const id = "00000000-0000-4000-8000-000000000001";

describe("the IDs of Inbox items", () => {
  it("reads a change-set as its store and UUID, and refuses anything else", () => {
    expect(parseChangeSetItemId(`topic:${id}`)).toEqual({ kind: "topic", id });
    expect(parseChangeSetItemId(`RELATION:${id}`)).toBeNull();
    expect(parseChangeSetItemId(`overview:${id.toUpperCase()}`)).toEqual({ kind: "overview", id });
    for (const bad of ["", id, `memo:${id}`, `topic:${id}:x`, "topic:not-a-uuid", `topic:`])
      expect(parseChangeSetItemId(bad), bad).toBeNull();
  });

  it("reads a quarantined subject as its task kind and subject key", () => {
    expect(parseQuarantineItemId(`topic-overview|note:${id}`)).toEqual({
      kind: "topic-overview",
      subjectKey: `note:${id}`
    });
    expect(parseQuarantineItemId("a|b|c")).toEqual({ kind: "a", subjectKey: "b|c" });
    for (const bad of ["", "|x", "x|", "nobar"]) expect(parseQuarantineItemId(bad), bad).toBeNull();
  });

  it("tells a UUID from anything else", () => {
    expect(isUuid(id)).toBe(true);
    expect(isUuid("1")).toBe(false);
    expect(isUuid(`${id} `)).toBe(false);
  });
});

describe("the variants an item takes", () => {
  it("maps a task kind to one of the quarantine tasks the interface words", () => {
    expect(quarantineVariant("topic-overview")).toBe("refresh");
    expect(quarantineVariant("relation-match")).toBe("match");
    expect(quarantineVariant("not-a-kind")).toBe("other");
    for (const kind of ["topic-overview", "relation-match", "not-a-kind", "ingestion"])
      expect(inboxVariants.quarantined).toContain(quarantineVariant(kind));
  });

  it("reads a budget item's variant from its fingerprint", () => {
    expect(budgetVariant("money_80:2026-10")).toBe("money_80");
    expect(budgetVariant("money_100:2026-10")).toBe("money_100");
    expect(budgetVariant("something:else")).toBe("money_80");
  });

  it("makes an Obsidian conflict a medium-risk item with no verb", () => {
    expect(
      obsidianItem(
        { id, path: "Notes/a.md", variant: "projection", at: null },
        "1970-01-01T00:00:00.000000Z"
      )
    ).toMatchObject({
      kind: "obsidian_conflict",
      id: `projection:${id}`,
      risk: "medium",
      variant: "projection",
      params: { path: "Notes/a.md" },
      actions: []
    });
    expect(
      obsidianItem(
        { id, path: "x".repeat(500), variant: "deleted", at: null },
        "1970-01-01T00:00:00.000000Z"
      ).params.path
    ).toHaveLength(300);
    expect(
      obsidianItem(
        { id, path: "a.md", variant: "deleted", at: null },
        "1970-01-01T00:00:00.000000Z"
      ).id
    ).toBe(`editorial:${id}`);
  });
});
