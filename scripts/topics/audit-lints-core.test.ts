import { describe, expect, it } from "vitest";

import { lintsUsage, parseLintsArgs, renderLintsMarkdown } from "./audit-lints-core.js";
import type { LintsReport } from "./audit-lints-core.js";

const report: LintsReport = {
  generatedAt: "2026-10-24T00:00:00.000Z",
  database: { host: "localhost", name: "env-g" },
  tree: {
    id: "00000000-0000-4000-8000-000000000001",
    generation: 12,
    spaceKey: "local:test",
    dimensions: 1024,
    topics: 40,
    retiredTopics: 7,
    notes: 1000
  },
  duplicates: {
    examined: 1000,
    pairs: 2,
    byReason: { vector: 1, title: 1, both: 0 },
    genericTitleGroups: 3,
    cosines: { min: 0.98, median: 0.98, max: 0.98 },
    listed: [
      { notes: ["a", "b"], cosine: 0.98, reason: "vector" },
      { notes: ["c", "d"], cosine: null, reason: "title" }
    ],
    ms: 1234
  },
  brokenLinks: {
    checked: 20,
    broken: 1,
    byReason: { missing: 1 },
    listed: [{ address: "memora://note/x", reason: "missing" }],
    ms: 5
  },
  staleEmbeddings: { missing: 2, editedExamined: 10, content: 1, ms: 80 },
  redirects: {
    retired: 5,
    direct: 3,
    chains: 1,
    longestChain: 3,
    deadEnds: 1,
    unresolved: 0,
    listed: [{ topicId: "t1", from: "t2", to: "t3", hops: 3 }],
    ms: 1
  },
  themeDrift: {
    measured: 30,
    threshold: 0.55,
    below: 2,
    percentiles: { p05: 0.4, p50: 0.7, p95: 0.9 },
    listed: [{ topicId: "t4", cosine: 0.31 }],
    ms: 2
  },
  replacement: {
    share: 1,
    eligible: 1000,
    sampled: 1000,
    candidates: 1,
    listed: [{ item: "note:1", from: "t5", to: "t6", gain: 0.2 }],
    ms: 60
  }
};

describe("the lint dry run's command line", () => {
  it("needs a database and reads the options", () => {
    expect(parseLintsArgs(["--help"])).toEqual({ kind: "help" });
    expect(() => parseLintsArgs([])).toThrow("--db is required");
    expect(parseLintsArgs(["--db", "postgres://u:p@localhost/db"])).toMatchObject({
      kind: "run",
      treeId: null,
      share: 1,
      listed: 10
    });
    expect(
      parseLintsArgs([
        "--db",
        "c.json",
        "--tree",
        "00000000-0000-4000-8000-000000000001",
        "--share",
        "0.01",
        "--listed",
        "3",
        "--out",
        "r.md"
      ])
    ).toMatchObject({
      treeId: "00000000-0000-4000-8000-000000000001",
      share: 0.01,
      listed: 3,
      out: "r.md"
    });
  });

  it("refuses values out of range", () => {
    expect(() => parseLintsArgs(["--db", "x", "--share", "2"])).toThrow("--share");
    expect(() => parseLintsArgs(["--db", "x", "--tree", "nope"])).toThrow("--tree");
    expect(() => parseLintsArgs(["--db", "x", "--listed", "-1"])).toThrow("--listed");
    expect(lintsUsage).toContain("Read-only");
  });
});

describe("the lint dry run's report", () => {
  it("states every lint's count and lists identifiers only", () => {
    const markdown = renderLintsMarkdown(report);
    for (const heading of [
      "## Duplicate notes",
      "## Broken links",
      "## Stale embeddings",
      "## Redirect chains",
      "## Theme drift",
      "## Rolling re-placement"
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("duplicate pairs 2 (vector 1, title 1, both 0)");
    expect(markdown).toContain("p05 0.400, p50 0.700, p95 0.900");
    expect(markdown).toContain("chains to compress 1 (longest 3 redirects)");
    expect(markdown).toContain("memora://note/x");
  });

  it("renders a library with nothing found", () => {
    const empty: LintsReport = {
      ...report,
      duplicates: { ...report.duplicates, pairs: 0, cosines: null, listed: [] },
      brokenLinks: { ...report.brokenLinks, broken: 0, byReason: {}, listed: [] },
      themeDrift: { ...report.themeDrift, below: 0, percentiles: null, listed: [] },
      redirects: { ...report.redirects, chains: 0, listed: [] },
      replacement: { ...report.replacement, candidates: 0, listed: [] }
    };
    const markdown = renderLintsMarkdown(empty);
    expect(markdown).toContain("duplicate pairs 0");
    expect(markdown).toContain("broken 0;");
  });
});
