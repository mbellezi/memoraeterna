import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { topicOverviewSql } from "./topicOverviewRepository.js";

// The SQL runs against a real database in `npm run db:topic-overview:verify` (migration shape,
// writes, citations, citedBy with EXPLAIN) and in the overview service's sidecar test; these tests
// pin the statements' boundaries and the single writer of the overview tables.
const workspace = resolve(import.meta.dirname, "../../../..");
const writer = "packages/db/src/repositories/topicOverviewRepository.ts";
const probeScript = "packages/db/src/scripts/verify-topic-overview.ts";
const probeMarker = "overview constraint probe";

const overviewWrite =
  /\b(?:insert\s+into|update|delete\s+from|truncate(?:\s+table)?|alter\s+table|copy)\s+(?:only\s+)?(?:public\.)?"?(topic_overviews|topic_overview_citations)"?(?![\w.])/giu;
const drizzleWrite =
  /\.(?:insert|update|delete)\(\s*(?:schema\.)?(topicOverviews|topicOverviewCitations)\s*\)/gu;

const isTest = (file: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)__fixtures__\//u.test(file);

function overviewWrites(file: string, text: string): string[] {
  const writes: string[] = [];
  for (const pattern of [overviewWrite, drizzleWrite]) {
    for (const match of text.matchAll(pattern)) {
      const window = text.slice(Math.max(0, (match.index ?? 0) - 160), match.index);
      if (file === probeScript && window.includes(probeMarker)) continue;
      writes.push(`${file}:${text.slice(0, match.index).split("\n").length} ${match[0]}`);
    }
  }
  return writes;
}

describe("the overview tables have a single writer (D9)", () => {
  it("finds no write to them outside topicOverviewRepository.ts", () => {
    const files = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      {
        cwd: workspace,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024
      }
    )
      .split("\0")
      .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/u.test(file) && !isTest(file) && file !== writer)
      .filter((file) => existsSync(resolve(workspace, file)));
    const writes = files.flatMap((file) =>
      overviewWrites(file, readFileSync(resolve(workspace, file), "utf8"))
    );
    expect(writes).toEqual([]);
  });

  it("recognizes raw and Drizzle writes, and only marked probes in the verify script", () => {
    expect(
      overviewWrites("a.ts", "insert into topic_overviews (topic_id) values ($1)")
    ).toHaveLength(1);
    expect(overviewWrites("a.ts", "DELETE FROM topic_overview_citations")).toHaveLength(1);
    expect(overviewWrites("a.ts", "db.insert(topicOverviews).values(row)")).toHaveLength(1);
    expect(overviewWrites("a.ts", "select * from topic_overviews")).toEqual([]);
    expect(
      overviewWrites(probeScript, `/* ${probeMarker} */ "insert into topic_overviews (x)"`)
    ).toEqual([]);
    expect(
      overviewWrites("other.ts", `/* ${probeMarker} */ "insert into topic_overviews (x)"`)
    ).toHaveLength(1);
  });
});

describe("topic overview statements", () => {
  it("read the topic tables without writing them", () => {
    for (const [name, statement] of Object.entries(topicOverviewSql)) {
      expect(statement, name).not.toMatch(
        /\b(?:insert\s+into|update|delete\s+from)\s+(?:topics|topic_placements|topic_trees|topic_stats)\b/iu
      );
    }
  });

  it("reach placements per topic through the index and bound every list", () => {
    for (const name of ["members", "evidence"] as const) {
      const statement = topicOverviewSql[name];
      // Each topic of the subtree is probed by itself (the fence keeps the planner from scanning).
      expect(statement, name).toContain("where q.topic_id = sub.id and q.role = 'primary'");
      expect(statement, name).toContain("offset 0) c");
      expect(statement, name).toContain("k.tree_id = $2::uuid and k.parent_id = sub.id");
    }
    expect(topicOverviewSql.evidence).toContain("limit $3::int");
    expect(topicOverviewSql.evidence).toContain("limit $4::int");
  });

  it("use only current notes and passages as evidence, and keep replaced ones as unavailable citations", () => {
    expect(topicOverviewSql.evidence).toContain("n.status not in ('rejected', 'archived')");
    expect(topicOverviewSql.evidence).toContain("n.supersession_status = 'current'");
    expect(topicOverviewSql.evidence).toContain("supersededByDocumentId");
    expect(topicOverviewSql.stored).toContain(
      "'available', ch.id is not null and not coalesce(d.metadata ? 'supersededByDocumentId', false)"
    );
    // A chunk, span or note gone since the evidence was read becomes null instead of failing.
    expect(topicOverviewSql.saveCitations).toContain("left join chunks ch on ch.id = c.chunk_id");
    expect(topicOverviewSql.saveCitations).toContain(
      "left join atomic_notes nt on nt.id = c.note_id"
    );
  });

  it("write only for a live topic, and record a verdict only for its own writing", () => {
    expect(topicOverviewSql.save).toContain(
      "where exists (select 1 from topics t where t.id = $1::uuid and t.retired_at is null)"
    );
    expect(topicOverviewSql.saveSupport).toContain("written_at = $2::timestamptz");
  });
});
