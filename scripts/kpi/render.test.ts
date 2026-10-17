import { describe, expect, it } from "vitest";

import { fmtInt, fmtPair, fmtPercent, fmtSeconds, renderMarkdown, table } from "./render.js";
import type { KpiReport } from "./report.js";

describe("number formatting", () => {
  it("keeps precision proportional to magnitude", () => {
    expect(fmtSeconds(0.1234)).toBe("0.12");
    expect(fmtSeconds(12.34)).toBe("12.3");
    expect(fmtSeconds(123.4)).toBe("123");
    expect(fmtSeconds(null)).toBe("n/a");
  });

  it("formats integers with thousands separators and unknowns as n/a", () => {
    expect(fmtInt(1234567)).toBe("1,234,567");
    expect(fmtInt(0)).toBe("0");
    expect(fmtInt(null)).toBe("n/a");
    expect(fmtInt(undefined)).toBe("n/a");
  });

  it("formats percentiles and shares", () => {
    expect(fmtPair({ n: 3, min: 1, p50: 2, p95: 25.5, max: 30, mean: 10, sum: 30 })).toBe(
      "2.00 / 25.5"
    );
    expect(fmtPair(null)).toBe("n/a");
    expect(fmtPercent(2 / 3)).toBe("66.7%");
    expect(fmtPercent(null)).toBe("n/a");
  });
});

describe("table", () => {
  it("renders a Markdown table and escapes pipes", () => {
    expect(table(["A", "B"], [["x|y", 2]])).toBe("| A | B |\n| --- | --- |\n| x\\|y | 2 |\n");
  });

  it("says when there are no rows", () => {
    expect(table(["A"], [])).toBe("_none_\n");
  });
});

describe("renderMarkdown", () => {
  const unavailable = (reason: string) => ({ available: false as const, reason });
  const report: KpiReport = {
    schemaVersion: 1,
    generatedAt: "2026-10-14T00:00:00.000Z",
    asOf: { value: null, basis: "latest-activity" },
    database: {
      host: "127.0.0.1",
      port: 61108,
      name: "memora_app",
      label: "owner",
      provenance: {
        sourceName: "automatic-wiki-20260912/dev-clean-wiki-before-a8.dump",
        sha256: "0123456789abcdef".repeat(4),
        dumpCreatedAt: null
      },
      migrations: { applied: 42, latestAt: null },
      instrumentation: {
        stageAttempts: false,
        aiQueueMs: false,
        aiAttempt: false,
        aiLanes: false,
        monitoring: true
      }
    },
    library: unavailable("missing table source_items"),
    processing: unavailable("missing table ingestion_run_stages"),
    ai: unavailable("missing table ai_task_runs"),
    matching: unavailable("missing table ai_task_runs"),
    topics: unavailable("missing table topic_trees"),
    wiki: unavailable("missing table wiki_pages"),
    organization: unavailable("missing table organization_runs"),
    maintenance: unavailable("missing table maintenance_runs"),
    jobs: unavailable("missing table jobs"),
    gaps: ["wiki: missing table wiki_pages"]
  };

  it("renders every section with its reason when a database cannot answer", () => {
    const markdown = renderMarkdown(report);
    for (const heading of [
      "## Library",
      "## Processing",
      "## AI usage",
      "## Matching",
      "## Topic tree",
      "## Wiki structure",
      "## Organization runs",
      "## Maintenance runs",
      "## Jobs",
      "## Not measurable on this database"
    ])
      expect(markdown).toContain(heading);
    expect(markdown).toContain("_Not available: missing table wiki_pages._");
    expect(markdown).toContain("_Not available: missing table topic_trees._");
    expect(markdown).toContain("- wiki: missing table wiki_pages");
    expect(markdown).toContain("owner (127.0.0.1:61108/memora_app)");
    expect(markdown).toContain("sha256 0123456789ab");
  });
});
