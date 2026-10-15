import { defaultTopicTreeConfig } from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";
import { describe, expect, it } from "vitest";

import { analyzeTopicTree } from "./audit-core.js";
import type { AuditInput, AuditPlacement, AuditTopic } from "./audit-core.js";
import { auditUsage, parseAuditArgs, renderAuditMarkdown } from "./audit-render.js";

describe("parseAuditArgs", () => {
  const tree = "00000000-0000-4000-8000-000000000123";

  it("parses a full command", () => {
    expect(
      parseAuditArgs([
        "--db",
        "conn.json",
        "--tree",
        tree,
        "--areas",
        "on",
        "--as-of",
        "2026-10-15T12:00:00Z",
        "--undo-days",
        "14",
        "--limit",
        "20",
        "--out",
        "audit.md",
        "--json",
        "audit.json"
      ])
    ).toEqual({
      kind: "run",
      db: "conn.json",
      treeId: tree,
      areas: "on",
      asOf: new Date("2026-10-15T12:00:00Z"),
      undoWindowDays: 14,
      limit: 20,
      out: "audit.md",
      json: "audit.json"
    });
  });

  it("audits the active tree to stdout over the last week by default", () => {
    expect(parseAuditArgs(["--db", "postgres://u@h/d", "--as-of", "now"])).toEqual({
      kind: "run",
      db: "postgres://u@h/d",
      treeId: null,
      areas: "auto",
      asOf: null,
      undoWindowDays: 7,
      limit: 100,
      out: null,
      json: null
    });
  });

  it("prints the usage on --help, and refuses what it cannot run", () => {
    expect(parseAuditArgs(["--help"])).toEqual({ kind: "help" });
    expect(auditUsage).toContain("--db");
    expect(() => parseAuditArgs([])).toThrow("--db is required.");
    expect(() => parseAuditArgs(["--db", "x", "--tree", "not-a-uuid"])).toThrow(
      "--tree must be a UUID."
    );
    expect(() => parseAuditArgs(["--db", "x", "--areas", "maybe"])).toThrow(
      '--areas must be auto, on or off, got "maybe".'
    );
    expect(() => parseAuditArgs(["--db", "x", "--as-of", "yesterday"])).toThrow("--as-of");
    expect(() => parseAuditArgs(["--db", "x", "--undo-days", "0"])).toThrow("--undo-days");
    expect(() => parseAuditArgs(["--db", "x", "--limit", "1.5"])).toThrow("--limit");
    expect(() => parseAuditArgs(["--db", "x", "--wat"])).toThrow();
  });
});

describe("renderAuditMarkdown", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const topic = (
    n: number,
    parent: number | null,
    extra: Partial<AuditTopic> = {}
  ): AuditTopic => ({
    id: uuid(n),
    parentId: parent === null ? null : uuid(parent),
    role: parent === null ? "root" : "topic",
    title: `SECRET-TITLE ${n}`,
    management: "ai",
    position: n,
    retiredAt: null,
    redirectTo: null,
    ...extra
  });
  const place = (item: ItemKey, at: number): AuditPlacement => ({
    item,
    topicId: uuid(at),
    rank: 0,
    management: "ai",
    needsGate: false,
    needsSplitCheck: false,
    needsVector: false
  });
  const note = (n: number): ItemKey => `note:${uuid(1000 + n)}`;

  const input = (unplacedItems: number): AuditInput => {
    const notes = Array.from({ length: 6 + unplacedItems }, (_, n) => note(n));
    return {
      tree: { id: uuid(900), status: "active", generation: 4, consistent: true },
      config: defaultTopicTreeConfig,
      topics: [topic(1, null), topic(2, 1), topic(3, 1)],
      placements: notes.slice(0, 6).map((item, n) => place(item, n < 3 ? 2 : 3)),
      expectedItems: notes,
      areasActive: false,
      undo: { days: 7, automatic: 10, undone: 0 }
    };
  };
  const render = (unplacedItems: number, limit = 100) =>
    renderAuditMarkdown(
      analyzeTopicTree(input(unplacedItems), {
        limit,
        now: () => "2026-10-15T12:00:00.000Z"
      })
    );

  it("says PASS and lists nothing for a sound tree", () => {
    const markdown = render(0);
    expect(markdown).toContain("# Topic tree audit");
    expect(markdown).toContain("| E1 (reachability 100%, 0 orphans, 0 hard violations) | PASS |");
    expect(markdown).toContain("Reachable from the root (E1) | 6 of 6 (100.00%)");
    expect(markdown).toContain("_Nothing to list._");
  });

  it("names the failing criteria and lists identifiers but never titles", () => {
    const markdown = render(3);
    expect(markdown).toContain("FAIL: reachability, itemsWithoutPrimary, hardViolations");
    expect(markdown).toContain("Reachable from the root (E1) | 6 of 9 (66.67%)");
    expect(markdown).toContain("Expected items without a primary placement (3):");
    expect(markdown).toContain(note(6));
    expect(markdown).toContain("| I1 | hard | item-unplaced |");
    expect(markdown).not.toContain("SECRET-TITLE");
  });

  it("says how many entries a cut list shows", () => {
    expect(render(3, 2)).toContain("Expected items without a primary placement (3, first 2):");
  });
});
