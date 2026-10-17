/**
 * The product's dedicated rankers, driven from a script (F3 T46 part b, R1): the MLX and GGUF
 * Qwen3-Reranker adapters of `packages/ai/src/local-ranker-adapters.ts`, called the way
 * `AiService.rankPairs` calls them. A list of directed pairs is split into calls of at most
 * `rankPairsLimits.perCall` (32 on MLX, 16 on GGUF) and each call carries the product's helper batch
 * size (16 on MLX), so a calibration fitted on these scores is fitted on what the product produces
 * (scores depend on the batch makeup by up to a few tenths of a log-odds unit; the sorting inside a
 * call is the helper's own). The service adds the lane, the audit rows and the route lookup around
 * the same adapter call; none of them touches a score.
 *
 * Local inference: the caller holds `.cache/f2/LOCAL_MODEL_BUSY` while a ranker is open, and opens one
 * ranker at a time.
 */
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { AiCapability } from "@app/domain";

import type { AiModelAdapter } from "../../packages/ai/src/contracts.js";
import {
  MlxRerankerAdapter,
  NodeLlamaRankerAdapter,
  rankPairsWithAdapter
} from "../../packages/ai/src/local-ranker-adapters.js";
import { MlxHelperHost } from "../../packages/ai/src/mlx-helper-host.js";
import { rankPairsLimits } from "../../packages/ai/src/ranker-input.js";
import {
  validateGgufRankerArtifact,
  validateMlxRankerArtifact
} from "../../packages/ai/src/ranker-validation.js";
import { modelDirectory, readModelManifest } from "../spikes/download-models.ts";
import { defaultHelperPath } from "../spikes/lib/mlx-helper-client.ts";
import type { ArtifactInfo, PairText } from "../spikes/reranker/runtimes.ts";

export type ProductRuntime = "mlx" | "gguf";

const artifactNames: Record<ProductRuntime, string> = {
  mlx: "qwen3-reranker-0.6b-mlx",
  gguf: "qwen3-reranker-0.6b-q8_0-gguf"
};

const capabilities: AiCapability[] = ["reranking", "offline", "local-files"];

export interface ProductScores {
  logOdds: number[];
  tokenCounts: number[];
  /** Pairs whose sequence the runtime cut to fit its bound. */
  truncated: number;
  calls: number;
  /** Sum of the calls' wall times as the caller sees them. */
  wallMs: number;
  callMs: number[];
}

export interface ProductRanker {
  readonly runtime: ProductRuntime;
  /** Pairs per call and helper batch, as `AiService.rankPairs` sets them. */
  readonly perCall: number;
  readonly helperBatchSize: number | null;
  readonly artifact: ArtifactInfo;
  /** The runtime build a calibration is bound to (the helper's SHA-256, or the llama.cpp build). */
  runtimeBuild(): Promise<string>;
  rank(
    instruction: string,
    pairs: readonly PairText[],
    onProgress?: (done: number) => void
  ): Promise<ProductScores>;
  dispose(): Promise<void>;
}

/** Calls an adapter the way `AiService.rankPairs` does; exported so tests can drive a fake adapter. */
export async function rankThroughAdapter(
  adapter: Pick<AiModelAdapter, "run">,
  plan: { perCall: number; helperBatchSize: number | null },
  instruction: string,
  pairs: readonly PairText[],
  onProgress?: (done: number) => void
): Promise<ProductScores> {
  const result: ProductScores = {
    logOdds: [],
    tokenCounts: [],
    truncated: 0,
    calls: 0,
    wallMs: 0,
    callMs: []
  };
  for (let start = 0; start < pairs.length; start += plan.perCall) {
    const chunk = pairs.slice(start, start + plan.perCall);
    const began = performance.now();
    const ranked = await rankPairsWithAdapter(
      adapter as AiModelAdapter,
      { instruction, pairs: chunk },
      plan.helperBatchSize === null ? {} : { batchSize: plan.helperBatchSize }
    );
    const ms = performance.now() - began;
    if (ranked.logOdds.length !== chunk.length || !ranked.logOdds.every(Number.isFinite))
      throw new Error(`The ranker returned missing or non-finite scores for pairs ${start}+.`);
    result.logOdds.push(...ranked.logOdds);
    result.tokenCounts.push(...ranked.tokenCounts);
    result.truncated += ranked.truncated.filter(Boolean).length;
    result.calls += 1;
    result.wallMs += ms;
    result.callMs.push(ms);
    onProgress?.(result.logOdds.length);
  }
  return result;
}

/** Opens the product's MLX or GGUF ranker over the pinned, checksum-verified artifact. */
export async function openProductRanker(runtime: ProductRuntime): Promise<ProductRanker> {
  const pins = (await readModelManifest()).find((model) => model.name === artifactNames[runtime]);
  if (!pins) throw new Error(`models.json has no ${artifactNames[runtime]}.`);
  const directory = modelDirectory(pins);
  const main =
    runtime === "gguf"
      ? pins.files.find((file) => file.path.endsWith(".gguf"))
      : pins.files.find((file) => file.path === "model.safetensors");
  if (!main) throw new Error(`${pins.name} has no main weights file.`);
  const artifact: ArtifactInfo = {
    name: pins.name,
    repository: pins.repository,
    revision: pins.revision,
    license: pins.license,
    mainFile: main.path,
    bytes: main.size,
    sha256: main.sha256
  };
  if (runtime === "mlx") {
    await validateMlxRankerArtifact({
      directory,
      files: pins.files.map((file) => ({
        path: file.path,
        sizeBytes: file.size,
        sha256: file.sha256
      }))
    });
    const host = new MlxHelperHost({ helperPath: defaultHelperPath });
    const adapter = new MlxRerankerAdapter({
      modelId: pins.repository,
      modelPath: directory,
      helperPath: defaultHelperPath,
      host,
      capabilities,
      revision: pins.revision
    });
    const plan = {
      perCall: rankPairsLimits.perCall.mlx,
      helperBatchSize: rankPairsLimits.helperBatchSize
    };
    return {
      runtime,
      ...plan,
      artifact,
      runtimeBuild: () => adapter.runtimeBuild(),
      rank: (instruction, pairs, onProgress) =>
        rankThroughAdapter(adapter, plan, instruction, pairs, onProgress),
      dispose: () => host.dispose()
    };
  }
  const path = join(directory, main.path);
  await validateGgufRankerArtifact({ path, sizeBytes: main.size, sha256: main.sha256 });
  const adapter = new NodeLlamaRankerAdapter({
    modelId: main.path,
    modelPath: path,
    capabilities,
    revision: pins.revision
  });
  const plan = { perCall: rankPairsLimits.perCall.gguf, helperBatchSize: null };
  return {
    runtime,
    ...plan,
    artifact,
    runtimeBuild: () => adapter.runtimeBuild(),
    rank: (instruction, pairs, onProgress) =>
      rankThroughAdapter(adapter, plan, instruction, pairs, onProgress),
    dispose: () => adapter.dispose()
  };
}
