/**
 * The generative v9 decider in the bake-off (T46 part b, spec 3.18): recorded verdicts where they exist
 * at $0, live verdicts for the rest through the DEV knob `MEMORA_GOLDEN_NOTE_PAIRS` (the orchestrator's
 * run, never this script's).
 *
 *   npx tsx scripts/relations/bakeoff-v9.ts inputs   writes the knob's pair list: the note pairs of the
 *                                                    label set that no recorded v9 decision covers,
 *                                                    oriented so one call per source note carries many
 *   npx tsx scripts/relations/bakeoff-v9.ts merge [--report <note-pair-verdicts.json> ...]
 *                                                    recorded + live verdicts in one file for T58
 *
 * Recorded verdicts are the 574 `relation_decisions` of the v9 run on the pinned fixture
 * (`.cache/f3/labels/r-v9/decisions.json`, decider key e78e…, contract `atomic-note-matching-v9`): one
 * score per judged direction. A generative decider judges an unordered pair once, so a pair has one live
 * verdict, from the call of the note the file made its source.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { repositoryRoot } from "../spikes/reranker/dataset.ts";
import {
  bakeoffDirectory,
  loadBakeoffSources,
  pairKeyOf,
  type BakeoffSources,
  type LabelItem
} from "./bakeoff-sets.ts";
import { sha256Hex, type StoredNote } from "./note-texts.ts";

export const v9Contract = "atomic-note-matching-v9";
export const v9PairsFile = "inputs/v9-note-pairs.json";
export const v9VerdictsFile = "v9-verdicts.json";
export const recordedDecisionsPath = join(
  repositoryRoot,
  ".cache",
  "f3",
  "labels",
  "r-v9",
  "decisions.json"
);

/** The stored decision rows of the v9 run (Postgres text output: empty string for NULL). */
const recordedRowSchema = z
  .object({
    lo_note: z.string().min(1),
    hi_note: z.string().min(1),
    decider_key: z.string(),
    lo_to_hi_score: z.string(),
    lo_to_hi_relation_type: z.string(),
    hi_to_lo_score: z.string(),
    hi_to_lo_relation_type: z.string(),
    accepted: z.string(),
    lo_to_hi_decided_at: z.string().optional(),
    hi_to_lo_decided_at: z.string().optional()
  })
  .passthrough();

export interface Verdict {
  lo: string;
  hi: string;
  /** `lo_to_hi` and `hi_to_lo` for recorded rows; `call` for a live verdict (the pair's source note's call). */
  direction: "lo_to_hi" | "hi_to_lo" | "call";
  /** The decider's score scaled to 0-1 (the contract's integer divided by 100). */
  score: number;
  scoreInt: number;
  relationType: string;
  origin: "recorded" | "live";
  /** Recorded rows only: whether the pair was accepted by the whole pipeline. */
  accepted: boolean | null;
  /** The source note of the live call. */
  source: string | null;
  aiTaskRunId: string | null;
}

export function readRecordedVerdicts(rows: unknown): Verdict[] {
  const verdicts: Verdict[] = [];
  for (const row of z.array(recordedRowSchema).parse(rows)) {
    for (const direction of ["lo_to_hi", "hi_to_lo"] as const) {
      const text = row[`${direction}_score`];
      if (text === "") continue;
      const score = Number(text);
      if (!Number.isFinite(score) || score < 0 || score > 1)
        throw new Error(`A recorded decision has the score "${text}".`);
      verdicts.push({
        lo: row.lo_note,
        hi: row.hi_note,
        direction,
        score,
        scoreInt: Math.round(score * 100),
        relationType: row[`${direction}_relation_type`],
        origin: "recorded",
        accepted: row.accepted === "t",
        source: null,
        aiTaskRunId: null
      });
    }
  }
  return verdicts;
}

export interface LivePair {
  source: string;
  candidate: string;
  label: string;
}

/**
 * Orients unordered pairs so as few notes as possible are sources: the note in the most uncovered
 * pairs takes them all (ties by id), repeatedly. One call then carries all its pairs.
 */
