/**
 * Non-regression cassette copies (F3 5.1 and D41, review R3).
 *
 * After F3 matching merges, a cassette recorded before it no longer holds the calls the matching stages make,
 * so the non-regression replays of `golden-small-f2` and `e2e-plos` (5.6) run on a copy of the base cassette
 * with every MATCHING entry stripped. The stripped calls then miss: a miss on a remote runtime fails (and is
 * counted), a miss on a local runtime runs live under `MEMORA_AI_CASSETTE_LOCAL_MISSES=live` (and is counted).
 * Everything else stays: extraction (summaries, notes, knowledge graph with identity and type resolution),
 * embeddings, the topic calls and the topic gate's rank calls.
 *
 *   npm run golden:cassette-nonreg -- --base .cache/golden/cassettes/golden-small-f2 \
 *     --out .cache/golden/cassettes/golden-small-f2-nonreg-R --strict
 *
 * The base is only read and is never modified. The target must not exist (a replay with live local misses
 * records into its cassette, so every sample starts from its own fresh copy) and both folders must sit inside
 * `<workspace root>/.cache`. The copy is made beside its final place and moved into it when complete, so a
 * failure leaves nothing behind. Besides the kept entries it holds the base's top-level files
 * (`cassette.json`, `e2e-route.json`) and `nonreg.json`, the provenance: base path, rule version, counts.
 *
 * THE RULE (`matching-strip-v2`): an entry is a matching entry when the prompt it carries is one of the matching
 * prompts of the catalog (`packages/domain/src/prompt-defaults.ts`), whatever the task type or the runtime,
 * because the E6 cassette holds its note decide on a local writer and the golden one on Codex:
 *
 *   note-decide         `notes.match`: the v9 generative note decide (and the older "Evaluate whether" wording)
 *   note-decide-ranker  `relations.decide.instruction`: a dedicated ranker scoring a note pair
 *   source-judge        `sources.decide`: the v5 generative source judge (and the older "Identify" wording)
 *   relation-typing     `relations.type` and its repair: the typer of an applied note relation
 *
 * A generative prompt is recognised by its first paragraph after the output-language preamble
 * (`shared.output_language`), a ranker request by the `instruction` of its `{instruction, query, documents}`
 * JSON. A repair prompt starts with the prompt it repairs, so it is stripped with it. Everything else is kept and
 * named (`KEPT_RULES`, else its task type); an entry that fits no known kind is kept and reported as
 * unrecognised, and `--strict` refuses to write a copy that has any, so a prompt rewrite cannot silently move
 * an entry from one side to the other. `cassette-nonreg.test.ts` pins every rule to the shipped catalog.
 */
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

/** Bump when a rule below changes: the provenance file names the version a copy was made with. */
// v2: the ranker note decide also carries the F3 bake-off's `relation` instruction.
export const nonRegressionRuleVersion = "matching-strip-v2";

export const nonRegressionFileName = "nonreg.json";

/** The first words of `shared.output_language`, which opens every generative prompt of a language-aware task. */
const outputLanguagePreamble = "Produce all natural-language response text in ";

/** Where a rule looks: the prompt text of a generative request, or the instruction of a ranker request. */
type Probe = "prompt" | "instruction";

interface Rule {
  kind: string;
  probe: Probe;
  /** The text the probe starts with, for any of its wordings (recorded cassettes keep old ones). */
  startsWith: readonly string[];
}

/** The matching entries a non-regression copy loses. */
export const MATCHING_RULES: readonly Rule[] = [
  {
    kind: "note-decide",
    probe: "prompt",
    startsWith: [
      "Decide whether the source atomic note has a meaningful knowledge relationship",
      "Evaluate whether the source atomic note has a meaningful knowledge relationship"
    ]
  },
  {
    kind: "note-decide-ranker",
    probe: "instruction",
    startsWith: [
      "Judge whether the Document states an idea with a substantive conceptual relationship to the Query note",
      "Given a note (Query), decide whether the Document note"
    ]
  },
  {
    kind: "source-judge",
    probe: "prompt",
    startsWith: [
      "Decide which durable, important conceptual relationships",
      "Identify durable, important conceptual relationships"
    ]
  },
  {
    kind: "relation-typing",
    probe: "prompt",
    startsWith: ["Classify how each pair of atomic notes is related"]
  }
];

