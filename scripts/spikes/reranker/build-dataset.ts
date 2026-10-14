/**
 * Builds `.cache/spikes/reranker/dataset.json` from the matching benchmark exports.
 *
 *   npx tsx scripts/spikes/reranker/build-dataset.ts
 *
 * Inputs: scripts/fixtures/matching-benchmark.json (root-level labels and the 40/20 partition),
 * .cache/matching-benchmark/manifest.json (fixture key -> source id), and the per-phase
 * results.json files (notes and one diagnostic row per judged candidate).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  datasetPath,
  noteText,
  outputDirectory,
  repositoryRoot,
  type Dataset,
  type Partition,
  type Phase
} from "./dataset.js";
import { pairKey } from "./metrics.js";

const benchmarkDirectory = join(repositoryRoot, ".cache", "matching-benchmark");

const fixtureSchema = z.object({
  sources: z.array(z.object({ key: z.string(), partition: z.enum(["tuning", "holdout"]) })),
  expectedRootPairs: z.array(
    z.object({ pair: z.tuple([z.string(), z.string()]), partition: z.enum(["tuning", "holdout"]) })
  ),
  forbiddenRootPairs: z.array(
    z.object({ pair: z.tuple([z.string(), z.string()]), partition: z.enum(["tuning", "holdout"]) })
  )
});

const resultsSchema = z.object({
  sources: z.array(
    z.object({ id: z.string(), parent_source_item_id: z.string().nullable() }).passthrough()
  ),
  notes: z.array(
    z.object({
      id: z.string(),
      created_from_source_item_id: z.string(),
      title: z.string(),
      idea_statement: z.string(),
      body_markdown: z.string()
    })
  ),
  diagnostics: z.array(
    z.object({
      source_note_id: z.string(),
      target_id: z.string(),
      vector_score: z.number(),
      rerank_score: z.number(),
      final_score: z.number(),
      passed_threshold: z.boolean()
    })
  )
});
type Results = z.infer<typeof resultsSchema>;

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

const fixture = fixtureSchema.parse(
  await readJson(join(repositoryRoot, "scripts", "fixtures", "matching-benchmark.json"))
);
const manifest = z
  .object({ ids: z.record(z.string(), z.string()) })
  .parse(await readJson(join(benchmarkDirectory, "manifest.json")));
const keyBySourceId = new Map(Object.entries(manifest.ids).map(([key, id]) => [id, key]));
const partitionByRoot = new Map<string, Partition>(
  fixture.sources.map((source) => [source.key, source.partition])
);

function rootKey(results: Results, sourceId: string): string {
  const parents = new Map(results.sources.map((s) => [s.id, s.parent_source_item_id]));
  let id = sourceId;
  for (let depth = 0; depth < 10 && parents.get(id); depth += 1) id = parents.get(id)!;
  const key = keyBySourceId.get(id);
  if (!key) throw new Error(`Unknown source id ${id}`);
  return key;
}

const phases: Phase[] = ["baseline", "economy", "coverage", "validate"];
const notes = new Map<string, Dataset["notes"][number]>();
const rows: Dataset["rows"] = [];
for (const phase of phases) {
  const results = resultsSchema.parse(
    await readJson(join(benchmarkDirectory, phase, "results.json"))
  );
  for (const note of results.notes) {
    const root = rootKey(results, note.created_from_source_item_id);
    const partition = partitionByRoot.get(root);
    if (!partition) throw new Error(`Root ${root} is not in the fixture`);
    const text = noteText({
      title: note.title,
      idea: note.idea_statement,
      body: note.body_markdown
    });
    const existing = notes.get(note.id);
    if (existing && existing.text !== text)
      throw new Error(`Note ${note.id} changed between phases`);
    notes.set(note.id, {
      id: note.id,
      root,
      partition,
      title: note.title,
      idea: note.idea_statement,
      text
    });
  }
  for (const row of results.diagnostics) {
    rows.push({
      phase,
      query: row.source_note_id,
      doc: row.target_id,
      cosine: row.vector_score,
      oldLlm: row.rerank_score,
      finalScore: row.final_score,
      accepted: row.passed_threshold
    });
  }
  console.info(`${phase}: ${results.notes.length} notes, ${results.diagnostics.length} rows`);
}
for (const row of rows) {
  if (!notes.has(row.query) || !notes.has(row.doc)) throw new Error("Row references unknown note");
}

// The benchmark's own partition rule: a root pair is "tuning" unless one of its roots is held out.
const labels: Dataset["labels"] = [];
for (const [kind, entries] of [
  ["expected", fixture.expectedRootPairs],
  ["forbidden", fixture.forbiddenRootPairs]
] as const) {
  for (const entry of entries) {
    const rule: Partition = entry.pair.some((key) => partitionByRoot.get(key) === "holdout")
      ? "holdout"
      : "tuning";
    if (rule !== entry.partition) throw new Error(`Partition mismatch for ${entry.pair.join("/")}`);
    labels.push({ pair: [...entry.pair].sort() as [string, string], partition: rule, kind });
  }
}

const pairsOf = (phase: Phase): Array<[string, string]> => {
  const unique = new Map<string, [string, string]>();
  for (const row of rows) {
    if (row.phase === phase) unique.set(`${row.query}|${row.doc}`, [row.query, row.doc]);
  }
  return [...unique.values()];
};
const all = new Map<string, [string, string]>();
for (const row of rows) {
  all.set(`${row.query}|${row.doc}`, [row.query, row.doc]);
  if (!all.has(`${row.doc}|${row.query}`)) all.set(`${row.doc}|${row.query}`, [row.doc, row.query]);
}

// Old source-level (LLM source-relation) result per partition, from the saved analyses.
async function sourceLevel(phase: Phase, partition: Partition) {
  const analysis = z
    .object({
      summary: z.object({
        expectedPairCases: z.number(),
        source: z.object({
          expectedPairsFound: z.array(z.string()),
          forbiddenPairsFound: z.array(z.string())
        })
      })
    })
    .parse(await readJson(join(benchmarkDirectory, phase, "analysis.json")));
  const expected = new Set(
    labels
      .filter((l) => l.partition === partition && l.kind === "expected")
      .map((l) => pairKey(...l.pair))
  );
  return {
    expectedFound: analysis.summary.source.expectedPairsFound.filter((key) => expected.has(key))
      .length,
    expectedTotal: analysis.summary.expectedPairCases,
    forbiddenFound: analysis.summary.source.forbiddenPairsFound.length
  };
}

const dataset: Dataset = {
  version: 1,
  createdAt: new Date().toISOString(),
  textFormat:
    "Title: {title}\nIdea: {idea_statement}\nText: {first 400 characters of body_markdown}",
  notes: [...notes.values()],
  labels,
  rows,
  sets: { tuning: pairsOf("economy"), holdout: pairsOf("validate"), all: [...all.values()] },
  oldSourceLevel: {
    tuning: await sourceLevel("economy", "tuning"),
    holdout: await sourceLevel("validate", "holdout")
  }
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(datasetPath, `${JSON.stringify(dataset)}\n`);
console.info(
  `notes ${dataset.notes.length} (tuning ${dataset.notes.filter((n) => n.partition === "tuning").length}), ` +
    `rows ${rows.length}, sets tuning ${dataset.sets.tuning.length} / holdout ${dataset.sets.holdout.length} / all ${dataset.sets.all.length}`
);
console.info(
  `labels: ${JSON.stringify(
    Object.fromEntries(
      (["tuning", "holdout"] as const).map((p) => [
        p,
        {
          expected: labels.filter((l) => l.partition === p && l.kind === "expected").length,
          forbidden: labels.filter((l) => l.partition === p && l.kind === "forbidden").length
        }
      ])
    )
  )}`
);
console.info(`Wrote ${datasetPath}`);
