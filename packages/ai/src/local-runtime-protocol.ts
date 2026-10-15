import { z } from "zod";

/**
 * JSONL protocol 1 of the supervised MLX helper (`native/mlx-helper`, documented in its README).
 * Requests go to stdin, one JSON object per line; responses come back on stdout. The helper
 * echoes the request ID as uppercase UUID text, so every schema lowercases it.
 */

const requestIdSchema = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());

const generationParametersSchema = z
  .object({
    maxTokens: z.number().int().min(1).max(32_768).default(1_024),
    temperature: z.number().min(0).max(2).default(0.2),
    topP: z.number().min(0).max(1).optional(),
    topK: z.number().int().min(1).max(1_000_000).optional(),
    presencePenalty: z.number().min(-2).max(2).optional(),
    enableThinking: z.boolean().default(false),
    seed: z.number().int().nonnegative().optional()
  })
  .strict();

/** The helper rejects fewer than 2 tokens for `embed` and fewer than 64 for `score`. */
const maxSequenceTokens = 131_072;
const maxBatchSize = 512;
/** Bounds on one request, far above any caller (rank requests carry at most 32 documents). */
export const mlxHelperMaxItemsPerRequest = 4_096;
const maxTextCharacters = 1_000_000;

const textSchema = z.string().min(1).max(maxTextCharacters);
const instructionSchema = z.string().min(1).max(maxTextCharacters);

const scorePairSchema = z
  .object({
    query: textSchema,
    document: textSchema,
    instruction: instructionSchema.optional()
  })
  .strict();

export const mlxHelperEmbedRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    command: z.literal("embed"),
    modelPath: z.string().min(1),
    texts: z.array(textSchema).min(1).max(mlxHelperMaxItemsPerRequest),
    normalize: z.boolean().optional(),
    dimensions: z.number().int().min(1).max(65_536).optional(),
    maxTokens: z.number().int().min(2).max(maxSequenceTokens).optional(),
    batchSize: z.number().int().min(1).max(maxBatchSize).optional()
  })
  .strict();

export const mlxHelperScoreRequestSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    command: z.literal("score"),
    modelPath: z.string().min(1),
    instruction: instructionSchema.optional(),
    query: textSchema.optional(),
    documents: z.array(textSchema).min(1).max(mlxHelperMaxItemsPerRequest).optional(),
    pairs: z.array(scorePairSchema).min(1).max(mlxHelperMaxItemsPerRequest).optional(),
    maxTokens: z.number().int().min(64).max(maxSequenceTokens).optional(),
    batchSize: z.number().int().min(1).max(maxBatchSize).optional()
  })
  .strict()
  .refine(
    (request) =>
      request.pairs === undefined
        ? request.query !== undefined && request.documents !== undefined
        : request.query === undefined && request.documents === undefined,
    { message: "score takes either query with documents, or pairs" }
  );

export const mlxHelperRequestSchema = z.discriminatedUnion("command", [
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: requestIdSchema,
      command: z.literal("health")
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: requestIdSchema,
      command: z.literal("generate"),
      modelPath: z.string().min(1),
      prompt: z.string().min(1),
      parameters: generationParametersSchema.default({
        maxTokens: 1_024,
        temperature: 0.2,
        enableThinking: false
      })
    })
    .strict(),
  mlxHelperEmbedRequestSchema,
  mlxHelperScoreRequestSchema,
  z
    .object({
      protocolVersion: z.literal(1),
      requestId: requestIdSchema,
      command: z.literal("shutdown")
    })
    .strict()
]);

const mlxHelperProgressSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("progress"),
    progress: z.number().min(0).max(1),
    messageKey: z.string().min(1)
  })
  .strict();

/** The result of `health`, `shutdown` and `generate`. */
export const mlxHelperTextResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    output: z.string(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    durationMs: z.number().int().nonnegative()
  })
  .strict();

const mlxHelperErrorSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(false),
    error: z
      .object({
        code: z.string().min(1),
        messageKey: z.string().min(1),
        recoverable: z.boolean()
      })
      .strict()
  })
  .strict();

