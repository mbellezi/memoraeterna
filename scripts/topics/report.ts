// `npm run topics:report -- [--export <name> ...] [options]`
//
// The developer comparison report (F2 T22b, D21): one self-contained HTML file (and its JSON) that
// sets the exports of the measurement profiles side by side. It reads what `npm run topics:export`
// wrote (`<cache>/topics/exports/<name>/export.json` and the replay store of the note vectors in
// `<cache>/topics/vectors/<name>.*`), never a live owner database, and builds the fresh tree the
// in-app tree is compared with offline, with the product's own builder. Per profile:
//
//   - the exit criteria it can be measured against, with bars and verdicts (E1 reachability,
//     E2 shape, E3 churn from the daily metrics, E5 undo rate, the Unsorted share);
//   - the incremental tree against a fresh build (partition hash, agreement, shapes);
//   - gate statistics, naming, churn and change-sets per day;
//   - sampled topics with their 5 central members;
//   - for DEV, the legacy wiki's shape as the wipe recorded it.
//
// Typical use (the orchestrator exports each profile first):
//
//   npm run topics:export -- --db <profile connection file> --name env-c
//   npm run topics:report -- --export env-c --export env-g --corpus .cache/corpus
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { z } from "zod";

import { cacheRoot } from "./datasets.js";
import { assertExportName } from "./export-tree.js";
import { tryReadReplayStore } from "./export-vectors.js";
import {
  buildComparison,
  buildProfileReport,
  defaultReportOptions,
  devLegacyRecord,
  gatingFailures,
  parseExportDocument
} from "./report-core.js";
import type {
  ComparisonDocument,
  ProfileInput,
  ReportOptions,
  TruthSource
} from "./report-core.js";
import { renderReportHtml } from "./report-render.js";

export const reportUsage = `Usage: npm run topics:report -- [options]

  --export <name>     An export to include (repeatable). Default: every export in the cache.
  --cache <folder>    Folder with topics/exports and topics/vectors (default: the repository
                      .cache, or MEMORA_TOPICS_CACHE).
  --out <file>        HTML to write (default: <cache>/topics/reports/topics-report.html); the data
                      goes to the same name with .json.
  --corpus <folder>   The Wikipedia corpus (manifest.json) to join ground-truth domains to ENV-C.
  --seed <n>          Seed of the sampled topics (default ${defaultReportOptions.seed}).
  --sample <n>        Topics sampled per profile (default ${defaultReportOptions.sample}).
  --members <n>       Central members per sampled topic (default ${defaultReportOptions.members}).
  --no-fresh          Skip the fresh build (the comparison and its agreement figures).
  --check             Exit with 1 when a gating exit criterion (E1, E2) fails in any profile.
  --help              Show this text.

The export named "dev" also gets the legacy wiki's recorded shape. A report holds topic names and
note titles of the exported libraries: it stays under .cache/.`;

export interface ReportArgs {
  exports: string[];
  cache: string;
  out: string | null;
  corpus: string | null;
  options: ReportOptions;
  check: boolean;
}

export type ReportCommand = { kind: "help" } | ({ kind: "run" } & ReportArgs);

function wholeNumber(
  name: string,
  value: string | undefined,
  fallback: number,
  min: number
): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min)
    throw new Error(`${name} must be a whole number of at least ${min}.`);
  return parsed;
}

export function parseReportArgs(argv: readonly string[]): ReportCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      export: { type: "string", multiple: true },
      cache: { type: "string" },
      out: { type: "string" },
      corpus: { type: "string" },
      seed: { type: "string" },
      sample: { type: "string" },
      members: { type: "string" },
      "no-fresh": { type: "boolean" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  const exports = values.export ?? [];
  for (const name of exports) assertExportName(name);
  if (new Set(exports).size !== exports.length) throw new Error("An --export is listed twice.");
  return {
    kind: "run",
    exports,
    cache: values.cache ? resolve(values.cache) : cacheRoot(),
    out: values.out ? resolve(values.out) : null,
    corpus: values.corpus ? resolve(values.corpus) : null,
    options: {
      seed: wholeNumber("--seed", values.seed, defaultReportOptions.seed, 0),
      sample: wholeNumber("--sample", values.sample, defaultReportOptions.sample, 0),
      members: wholeNumber("--members", values.members, defaultReportOptions.members, 1),
      fresh: values["no-fresh"] !== true
    },
    check: values.check === true
  };
}

