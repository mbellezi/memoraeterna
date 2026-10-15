import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// D9: the engine is the single writer of the topic tree. Only `topicTreeRepository.ts` writes the
// structure tables and the engine's logs; the database guard is the second enforcement. Tests are
// exempt (they probe the guard); a verify script may probe it only in statements marked as such.
const workspace = resolve(import.meta.dirname, "../../../..");
const writer = "packages/db/src/repositories/topicTreeRepository.ts";
const probeScript = "packages/db/src/scripts/verify-topic-tree.ts";
const probeMarker = "D9 guard probe";

const tables = [
  "topic_trees",
  "topics",
  "topic_stats",
  "topic_placements",
  "topic_change_sets",
  "topic_structure_events",
  "topic_gate_decisions",
  "topic_daily_metrics",
  "topic_calibrations"
];
const drizzleTables = [
  "topicTrees",
  "topics",
  "topicStats",
  "topicPlacements",
  "topicChangeSets",
  "topicStructureEvents",
  "topicGateDecisions",
  "topicDailyMetrics",
  "topicCalibrations"
];

const sqlWrite = new RegExp(
  `\\b(?:insert\\s+into|update|delete\\s+from|truncate(?:\\s+table)?|alter\\s+table|copy)\\s+` +
    `(?:only\\s+)?(?:public\\.)?"?(${tables.join("|")})"?(?![\\w.])`,
  "giu"
);
const drizzleWrite = new RegExp(
  `\\.(?:insert|update|delete)\\(\\s*(?:schema\\.)?(${drizzleTables.join("|")})\\s*\\)`,
  "gu"
);

const isTest = (file: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) || /(^|\/)__fixtures__\//u.test(file);

function topicTableWrites(file: string, text: string): string[] {
  const writes: string[] = [];
  for (const pattern of [sqlWrite, drizzleWrite]) {
    for (const match of text.matchAll(pattern)) {
      const window = text.slice(Math.max(0, (match.index ?? 0) - 160), match.index);
      if (file === probeScript && window.includes(probeMarker)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      writes.push(`${file}:${line} ${match[0].replace(/\s+/gu, " ")}`);
    }
  }
  return writes;
}

function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/u.test(file) && !isTest(file))
    .filter((file) => existsSync(resolve(workspace, file)));
}

describe("the topic tree has a single writer (D9)", () => {
  it("finds no write to a topic table outside topicTreeRepository.ts", () => {
    const writes = sourceFiles()
      .filter((file) => file !== writer)
      .flatMap((file) => topicTableWrites(file, readFileSync(resolve(workspace, file), "utf8")));
    expect(writes).toEqual([]);
  });

  it("recognizes raw SQL and Drizzle writes, and only marked probes in the verify script", () => {
    expect(topicTableWrites("a.ts", 'db.query("update topics set parent_id = $1")')).toHaveLength(
      1
    );
    expect(
      topicTableWrites("a.ts", "insert into public.topic_placements (id) values ($1)")
    ).toHaveLength(1);
    expect(topicTableWrites("a.ts", "DELETE FROM topic_stats WHERE dirty")).toHaveLength(1);
    expect(topicTableWrites("a.ts", "db.insert(topicChangeSets).values(row)")).toHaveLength(1);
    expect(topicTableWrites("a.ts", "select * from topics where id = $1")).toEqual([]);
    expect(topicTableWrites("a.ts", "insert into topic_overviews (topic_id) values ($1)")).toEqual(
      []
    );
    expect(
      topicTableWrites(probeScript, `/* ${probeMarker} */ "update topics set parent_id = $2"`)
    ).toEqual([]);
    expect(
      topicTableWrites("other.ts", `/* ${probeMarker} */ "update topics set x = 1"`)
    ).toHaveLength(1);
  });

  it("the writer itself writes every structure table", () => {
    const text = readFileSync(resolve(workspace, writer), "utf8");
    for (const table of tables) {
      expect(text, table).toMatch(
        new RegExp(`(?:insert\\s+into|update|delete\\s+from)\\s+${table}\\b`, "u")
      );
    }
  });
});
