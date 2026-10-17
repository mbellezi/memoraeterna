import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// F3 D36: claims stay stopped. The knowledge-graph stage extracts entities and relations from chunks
// and writes no claim (decision 14, F1a); the read-side remnants stay until F4. No product module
// inserts into `claims` or `claim_entity_links`, whatever else it does with them (the source deletion
// reads and removes them, the graph repository reads them). Tests and the database verification
// scripts (packages/db/src/scripts and the repository's scripts/ folder: they build rows to probe
// constraints) are exempt; the rule covers the code the application ships.
const workspace = resolve(import.meta.dirname, "../../../..");

const tables = ["claims", "claim_entity_links"];
const drizzleTables = ["claims", "claimEntityLinks"];

const sqlInsert = new RegExp(
  `\\b(?:insert\\s+into|copy)\\s+(?:public\\.)?"?(${tables.join("|")})"?(?![\\w.])`,
  "giu"
);
const drizzleInsert = new RegExp(
  `\\.insert\\(\\s*(?:schema\\.)?(${drizzleTables.join("|")})\\s*\\)`,
  "gu"
);

const isProduct = (file: string): boolean =>
  /^(?:apps|packages)\/[^/]+\/src\//u.test(file) &&
  !/\.(test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
  !/(^|\/)__fixtures__\//u.test(file) &&
  !file.startsWith("packages/db/src/scripts/");

function claimInserts(file: string, text: string): string[] {
  const writes: string[] = [];
  for (const pattern of [sqlInsert, drizzleInsert])
    for (const match of text.matchAll(pattern)) {
      const line = text.slice(0, match.index).split("\n").length;
      writes.push(`${file}:${line} ${match[0].replace(/\s+/gu, " ")}`);
    }
  return writes;
}

function productFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter((file) => /\.(?:[cm]?[jt]s|tsx)$/u.test(file) && isProduct(file))
    .filter((file) => existsSync(resolve(workspace, file)));
}

describe("claims stay stopped (F3 D36)", () => {
  it("finds no product module that inserts into claims or claim_entity_links", () => {
    const writes = productFiles().flatMap((file) =>
      claimInserts(file, readFileSync(resolve(workspace, file), "utf8"))
    );
    expect(writes).toEqual([]);
  });

  it("would notice an insert (the pattern itself)", () => {
    expect(
      claimInserts("x.ts", "await pool.query(`insert into claims (text) values ($1)`)")
    ).toHaveLength(1);
    expect(
      claimInserts("x.ts", "INSERT\n  INTO public.claim_entity_links (a) values (1)")
    ).toHaveLength(1);
    expect(claimInserts("x.ts", "await db.insert(claims).values(row)")).toHaveLength(1);
    expect(
      claimInserts("x.ts", "await db.insert(schema.claimEntityLinks).values(row)")
    ).toHaveLength(1);
    // Reads and deletes are the read-side remnants and stay allowed.
    expect(
      claimInserts("x.ts", "select 1 from claims; delete from claim_entity_links where a = 1")
    ).toEqual([]);
  });
});
