// Exports the 150 notes of the synthetic matching benchmark in the Spike B corpus
// item format (text = title + idea + body; domain = the fixture family of the
// note's root source).
//
//   npx tsx scripts/spikes/corpus/export-benchmark-notes.ts
//
// Reads .cache/matching-benchmark/validate/results.json and .cache/matching-benchmark/manifest.json
// (local, gitignored) plus scripts/fixtures/matching-benchmark.json; writes
// .cache/spikes/topic-tree/benchmark-notes.jsonl.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";

import { corpusItemSchema, guessLanguage, writeJsonl } from "./items.js";
import type { CorpusItem } from "./items.js";

const repoRoot = resolve(import.meta.dirname, "../../..");
const benchmarkDir = join(repoRoot, ".cache", "matching-benchmark");
const resultsPath = join(benchmarkDir, "validate", "results.json");
const manifestPath = join(benchmarkDir, "manifest.json");
const fixturePath = join(repoRoot, "scripts", "fixtures", "matching-benchmark.json");
const outputPath = join(repoRoot, ".cache", "spikes", "topic-tree", "benchmark-notes.jsonl");

const resultsSchema = z.object({
  sources: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      parent_source_item_id: z.string().nullable()
    })
  ),
  notes: z.array(
    z.object({
      id: z.string(),
      created_from_source_item_id: z.string(),
      title: z.string(),
      idea_statement: z.string().nullable(),
      body_markdown: z.string().nullable()
    })
  )
});
const manifestSchema = z.object({ ids: z.record(z.string(), z.string()) });
const fixtureSchema = z.object({
  sources: z.array(z.object({ key: z.string(), family: z.string() }))
});

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(path, "utf8")));
}

const results = await readJson(resultsPath, resultsSchema);
const manifest = await readJson(manifestPath, manifestSchema);
const fixture = await readJson(fixturePath, fixtureSchema);

const sources = new Map(results.sources.map((source) => [source.id, source]));
const keyById = new Map(Object.entries(manifest.ids).map(([key, id]) => [id, key]));
const familyByKey = new Map(fixture.sources.map((source) => [source.key, source.family]));

const rootOf = (sourceId: string): { id: string; title: string } => {
  let current = sources.get(sourceId);
  const seen = new Set<string>();
  while (current?.parent_source_item_id && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = sources.get(current.parent_source_item_id);
    if (!parent) break;
    current = parent;
  }
  return current ?? { id: sourceId, title: "(unknown source)" };
};

const items: CorpusItem[] = results.notes.map((note) => {
  const root = rootOf(note.created_from_source_item_id);
  const key = keyById.get(root.id);
  const text = [note.title, note.idea_statement, note.body_markdown]
    .map((part) => part?.trim() ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
  return corpusItemSchema.parse({
    id: note.id,
    lang: guessLanguage(text),
    domain: (key && familyByKey.get(key)) ?? "benchmark",
    articleTitle: root.title,
    title: note.title,
    text
  });
});

await writeJsonl(outputPath, items);
const byDomain = new Map<string, number>();
for (const item of items) byDomain.set(item.domain, (byDomain.get(item.domain) ?? 0) + 1);
console.log(`${items.length} notes -> ${outputPath}`);
console.log(Object.fromEntries([...byDomain.entries()].sort()));
console.log({
  pt: items.filter((item) => item.lang === "pt").length,
  en: items.filter((item) => item.lang === "en").length
});
