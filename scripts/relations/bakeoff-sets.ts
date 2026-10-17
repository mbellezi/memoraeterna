/**
 * The sets the F3 decider bake-off scores (T46 part b, spec 3.18 and 5.2): the note pairs of the panel
 * label set (pools A-C, R_v6 and the R_v9 sample), every R_v9 pair, and the text of their notes. They go
 * into one pairs file and one note-texts file in the formats the T46a harness reads
 * (`t44-pairs-to-score`, `memora-relations-note-texts`), so a ranker scores them all in one pass per
 * configuration and a reader finds the set of a pair in the file's `membership`.
 *
 *   npx tsx scripts/relations/bakeoff-sets.ts build [--out-dir .cache/f3/scores/bakeoff] [--force]
 *
 * Sources (all synthetic or public text, decision D4; the files stay under `.cache`):
 * - `scripts/fixtures/f3-relation-labels.json` (T45): the pairs, their sets, pools, strata and splits;
 * - the note texts T46a exported from scratch clones of ENV-F, ENV-G and ENV-C
 *   (`.cache/f3/scratch/t46a/*-note-texts.json`), checked against the hashes the label set recorded;
 * - Spike A's dataset and the matching benchmark exports, for the R_v6 notes (their bodies);
 * - `.cache/f3/labels/r-v9/relations.json`: the 137 pairs the v9 decider accepted on the pinned fixture.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { noteText, repositoryRoot } from "../spikes/reranker/dataset.ts";
import {
  noteTextsFormat,
  noteTextsSchema,
  sha256Hex,
  storedBody,
  type NoteTextsFile,
  type StoredNote
} from "./note-texts.ts";
import { pairsFileFormat, readPairsFile, type PairsFile } from "./pair-scoring.ts";

const cacheDirectory = join(repositoryRoot, ".cache");

export const bakeoffProfile = "f3-bakeoff-labels";

/** Where the bake-off scores, inputs and reports live. */
export const bakeoffDirectory = join(cacheDirectory, "f3", "scores", "bakeoff");

/** The Decisions score file (`bakeoff-decisions.ts scores`), beside the local deciders' score files. */
export const decisionsScoresFile = "decisions-predicate-fixture-rv6.json";

export const libraryNames = ["fixture", "golden", "corpus", "spike-a"] as const;
export type BakeoffLibrary = (typeof libraryNames)[number];

export const defaultSourcePaths = {
  labels: join(repositoryRoot, "scripts", "fixtures", "f3-relation-labels.json"),
  labelSet: join(cacheDirectory, "f3", "labels", "label-set.json"),
  rv9Relations: join(cacheDirectory, "f3", "labels", "r-v9", "relations.json"),
  texts: {
    fixture: join(cacheDirectory, "f3", "scratch", "t46a", "env-f-note-texts.json"),
    golden: join(cacheDirectory, "f3", "scratch", "t46a", "env-g-note-texts.json"),
    corpus: join(cacheDirectory, "f3", "scratch", "t46a", "env-c-20261018-note-texts.json")
  },
  /** The fixture's candidate lists of T44 (the pinned retrieval at k = 20). */
  fixturePairs: join(cacheDirectory, "f3", "m0", "pairs", "env-f-pairs.json"),
  spikeDataset: join(cacheDirectory, "spikes", "reranker", "dataset.json"),
  benchmarkDirectory: join(cacheDirectory, "matching-benchmark")
} as const;

// --- Sources --------------------------------------------------------------------------------------

const labelItemSchema = z
  .object({
    pairId: z.string().min(1),
    kind: z.enum(["note", "source"]),
    library: z.string().min(1),
    lo: z.string().min(1),
    hi: z.string().min(1),
    sets: z.array(z.string().min(1)),
    pool: z.string().nullable(),
    stratum: z.number().int().nullable(),
    split: z.enum(["fit", "eval"]).nullable(),
    related: z.boolean().nullable()
  })
  .passthrough();
export type LabelItem = z.infer<typeof labelItemSchema>;

export const labelFixtureSchema = z
  .object({
    format: z.literal("memora-f3-relation-labels"),
    version: z.literal(1),
    labelSetSha256: z.string().regex(/^[0-9a-f]{64}$/u),
    items: z.array(labelItemSchema)
  })
  .passthrough();
export type LabelFixture = z.infer<typeof labelFixtureSchema>;

const rv9RelationSchema = z
  .object({ source_note: z.string().min(1), target_note: z.string().min(1) })
  .passthrough();

const spikeDatasetSchema = z
  .object({
    notes: z.array(
      z.object({ id: z.string().min(1), title: z.string(), idea: z.string(), text: z.string() })
    )
  })
  .passthrough();

const benchmarkResultsSchema = z
  .object({
    notes: z.array(
      z.object({
        id: z.string().min(1),
        title: z.string(),
        idea_statement: z.string(),
        body_markdown: z.string()
      })
    )
  })
  .passthrough();

/** The matching benchmark phases Spike A's dataset was built from. */
export const benchmarkPhases = ["baseline", "economy", "coverage", "validate"] as const;

