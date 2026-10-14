/**
 * Qwen3-Reranker prompt pieces exactly as the Qwen/Qwen3-Reranker-0.6B model card prescribes.
 * The MLX helper (`native/mlx-helper`, Scoring.swift) embeds the same strings.
 */
export const qwen3RerankerPrefix =
  "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the " +
  'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n';

export const qwen3RerankerSuffix = "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n";

export const qwen3RerankerDefaultInstruction =
  "Given a web search query, retrieve relevant passages that answer the query";

export function qwen3RerankerContent(instruction: string, query: string, document: string): string {
  return `<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${document}`;
}