export function orientPairs(
  pairs: ReadonlyArray<readonly [string, string]>
): Array<[string, string]> {
  const remaining = new Map(pairs.map(([a, b]) => [pairKeyOf(a, b), [a, b] as [string, string]]));
  const oriented: Array<[string, string]> = [];
  while (remaining.size > 0) {
    const degree = new Map<string, number>();
    for (const [a, b] of remaining.values())
      for (const note of [a, b]) degree.set(note, (degree.get(note) ?? 0) + 1);
    const [source] = [...degree.entries()].sort(
      ([ia, da], [ib, db]) => db - da || (ia < ib ? -1 : 1)
    )[0]!;
    for (const [key, [a, b]] of [...remaining]) {
      if (a !== source && b !== source) continue;
      oriented.push([source, a === source ? b : a]);
      remaining.delete(key);
    }
  }
  return oriented;
}

export interface V9Plan {
  /** Note pairs of the label set (all sets) with no recorded verdict, oriented for the calls. */
  live: LivePair[];
  /** Note pairs of the label set covered by a recorded verdict. */
  recordedPairs: number;
  labelPairs: number;
  notes: Record<string, { title: string; idea: string }>;
}

/** The label set's note pairs, minus those a recorded verdict covers, with the text of their notes. */
export function planV9(
  items: readonly LabelItem[],
  recorded: readonly Verdict[],
  noteOf: (id: string) => StoredNote | undefined
): V9Plan {
  const covered = new Set(recorded.map((verdict) => pairKeyOf(verdict.lo, verdict.hi)));
  const labelOf = new Map<string, string>();
  for (const item of items) {
    if (item.kind !== "note") continue;
    const key = pairKeyOf(item.lo, item.hi);
    labelOf.set(key, `${item.pairId} ${[...item.sets].sort().join(",")}`.slice(0, 200));
  }
  const needed = [...labelOf.keys()].filter((key) => !covered.has(key)).sort();
  const pairs = needed.map((key) => key.split("|") as [string, string]);
  const live = orientPairs(pairs).map(([source, candidate]) => ({
    source,
    candidate,
    label: labelOf.get(pairKeyOf(source, candidate))!
  }));
  const notes: V9Plan["notes"] = {};
  for (const { source, candidate } of live)
    for (const id of [source, candidate]) {
      const note = noteOf(id);
      if (!note) throw new Error(`No text for note ${id}.`);
      notes[id] = { title: note.title, idea: note.idea };
    }
  return { live, recordedPairs: labelOf.size - needed.length, labelPairs: labelOf.size, notes };
}

const reportSchema = z
  .object({
    format: z.literal("memora-golden-note-pair-verdicts"),
    version: z.literal(1),
    state: z.literal("finished"),
    contract: z.string(),
    pairsFile: z.object({ sha256: z.string() }).passthrough(),
    totals: z.record(z.string(), z.number()),
    cassette: z.object({ mode: z.string() }).passthrough().nullable(),
    pairs: z.array(
      z
        .object({
          source: z.string(),
          candidate: z.string(),
          status: z.enum(["decided", "undecided", "skipped", "error"]),
          score: z.number().int().min(0).max(100).nullable(),
          relationType: z.string().nullable(),
          aiTaskRunId: z.string().nullable()
        })
        .passthrough()
    )
  })
  .passthrough();
export type NotePairReport = z.infer<typeof reportSchema>;

export function readReport(json: unknown): NotePairReport {
  const report = reportSchema.parse(json);
  if (report.contract !== v9Contract)
    throw new Error(`The report is of the contract ${report.contract}, not ${v9Contract}.`);
  return report;
}

export function liveVerdicts(report: NotePairReport): Verdict[] {
  return report.pairs.flatMap((pair) => {
    if (pair.status !== "decided" || pair.score === null || pair.relationType === null) return [];
    const [lo, hi] =
      pair.source < pair.candidate ? [pair.source, pair.candidate] : [pair.candidate, pair.source];
    return [
      {
        lo,
        hi,
        direction: "call" as const,
        score: pair.score / 100,
        scoreInt: pair.score,
        relationType: pair.relationType,
        origin: "live" as const,
        accepted: null,
        source: pair.source,
        aiTaskRunId: pair.aiTaskRunId
      }
    ];
  });
}

export interface MergedVerdicts {
  verdicts: Verdict[];
  /** Label-set note pairs with no verdict, recorded or live. */
  missing: string[];
  counts: Record<string, number>;
}

