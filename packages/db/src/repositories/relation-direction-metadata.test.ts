import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// F3 D8: a note relation's direction is its `direction` column. The matching metadata keys that
// held it before relations v2 are read only by the migration that backfilled the column and by
// its verify script, and no code writes them any more (`metadata` itself is never rewritten).
const workspace = resolve(import.meta.dirname, "../../../..");
const allowed = new Set([
  "packages/db/drizzle/0056_relations_v2.sql",
  "packages/db/seed/baseline.sql",
  "packages/db/src/scripts/verify-relations-v2.ts",
  "packages/db/src/repositories/relation-direction-metadata.test.ts"
]);
// Split so that this file's own text does not name the keys.
const keys = ["semanticSource", "semanticTarget"].map((prefix) => `${prefix}AtomicNoteId`);

function codeFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: workspace,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024
  })
    .split("\0")
    .filter((file) => /\.(?:[cm]?[jt]s|tsx|sql)$/u.test(file))
    .filter((file) => !allowed.has(file) && existsSync(resolve(workspace, file)));
}

describe("the legacy direction metadata keys (D8)", () => {
  it("are named only by migration 0056 and its verify script", () => {
    const uses = codeFiles().flatMap((file) => {
      const text = readFileSync(resolve(workspace, file), "utf8");
      return keys.filter((key) => text.includes(key)).map((key) => `${file}: ${key}`);
    });
    expect(uses).toEqual([]);
  });
});