const corpusManifestSchema = z.looseObject({
  name: z.string(),
  articles: z.array(z.looseObject({ lang: z.string(), title: z.string(), domain: z.string() }))
});

/** Domains of the Wikipedia corpus's articles, by (language, article title). */
export async function readCorpusTruth(folder: string): Promise<TruthSource> {
  const manifest = corpusManifestSchema.parse(
    JSON.parse(await readFile(join(folder, "manifest.json"), "utf8"))
  );
  const domains = new Map(manifest.articles.map((a) => [`${a.lang}:${a.title}`, a.domain]));
  return {
    name: manifest.name,
    domainOf: (language, title) => domains.get(`${language}:${title}`)
  };
}

/** The exports found in a cache, by name. */
export async function listExports(cache: string): Promise<string[]> {
  const entries = await readdir(join(cache, "topics", "exports"), { withFileTypes: true }).catch(
    () => []
  );
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(join(cache, "topics", "exports", entry.name, "export.json"));
      names.push(entry.name);
    } catch {
      // Not an export.
    }
  }
  return names.sort();
}

export async function loadProfileInput(
  cache: string,
  name: string,
  truth: TruthSource | null
): Promise<ProfileInput> {
  const path = join(cache, "topics", "exports", name, "export.json");
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read the export ${name} (${path}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  const document = parseExportDocument(raw);
  let store = null;
  if (document.vectors !== null) {
    store = await tryReadReplayStore(join(cache, "topics", "vectors"), name, { normalize: true });
    if (store === null)
      throw new Error(
        `The export ${name} lists a replay store, but ${name}.meta.json is not in ${join(cache, "topics", "vectors")}`
      );
    if (store.meta.count !== document.vectors.rows)
      throw new Error(
        `The replay store of ${name} has ${store.meta.count} rows, its export ${document.vectors.rows}: export it again`
      );
  }
  return { document, store, truth, legacy: name === "dev" ? devLegacyRecord : null };
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

export interface ReportResult {
  htmlPath: string;
  jsonPath: string;
  document: ComparisonDocument;
  failures: string[];
}

export async function runReport(
  args: ReportArgs,
  log: (line: string) => void
): Promise<ReportResult> {
  const names = args.exports.length > 0 ? args.exports : await listExports(args.cache);
  if (names.length === 0)
    throw new Error(
      `No export in ${join(args.cache, "topics", "exports")}: run npm run topics:export first.`
    );
  const truth = args.corpus ? await readCorpusTruth(args.corpus) : null;
  const profiles = [];
  for (const name of names) {
    const began = performance.now();
    const input = await loadProfileInput(args.cache, name, truth);
    profiles.push(buildProfileReport(input, args.options));
    log(
      `${name}: ${input.document.library.notes} notes, ${Math.round(performance.now() - began)} ms`
    );
  }
  const document = buildComparison(profiles);
  const htmlPath = args.out ?? join(args.cache, "topics", "reports", "topics-report.html");
  const jsonPath = htmlPath.replace(/\.html?$/u, "") + ".json";
  await writeAtomic(htmlPath, renderReportHtml(document));
  await writeAtomic(jsonPath, `${JSON.stringify(document, null, 2)}\n`);
  return { htmlPath, jsonPath, document, failures: gatingFailures(profiles) };
}

async function main(argv: readonly string[]): Promise<number> {
  const command = parseReportArgs(argv);
  if (command.kind === "help") {
    console.info(reportUsage);
    return 0;
  }
  const result = await runReport(command, (line) => console.error(`[topics:report] ${line}`));
  for (const profile of result.document.profiles) {
    const verdicts = profile.targets
      .filter((check) => check.gating)
      .map((check) => `${check.id} ${check.status}`)
      .join(", ");
    const fresh = profile.fresh
      ? `, fresh build ${profile.fresh.identical ? "same partition" : `differs (leaf NMI ${profile.fresh.agreement.leafNmi})`}`
      : "";
    console.info(`${profile.name}: ${verdicts}${fresh}`);
  }
  console.info(result.htmlPath);
  console.info(result.jsonPath);
  if (result.failures.length > 0) {
    console.error(`[topics:report] failing gating checks:\n  ${result.failures.join("\n  ")}`);
    if (command.check) return 1;
  }
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(`[topics:report] ${error instanceof Error ? error.message : String(error)}`);
      console.error("Run with --help for usage.");
      process.exitCode = 1;
    }
  );
}