/** Kept entries that need more than their task type to be told apart from a matching one. */
export const KEPT_RULES: readonly Rule[] = [
  {
    kind: "topic-gate-rank",
    probe: "instruction",
    startsWith: ["Given a note, retrieve the topic it belongs to"]
  },
  {
    kind: "topic-support-rank",
    probe: "instruction",
    startsWith: ["Given a sentence from a summary, retrieve the passage"]
  },
  { kind: "topic-name", probe: "prompt", startsWith: ["Name the numbered topics"] },
  { kind: "topic-areas", probe: "prompt", startsWith: ["Group the numbered topics"] },
  { kind: "topic-overview", probe: "prompt", startsWith: ["Write a short overview of one topic"] },
  {
    kind: "explanation",
    probe: "prompt",
    startsWith: ["Explain why two atomic notes are related", "Explain why two sources are related"]
  }
];

/** Task types whose entries are extraction or embeddings: kept, and named by the task. */
const KEPT_TASK_TYPES: ReadonlySet<string> = new Set([
  "embedding",
  "summarization",
  "atomic-note-generation",
  "knowledge-graph-generation"
]);

const entrySchema = z
  .object({
    format: z.literal("memora-ai-cassette-entry"),
    version: z.literal(1),
    key: z.string().regex(/^[0-9a-f]{64}$/),
    taskType: z.string().min(1),
    request: z.object({ input: z.unknown() }).passthrough(),
    responses: z.array(z.unknown()).min(1)
  })
  .passthrough();
export type CassetteEntryFile = z.infer<typeof entrySchema>;

const manifestSchema = z
  .object({
    format: z.literal("memora-ai-cassette"),
    version: z.literal(1),
    createdAt: z.string()
  })
  .passthrough();

export interface Classification {
  kind: string;
  /** True for an entry the copy loses. */
  matching: boolean;
  /** False for a kept entry that no rule names and whose task type is not a known extraction one. */
  recognized: boolean;
}

/** The prompt of a generative request without its output-language preamble paragraph. */
export function promptBody(input: string): string {
  const text = input.trimStart();
  if (!text.startsWith(outputLanguagePreamble)) return text;
  const end = text.indexOf("\n\n");
  return end < 0 ? "" : text.slice(end + 2).trimStart();
}

/** The instruction of a dedicated ranker's `{instruction, query, documents}` request, or null. */
export function rankInstruction(input: string): string | null {
  const text = input.trimStart();
  if (!text.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { instruction, documents } = parsed as Record<string, unknown>;
    return typeof instruction === "string" && Array.isArray(documents) ? instruction : null;
  } catch {
    return null;
  }
}

function probeText(rule: Rule, input: string): string | null {
  return rule.probe === "prompt" ? promptBody(input) : rankInstruction(input);
}

/** Which kind an entry is, and whether the non-regression copy loses it. */
export function classifyCassetteEntry(
  entry: Pick<CassetteEntryFile, "taskType" | "request">
): Classification {
  const input = typeof entry.request.input === "string" ? entry.request.input : null;
  if (input !== null) {
    for (const rule of MATCHING_RULES) {
      const text = probeText(rule, input);
      if (text !== null && rule.startsWith.some((start) => text.startsWith(start)))
        return { kind: rule.kind, matching: true, recognized: true };
    }
    for (const rule of KEPT_RULES) {
      const text = probeText(rule, input);
      if (text !== null && rule.startsWith.some((start) => text.startsWith(start)))
        return { kind: rule.kind, matching: false, recognized: true };
    }
  }
  if (KEPT_TASK_TYPES.has(entry.taskType))
    return { kind: entry.taskType, matching: false, recognized: true };
  return { kind: `other:${entry.taskType}`, matching: false, recognized: false };
}

export interface NonRegressionOptions {
  /** The base cassette folder: read only. */
  base: string;
  /** The copy to make: must not exist. */
  out: string;
  /** The checkout whose `.cache` holds both folders (default: the working directory). */
  workspaceRoot?: string;
  /** Refuse to write a copy when an entry fits no known kind. */
  strict?: boolean;
  /** Classify and count only: write nothing. */
  dryRun?: boolean;
  now?: () => Date;
}

export interface NonRegressionReport {
  format: "memora-cassette-nonreg";
  version: 1;
  rule: string;
  createdAt: string;
  /** Absolute path of the base cassette. */
  base: string;
  /** The `createdAt` of the base cassette's own manifest. */
  baseCreatedAt: string;
  entries: { base: number; kept: number; stripped: number };
  /** Entries by kind: kept in the copy, and stripped from it. */
  kept: Record<string, number>;
  stripped: Record<string, number>;
  /** Kept entries no rule names (their kinds start with `other:`). */
  unrecognized: Record<string, number>;
  /** Top-level files of the base that the copy carries (the manifest, the E6 route). */
  carried: string[];
}

export class NonRegressionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "NonRegressionError";
  }
}

const keyFile = /^([0-9a-f]{64})\.json$/;
const shardName = /^[0-9a-f]{2}$/;

