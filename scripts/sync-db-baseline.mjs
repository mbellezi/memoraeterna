import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const journalPath = resolve(root, "packages/db/drizzle/meta/_journal.json");
const seedPath = resolve(root, "packages/db/seed/baseline.sql");
const manifestPath = resolve(root, "packages/db/seed/manifest.json");
const journal = JSON.parse(await readFile(journalPath, "utf8"));
const tags = journal.entries.map((entry) => entry.tag);
const migrations = await Promise.all(
  tags.map((tag) => readFile(resolve(root, `packages/db/drizzle/${tag}.sql`), "utf8"))
);

await writeFile(seedPath, migrations.join("\n\n"));
await writeFile(manifestPath, `${JSON.stringify({
  version: 1,
  seedFile: "baseline.sql",
  includedMigrations: tags
}, null, 2)}\n`);

console.info(`Synchronized baseline seed with ${tags.length} migration(s).`);