const mlxHelperBatchTimingSchema = z
  .object({
    size: z.number().int().positive(),
    sequenceLength: z.number().int().positive(),
    ms: z.number().nonnegative()
  })
  .strict();

/** Per-request timing of `embed` and `score`; `loadMs` is 0 when the cached model was reused. */
export const mlxHelperTimingSchema = z
  .object({
    loadMs: z.number().nonnegative(),
    modelCached: z.boolean(),
    tokenizeMs: z.number().nonnegative(),
    inferenceMs: z.number().nonnegative(),
    perItemMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
    batches: z.array(mlxHelperBatchTimingSchema)
  })
  .strict();

export const mlxHelperEmbedResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    embeddings: z.array(z.array(z.number())).min(1),
    dimensions: z.number().int().positive(),
    normalized: z.boolean(),
    pooling: z.enum(["mean", "cls", "first", "last", "max", "none"]),
    tokenCounts: z.array(z.number().int().positive()),
    truncated: z.array(z.boolean()),
    timing: mlxHelperTimingSchema
  })
  .strict()
  .refine(
    (result) =>
      result.tokenCounts.length === result.embeddings.length &&
      result.truncated.length === result.embeddings.length &&
      result.embeddings.every((vector) => vector.length === result.dimensions),
    { message: "embed result lengths disagree" }
  );

export const mlxHelperScoreResultSchema = z
  .object({
    protocolVersion: z.literal(1),
    requestId: requestIdSchema,
    kind: z.literal("result"),
    ok: z.literal(true),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    scores: z.array(z.number().min(0).max(1)).min(1),
    logOdds: z.array(z.number()),
    yesTokenId: z.number().int().nonnegative(),
    noTokenId: z.number().int().nonnegative(),
    tokenCounts: z.array(z.number().int().positive()),
    truncated: z.array(z.boolean()),
    timing: mlxHelperTimingSchema
  })
  .strict()
  .refine(
    (result) =>
      result.logOdds.length === result.scores.length &&
      result.tokenCounts.length === result.scores.length &&
      result.truncated.length === result.scores.length,
    { message: "score result lengths disagree" }
  );

export const mlxHelperMessageSchema = z.union([
  mlxHelperProgressSchema,
  mlxHelperTextResultSchema,
  mlxHelperEmbedResultSchema,
  mlxHelperScoreResultSchema,
  mlxHelperErrorSchema
]);

export type MlxHelperRequest = z.infer<typeof mlxHelperRequestSchema>;
export type MlxHelperMessage = z.infer<typeof mlxHelperMessageSchema>;
export type MlxHelperProgress = z.infer<typeof mlxHelperProgressSchema>;
export type MlxHelperTextResult = z.infer<typeof mlxHelperTextResultSchema>;
export type MlxHelperEmbedResult = z.infer<typeof mlxHelperEmbedResultSchema>;
export type MlxHelperScoreResult = z.infer<typeof mlxHelperScoreResultSchema>;
export type MlxHelperTiming = z.infer<typeof mlxHelperTimingSchema>;
export type MlxGenerationParameters = z.input<typeof generationParametersSchema>;

/** What a caller supplies for `embed`; the host adds the protocol fields. */
export interface MlxEmbedInput {
  modelPath: string;
  texts: string[];
  /** L2 normalization after pooling; the helper defaults to true. */
  normalize?: boolean;
  /** Prefix truncation (MRL) applied before normalization. */
  dimensions?: number;
  maxTokens?: number;
  batchSize?: number;
}

/**
 * What a caller supplies for `score`: one query against several documents, or explicit pairs.
 * The Qwen3-Reranker template strings are protocol constants inside the helper.
 */
export type MlxScoreInput = {
  modelPath: string;
  instruction?: string;
  maxTokens?: number;
  batchSize?: number;
} & (
  | { query: string; documents: string[]; pairs?: never }
  | {
      pairs: Array<{ query: string; document: string; instruction?: string }>;
      query?: never;
      documents?: never;
    }
);

export function parseMlxHelperOutput(stdout: string): MlxHelperMessage[] {
  const messages: MlxHelperMessage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    messages.push(mlxHelperMessageSchema.parse(value));
  }
  return messages;
}