function insideCache(cacheRoot: string, path: string): boolean {
  const inside = relative(cacheRoot, path);
  return inside !== "" && inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
}

/** The real path of a path that may not exist: its nearest existing ancestor, resolved, plus the rest. */
async function realPathOfPlanned(path: string): Promise<string> {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(await realpath(current), ...rest.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      rest.push(basename(current));
      current = parent;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

interface BaseEntry {
  key: string;
  file: string;
  relativePath: string;
  classification: Classification;
}

async function readBase(base: string): Promise<{
  entries: BaseEntry[];
  baseCreatedAt: string;
  carried: string[];
}> {
  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(base, "cassette.json"), "utf8"))
    );
  } catch {
    throw new NonRegressionError(`${base} is not an AI cassette (no valid cassette.json)`);
  }
  const carried: string[] = [];
  for (const item of await readdir(base, { withFileTypes: true })) {
    if (item.isFile()) carried.push(item.name);
    // `misses` holds the requests of earlier failed replays: diagnostics, not part of the cassette.
    else if (item.isDirectory() && (item.name === "entries" || item.name === "misses")) continue;
    else
      throw new NonRegressionError(
        `${join(base, item.name)} is neither a file, entries/ nor misses/: the rule does not know it`
      );
  }
  const entries: BaseEntry[] = [];
  const entriesDirectory = join(base, "entries");
  if (!(await exists(entriesDirectory)))
    throw new NonRegressionError(`${base} has no entries/ folder`);
  for (const shard of (await readdir(entriesDirectory, { withFileTypes: true })).sort((a, b) =>
    a.name < b.name ? -1 : 1
  )) {
    if (!shard.isDirectory() || !shardName.test(shard.name))
      throw new NonRegressionError(`${join(entriesDirectory, shard.name)} is not an entry folder`);
    for (const item of (await readdir(join(entriesDirectory, shard.name))).sort()) {
      const match = keyFile.exec(item);
      const file = join(entriesDirectory, shard.name, item);
      if (!match) throw new NonRegressionError(`${file} is not an entry file`);
      let entry: CassetteEntryFile;
      try {
        entry = entrySchema.parse(JSON.parse(await readFile(file, "utf8")));
      } catch {
        throw new NonRegressionError(`${file} is not a valid cassette entry`);
      }
      if (entry.key !== match[1] || !entry.key.startsWith(shard.name))
        throw new NonRegressionError(
          `${file} holds the key ${entry.key}, not the one it is named by`
        );
      entries.push({
        key: entry.key,
        file,
        relativePath: join("entries", shard.name, item),
        classification: classifyCassetteEntry(entry)
      });
    }
  }
  return { entries, baseCreatedAt: manifest.createdAt, carried: carried.sort() };
}

const tally = (items: Iterable<string>): Record<string, number> => {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
};

/**
 * Makes the copy of `base` at `out` without the matching entries (or, with `dryRun`, only counts them) and
 * returns the report that `nonreg.json` holds.
 */
