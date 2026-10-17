/**
 * Pair scoring core (F3 T46a, spec 5.4 step 4): the unordered note pairs of T44's candidate exports,
 * scored in both directions by a local ranker, written as `memora-relations-pair-scores` (the file the
 * evaluator, the rescore script and the reverse-only script read) with the hashes of every input.
 *
 * Pure apart from the scorer it is handed: tests inject a fake, the CLI (`score-pairs.ts`) opens the real
 * MLX or GGUF runtime of Spike A (`scripts/spikes/reranker/runtimes.ts`) inside the local-model lock.
 */
import { readFile } from "node:fs/promises";

import { z } from "zod";

import { mean } from "../spikes/reranker/metrics.ts";
import type { ArtifactInfo, PairText, ScoreCall } from "../spikes/reranker/runtimes.ts";
import { noteTextDigest, sha256Hex, textTemplateId, type TextLookup } from "./note-texts.ts";

export const pairScoresFormat = "memora-relations-pair-scores";

export const pairsFileFormat = "t44-pairs-to-score";

const noteId = z.string().min(1);

/** T44's pair lists: unordered pairs (lower id first), scored in both directions. */
export const pairsFileSchema = z
  .object({
    format: z.literal(pairsFileFormat),
    version: z.literal(1),
    profile: z.string().min(1),
    unorderedPairs: z.number().int().nonnegative(),
    directedPairs: z.number().int().nonnegative(),
    pairs: z.array(z.tuple([noteId, noteId]))
  })
  .passthrough();
export type PairsFile = z.infer<typeof pairsFileSchema>;

export interface ReadPairs {
  file: PairsFile;
  /** SHA-256 of the file's bytes. */
  sha256: string;
}

export async function readPairsFile(path: string): Promise<ReadPairs> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error(`Cannot read the pairs file "${path}".`);
  }
  const file = pairsFileSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (file.unorderedPairs !== file.pairs.length || file.directedPairs !== 2 * file.pairs.length)
    throw new Error(`The pairs file "${path}" counts do not match its pairs.`);
  const seen = new Set<string>();
  for (const [a, b] of file.pairs) {
    if (a === b) throw new Error(`The pairs file "${path}" pairs note ${a} with itself.`);
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) throw new Error(`The pairs file "${path}" lists the pair ${key} twice.`);
    seen.add(key);
  }
  return { file, sha256: sha256Hex(bytes) };
}

/** `query` is the note whose text opens the prompt, `doc` the candidate (the evaluator's convention). */
export interface DirectedPair {
  query: string;
  doc: string;
}

/** Both directions of every pair, a to b first, in the file's order. */
export function directedPairsOf(pairs: ReadonlyArray<readonly [string, string]>): DirectedPair[] {
  return pairs.flatMap(([a, b]) => [
    { query: a, doc: b },
    { query: b, doc: a }
  ]);
}

export function noteIdsOf(pairs: ReadonlyArray<readonly [string, string]>): string[] {
  return [...new Set(pairs.flat())].sort();
}

/** The prompts of the directed pairs; names the notes without text when there are any. */
export function pairTexts(directed: readonly DirectedPair[], lookup: TextLookup): PairText[] {
  const missing = new Set<string>();
  const texts = directed.map(({ query, doc }) => {
    const left = lookup(query);
    const right = lookup(doc);
    if (!left) missing.add(query);
    if (!right) missing.add(doc);
    return { query: left?.text ?? "", document: right?.text ?? "" };
  });
  if (missing.size > 0) {
    const sample = [...missing].sort().slice(0, 5).join(", ");
    throw new Error(`${missing.size} note(s) have no text (first: ${sample}).`);
  }
  return texts;
}

export interface PairScorer {
  readonly name: string;
  readonly artifact: ArtifactInfo;
  scorePairs(
    pairs: PairText[],
    batchSize: number,
    onProgress?: (done: number) => void
  ): Promise<ScoreCall>;
}

export interface ScoreOptions {
  /** The helper's batch size (MLX); GGUF ranks one pair at a time and ignores it. */
  batchSize: number;
  /** Directed pairs per scorer request. A request sorts its pairs by length before batching. */
  requestSize: number;
  onProgress?: (done: number, total: number) => void;
}

export interface ScoredPairs {
  logOdds: number[];
  requests: number;
  /** Sum of the requests' wall times, as the caller sees them. */
  wallMs: number;
  /** MLX only: tokens per pair. */
  tokenCounts: number[];
}

export async function scoreDirectedPairs(
  scorer: PairScorer,
  texts: readonly PairText[],
  options: ScoreOptions
): Promise<ScoredPairs> {
  if (!Number.isInteger(options.requestSize) || options.requestSize <= 0)
    throw new Error("The request size must be a positive integer.");
  const logOdds: number[] = [];
  const tokenCounts: number[] = [];
  let requests = 0;
  let wallMs = 0;
  for (let start = 0; start < texts.length; start += options.requestSize) {
    const chunk = texts.slice(start, start + options.requestSize);
    const call = await scorer.scorePairs(chunk, options.batchSize);
    if (call.logOdds.length !== chunk.length || !call.logOdds.every(Number.isFinite))
      throw new Error(`The scorer returned missing or non-finite scores for pairs ${start}+.`);
    logOdds.push(...call.logOdds);
    tokenCounts.push(...(call.tokenCounts ?? []));
    requests += 1;
    wallMs += call.wallMs;
    options.onProgress?.(logOdds.length, texts.length);
  }
  return { logOdds, requests, wallMs, tokenCounts };
}

