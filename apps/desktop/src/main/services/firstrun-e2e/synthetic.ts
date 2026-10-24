// The synthetic library and the synthetic models of the first-run end-to-end test's own proof
// (`--synthetic`, and its sidecar test): the real services, the real cassette and the real setup run
// on two small articles whose notes carry their theme in their words, with a stand-in for each model
// (embeddings, topic names, the ranker, the writer's class tests). It proves the harness (the clock,
// the setup sequence, the install and its events, the Hybrid routes, T1 and D, the replay), not the
// product's quality: the product's own import, matching and Docling are the live record's.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseRankInput } from "@app/ai";
import type { AiModelAdapter, AiTaskRequest, AiTaskResult, RankResult } from "@app/ai";
import { createAtomicNoteRelationRepository } from "@app/db";
import type { PgPool } from "@app/db";

import type { CorpusArticle } from "../topic-tree/corpus-library.js";
import type { SeededArticle } from "../topic-tree/corpus-library.js";
import {
  syntheticArticle,
  syntheticEmbedding,
  syntheticProvider
} from "../topics-e2e/synthetic.js";

export { syntheticArticle, syntheticCorpus, syntheticLanguage } from "../topics-e2e/synthetic.js";

/** The second source of the self-test: the same three themes, fewer notes, another article. */
export function syntheticSecondArticle(language: "pt" | "en"): CorpusArticle {
  const base = syntheticArticle(language, 5);
  return {
    ...base,
    key: `${language}:Synthetic second paper`,
    title:
      language === "pt"
        ? "Um segundo artigo sintético sobre memória"
        : "A second synthetic paper on memory",
    pageId: 2,
    revisionId: 2,
    notes: base.notes.map((note) => ({ ...note, id: `second-${note.id}` }))
  };
}

/**
 * A file at the path the AI service reads the MLX helper from, so the ranker's runtime build (the
 * helper's SHA-256) exists without a Swift build. Nothing ever runs it: the stand-in answers.
 */
export async function writeSyntheticHelper(workspaceRoot: string): Promise<string> {
  const path = join(
    workspaceRoot,
    "native",
    "mlx-helper",
    ".build",
    "release",
    "memora-mlx-helper"
  );
  await mkdir(join(workspaceRoot, "native", "mlx-helper", ".build", "release"), {
    recursive: true
  });
  await writeFile(path, "synthetic mlx helper of the first-run self-test\n");
  return path;
}

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  for (const [index, value] of left.entries()) dot += value * (right[index] ?? 0);
  return dot;
}

/** The ranker's scores from the words the texts share (the stand-in embedding's cosine). */
function rankOutput(input: string): RankResult | null {
  let parsed;
  try {
    parsed = parseRankInput(input);
  } catch {
    return null;
  }
  const pairs =
    parsed.kind === "documents"
      ? parsed.request.documents.map((document) => ({ query: parsed.request.query, document }))
      : parsed.request.pairs;
  const logOdds = pairs.map(
    (pair) => 12 * cosine(syntheticEmbedding(pair.query), syntheticEmbedding(pair.document)) - 3
  );
  return {
    logOdds,
    scores: logOdds.map(sigmoid),
    tokenCounts: logOdds.map(() => 100),
    truncated: logOdds.map(() => false)
  };
}

/**
 * The topics e2e stand-in plus what the first run asks of the other models: a ranker scores pairs by
 * the words they share, the writer answers the class tests (`OK`, a one-candidate judgement), and
 * the embedding and topic names come from the base stand-in. The cassette wraps it, so a recording
 * keeps the answers and a replay reads them back.
 */
export function hybridSyntheticProvider(
  adapter: AiModelAdapter,
  options: { language: "pt" | "en"; contentLanguage: string }
): AiModelAdapter {
  const base = syntheticProvider(adapter, options);
  const answer = async (request: AiTaskRequest): Promise<AiTaskResult> => {
    const input = typeof request.input === "string" ? request.input : JSON.stringify(request.input);
    let output: unknown;
    if (request.taskType === "reranking") {
      output = rankOutput(input) ?? JSON.stringify({ results: [[1, 85, "related"]] });
    } else if (/Reply with exactly: OK/u.test(input)) {
      output = "OK";
    } else {
      return base.run(request);
    }
    const descriptor = adapter.describe();
    return {
      taskType: request.taskType,
      output,
      providerId: descriptor.providerId,
      modelId: request.modelId ?? descriptor.modelId,
      runtime: descriptor.runtime,
      durationMs: 1,
      inputTokens: Math.ceil(input.length / 4),
      outputTokens: 8
    };
  };
  return {
    ...base,
    run: (request) => answer(request),
    runStreaming: (request, _signal, onProgress) => {
      onProgress({ progress: 1 });
      return answer(request);
    }
  };
}

/**
 * The relation the product's matching would draw between the two articles: one pair of notes, stored
 * the way the interim matcher stored it (no band, so it reads as applied). The self-test seeds its
 * library, so nothing runs the matching; the relation is what T1 needs to be reached.
 */
export async function seedSyntheticRelation(
  pool: PgPool,
  first: SeededArticle,
  second: SeededArticle
): Promise<{ firstNoteId: string; secondNoteId: string }> {
  const a = first.noteIds[0]!;
  const b = second.noteIds[0]!;
  const [lo, hi] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
  await createAtomicNoteRelationRepository(pool).upsert({
    loAtomicNoteId: lo,
    hiAtomicNoteId: hi,
    direction: "symmetric",
    // A legacy type: the stored v2 check wants a type or a band, and no band reads as applied.
    relationType: "related",
    band: null,
    finalScore: 0.9,
    explanation: "A relation of the first-run self-test between its two synthetic papers."
  });
  return { firstNoteId: a, secondNoteId: b };
}
