import { z } from "zod";

import type { AiTaskRequest, AiTaskResult } from "./contracts.js";

/**
 * The wire contract of a dedicated ranker call. A `reranking` task addressed to a ranker carries a
 * `RankRequest` as JSON in the existing `input` string, and its result `output` is a `RankResult`.
 * A generative decider on the same route keeps receiving a prompt; the two never mix (D17).
 */

/** Bounds of one rank request (typed configuration; the rank input is never cut silently). */
export const rankRequestLimits = {
  /** One query against at most this many documents in one call (D10: ≤5 gate candidates). */
  maxDocuments: 32,
  /** Characters of the ranker instruction (an application prompt, far shorter in practice). */
  maxInstructionCharacters: 1_000,
  /** Characters of the query and of each document. Longer token sequences are truncated by the
   * runtime and reported per document in `truncated`. */
  maxTextCharacters: 16_000
} as const;

/**
 * Bounds of a pairs request (F3 D16, R23): independent directed pairs under one instruction, as the
 * relation decider sends both directions of every candidate. One call stays short enough that a
 * P0 call waits for at most one of them on the local lane (about 1 s), so `AiService.rankPairs`
 * splits a longer list at the runtime's `perCall`. Gate 0 may revise `perCall` (B1); the request
 * bound only keeps a caller from sending an unbounded list.
 */
export const rankPairsLimits = {
  /** Pairs of one request on any runtime; a runtime's own `perCall` is lower. */
  maxPairs: 64,
  /** Pairs per local call, by runtime: MLX 32 (about 1.0 s), GGUF 16 (about 0.9 s). */
  perCall: { mlx: 32, gguf: 16 },
  /** Sequences per MLX forward pass for a pairs request (Spike A: 16 is fastest). */
  helperBatchSize: 16,
  /** The largest helper batch a caller may ask for. */
  maxHelperBatchSize: 64
} as const;

/**
 * The Qwen3-Reranker prompt exactly as its model card prescribes. These strings are protocol
 * constants of the ranking runtimes, not catalog prompts: the MLX helper embeds the same text
 * (`native/mlx-helper`, `Scoring.swift`) and the GGUF adapter builds its ranking template from it.
 * Only the instruction is application wording; it comes from the prompt catalog.
 */
export const qwen3RerankerPrompt = {
  prefix:
    "<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the " +
    'Instruct provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n',
  suffix: "<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n",
  /** The model card's own instruction; its reference scores are measured with it. */
  defaultInstruction: "Given a web search query, retrieve relevant passages that answer the query",
  content(instruction: string, query: string, document: string): string {
    return `<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${document}`;
  }
} as const;

/** The GGUF template's placeholders; an instruction holding one would corrupt the template. */
const templatePlaceholder = /\{\{(?:query|document)\}\}/u;
/** At least one non-space character, without trimming the text the model sees. */
const nonBlank = /\S/u;

const rankTextSchema = z
  .string()
  .max(rankRequestLimits.maxTextCharacters)
  .regex(nonBlank, { message: "The text is blank." });

export const rankRequestSchema = z
  .object({
    instruction: z
      .string()
      .max(rankRequestLimits.maxInstructionCharacters)
      .regex(nonBlank, { message: "The instruction is blank." })
      .refine((value) => !templatePlaceholder.test(value), {
        message: "The instruction must not contain ranking template placeholders."
      }),
    query: rankTextSchema,
    documents: z.array(rankTextSchema).min(1).max(rankRequestLimits.maxDocuments)
  })
  .strict();
export type RankRequest = z.infer<typeof rankRequestSchema>;

/**
 * A pairs request: independent directed pairs (query, document) under one instruction. Scores come
 * back in pair order. The helper batch size is not part of the input: it travels in the task
 * request's `parameters`, so the cassette and the decider cache distinguish batch 1 from batch 16.
 */
export const rankPairsRequestSchema = z
  .object({
    instruction: rankRequestSchema.shape.instruction,
    pairs: z
      .array(z.object({ query: rankTextSchema, document: rankTextSchema }).strict())
      .min(1)
      .max(rankPairsLimits.maxPairs)
  })
  .strict();
export type RankPairsRequest = z.infer<typeof rankPairsRequestSchema>;

/** The parameters of a pairs task request: the MLX helper's batch size, the only one a ranker takes. */
export const rankPairsParametersSchema = z
  .object({
    batchSize: z.number().int().min(1).max(rankPairsLimits.maxHelperBatchSize).optional()
  })
  .strict();
export type RankPairsParameters = z.infer<typeof rankPairsParametersSchema>;

export const rankResultSchema = z
  .object({
    /** `logit_yes − logit_no` per document, in request order (higher means more relevant). */
    logOdds: z.array(z.number().finite()).min(1),
    /** `sigmoid(logOdds)`, the relevance probability. */
    scores: z.array(z.number().min(0).max(1)).min(1),
    /** Tokens of each evaluated sequence, template included. */
    tokenCounts: z.array(z.number().int().positive()).min(1),
    /** Whether a document's sequence was truncated to fit the runtime's sequence bound. */
    truncated: z.array(z.boolean()).min(1)
  })
  .strict()
  .refine(
    (result) =>
      result.scores.length === result.logOdds.length &&
      result.tokenCounts.length === result.logOdds.length &&
      result.truncated.length === result.logOdds.length,
    { message: "rank result lengths disagree" }
  );
export type RankResult = z.infer<typeof rankResultSchema>;

