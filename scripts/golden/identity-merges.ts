/**
 * F4 C1 (X7 back to 40 generative calls per chapter): the merged-entity statistic of entity identity
 * and the partition agreement that guard "identity grouped across a source's extraction batches"
 * (D20, spec 5.3). The plan adopts grouping only if the merged-entity count stays within +/-5% of the
 * per-batch run; no script defined that count until now.
 *
 *   M = rows of `entity_identity_keys` for the roots - distinct `entity_id` among them
 *
 * (extracted entities folded into a canonical one; `entities.metadata.identityResolution` is not
 * used, a later merge overwrites it). Four commands, all read-only:
 *
 *   npx tsx scripts/golden/identity-merges.ts snapshot --db <connection.json> --out <snapshot.json>
 *       [--label per-batch] [--root-title <title> ...]     one library's identity rows and mentions
 *   npx tsx scripts/golden/identity-merges.ts report --snapshot <snapshot.json> [--expect-merges <n>]
 *       [--json f] [--out f.md]
 *   npx tsx scripts/golden/identity-merges.ts compare --baseline <a.json> --candidate <b.json>
 *       [--noise <n.json>] [--tolerance 0.05] [--json f] [--out f.md]     M, the bar, the partitions
 *   npx tsx scripts/golden/identity-merges.ts cassette --dir <cassette dir> [--kind entity|relation]
 *       [--row-cap 12] [--char-cap 12000] [--since <iso>] [--json f] [--out f.md]
 *       the identity calls of a recording: rows per call, decisions, which cap bound (no database)
 *
 * The partition is compared over mentions keyed by what two runs of the same extraction share:
 * the chunk's content hash and the entity's normalized surface text (IDs and fingerprints differ
 * between profiles). A mention whose entity was merged into another of the same chunk is lost to
 * the unique (entity, chunk) index; the report counts the mentions each side lacks.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { createReadOnlyClient, resolveEvaluationConnection } from "./matching-evaluation-db.ts";

/** X7-REF's five roots (`scripts/golden/manifest.json`), by title as `x7-yield.py` finds them. */
export const x7RefRootTitles = [
  "Memory and Language",
  "O Alienista",
  "A Cartomante",
  "The Tell-Tale Heart",
  "The Gift of the Magi"
] as const;

// --- Snapshot --------------------------------------------------------------------------------

