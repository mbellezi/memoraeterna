import { describe, expect, it } from "vitest";

import {
  overviewCallsSql,
  overviewReportSql,
  summarizeOverviews,
  type OverviewRow
} from "./overview-report.js";

const row = (overrides: Partial<OverviewRow> = {}): OverviewRow => ({
  topicId: "00000000-0000-4000-8000-000000000001",
  title: "Sleep",
  writtenAt: "2026-10-16 10:00:00+00",
  model: "writer",
  language: "pt-BR",
  memberCount: 12,
  evidenceUsed: 8,
  stale: false,
  support: { status: "verified", sentences: { checked: 6, supported: 6 } },
  citations: 4,
  resolved: 4,
  runExists: true,
  runSources: 2,
  runMs: 9_000,
  queueMs: 1_000,
  ...overrides
});

describe("the overview report", () => {
  it("sums citations, supported sentences, stale overviews, audit rows and writing time", () => {
    const summary = summarizeOverviews(
      [
        row(),
        row({
          stale: true,
          resolved: 3,
          support: { status: "partial", sentences: { checked: 4, supported: 2 } },
          runMs: 19_000,
          queueMs: null,
          runSources: 0
        }),
        row({ support: { status: "unchecked" }, runExists: false, runMs: null })
      ],
      { writer: 3, ranker: 10 }
    );
    expect(summary).toEqual({
      overviews: 3,
      citations: 12,
      resolvedExactly: 11,
      resolvedShare: 0.9167,
      sentences: { checked: 10, supported: 8, share: 0.8 },
      supportStatus: { verified: 1, partial: 1, unchecked: 1 },
      stale: 1,
      audit: { withRun: 2, withSources: 2 },
      writing: { meanMs: 14_500, maxMs: 19_000 },
      calls: { writer: 3, ranker: 10 }
    });
  });

  it("reports nothing measured as null, never as zero shares", () => {
    expect(summarizeOverviews([], { writer: 0, ranker: 0 })).toMatchObject({
      overviews: 0,
      resolvedShare: null,
      sentences: { share: null },
      writing: { meanMs: null, maxMs: null }
    });
  });

  it("only reads", () => {
    for (const statement of [overviewReportSql, overviewCallsSql]) {
      expect(statement).not.toMatch(/\b(insert|update|delete|truncate|create|drop|alter)\b/iu);
    }
    expect(overviewReportSql).toContain("tree.status = 'active'");
    expect(overviewReportSql).toContain("t.retired_at is null");
  });
});
