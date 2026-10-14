/**
 * node-llama-cpp 3.19 helpers for the GGUF fallbacks used by the F0 spikes.
 *
 * - Qwen3-Reranker GGUF: `createRankingContext` with an explicit model-card template (the
 *   instruction is baked into the template) and a fixed 2048-token context.
 * - bge-reranker-v2-m3 GGUF: `createRankingContext` default path (no custom template; the
 *   `[bos] query [eos][sep] document [eos]` pairing) with the same context size.
 * - GGUF embeddings: `createEmbeddingContext`, mirroring the desktop adapter (context "auto",
 *   L2-normalized output).
 *
 * Callers own disposal: dispose contexts, then the model, then the Llama instance.
 */
import {
  getLlama,
  type Llama,
  type LlamaEmbeddingContext,
  type LlamaModel,
  type LlamaRankingContext
} from "node-llama-cpp";

import {
  qwen3RerankerContent,
  qwen3RerankerDefaultInstruction,
  qwen3RerankerPrefix,
  qwen3RerankerSuffix
} from "./qwen3-reranker.js";

export const rankingContextSize = 2_048;

export interface GgufRuntime {
  llama: Llama;
  model: LlamaModel;
  dispose(): Promise<void>;
}

export async function loadGgufModel(modelPath: string): Promise<GgufRuntime> {
  const llama = await getLlama();
  let model: LlamaModel;
  try {
    model = await llama.loadModel({ modelPath });
  } catch (error) {
    await llama.dispose();
    throw error;
  }
  return {
    llama,
    model,
    async dispose() {
      await model.dispose();
      await llama.dispose();
    }
  };
}

export type RankingTemplate =
  | `${string}{{query}}${string}{{document}}${string}`
  | `${string}{{document}}${string}{{query}}${string}`;

/** The Qwen3-Reranker model-card prompt with the instruction inlined. */
export function qwen3RankingTemplate(
  instruction = qwen3RerankerDefaultInstruction
): `${string}{{query}}${string}{{document}}${string}` {
  if (/\{\{(query|document)\}\}/.test(instruction)) {
    throw new Error("The instruction must not contain ranking template placeholders.");
  }
  const content = qwen3RerankerContent(instruction, "{{query}}", "{{document}}");
  const template = `${qwen3RerankerPrefix}${content}${qwen3RerankerSuffix}`;
  if (!isQueryFirstTemplate(template)) throw new Error("Invalid Qwen3 ranking template.");
  return template;
}

function isQueryFirstTemplate(
  template: string
): template is `${string}{{query}}${string}{{document}}${string}` {
  const query = template.indexOf("{{query}}");
  return query >= 0 && template.indexOf("{{document}}") > query;
}

export function createQwen3RankingContext(
  model: LlamaModel,
  instruction?: string
): Promise<LlamaRankingContext> {
  return model.createRankingContext({
    contextSize: rankingContextSize,
    template: qwen3RankingTemplate(instruction)
  });
}

export function createDefaultRankingContext(model: LlamaModel): Promise<LlamaRankingContext> {
  return model.createRankingContext({ contextSize: rankingContextSize });
}

export function createGgufEmbeddingContext(
  model: LlamaModel,
  contextSize: "auto" | number = "auto"
): Promise<LlamaEmbeddingContext> {
  return model.createEmbeddingContext({ contextSize });
}

export async function embedNormalized(
  context: LlamaEmbeddingContext,
  text: string
): Promise<number[]> {
  const { vector } = await context.getEmbeddingFor(text);
  return l2Normalize(vector);
}

export function l2Normalize(vector: readonly number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((total, value) => total + value * value, 0));
  return magnitude === 0 ? [...vector] : vector.map((value) => value / magnitude);
}

/** Header facts that gate exposing `decide`/`embed` for a GGUF artifact (rules/ai.md). */
export interface GgufArtifactReport {
  architecture: string | undefined;
  poolingType: unknown;
  supportsRanking: boolean;
  hasRerankTemplate: boolean;
  classifierOutputLabels: unknown;
  vocabularyType: string;
  bos: number | null;
  eos: number | null;
  sep: number | null;
  prependsBos: boolean;
  appendsEos: boolean;
  trainContextSize: number;
}

export function inspectGguf(model: LlamaModel): GgufArtifactReport {
  const metadata = model.fileInfo.metadata as Record<string, unknown>;
  const general = metadata.general as Record<string, unknown> | undefined;
  const architecture = typeof general?.architecture === "string" ? general.architecture : undefined;
  const architectureMetadata = architecture
    ? (metadata[architecture] as Record<string, unknown> | undefined)
    : undefined;
  const tokenizer = metadata.tokenizer as Record<string, unknown> | undefined;
  return {
    architecture,
    poolingType: architectureMetadata?.pooling_type,
    supportsRanking: model.fileInsights.supportsRanking,
    hasRerankTemplate: typeof tokenizer?.["chat_template.rerank"] === "string",
    classifierOutputLabels: architectureMetadata?.classifier,
    vocabularyType: String(model.vocabularyType),
    bos: tokenOrNull(model.tokens.bos),
    eos: tokenOrNull(model.tokens.eos),
    sep: tokenOrNull(model.tokens.sep),
    prependsBos: model.tokens.shouldPrependBosToken,
    appendsEos: model.tokens.shouldAppendEosToken,
    trainContextSize: model.trainContextSize
  };
}

function tokenOrNull(token: unknown): number | null {
  return typeof token === "number" ? token : null;
}