/**
 * A ranker failure with a localization key as its message, so the UI and job failure
 * classification treat it like every other local-model error. It has no `cause`: a deterministic
 * failure must not inherit a transient key from the runtime error it replaces. `detail` is an
 * English diagnostic for logs and must not be shown to the user.
 */
export class LocalRankerError extends Error {
  public constructor(
    message:
      | "errors.ai.unsupportedTask"
      | "errors.localModels.rankerInvalid"
      | "errors.localModels.rankerSmokeFailed"
      | "errors.localModels.invalidRuntimeResponse"
      | "errors.localModels.checksumMismatch"
      | "errors.localModels.sizeMismatch"
      | "errors.localModels.notFound"
      | "errors.localModels.unsafePath",
    public readonly detail: string
  ) {
    super(message);
    this.name = "LocalRankerError";
  }
}

/**
 * Reads a rank request from a task input: the JSON string the routed call carries, or an object.
 * Anything else, a generative prompt included, is a task this model cannot run.
 */
export function parseRankRequest(input: unknown): RankRequest {
  const parsed = rankRequestSchema.safeParse(readJsonInput(input));
  if (!parsed.success) {
    throw new LocalRankerError("errors.ai.unsupportedTask", parsed.error.issues[0]!.message);
  }
  return parsed.data;
}

/** The canonical JSON form of a validated rank request (the task input string). */
export function serializeRankRequest(request: RankRequest): string {
  return JSON.stringify(rankRequestSchema.parse(request));
}

/** A `reranking` task request for a dedicated ranker. */
export function rankTaskRequest(request: RankRequest): AiTaskRequest {
  return {
    taskType: "reranking",
    input: serializeRankRequest(request),
    requiredCapabilities: ["reranking"],
    parameters: {},
    metadata: {}
  };
}

/**
 * Reads a pairs request from a task input (the JSON string the routed call carries, or an object).
 * A `{query, documents}` input is not a pairs request: the two shapes never mix.
 */
export function parseRankPairsRequest(input: unknown): RankPairsRequest {
  const value = readJsonInput(input);
  const parsed = rankPairsRequestSchema.safeParse(value);
  if (!parsed.success) {
    throw new LocalRankerError("errors.ai.unsupportedTask", parsed.error.issues[0]!.message);
  }
  return parsed.data;
}

/** The wire shape of a rank task input. */
export type RankInput =
  { kind: "documents"; request: RankRequest } | { kind: "pairs"; request: RankPairsRequest };

/** Reads either wire shape of a rank task input; the presence of `pairs` selects the pairs shape. */
export function parseRankInput(input: unknown): RankInput {
  const value = readJsonInput(input);
  return value !== null && typeof value === "object" && "pairs" in value
    ? { kind: "pairs", request: parseRankPairsRequest(value) }
    : { kind: "documents", request: parseRankRequest(value) };
}

/** How many scores a rank input asks for: one per document, or one per pair. */
export function rankInputCount(input: RankInput): number {
  return input.kind === "documents" ? input.request.documents.length : input.request.pairs.length;
}

/** The canonical JSON form of a validated pairs request (the task input string). */
export function serializeRankPairsRequest(request: RankPairsRequest): string {
  return JSON.stringify(rankPairsRequestSchema.parse(request));
}

/**
 * A `reranking` task request for a dedicated ranker over independent pairs. `batchSize` is the MLX
 * helper's sequences per forward pass; it belongs to the effective parameters because bf16 batch
 * makeup moves scores by up to a few tenths of a log-odds unit, so a batch-1 request has another
 * cassette and decider cache key than a batch-16 one (D13, R17). A GGUF ranker scores pairs one by
 * one and takes none.
 */
export function rankPairsTaskRequest(
  request: RankPairsRequest,
  options: { batchSize?: number } = {}
): AiTaskRequest {
  const parameters = readRankPairsParameters(
    options.batchSize === undefined ? {} : { batchSize: options.batchSize }
  );
  return {
    taskType: "reranking",
    input: serializeRankPairsRequest(request),
    requiredCapabilities: ["reranking"],
    parameters,
    metadata: {}
  };
}

/** The helper batch size a pairs task request carries; none when it carries no parameter. */
export function readRankPairsParameters(parameters: Record<string, unknown>): RankPairsParameters {
  const parsed = rankPairsParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    throw new LocalRankerError("errors.ai.unsupportedTask", parsed.error.issues[0]!.message);
  }
  return parsed.data;
}

function readJsonInput(input: unknown): unknown {
  if (typeof input !== "string") return input;
  try {
    return JSON.parse(input);
  } catch {
    throw new LocalRankerError("errors.ai.unsupportedTask", "The input is not a rank request.");
  }
}

/** The rank result of a ranker's task result; a malformed one is an invalid runtime response. */
export function readRankResult(
  result: Pick<AiTaskResult, "output">,
  documents: number
): RankResult {
  const parsed = rankResultSchema.safeParse(result.output);
  if (!parsed.success || parsed.data.logOdds.length !== documents) {
    throw new LocalRankerError(
      "errors.localModels.invalidRuntimeResponse",
      parsed.success ? "The result does not score every document." : parsed.error.issues[0]!.message
    );
  }
  return parsed.data;
}

/** Bound of a probability before its log-odds are taken, as in Spike A (`logit(p)`, ε = 1e-7). */
export const rankProbabilityEpsilon = 1e-7;

/** Log-odds of a relevance probability, clamped so 0 and 1 stay finite (about ±16.1). */
export function probabilityLogOdds(probability: number): number {
  const p = Math.min(1 - rankProbabilityEpsilon, Math.max(rankProbabilityEpsilon, probability));
  return Math.log(p / (1 - p));
}
