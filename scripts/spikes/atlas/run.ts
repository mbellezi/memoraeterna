// Atlas spike (F5 T153, D21): is a 2-D map of the topic tree worth building in F6? Record only: no
// model, no Electron, no remote call. Reads stored vectors and placements, runs exact 1024-d kNN purity,
// UMAP (three seeds) and PCA, and writes PNG scatter plots and metrics JSON under `.cache/f5/atlas/`.
//
//   npm run atlas:spike -- \
//     --gs-profile "$PWD/.cache/f5/scratch/atlas/env-g" --gs-vectors .cache/topics/vectors/env-g \
//     --profile "$PWD/.cache/f5/scratch/atlas/env-c"
//
// `--gs-profile` and `--profile` are profile-shaped scratch clones under `<repo>/.cache/f<N>/scratch/`
// (see docs/spikes/atlas-f5.md for how they are made); each is started through
// `scripts/lib/profile-server.ts` and opened read-only. The go criterion is frozen in criterion.ts.
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import pg from "pg";

import { analyseDataset } from "./analyse.js";
import type { DatasetReport } from "./analyse.js";
import { atlasCriterion, judgeAtlas } from "./criterion.js";
import { readCloneDataset, readGoldenSmall } from "./sources.js";
import type { LoadedDataset } from "./sources.js";
import { startProfileServer } from "../../lib/profile-server.js";

const usage = `Usage: npm run atlas:spike -- --gs-profile <abs dir> --gs-vectors <store path without extension> --profile <abs dir> [options]

  --gs-profile <abs dir>   env-g clone under <repo>/.cache/f<N>/scratch/ (golden-small placements).
  --gs-vectors <path>      The replay store of golden-small, e.g. .cache/topics/vectors/env-g
                           (<path>.f32, <path>.index.jsonl, <path>.meta.json).
  --profile <abs dir>      ENV-C clone under <repo>/.cache/f<N>/scratch/ (stored vectors and placements).
  --out <dir>              Output folder (default <repo>/.cache/f5/atlas).
  --only <name>            Run one dataset only: golden-small or env-c (no verdict is given).
  --help                   Show this text.`;

const { values } = parseArgs({
  options: {
    "gs-profile": { type: "string" },
    "gs-vectors": { type: "string" },
    profile: { type: "string" },
    out: { type: "string" },
    only: { type: "string" },
    help: { type: "boolean", short: "h" }
  },
  strict: true,
  allowPositionals: false
});
if (values.help) {
  console.info(usage);
  process.exit(0);
}
const only = values.only;
if (only !== undefined && only !== "golden-small" && only !== "env-c") {
  console.error(`--only is golden-small or env-c.\n\n${usage}`);
  process.exit(2);
}
const runGs = only === undefined || only === "golden-small";
const runEnvC = only === undefined || only === "env-c";
if ((runGs && (!values["gs-profile"] || !values["gs-vectors"])) || (runEnvC && !values.profile)) {
  console.error(`Missing arguments.\n\n${usage}`);
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const outDir = resolve(values.out ?? resolve(repoRoot, ".cache/f5/atlas"));
const log = (message: string) => console.error(`[atlas] ${message}`);

/** Starts a scratch clone read-only, reads one dataset and stops the server before the heavy work. */
async function load(
  profile: string,
  read: (pool: pg.Pool) => Promise<LoadedDataset>
): Promise<LoadedDataset> {
  const server = await startProfileServer(profile, { repoRoot, allowIncomplete: true });
  const pool = new pg.Pool({
    connectionString: server.connectionString,
    max: 1,
    options: "-c default_transaction_read_only=on -c statement_timeout=120000"
  });
  try {
    return await read(pool);
  } finally {
    await pool.end();
    await server.stop();
  }
}

const startedAt = Date.now();
await mkdir(outDir, { recursive: true });
const reports: { loaded: LoadedDataset; report: DatasetReport }[] = [];
if (runGs) {
  const storeBase = resolve(values["gs-vectors"]!);
  const loaded = await load(values["gs-profile"]!, (pool) => readGoldenSmall(pool, storeBase));
  log(
    `golden-small: ${loaded.tree.treeIdMatchesStore ? "the store's tree" : "NOT the store's tree (the clone's active tree)"}; generation in the clone ${loaded.tree.cloneGeneration}, in the store ${loaded.tree.storeGeneration ?? "unknown"}` +
      (loaded.tree.generationDiffers ? " (DIFFERENT)" : "")
  );
  if (loaded.pairing)
    log(
      `golden-small: ${loaded.pairing.byId} store notes paired by id, ${loaded.pairing.byContentHash} by content hash, ` +
        `${loaded.pairing.unmatched} unmatched; cosine to the clone's vector: mean ${loaded.pairing.meanCosineToCloneVector.toFixed(4)}, min ${loaded.pairing.minCosineToCloneVector.toFixed(4)}`
    );
  reports.push({ loaded, report: await analyseDataset(loaded.dataset, outDir, log) });
}
if (runEnvC) {
  const loaded = await load(values.profile!, (pool) => readCloneDataset(pool, "env-c"));
  log(
    `env-c: tree generation ${loaded.tree.cloneGeneration}, ${loaded.dataset.counts.points} points`
  );
  reports.push({ loaded, report: await analyseDataset(loaded.dataset, outDir, log) });
}

const verdict =
  only === undefined ? judgeAtlas(reports.map((entry) => entry.report.outcome)) : null;
const summary = {
  spike: "atlas-f5",
  decision: atlasCriterion.decision,
  criterion: atlasCriterion,
  startedAt: new Date(startedAt).toISOString(),
  seconds: (Date.now() - startedAt) / 1000,
  verdict: verdict?.verdict ?? "partial run: no verdict",
  judgements: verdict?.datasets ?? [],
  datasets: reports.map(({ loaded, report }) => ({
    ...report,
    source: loaded.source,
    tree: loaded.tree,
    placedWithoutVector: loaded.placedWithoutVector,
    pairing: loaded.pairing ?? null
  }))
};
await writeFile(resolve(outDir, "metrics.json"), `${JSON.stringify(summary, null, 2)}\n`);

const fixed = (value: number) => (Number.isNaN(value) ? "-" : value.toFixed(3));
for (const { report } of reports) {
  console.info(
    `${report.name}${report.weak ? " (weak)" : ""}: ${report.counts.points} points, ${report.branches} level-1 branches | ` +
      `1024-d purity ${fixed(report.purity1024.overall)} (chance ${fixed(report.chance)}) | ` +
      `UMAP contiguity ${fixed(report.umap.contiguityMean)} (min ${fixed(report.umap.contiguityMin)}) | ` +
      `disparity max ${fixed(report.umap.disparityMax)} | PCA contiguity ${fixed(report.pca.contiguity)}`
  );
}
console.info(`verdict: ${summary.verdict}; written to ${outDir}`);