// --- The score file ------------------------------------------------------------------------------

export type RuntimeKind = "mlx" | "gguf-qwen3";

/** What identifies the code that produced the scores besides the model: the helper or llama build. */
export type RuntimeBuild =
  { kind: "mlx-helper"; sha256: string } | { kind: "node-llama-cpp"; version: string };

export interface ScoreRunInput {
  profile: string;
  runtime: RuntimeKind;
  instructionId: string;
  instruction: string;
  pairs: ReadPairs;
  textsPath: string;
  textsSha256: string;
  lookup: TextLookup;
  artifact: ArtifactInfo;
  build: RuntimeBuild;
  options: ScoreOptions;
  directed: readonly DirectedPair[];
  scored: ScoredPairs;
  startedAt: string;
  finishedAt: string;
  hostLoadAverage: { before: number[]; after: number[] };
}

export interface PairScoresFile {
  format: typeof pairScoresFormat;
  version: 1;
  decider: string;
  scale: "log-odds";
  scores: Array<{ query: string; doc: string; logOdds: number }>;
  /** Everything needed to say which input and which runtime produced the scores (ignored by readers). */
  run: {
    task: "T46a";
    profile: string;
    runtime: RuntimeKind;
    instructionId: string;
    instruction: string;
    instructionSha256: string;
    textTemplate: typeof textTemplateId;
    inputs: {
      pairsSha256: string;
      textsFile: string;
      textsSha256: string;
      noteTextDigest: string;
      notes: number;
      unorderedPairs: number;
      directedPairs: number;
    };
    model: ArtifactInfo;
    build: RuntimeBuild;
    parameters: { helperBatchSize: number | null; requestSize: number };
    timing: {
      startedAt: string;
      finishedAt: string;
      wallMs: number;
      requests: number;
      msPerDirectedPair: number;
      hostLoadAverage: { before: number[]; after: number[] };
    };
    tokens: { mean: number; max: number } | null;
    scoresSha256: string;
  };
}

export function deciderLabel(
  runtime: RuntimeKind,
  artifact: ArtifactInfo,
  instructionId: string,
  helperBatchSize: number | null
): string {
  return [
    `${runtime}:${artifact.name}@${artifact.revision.slice(0, 7)}`,
    `instruction=${instructionId}`,
    `template=${textTemplateId}`,
    ...(helperBatchSize === null ? [] : [`helper-batch=${helperBatchSize}`])
  ].join(" ");
}

export function buildScoreFile(input: ScoreRunInput): PairScoresFile {
  const { directed, scored, options } = input;
  if (scored.logOdds.length !== directed.length)
    throw new Error("The number of scores differs from the number of directed pairs.");
  const scores = directed.map(({ query, doc }, index) => ({
    query,
    doc,
    logOdds: scored.logOdds[index]!
  }));
  const noteIds = noteIdsOf(input.pairs.file.pairs);
  const helperBatchSize = input.runtime === "mlx" ? options.batchSize : null;
  return {
    format: pairScoresFormat,
    version: 1,
    decider: deciderLabel(input.runtime, input.artifact, input.instructionId, helperBatchSize),
    scale: "log-odds",
    scores,
    run: {
      task: "T46a",
      profile: input.profile,
      runtime: input.runtime,
      instructionId: input.instructionId,
      instruction: input.instruction,
      instructionSha256: sha256Hex(input.instruction),
      textTemplate: textTemplateId,
      inputs: {
        pairsSha256: input.pairs.sha256,
        textsFile: input.textsPath,
        textsSha256: input.textsSha256,
        noteTextDigest: noteTextDigest(input.lookup, noteIds),
        notes: noteIds.length,
        unorderedPairs: input.pairs.file.pairs.length,
        directedPairs: directed.length
      },
      model: input.artifact,
      build: input.build,
      parameters: { helperBatchSize, requestSize: options.requestSize },
      timing: {
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        wallMs: scored.wallMs,
        requests: scored.requests,
        msPerDirectedPair: scored.wallMs / Math.max(1, directed.length),
        hostLoadAverage: input.hostLoadAverage
      },
      tokens:
        scored.tokenCounts.length > 0
          ? { mean: mean(scored.tokenCounts), max: Math.max(...scored.tokenCounts) }
          : null,
      scoresSha256: sha256Hex(JSON.stringify(scores))
    }
  };
}

/** Counts a reader needs to sanity-check a score file against its pair list. */
export function checkScoreFile(file: PairScoresFile, pairs: PairsFile): void {
  const expected = new Set(pairs.pairs.flatMap(([a, b]) => [`${a}|${b}`, `${b}|${a}`]));
  if (file.scores.length !== expected.size)
    throw new Error(`Expected ${expected.size} directed scores, found ${file.scores.length}.`);
  for (const { query, doc, logOdds } of file.scores) {
    if (!expected.delete(`${query}|${doc}`))
      throw new Error(`Score for ${query} -> ${doc} is unexpected or repeated.`);
    if (!Number.isFinite(logOdds)) throw new Error(`Score for ${query} -> ${doc} is not finite.`);
  }
}