export const identitySnapshotSchema = z
  .object({
    format: z.literal("memora-identity-merges-snapshot"),
    version: z.literal(1),
    label: z.string(),
    capturedAt: z.string(),
    /** The root titles asked for, each found exactly once. */
    roots: z.array(z.string().min(1)).min(1),
    /** One row per `entity_identity_keys` row of the roots' source items. */
    rows: z.array(
      z
        .object({
          fingerprint: z.string().min(1),
          entityId: z.string().min(1),
          root: z.string(),
          type: z.string(),
          name: z.string()
        })
        .strict()
    ),
    /** One per `entity_mentions` row of the roots: the unit the partitions are compared on. */
    mentions: z.array(
      z
        .object({
          root: z.string(),
          chunkHash: z.string().min(1),
          chunkIndex: z.number().int(),
          surface: z.string(),
          entityId: z.string().min(1)
        })
        .strict()
    ),
    catalog: z
      .object({
        entities: z.number().int().nonnegative(),
        /** Entities with no identity key in the roots: a library that was not reset first. */
        entitiesWithoutKeysInRoots: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type IdentitySnapshot = z.infer<typeof identitySnapshotSchema>;
export type IdentityRow = IdentitySnapshot["rows"][number];
export type IdentityMention = IdentitySnapshot["mentions"][number];

export interface MergeStatistic {
  rows: number;
  entities: number;
  /** Rows folded into an entity another row of the roots already resolved to. */
  merged: number;
}

/** M = rows - distinct entity IDs. */
export function mergedEntityStatistic(
  rows: ReadonlyArray<Pick<IdentityRow, "entityId">>
): MergeStatistic {
  const entities = new Set(rows.map((row) => row.entityId)).size;
  return { rows: rows.length, entities, merged: rows.length - entities };
}

export function mergesByType(
  rows: readonly IdentityRow[]
): Array<{ type: string } & MergeStatistic> {
  const groups = Map.groupBy(rows, (row) => row.type);
  return [...groups.entries()]
    .map(([type, list]) => ({ type, ...mergedEntityStatistic(list) }))
    .sort((a, b) => (a.type < b.type ? -1 : 1));
}

export function mergesByRoot(
  rows: readonly IdentityRow[]
): Array<{ root: string } & MergeStatistic> {
  const groups = Map.groupBy(rows, (row) => row.root);
  return [...groups.entries()]
    .map(([root, list]) => ({ root, ...mergedEntityStatistic(list) }))
    .sort((a, b) => (a.root < b.root ? -1 : 1));
}

// --- Partition agreement ---------------------------------------------------------------------

/** The text two runs of one extraction share: lowercase, no accents, no surrounding space. */
export const normalizeSurface = (value: string): string =>
  value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/gu, " ").trim();

const choose2 = (n: number) => (n * (n - 1)) / 2;

export interface PartitionAgreement {
  commonMentions: number;
  onlyBaseline: number;
  onlyCandidate: number;
  /** Keys that map to several entities inside one side (the first entity ID is kept). */
  ambiguousBaseline: number;
  ambiguousCandidate: number;
  entitiesBaseline: number;
  entitiesCandidate: number;
  /** Mention pairs in one entity on each side, and on both. */
  togetherBaseline: number;
  togetherCandidate: number;
  togetherBoth: number;
  /** Of the pairs the candidate puts together, the share the baseline does too. */
  precision: number | null;
  /** Of the pairs the baseline puts together, the share the candidate does too. */
  recall: number | null;
  f1: number | null;
  /** Share of all mention pairs the two partitions treat alike (together or apart). */
  rand: number | null;
}

function mentionMap(mentions: readonly IdentityMention[]) {
  const map = new Map<string, string>();
  let ambiguous = 0;
  for (const mention of mentions) {
    const key = `${mention.chunkHash}|${normalizeSurface(mention.surface)}`;
    const known = map.get(key);
    if (known === undefined) map.set(key, mention.entityId);
    else if (known !== mention.entityId) {
      ambiguous += 1;
      if (mention.entityId < known) map.set(key, mention.entityId);
    }
  }
  return { map, ambiguous };
}

/** Pairwise agreement of two partitions of the mentions both sides hold, by contingency counts. */
export function partitionAgreement(
  baseline: readonly IdentityMention[],
  candidate: readonly IdentityMention[]
): PartitionAgreement {
  const a = mentionMap(baseline);
  const b = mentionMap(candidate);
  const common = [...a.map.keys()].filter((key) => b.map.has(key));
  const countsA = new Map<string, number>();
  const countsB = new Map<string, number>();
  const cells = new Map<string, number>();
  for (const key of common) {
    const x = a.map.get(key)!;
    const y = b.map.get(key)!;
    countsA.set(x, (countsA.get(x) ?? 0) + 1);
    countsB.set(y, (countsB.get(y) ?? 0) + 1);
    const cell = `${x}\u0000${y}`;
    cells.set(cell, (cells.get(cell) ?? 0) + 1);
  }
  const sum = (values: Iterable<number>) =>
    [...values].reduce((total, value) => total + choose2(value), 0);
  const togetherBaseline = sum(countsA.values());
  const togetherCandidate = sum(countsB.values());
  const togetherBoth = sum(cells.values());
  const all = choose2(common.length);
  const precision = togetherCandidate ? togetherBoth / togetherCandidate : null;
  const recall = togetherBaseline ? togetherBoth / togetherBaseline : null;
  return {
    commonMentions: common.length,
    onlyBaseline: a.map.size - common.length,
    onlyCandidate: b.map.size - common.length,
    ambiguousBaseline: a.ambiguous,
    ambiguousCandidate: b.ambiguous,
    entitiesBaseline: countsA.size,
    entitiesCandidate: countsB.size,
    togetherBaseline,
    togetherCandidate,
    togetherBoth,
    precision,
    recall,
    f1:
      precision !== null && recall !== null && precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : null,
    rand: all ? (all - (togetherBaseline + togetherCandidate - 2 * togetherBoth)) / all : null
  };
}

// --- Comparison ------------------------------------------------------------------------------

export interface SnapshotSummary extends MergeStatistic {
  label: string;
  capturedAt: string;
  roots: number;
  mentions: number;
  catalog: IdentitySnapshot["catalog"];
  byType: Array<{ type: string } & MergeStatistic>;
  byRoot: Array<{ root: string } & MergeStatistic>;
}

export function summarizeSnapshot(snapshot: IdentitySnapshot): SnapshotSummary {
  return {
    label: snapshot.label,
    capturedAt: snapshot.capturedAt,
    roots: snapshot.roots.length,
    mentions: snapshot.mentions.length,
    catalog: snapshot.catalog,
    ...mergedEntityStatistic(snapshot.rows),
    byType: mergesByType(snapshot.rows),
    byRoot: mergesByRoot(snapshot.rows)
  };
}

export type CompareVerdict = "within" | "owner" | "miss";

export interface SnapshotComparison {
  format: "memora-identity-merges-comparison";
  version: 1;
  tolerance: number;
  baseline: SnapshotSummary;
  candidate: SnapshotSummary;
  noise: SnapshotSummary | null;
  /** M of the candidate minus M of the baseline, and as a share of the baseline's M. */
  difference: number;
  relative: number | null;
  /** The merges the bar allows the candidate to differ by (tolerance x baseline M). */
  allowedAbsolute: number;
  withinTolerance: boolean;
  /** The noise reference's own difference from the baseline: the run-to-run spread of one extraction. */
  noiseDifference: number | null;
  /**
   * within: inside the bar. owner: outside it by no more than the noise reference's own spread, so it
   * goes to the owner and never passes by itself (C1). miss: outside it by more than the noise.
   */
  verdict: CompareVerdict;
  agreement: {
    baselineVsCandidate: PartitionAgreement;
    baselineVsNoise: PartitionAgreement | null;
    noiseVsCandidate: PartitionAgreement | null;
  };
  byType: Array<{
    type: string;
    baseline: MergeStatistic;
    candidate: MergeStatistic;
    difference: number;
  }>;
  /** Problems that weaken the reading (a library that was not reset first, different roots). */
  warnings: string[];
}

export function compareSnapshots(input: {
  baseline: IdentitySnapshot;
  candidate: IdentitySnapshot;
  noise?: IdentitySnapshot | undefined;
  tolerance?: number | undefined;
}): SnapshotComparison {
  const tolerance = input.tolerance ?? 0.05;
  const baseline = summarizeSnapshot(input.baseline);
  const candidate = summarizeSnapshot(input.candidate);
  const noise = input.noise ? summarizeSnapshot(input.noise) : null;
  const difference = candidate.merged - baseline.merged;
  const allowedAbsolute = tolerance * baseline.merged;
  const withinTolerance = Math.abs(difference) <= allowedAbsolute + 1e-9;
  const noiseDifference = noise ? noise.merged - baseline.merged : null;
  const verdict: CompareVerdict = withinTolerance
    ? "within"
    : noiseDifference !== null && Math.abs(difference) <= Math.abs(noiseDifference)
      ? "owner"
      : "miss";
  const types = new Set([...baseline.byType, ...candidate.byType].map((item) => item.type));
  const find = (summary: SnapshotSummary, type: string): MergeStatistic => {
    const found = summary.byType.find((item) => item.type === type);
    return { rows: found?.rows ?? 0, entities: found?.entities ?? 0, merged: found?.merged ?? 0 };
  };
  const warnings: string[] = [];
  for (const [name, snapshot] of [
    ["baseline", input.baseline],
    ["candidate", input.candidate],
    ...(input.noise ? ([["noise", input.noise]] as const) : [])
  ] as const)
    if (snapshot.catalog.entitiesWithoutKeysInRoots > 0)
      warnings.push(
        `${name}: ${snapshot.catalog.entitiesWithoutKeysInRoots} entities have no identity key in the roots (the library was not reset first); merges into them are not counted.`
      );
  const rootsKey = (snapshot: IdentitySnapshot) => [...snapshot.roots].sort().join("|");
  if (rootsKey(input.baseline) !== rootsKey(input.candidate))
    warnings.push("baseline and candidate were read for different roots.");
  if (baseline.rows !== candidate.rows)
    warnings.push(
      `baseline holds ${baseline.rows} identity rows, candidate ${candidate.rows}: the extraction is not identical, so M is not comparable.`
    );
  return {
    format: "memora-identity-merges-comparison",
    version: 1,
    tolerance,
    baseline,
    candidate,
    noise,
    difference,
    relative: baseline.merged ? difference / baseline.merged : null,
    allowedAbsolute,
    withinTolerance,
    noiseDifference,
    verdict,
    agreement: {
      baselineVsCandidate: partitionAgreement(input.baseline.mentions, input.candidate.mentions),
      baselineVsNoise: input.noise
        ? partitionAgreement(input.baseline.mentions, input.noise.mentions)
        : null,
      noiseVsCandidate: input.noise
        ? partitionAgreement(input.noise.mentions, input.candidate.mentions)
        : null
    },
    byType: [...types].sort().map((type) => ({
      type,
      baseline: find(baseline, type),
      candidate: find(candidate, type),
      difference: find(candidate, type).merged - find(baseline, type).merged
    })),
    warnings
  };
}

// --- Rendering -------------------------------------------------------------------------------

const percent = (value: number | null) => (value === null ? "n/a" : `${(value * 100).toFixed(1)}%`);

export function renderSnapshotMarkdown(
  snapshot: IdentitySnapshot,
  options: { expectMerges?: number | undefined } = {}
): string {
  const summary = summarizeSnapshot(snapshot);
  const expected = options.expectMerges;
  return [
    `# Merged entities: ${summary.label}`,
    "",
    `${summary.roots} roots (${snapshot.roots.join(", ")}), read ${summary.capturedAt}.`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    `| Identity rows (\`entity_identity_keys\`) | ${summary.rows} |`,
    `| Distinct entities among them | ${summary.entities} |`,
    `| **M, rows folded into another** | **${summary.merged}** |`,
    `| Mentions | ${summary.mentions} |`,
    `| Entities of the library, none keyed in the roots | ${summary.catalog.entitiesWithoutKeysInRoots} of ${summary.catalog.entities} |`,
    ...(expected === undefined
      ? []
      : [
          `| Merge decisions of the recording | ${expected} (${
            expected === summary.merged
              ? "equal to M"
              : `M differs by ${summary.merged - expected >= 0 ? "+" : ""}${summary.merged - expected}`
          }) |`
        ]),
    "",
    "| Type | Rows | Entities | M |",
    "| --- | ---: | ---: | ---: |",
    ...summary.byType.map(
      (item) => `| ${item.type} | ${item.rows} | ${item.entities} | ${item.merged} |`
    ),
    "",
    "| Root | Rows | Entities | M |",
    "| --- | ---: | ---: | ---: |",
    ...summary.byRoot.map(
      (item) => `| ${item.root} | ${item.rows} | ${item.entities} | ${item.merged} |`
    ),
    ""
  ].join("\n");
}

const agreementRow = (name: string, item: PartitionAgreement | null) =>
  item
    ? `| ${name} | ${item.commonMentions} (${item.onlyBaseline} / ${item.onlyCandidate} not shared) | ${item.togetherBaseline} / ${item.togetherCandidate} / ${item.togetherBoth} | ${percent(item.precision)} | ${percent(item.recall)} | ${percent(item.f1)} | ${percent(item.rand)} |`
    : null;

export function renderComparisonMarkdown(comparison: SnapshotComparison): string {
  const { baseline, candidate, noise } = comparison;
  return [
    "# Merged entities: candidate against baseline (C1)",
    "",
    "| Run | Rows | Entities | M |",
    "| --- | ---: | ---: | ---: |",
    `| baseline (${baseline.label}) | ${baseline.rows} | ${baseline.entities} | ${baseline.merged} |`,
    `| candidate (${candidate.label}) | ${candidate.rows} | ${candidate.entities} | ${candidate.merged} |`,
    ...(noise
      ? [
          `| noise reference (${noise.label}) | ${noise.rows} | ${noise.entities} | ${noise.merged} |`
        ]
      : []),
    "",
    `M differs by ${comparison.difference >= 0 ? "+" : ""}${comparison.difference} (${percent(comparison.relative)}); the bar is +/-${percent(comparison.tolerance)} of ${baseline.merged} = +/-${comparison.allowedAbsolute.toFixed(2)} merges. Verdict: **${comparison.verdict}**${
      comparison.verdict === "owner"
        ? ` (outside the bar by no more than the noise reference's own ${comparison.noiseDifference! >= 0 ? "+" : ""}${comparison.noiseDifference}; it goes to the owner and never passes by itself)`
        : comparison.verdict === "miss" && comparison.noiseDifference !== null
          ? ` (more than the noise reference's ${comparison.noiseDifference >= 0 ? "+" : ""}${comparison.noiseDifference})`
          : ""
    }.`,
    "",
    "Canonical partition over the mentions both runs hold (pairs together in the baseline / in the other / in both):",
    "",
    "| Pair | Common mentions | Pairs together | Precision | Recall | F1 | Rand |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    agreementRow("baseline vs candidate", comparison.agreement.baselineVsCandidate),
    agreementRow("baseline vs noise reference", comparison.agreement.baselineVsNoise),
    agreementRow("noise reference vs candidate", comparison.agreement.noiseVsCandidate)
  ]
    .filter((line): line is string => line !== null)
    .concat([
      "",
      "| Type | baseline rows / M | candidate rows / M | difference |",
      "| --- | ---: | ---: | ---: |",
      ...comparison.byType.map(
        (item) =>
          `| ${item.type} | ${item.baseline.rows} / ${item.baseline.merged} | ${item.candidate.rows} / ${item.candidate.merged} | ${item.difference >= 0 ? "+" : ""}${item.difference} |`
      ),
      ...(comparison.warnings.length
        ? ["", "Warnings:", "", ...comparison.warnings.map((warning) => `- ${warning}`)]
        : []),
      ""
    ])
    .join("\n");
}

// --- The cassette: identity calls, group sizes and decisions ---------------------------------

const cassetteEntrySchema = z
  .object({
    taskType: z.string(),
    request: z.object({ input: z.string().optional() }).passthrough(),
    responses: z
      .array(
        z
          .object({ output: z.unknown().optional(), recordedAt: z.string().optional() })
          .passthrough()
      )
      .default([])
  })
  .passthrough();

/** First words of the shipped prompts (`graph.entity_identity`, `graph.relation_identity`). */
export const identityPromptMarkers = {
  entity: "Match entities only when the evidence establishes the SAME real-world identity",
  relation: "Match directed relation types only when their FULL meanings are interchangeable"
} as const;
export type IdentityKind = keyof typeof identityPromptMarkers;

export interface IdentityCall {
  recordedAt: string | null;
  rows: number;
  candidates: number;
  /** Characters of the recorded prompt, language preamble included. */
  characters: number;
  /** Characters of the rows and candidates JSON alone. */
  payloadCharacters: number;
  types: Record<string, number>;
  /** Non-null answers: rows the writer folded into a candidate. */
  matches: number;
  /** Rows answered null. */
  nulls: number;
  /** Rows with no answer in the recorded output (an invalid answer). */
  unanswered: number;
  responses: number;
}

const matchesSchema = z.object({ matches: z.array(z.tuple([z.string(), z.string().nullable()])) });
const payloadSchema = z.object({
  relations: z.array(z.tuple([z.string(), z.string(), z.string(), z.array(z.string())])),
  candidates: z.array(z.array(z.string()))
});

/** One cassette entry as an identity call; null when it is some other call. */
export function parseIdentityCall(entry: unknown, kind: IdentityKind): IdentityCall | null {
  const parsed = cassetteEntrySchema.safeParse(entry);
  if (!parsed.success || parsed.data.taskType !== "knowledge-graph-generation") return null;
  const input = parsed.data.request.input ?? "";
  if (!input.includes(identityPromptMarkers[kind])) return null;
  const start = input.indexOf('{"relations":');
  if (start < 0) return null;
  let payload: z.infer<typeof payloadSchema>;
  try {
    payload = payloadSchema.parse(JSON.parse(input.slice(start)));
  } catch {
    return null;
  }
  const first = parsed.data.responses[0];
  let answers = new Map<string, string | null>();
  if (typeof first?.output === "string") {
    try {
      answers = new Map(matchesSchema.parse(JSON.parse(first.output)).matches);
    } catch {
      answers = new Map();
    }
  }
  const types: Record<string, number> = {};
  for (const [, predicate] of payload.relations) {
    const type = predicate.includes(": ") ? predicate.slice(0, predicate.indexOf(": ")) : "-";
    types[type] = (types[type] ?? 0) + 1;
  }
  const keys = payload.relations.map(([key]) => key);
  return {
    recordedAt: first?.recordedAt ?? null,
    rows: payload.relations.length,
    candidates: payload.candidates.length,
    characters: input.length,
    payloadCharacters: input.length - start,
    types,
    matches: keys.filter((key) => typeof answers.get(key) === "string").length,
    nulls: keys.filter((key) => answers.get(key) === null).length,
    unanswered: keys.filter((key) => !answers.has(key)).length,
    responses: parsed.data.responses.length
  };
}

export interface IdentityCallSummary {
  kind: IdentityKind;
  rowCap: number;
  characterCap: number;
  calls: number;
  rows: number;
  rowsPerCall: { min: number; mean: number; max: number };
  matches: number;
  nulls: number;
  unanswered: number;
  /** Rows by entity type (the prompt's "Type: name"). */
  types: Record<string, number>;
  /** Calls with a bound: rows (the row cap is full) or characters (inference: the mean row would not fit). */
  bound: { rows: number; characters: number; neither: number };
  /** Entries holding several recorded responses (a retry). */
  retried: number;
  histogram: Array<{ rows: number; calls: number }>;
}

/** Group sizes and decisions of a set of identity calls under the caps they were formed with. */
export function summarizeIdentityCalls(
  calls: readonly IdentityCall[],
  options: { kind: IdentityKind; rowCap: number; characterCap: number }
): IdentityCallSummary {
  const rows = calls.map((call) => call.rows);
  const types: Record<string, number> = {};
  for (const call of calls)
    for (const [type, count] of Object.entries(call.types))
      types[type] = (types[type] ?? 0) + count;
  let byRows = 0;
  let byCharacters = 0;
  for (const call of calls) {
    const meanRow = call.rows ? call.payloadCharacters / call.rows : 0;
    if (call.rows >= options.rowCap) byRows += 1;
    else if (call.characters + meanRow > options.characterCap) byCharacters += 1;
  }
  const histogram = [...Map.groupBy(rows, (value) => value).entries()]
    .map(([count, list]) => ({ rows: count, calls: list.length }))
    .sort((a, b) => a.rows - b.rows);
  const total = rows.reduce((sum, value) => sum + value, 0);
  return {
    kind: options.kind,
    rowCap: options.rowCap,
    characterCap: options.characterCap,
    calls: calls.length,
    rows: total,
    rowsPerCall: {
      min: rows.length ? Math.min(...rows) : 0,
      mean: rows.length ? total / rows.length : 0,
      max: rows.length ? Math.max(...rows) : 0
    },
    matches: calls.reduce((sum, call) => sum + call.matches, 0),
    nulls: calls.reduce((sum, call) => sum + call.nulls, 0),
    unanswered: calls.reduce((sum, call) => sum + call.unanswered, 0),
    types,
    bound: {
      rows: byRows,
      characters: byCharacters,
      neither: calls.length - byRows - byCharacters
    },
    retried: calls.filter((call) => call.responses > 1).length,
    histogram
  };
}

/** The identity calls recorded in a cassette directory (`entries/<xx>/<hash>.json`), oldest first. */
export async function readCassetteIdentityCalls(
  directory: string,
  kind: IdentityKind,
  options: { since?: string | undefined; until?: string | undefined } = {}
): Promise<IdentityCall[]> {
  const root = join(resolve(directory), "entries");
  const calls: IdentityCall[] = [];
  for (const shard of (await readdir(root)).sort()) {
    for (const file of (await readdir(join(root, shard))).sort()) {
      if (!file.endsWith(".json")) continue;
      const text = await readFile(join(root, shard, file), "utf8");
      // Skip the embedding and reranking entries without parsing their vectors.
      if (
        !text.includes('"taskType":"knowledge-graph-generation"') &&
        !text.includes('"taskType": "knowledge-graph-generation"')
      )
        continue;
      const call = parseIdentityCall(JSON.parse(text), kind);
      if (!call) continue;
      if (options.since && (!call.recordedAt || call.recordedAt < options.since)) continue;
      if (options.until && (!call.recordedAt || call.recordedAt >= options.until)) continue;
      calls.push(call);
    }
  }
  return calls.sort((a, b) => ((a.recordedAt ?? "") < (b.recordedAt ?? "") ? -1 : 1));
}

export function renderCassetteMarkdown(summary: IdentityCallSummary, source: string): string {
  const name = summary.kind === "entity" ? "entity identity" : "relation type";
  return [
    `# ${name[0]!.toUpperCase()}${name.slice(1)} calls in a cassette`,
    "",
    `${source}. Caps assumed: ${summary.rowCap} rows and ${summary.characterCap} characters per call.`,
    "",
    "| Measure | Value |",
    "| --- | ---: |",
    `| Calls | ${summary.calls} |`,
    `| Rows | ${summary.rows} |`,
    `| Rows per call, min / mean / max | ${summary.rowsPerCall.min} / ${summary.rowsPerCall.mean.toFixed(2)} / ${summary.rowsPerCall.max} |`,
    `| Non-null answers (rows folded into a candidate) | ${summary.matches} |`,
    `| Null answers | ${summary.nulls} |`,
    `| Rows without an answer | ${summary.unanswered} |`,
    `| Calls bound by the row cap / by characters (inference) / by neither | ${summary.bound.rows} / ${summary.bound.characters} / ${summary.bound.neither} |`,
    `| Entries with a retried response | ${summary.retried} |`,
    "",
    `Rows by type: ${
      Object.entries(summary.types)
        .sort()
        .map(([type, count]) => `${type} ${count}`)
        .join(", ") || "none"
    }.`,
    `Calls by rows: ${summary.histogram.map((item) => `${item.rows} rows x ${item.calls}`).join(", ") || "none"}.`,
    "",
    "A non-null answer is a merge decision of the writer; M counts the rows that ended in an entity another row of the roots also resolved to, so the two agree except for rows answered from the fingerprint cache and invalid answers.",
    ""
  ].join("\n");
}

// --- The database ----------------------------------------------------------------------------

const membersSql = `
  with recursive tree(root_id, id) as (
    select id, id from source_items where parent_source_item_id is null and title = any($1::text[])
    union all
    select t.root_id, c.id from source_items c join tree t on c.parent_source_item_id = t.id
  ), members as (
    select r.title as root_title, t.id as source_item_id
      from tree t join source_items r on r.id = t.root_id
  )`;

/**
 * One library's identity rows and mentions for the given roots, in one read-only snapshot. Refuses a
 * title that names no root or several.
 */
export async function readIdentitySnapshot(
  connectionString: string,
  options: { label: string; rootTitles: readonly string[] }
): Promise<IdentitySnapshot> {
  const client = createReadOnlyClient(connectionString);
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const titles = [...options.rootTitles];
    const found = await client.query<{ title: string; roots: string }>(
      `select title, count(*)::text as roots from source_items
        where parent_source_item_id is null and title = any($1::text[]) group by title`,
      [titles]
    );
    for (const title of titles) {
      const count = Number(found.rows.find((row) => row.title === title)?.roots ?? 0);
      if (count !== 1)
        throw new Error(
          `The library holds ${count} roots titled "${title}"; expected exactly one.`
        );
    }
    const rows = await client.query<IdentityRow>(
      `${membersSql}
       select k.fingerprint, k.entity_id::text as "entityId", m.root_title as root, e.type, e.canonical_name as name
         from entity_identity_keys k
         join members m on m.source_item_id = k.source_item_id
         join entities e on e.id = k.entity_id
        order by m.root_title, k.created_at, k.fingerprint`,
      [titles]
    );
    const mentions = await client.query<IdentityMention>(
      `${membersSql}
       select m.root_title as root, c.content_hash as "chunkHash", c.chunk_index as "chunkIndex",
              em.surface_text as surface, em.entity_id::text as "entityId"
         from entity_mentions em
         join chunks c on c.id = em.chunk_id
         join members m on m.source_item_id = em.source_item_id
        order by m.root_title, c.chunk_index, em.surface_text, em.entity_id`,
      [titles]
    );
    const catalog = await client.query<{ entities: number; outside: number }>(
      `${membersSql}
       select (select count(*) from entities)::int as entities,
              (select count(*) from entities e where not exists (
                 select 1 from entity_identity_keys k join members m on m.source_item_id = k.source_item_id
                  where k.entity_id = e.id))::int as outside`,
      [titles]
    );
    await client.query("commit");
    return identitySnapshotSchema.parse({
      format: "memora-identity-merges-snapshot",
      version: 1,
      label: options.label,
      capturedAt: new Date().toISOString(),
      roots: titles,
      rows: rows.rows,
      mentions: mentions.rows.map((mention) => ({
        ...mention,
        chunkIndex: Number(mention.chunkIndex)
      })),
      catalog: {
        entities: catalog.rows[0]!.entities,
        entitiesWithoutKeysInRoots: catalog.rows[0]!.outside
      }
    });
  } finally {
    await client.end();
  }
}

// --- Command line ----------------------------------------------------------------------------

export const identityMergesUsage = `Merged-entity statistic and partition agreement of entity identity (F4 C1). Read-only.

  snapshot --db <connection.json | postgres url> --out <snapshot.json> [--label <text>] [--root-title <title> ...]
      Reads one library's identity rows and mentions (loopback PostgreSQL only; default roots: X7-REF's five).
  report --snapshot <snapshot.json> [--expect-merges <n>] [--json <file>] [--out <file.md>]
      M, rows and entities by type and by root of one snapshot. --expect-merges is the recording's
      non-null identity answers (the cassette command), which M equals on a replay of that recording.
  compare --baseline <a.json> --candidate <b.json> [--noise <n.json>] [--tolerance <share>] [--json <file>] [--out <file.md>]
      M against the +/-5% bar (default), the noise reference, and the canonical partitions' pairwise agreement.
  cassette --dir <cassette dir> [--kind entity|relation] [--row-cap <n>] [--char-cap <n>] [--since <iso>] [--until <iso>]
      [--json <file>] [--out <file.md>]
      The identity calls recorded in a cassette: rows per call, decisions, which cap bound (no database).`;

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function readSnapshot(path: string): Promise<IdentitySnapshot> {
  return identitySnapshotSchema.parse(await readJsonFile(path));
}

async function writeFileIn(path: string, content: string) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

function positiveInteger(value: string | undefined, fallback: number, name: string): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonNegativeInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${name} must be a whole number.`);
  return parsed;
}

export async function runIdentityMerges(argv: readonly string[]): Promise<string | null> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help")
    return identityMergesUsage;
  const { values } = parseArgs({
    args: rest,
    options: {
      db: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      label: { type: "string" },
      "root-title": { type: "string", multiple: true },
      snapshot: { type: "string" },
      baseline: { type: "string" },
      candidate: { type: "string" },
      noise: { type: "string" },
      tolerance: { type: "string" },
      "expect-merges": { type: "string" },
      dir: { type: "string" },
      kind: { type: "string" },
      "row-cap": { type: "string" },
      "char-cap": { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return identityMergesUsage;
  const emit = async (markdown: string, json: unknown): Promise<string | null> => {
    if (values.json) await writeFileIn(values.json, `${JSON.stringify(json, null, 2)}\n`);
    if (values.out) {
      await writeFileIn(values.out, markdown);
      return null;
    }
    return markdown;
  };
  if (command === "snapshot") {
    if (!values.db || !values.out) throw new Error("snapshot needs --db and --out.");
    const connection = await resolveEvaluationConnection(values.db);
    const snapshot = await readIdentitySnapshot(connection.connectionString, {
      label: values.label ?? "identity",
      rootTitles: values["root-title"]?.length ? values["root-title"] : x7RefRootTitles
    });
    await writeFileIn(values.out, `${JSON.stringify(snapshot, null, 2)}\n`);
    const summary = mergedEntityStatistic(snapshot.rows);
    return `${snapshot.roots.length} roots read from ${connection.description}: ${summary.rows} identity rows, ${summary.entities} entities, M = ${summary.merged}, ${snapshot.mentions.length} mentions -> ${resolve(values.out)}`;
  }
  if (command === "report") {
    if (!values.snapshot) throw new Error("report needs --snapshot.");
    const snapshot = await readSnapshot(values.snapshot);
    const expectMerges =
      values["expect-merges"] === undefined
        ? undefined
        : nonNegativeInteger(values["expect-merges"], "--expect-merges");
    return emit(renderSnapshotMarkdown(snapshot, { expectMerges }), summarizeSnapshot(snapshot));
  }
  if (command === "compare") {
    if (!values.baseline || !values.candidate)
      throw new Error("compare needs --baseline and --candidate.");
    const tolerance = values.tolerance === undefined ? 0.05 : Number(values.tolerance);
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 1)
      throw new Error("--tolerance is a share from 0 to 1.");
    const comparison = compareSnapshots({
      baseline: await readSnapshot(values.baseline),
      candidate: await readSnapshot(values.candidate),
      noise: values.noise ? await readSnapshot(values.noise) : undefined,
      tolerance
    });
    return emit(renderComparisonMarkdown(comparison), comparison);
  }
  if (command === "cassette") {
    if (!values.dir) throw new Error("cassette needs --dir.");
    const kind = (values.kind ?? "entity") as IdentityKind;
    if (kind !== "entity" && kind !== "relation") throw new Error("--kind is entity or relation.");
    const rowCap = positiveInteger(values["row-cap"], 12, "--row-cap");
    const characterCap = positiveInteger(values["char-cap"], 12_000, "--char-cap");
    const calls = await readCassetteIdentityCalls(values.dir, kind, {
      since: values.since,
      until: values.until
    });
    if (!calls.length)
      throw new Error(
        `No ${kind} identity calls found in ${values.dir} (check --since, --until and --kind).`
      );
    const summary = summarizeIdentityCalls(calls, { kind, rowCap, characterCap });
    return emit(renderCassetteMarkdown(summary, `Cassette ${values.dir}`), summary);
  }
  throw new Error(`Unknown command "${command}". Run with --help for usage.`);
}

if (import.meta.main) {
  try {
    const output = await runIdentityMerges(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(`[identity-merges] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
