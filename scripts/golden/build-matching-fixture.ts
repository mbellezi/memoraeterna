/**
 * Builds the matching-quality golden fixture from the expanded DEV matching benchmark.
 *
 *   npx tsx scripts/golden/build-matching-fixture.ts            write sources, manifest and mapping
 *   npx tsx scripts/golden/build-matching-fixture.ts --verify   offline check of what is on disk
 *   npx tsx scripts/golden/build-matching-fixture.ts --fixture <file>   another benchmark file
 *
 * Writes `.cache/golden/sources/mf-*.md` (the folder the golden runner reads), and
 * `.cache/golden/matching-fixture/manifest.json` (golden manifest, pins computed here) and
 * `mapping.json` (benchmark ids, partitions, expected and forbidden root pairs). Everything is
 * generated and gitignored; the build is deterministic, so rebuilding changes nothing unless the
 * benchmark file changed (which would invalidate recorded cassettes).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  goldenManifestFiles,
  goldenManifestSchema,
  goldenSourcePath,
  verifyGoldenFile
} from "../../apps/desktop/src/main/services/golden-runner.ts";
import {
  buildMatchingFixture,
  matchingFixtureManifestPath,
  matchingFixtureMappingPath,
  parseMatchingFixture
} from "./matching-fixture.ts";

const root = resolve(import.meta.dirname, "..", "..");
const defaultFixture = "scripts/fixtures/matching-benchmark.json";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { verify: { type: "boolean" }, fixture: { type: "string" } },
  strict: true,
  allowPositionals: false
});

const fixturePath = values.fixture ?? defaultFixture;
const text = await readFile(resolve(root, fixturePath), "utf8");
const fixture = parseMatchingFixture(JSON.parse(text));
const built = buildMatchingFixture(fixture, { path: fixturePath, text });
const manifest = goldenManifestSchema.parse(built.manifest);
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const generated = [
  { path: join(root, matchingFixtureManifestPath), text: json(built.manifest) },
  { path: join(root, matchingFixtureMappingPath), text: json(built.mapping) }
];

if (values.verify) {
  const problems: string[] = [];
  for (const file of goldenManifestFiles(manifest)) {
    const check = await verifyGoldenFile(goldenSourcePath(root, file), file);
    if (check.status !== "ok") problems.push(`${file.key}: ${check.status}`);
  }
  for (const item of generated) {
    const current = await readFile(item.path, "utf8").catch(() => null);
    if (current !== item.text)
      problems.push(
        `${item.path.slice(root.length + 1)}: ${current === null ? "missing" : "differs"}`
      );
  }
  if (problems.length) {
    console.error(
      `Not in sync with ${fixturePath} (run without --verify):\n- ${problems.join("\n- ")}`
    );
    process.exit(1);
  }
  console.log(
    `${goldenManifestFiles(manifest).length} files, manifest and mapping match ${fixturePath}`
  );
} else {
  for (const file of built.files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  for (const item of generated) {
    await mkdir(dirname(item.path), { recursive: true });
    await writeFile(item.path, item.text);
  }
  const partitions = (partition: string) =>
    built.mapping.roots.filter((rootEntry) => rootEntry.partition === partition).length;
  const labelled = (list: ReadonlyArray<{ partition: string }>, partition: string) =>
    list.filter((entry) => entry.partition === partition).length;
  console.log(
    [
      `${built.mapping.roots.length} roots (${partitions("tuning")} tuning, ${partitions("holdout")} held-out), ` +
        `${built.files.length} Markdown files in .cache/golden/sources/`,
      `manifest ${matchingFixtureManifestPath}`,
      `mapping  ${matchingFixtureMappingPath}`,
      `held-out pairs: ${labelled(built.mapping.expectedRootPairs, "holdout")} expected, ` +
        `${labelled(built.mapping.forbiddenRootPairs, "holdout")} forbidden; ` +
        `tuning pairs: ${labelled(built.mapping.expectedRootPairs, "tuning")} expected, ` +
        `${labelled(built.mapping.forbiddenRootPairs, "tuning")} forbidden`,
      `MEMORA_GOLDEN_ONLY for the held-out pairs only (${built.mapping.subsets.holdout.length} roots): ` +
        built.mapping.subsets.holdout.join(",")
    ].join("\n")
  );
}