export async function createNonRegressionCassette(
  options: NonRegressionOptions
): Promise<NonRegressionReport> {
  const workspaceRoot = resolve(options.workspaceRoot ?? process.cwd());
  const cacheRoot = resolve(workspaceRoot, ".cache");
  const base = resolve(options.base);
  const out = resolve(options.out);
  for (const [label, path] of [
    ["--base", base],
    ["--out", out]
  ] as const)
    if (!insideCache(cacheRoot, path))
      throw new NonRegressionError(
        `${label} must be a folder inside ${cacheRoot}: a cassette holds full prompts and outputs`
      );
  if (!(await exists(base))) throw new NonRegressionError(`${base} does not exist`);
  if (await exists(out))
    throw new NonRegressionError(
      `${out} already exists: a copy is never overwritten (every sample starts from a fresh copy)`
    );
  const realBase = await realpath(base);
  const realOut = await realPathOfPlanned(out);
  const apart = relative(realBase, realOut);
  const together = relative(realOut, realBase);
  const contains = (inside: string) =>
    inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
  if (contains(apart) || contains(together))
    throw new NonRegressionError(
      `--out ${out} and --base ${base} are the same folder or one holds the other`
    );

  const { entries, baseCreatedAt, carried } = await readBase(base);
  const stripped = entries.filter((entry) => entry.classification.matching);
  const kept = entries.filter((entry) => !entry.classification.matching);
  const unrecognized = tally(
    kept
      .filter((entry) => !entry.classification.recognized)
      .map((entry) => entry.classification.kind)
  );
  if (options.strict && Object.keys(unrecognized).length > 0)
    throw new NonRegressionError(
      `--strict: ${Object.entries(unrecognized)
        .map(([kind, count]) => `${count} ${kind}`)
        .join(", ")} fit no rule (add the prompt to MATCHING_RULES or KEPT_RULES)`
    );
  const report: NonRegressionReport = {
    format: "memora-cassette-nonreg",
    version: 1,
    rule: nonRegressionRuleVersion,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    base,
    baseCreatedAt,
    entries: { base: entries.length, kept: kept.length, stripped: stripped.length },
    kept: tally(kept.map((entry) => entry.classification.kind)),
    stripped: tally(stripped.map((entry) => entry.classification.kind)),
    unrecognized,
    carried
  };
  if (options.dryRun) return report;

  // Built beside its final place, so a failure leaves no half-made cassette where a replay would find it.
  await mkdir(dirname(out), { recursive: true });
  const partial = join(dirname(out), `.${basename(out)}.partial-${process.pid}`);
  await rm(partial, { recursive: true, force: true });
  try {
    await mkdir(join(partial, "entries"), { recursive: true });
    for (const name of carried) await copyFile(join(base, name), join(partial, name));
    const shards = new Set<string>();
    for (const entry of kept) {
      const shard = dirname(entry.relativePath);
      if (!shards.has(shard)) {
        await mkdir(join(partial, shard), { recursive: true });
        shards.add(shard);
      }
      // A clone on APFS, a copy elsewhere. A cassette rewrites an entry by renaming a new file over it,
      // never in place, so a clone never reaches back to the base.
      await copyFile(entry.file, join(partial, entry.relativePath), constants.COPYFILE_FICLONE);
    }
    await writeFile(join(partial, nonRegressionFileName), `${JSON.stringify(report, null, 2)}\n`);
    if (await exists(out))
      throw new NonRegressionError(`${out} appeared while the copy was made; nothing was moved`);
    await rename(partial, out);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  return report;
}

/** The kept and stripped counts per kind, for the terminal. */
export function renderNonRegressionReport(report: NonRegressionReport, out?: string): string {
  const kinds = [...new Set([...Object.keys(report.kept), ...Object.keys(report.stripped)])].sort();
  const width = Math.max(4, ...kinds.map((kind) => kind.length));
  const number = (value: number | undefined, size: number) => String(value ?? 0).padStart(size);
  const lines = [
    `Non-regression copy, rule ${report.rule}`,
    `  base: ${report.base} (${report.entries.base} entries)`,
    ...(out ? [`  copy: ${out}`] : []),
    "",
    `  ${"kind".padEnd(width)} ${"kept".padStart(7)} ${"stripped".padStart(8)}`,
    ...kinds.map(
      (kind) =>
        `  ${kind.padEnd(width)} ${number(report.kept[kind], 7)} ${number(report.stripped[kind], 8)}` +
        (kind.startsWith("other:") ? "   (not recognised)" : "")
    ),
    `  ${"total".padEnd(width)} ${number(report.entries.kept, 7)} ${number(report.entries.stripped, 8)}`
  ];
  if (report.carried.length > 0) lines.push("", `  carried files: ${report.carried.join(", ")}`);
  return lines.join("\n");
}

const usage = `Usage: npm run golden:cassette-nonreg -- --base <cassette> --out <new cassette> [options]

  Copies a base cassette without its matching entries (rule ${nonRegressionRuleVersion}) for a non-regression replay.

  --base <dir>            the cassette to copy (read only); inside <workspace root>/.cache
  --out <dir>             the copy; must not exist; inside <workspace root>/.cache
  --strict                refuse when an entry fits no known kind
  --dry-run               print the counts, write nothing
  --json                  print the report as JSON
  --workspace-root <dir>  the checkout that holds .cache (default: the working directory)
`;

export async function runCassetteNonRegression(argv: readonly string[]): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    allowPositionals: false,
    strict: true,
    options: {
      base: { type: "string" },
      out: { type: "string" },
      strict: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "boolean" },
      "workspace-root": { type: "string" },
      help: { type: "boolean", short: "h" }
    }
  });
  if (values.help) return usage;
  if (!values.base || !values.out) throw new NonRegressionError("--base and --out are required");
  const report = await createNonRegressionCassette({
    base: values.base,
    out: values.out,
    ...(values["workspace-root"] ? { workspaceRoot: values["workspace-root"] } : {}),
    ...(values.strict ? { strict: true } : {}),
    ...(values["dry-run"] ? { dryRun: true } : {})
  });
  return values.json
    ? JSON.stringify(report, null, 2)
    : renderNonRegressionReport(report, values["dry-run"] ? undefined : resolve(values.out));
}

if (import.meta.main) {
  try {
    console.info(await runCassetteNonRegression(process.argv.slice(2)));
  } catch (error) {
    console.error(`[cassette-nonreg] ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