export interface BakeoffSources {
  labels: LabelFixture;
  labelsSha256: string;
  /** The R_v9 pairs (the v9 accepted relations of the pinned fixture), lower id first. */
  rv9Pairs: Array<[string, string]>;
  rv9Sha256: string;
  /** Note texts by library, as T46a exported them; `spike-a` is built from Spike A's dataset. */
  notes: Record<BakeoffLibrary, Map<string, StoredNote>>;
  /** SHA-256 of each source file (the note-text files as the label set recorded them). */
  hashes: Record<string, string>;
}

export const pairKeyOf = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

const sortedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

async function readHashed(path: string): Promise<{ text: string; sha256: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Cannot read "${path}".`);
  }
  return { text: bytes.toString("utf8"), sha256: sha256Hex(bytes) };
}

/** Spike A's notes with their whole bodies: the dataset keeps the first 400 characters only. */
export async function readSpikeNotes(
  datasetPath: string,
  benchmarkDirectory: string
): Promise<{ notes: Map<string, StoredNote>; datasetSha256: string }> {
  const dataset = await readHashed(datasetPath);
  const parsed = spikeDatasetSchema.parse(JSON.parse(dataset.text));
  const bodies = new Map<string, { title: string; idea: string; body: string }>();
  for (const phase of benchmarkPhases) {
    const results = benchmarkResultsSchema.parse(
      JSON.parse((await readHashed(join(benchmarkDirectory, phase, "results.json"))).text)
    );
    for (const note of results.notes)
      bodies.set(note.id, {
        title: note.title,
        idea: note.idea_statement,
        body: note.body_markdown
      });
  }
  const notes = new Map<string, StoredNote>();
  for (const note of parsed.notes) {
    const source = bodies.get(note.id);
    if (!source) throw new Error(`The benchmark exports have no body for Spike A note ${note.id}.`);
    const stored: StoredNote = {
      id: note.id,
      title: source.title,
      idea: source.idea,
      body: storedBody(source.body)
    };
    // The body is only trusted if it renders the text Spike A scored.
    if (noteText({ title: stored.title, idea: stored.idea, body: stored.body }) !== note.text)
      throw new Error(`The body of Spike A note ${note.id} does not render the dataset's text.`);
    notes.set(note.id, stored);
  }
  return { notes, datasetSha256: dataset.sha256 };
}

export interface SourcePaths {
  labels: string;
  /** The label set's own file: when present, its recorded input hashes are checked. */
  labelSet: string | null;
  rv9Relations: string;
  texts: Record<"fixture" | "golden" | "corpus", string>;
  spikeDataset: string;
  benchmarkDirectory: string;
}

export async function loadBakeoffSources(
  paths: SourcePaths = { ...defaultSourcePaths, labelSet: defaultSourcePaths.labelSet }
): Promise<BakeoffSources> {
  const labels = await readHashed(paths.labels);
  const fixture = labelFixtureSchema.parse(JSON.parse(labels.text));
  const rv9 = await readHashed(paths.rv9Relations);
  const rv9Pairs = z
    .array(rv9RelationSchema)
    .parse(JSON.parse(rv9.text))
    .map((relation) => sortedPair(relation.source_note, relation.target_note));
  const hashes: Record<string, string> = { labels: labels.sha256, rv9Relations: rv9.sha256 };
  const notes: BakeoffSources["notes"] = {
    fixture: new Map(),
    golden: new Map(),
    corpus: new Map(),
    "spike-a": new Map()
  };
  for (const library of ["fixture", "golden", "corpus"] as const) {
    const texts = await readHashed(paths.texts[library]);
    hashes[`${library}.texts`] = texts.sha256;
    const parsed = noteTextsSchema.parse(JSON.parse(texts.text));
    if (parsed.format !== noteTextsFormat)
      throw new Error(`${paths.texts[library]} is no texts file.`);
    for (const note of parsed.notes) notes[library].set(note.id, note);
  }
  const spike = await readSpikeNotes(paths.spikeDataset, paths.benchmarkDirectory);
  hashes.spikeDataset = spike.datasetSha256;
  notes["spike-a"] = spike.notes;
  if (paths.labelSet) {
    // The label set recorded the hash of every input it was drawn from: the texts must be those.
    const labelSet = await readHashed(paths.labelSet);
    if (sha256Hex(labelSet.text) !== fixture.labelSetSha256)
      throw new Error("The label set file is not the one the label fixture was tallied from.");
    const recorded = z
      .object({ inputs: z.record(z.string(), z.string()) })
      .passthrough()
      .parse(JSON.parse(labelSet.text)).inputs;
    for (const [key, name] of [
      ["fixture.texts", "fixture.texts"],
      ["golden.texts", "golden.texts"],
      ["corpus.texts", "corpus.texts"],
      ["spikeDataset", "spikeDataset"]
    ] as const) {
      if (recorded[key] !== hashes[name])
        throw new Error(`The input "${key}" is not the file the label set was drawn from.`);
    }
  }
  return {
    labels: fixture,
    labelsSha256: labels.sha256,
    rv9Pairs,
    rv9Sha256: rv9.sha256,
    notes,
    hashes
  };
}