export function mergeVerdicts(
  items: readonly LabelItem[],
  recorded: readonly Verdict[],
  live: readonly Verdict[]
): MergedVerdicts {
  const verdicts = [...recorded, ...live].sort(
    (a, b) =>
      pairKeyOf(a.lo, a.hi).localeCompare(pairKeyOf(b.lo, b.hi)) ||
      a.origin.localeCompare(b.origin) ||
      a.direction.localeCompare(b.direction)
  );
  const have = new Set(verdicts.map((verdict) => pairKeyOf(verdict.lo, verdict.hi)));
  const labelled = new Set(
    items.filter((item) => item.kind === "note").map((item) => pairKeyOf(item.lo, item.hi))
  );
  return {
    verdicts,
    missing: [...labelled].filter((key) => !have.has(key)).sort(),
    counts: {
      labelPairs: labelled.size,
      labelPairsWithVerdict: [...labelled].filter((key) => have.has(key)).length,
      recordedVerdicts: recorded.length,
      liveVerdicts: live.length,
      recordedPairs: new Set(recorded.map((v) => pairKeyOf(v.lo, v.hi))).size,
      livePairs: new Set(live.map((v) => pairKeyOf(v.lo, v.hi))).size
    }
  };
}

// --- Command line ---------------------------------------------------------------------------------------

async function writeJson(path: string, value: unknown, pretty = false): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, pretty ? 1 : undefined)}\n`);
}

async function context(): Promise<{
  sources: BakeoffSources;
  recorded: Verdict[];
  recordedSha256: string;
  noteOf: (id: string) => StoredNote | undefined;
}> {
  const sources = await loadBakeoffSources();
  const bytes = await readFile(recordedDecisionsPath);
  return {
    sources,
    recorded: readRecordedVerdicts(JSON.parse(bytes.toString("utf8"))),
    recordedSha256: sha256Hex(bytes),
    noteOf: (id) =>
      sources.notes.fixture.get(id) ??
      sources.notes.golden.get(id) ??
      sources.notes.corpus.get(id) ??
      sources.notes["spike-a"].get(id)
  };
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { report: { type: "string", multiple: true }, "out-dir": { type: "string" } },
    allowPositionals: true,
    strict: true
  });
  const outDir = resolve(values["out-dir"] ?? bakeoffDirectory);
  const { sources, recorded, recordedSha256, noteOf } = await context();
  if (positionals[0] === "inputs") {
    const plan = planV9(sources.labels.items, recorded, noteOf);
    const file = {
      format: "memora-golden-note-pairs",
      version: 1,
      notes: plan.notes,
      pairs: plan.live
    };
    const path = join(outDir, v9PairsFile);
    await writeJson(path, file);
    const sourcesCount = new Set(plan.live.map((pair) => pair.source)).size;
    console.info(
      `${plan.live.length} live note pairs (${plan.recordedPairs} of ${plan.labelPairs} label pairs ` +
        `have a recorded verdict), ${sourcesCount} source notes -> ${path}`
    );
    return;
  }
  if (positionals[0] === "merge") {
    const reports = await Promise.all(
      (values.report ?? []).map(async (path) => ({
        path,
        report: readReport(JSON.parse(await readFile(resolve(path), "utf8")))
      }))
    );
    const live = reports.flatMap(({ report }) => liveVerdicts(report));
    const merged = mergeVerdicts(sources.labels.items, recorded, live);
    const file = {
      format: "memora-relations-v9-verdicts",
      version: 1,
      task: "T46b",
      contract: v9Contract,
      verdicts: merged.verdicts,
      missing: merged.missing,
      run: {
        counts: merged.counts,
        inputs: {
          recordedDecisions: recordedSha256,
          labels: sources.labelsSha256,
          reports: reports.map(({ path, report }) => ({
            path,
            pairsSha256: report.pairsFile.sha256,
            cassette: report.cassette?.mode ?? null,
            totals: report.totals
          }))
        }
      }
    };
    const path = join(outDir, v9VerdictsFile);
    await writeJson(path, file);
    console.info(
      `${JSON.stringify(merged.counts)}; ${merged.missing.length} label pairs have no verdict -> ${path}`
    );
    return;
  }
  console.info(
    "Usage: npx tsx scripts/relations/bakeoff-v9.ts <inputs|merge> [--report <file> ...] [--out-dir <dir>]"
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[bakeoff-v9] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
