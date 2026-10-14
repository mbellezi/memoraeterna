/**
 * The three local reranker runtimes compared by Spike A, behind one small interface:
 *
 *   mlx         Qwen3-Reranker-0.6B (bf16 safetensors) on the native MLX helper (`score`)
 *   gguf-qwen3  Qwen3-Reranker-0.6B Q8_0 GGUF, node-llama-cpp `createRankingContext` with the
 *               model-card template (instruction baked in), context 2048
 *   gguf-bge    bge-reranker-v2-m3 Q8_0 GGUF, `createRankingContext` default path (no template)
 *
 * Every score is returned as log-odds (higher = more related). MLX reports them natively; GGUF
 * reports a probability that is converted with a clamped logit. Local inference is serialized:
 * open one runtime at a time and dispose it before opening the next.
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { LlamaRankingContext } from "node-llama-cpp";

import { modelDirectory, readModelManifest, type PinnedModel } from "../download-models.js";
import {
  createDefaultRankingContext,
  createQwen3RankingContext,
  loadGgufModel,
  type GgufRuntime
} from "../lib/gguf.js";
import { MlxHelperClient } from "../lib/mlx-helper-client.js";
import type { RuntimeName } from "./dataset.js";
import { logit } from "./metrics.js";

const artifactNames: Record<RuntimeName, string> = {
  mlx: "qwen3-reranker-0.6b-mlx",
  "gguf-qwen3": "qwen3-reranker-0.6b-q8_0-gguf",
  "gguf-bge": "bge-reranker-v2-m3-q8_0-gguf"
};

export interface PairText {
  query: string;
  document: string;
}

export interface BatchTiming {
  size: number;
  sequenceLength: number;
  ms: number;
}

export interface ScoreCall {
  logOdds: number[];
  /** Wall-clock time of the whole call as the caller sees it (includes IPC for MLX). */
  wallMs: number;
  /** MLX only: forward-pass time, token counts and per-batch timings reported by the helper. */
  inferenceMs?: number;
  tokenCounts?: number[];
  batches?: BatchTiming[];
}

export interface ArtifactInfo {
  name: string;
  repository: string;
  revision: string;
  license: string;
  mainFile: string;
  bytes: number;
  sha256: string;
}

export interface RerankRuntime {
  readonly name: RuntimeName;
  readonly artifact: ArtifactInfo;
  /** One query against several documents in one call (what a per-note decision would send). */
  scoreDocuments(query: string, documents: string[], batchSize: number): Promise<ScoreCall>;
  /** Independent pairs. MLX batches them; GGUF ranks them one at a time. */
  scorePairs(
    pairs: PairText[],
    batchSize: number,
    onProgress?: (done: number) => void
  ): Promise<ScoreCall>;
  dispose(): Promise<void>;
}

interface ResolvedArtifact {
  info: ArtifactInfo;
  path: string;
}

async function resolveArtifact(name: RuntimeName): Promise<ResolvedArtifact> {
  const manifest = await readModelManifest();
  const model: PinnedModel | undefined = manifest.find((m) => m.name === artifactNames[name]);
  if (!model) throw new Error(`models.json has no ${artifactNames[name]}`);
  const directory = modelDirectory(model);
  const main =
    model.runtime === "gguf"
      ? model.files.find((file) => file.path.endsWith(".gguf"))
      : model.files.find((file) => file.path === "model.safetensors");
  if (!main) throw new Error(`${model.name} has no main weights file`);
  return {
    path: model.runtime === "gguf" ? join(directory, main.path) : directory,
    info: {
      name: model.name,
      repository: model.repository,
      revision: model.revision,
      license: model.license,
      mainFile: main.path,
      bytes: main.size,
      sha256: main.sha256
    }
  };
}

export async function openRuntime(
  name: RuntimeName,
  instruction: string | undefined
): Promise<RerankRuntime> {
  const artifact = await resolveArtifact(name);
  return name === "mlx" ? openMlx(artifact, instruction) : openGguf(name, artifact, instruction);
}

async function openMlx(
  artifact: ResolvedArtifact,
  instruction: string | undefined
): Promise<RerankRuntime> {
  const client = await MlxHelperClient.start({ timeoutMs: 30 * 60_000 });
  const common = { modelPath: artifact.path, ...(instruction ? { instruction } : {}) };
  // The first request loads the model; callers that time latency warm up before measuring.
  return {
    name: "mlx",
    artifact: artifact.info,
    async scoreDocuments(query, documents, batchSize) {
      const started = performance.now();
      const result = await client.score({ ...common, query, documents, batchSize });
      return mlxCall(result, performance.now() - started);
    },
    async scorePairs(pairs, batchSize, onProgress) {
      const started = performance.now();
      // One request keeps the length-sorted batching global; chunking would change batch makeup.
      const result = await client.score({ ...common, pairs, batchSize });
      onProgress?.(pairs.length);
      return mlxCall(result, performance.now() - started);
    },
    dispose: () => client.shutdown()
  };
}

function mlxCall(result: Awaited<ReturnType<MlxHelperClient["score"]>>, wallMs: number): ScoreCall {
  return {
    logOdds: result.logOdds,
    wallMs,
    inferenceMs: result.timing.inferenceMs,
    tokenCounts: result.tokenCounts,
    batches: result.timing.batches
  };
}

async function openGguf(
  name: Exclude<RuntimeName, "mlx">,
  artifact: ResolvedArtifact,
  instruction: string | undefined
): Promise<RerankRuntime> {
  const runtime: GgufRuntime = await loadGgufModel(artifact.path);
  let context: LlamaRankingContext;
  try {
    context =
      name === "gguf-qwen3"
        ? await createQwen3RankingContext(runtime.model, instruction)
        : await createDefaultRankingContext(runtime.model);
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
  return {
    name,
    artifact: artifact.info,
    async scoreDocuments(query, documents) {
      const started = performance.now();
      const probabilities =
        documents.length === 1
          ? [await context.rank(query, documents[0]!)]
          : await context.rankAll(query, documents);
      return { logOdds: probabilities.map((p) => logit(p)), wallMs: performance.now() - started };
    },
    async scorePairs(pairs, _batchSize, onProgress) {
      const started = performance.now();
      const logOdds: number[] = [];
      for (const pair of pairs) {
        logOdds.push(logit(await context.rank(pair.query, pair.document)));
        if (logOdds.length % 500 === 0) onProgress?.(logOdds.length);
      }
      return { logOdds, wallMs: performance.now() - started };
    },
    async dispose() {
      await context.dispose();
      await runtime.dispose();
    }
  };
}