// --- The scoring sets ----------------------------------------------------------------------------

/** The sets a note pair can belong to: the label sets of T45 plus `rv9` (all 137 pairs). */
export const setNames = ["pool-A", "pool-B", "pool-C", "rv6", "rv9-sample", "rv9"] as const;

export interface BakeoffInputs {
  pairsFile: PairsFile & {
    membership: Record<string, string[]>;
    inputs: Record<string, string>;
  };
  textsFile: NoteTextsFile;
  counts: Record<string, number>;
}

/** Note pairs of the label set and R_v9, with the sets each belongs to and the text of their notes. */
export function buildBakeoffInputs(sources: BakeoffSources, generatedAt: string): BakeoffInputs {
  const membership = new Map<string, Set<string>>();
  const pairIds = new Map<string, [string, string]>();
  const libraryOf = new Map<string, BakeoffLibrary>();
  const add = (a: string, b: string, set: string, library: BakeoffLibrary): void => {
    const key = pairKeyOf(a, b);
    pairIds.set(key, sortedPair(a, b));
    membership.set(key, (membership.get(key) ?? new Set()).add(set));
    for (const note of [a, b]) {
      const known = libraryOf.get(note);
      if (known && known !== library)
        throw new Error(`Note ${note} belongs to the libraries ${known} and ${library}.`);
      libraryOf.set(note, library);
    }
  };
  for (const item of sources.labels.items) {
    if (item.kind !== "note") continue;
    if (!(libraryNames as readonly string[]).includes(item.library))
      throw new Error(`Label ${item.pairId} names the unknown library "${item.library}".`);
    for (const set of item.sets) add(item.lo, item.hi, set, item.library as BakeoffLibrary);
  }
  for (const [lo, hi] of sources.rv9Pairs) add(lo, hi, "rv9", "fixture");
  const keys = [...pairIds.keys()].sort();
  const pairs = keys.map((key) => pairIds.get(key)!);
  const noteIds = [...new Set(pairs.flat())].sort();
  const notes = noteIds.map((id) => {
    const note = sources.notes[libraryOf.get(id)!].get(id);
    if (!note) throw new Error(`No text for note ${id} in the ${libraryOf.get(id)} note texts.`);
    return note;
  });
  const sets: Record<string, string[]> = {};
  for (const key of keys) sets[key] = [...membership.get(key)!].sort();
  const counts: Record<string, number> = {
    notes: notes.length,
    unorderedPairs: pairs.length,
    directedPairs: 2 * pairs.length
  };
  for (const name of setNames)
    counts[name] = keys.filter((key) => membership.get(key)!.has(name)).length;
  return {
    pairsFile: {
      format: pairsFileFormat,
      version: 1,
      profile: bakeoffProfile,
      unorderedPairs: pairs.length,
      directedPairs: 2 * pairs.length,
      pairs,
      membership: sets,
      inputs: sources.hashes
    },
    textsFile: {
      format: noteTextsFormat,
      version: 1,
      profile: bakeoffProfile,
      libraryDigest: null,
      generatedAt,
      notes
    },
    counts
  };
}

/** The sets a pair belongs to; empty for a pair of no set. */
export function membershipOf(pairs: PairsFile, a: string, b: string): string[] {
  const membership = (pairs as { membership?: Record<string, string[]> }).membership ?? {};
  return membership[pairKeyOf(a, b)] ?? [];
}

// --- Command line ---------------------------------------------------------------------------------

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

export const inputFiles = {
  pairs: "inputs/label-pairs.json",
  texts: "inputs/label-note-texts.json"
} as const;

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { "out-dir": { type: "string" }, force: { type: "boolean" } },
    allowPositionals: true,
    strict: true
  });
  if (positionals[0] !== "build") {
    console.info(
      "Usage: npx tsx scripts/relations/bakeoff-sets.ts build [--out-dir <dir>] [--force]"
    );
    return;
  }
  const outDir = resolve(values["out-dir"] ?? bakeoffDirectory);
  const pairsPath = join(outDir, inputFiles.pairs);
  const textsPath = join(outDir, inputFiles.texts);
  const existing = await readPairsFile(pairsPath).then(
    () => true,
    () => false
  );
  if (existing && !values.force) {
    console.info(`${pairsPath} exists; pass --force to rebuild it (score files record its hash).`);
    return;
  }
  const inputs = buildBakeoffInputs(
    await loadBakeoffSources({ ...defaultSourcePaths, labelSet: defaultSourcePaths.labelSet }),
    new Date().toISOString()
  );
  await writeJson(pairsPath, inputs.pairsFile);
  await writeJson(textsPath, inputs.textsFile);
  console.info(`wrote ${pairsPath} and ${textsPath}`);
  console.info(JSON.stringify(inputs.counts));
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[bakeoff-sets] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
