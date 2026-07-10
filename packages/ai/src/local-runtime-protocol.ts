import { z } from "zod";

const generationParametersSchema = z.object({
  maxTokens: z.number().int().min(1).max(32_768).default(1_024),
  temperature: z.number().min(0).max(2).default(0.2),
  seed: z.number().int().nonnegative().optional()
}).strict();

export const mlxHelperRequestSchema = z.discriminatedUnion("command", [
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    command: z.literal("health")
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    command: z.literal("generate"),
    modelPath: z.string().min(1),
    prompt: z.string().min(1),
    parameters: generationParametersSchema.default({ maxTokens: 1_024, temperature: 0.2 })
  }).strict(),
  z.object({
    protocolVersion: z.literal(1),
    requestId: z.string().uuid(),
    command: z.literal("shutdown")
  }).strict()
]);

const mlxHelperProgressSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  kind: z.literal("progress"),
  progress: z.number().min(0).max(1),
  messageKey: z.string().min(1)
}).strict();

const mlxHelperResultSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  kind: z.literal("result"),
  ok: z.literal(true),
  output: z.string(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative()
}).strict();

const mlxHelperErrorSchema = z.object({
  protocolVersion: z.literal(1),
  requestId: z.string().uuid(),
  kind: z.literal("result"),
  ok: z.literal(false),
  error: z.object({
    code: z.string().min(1),
    messageKey: z.string().min(1),
    recoverable: z.boolean()
  }).strict()
}).strict();

export const mlxHelperMessageSchema = z.discriminatedUnion("kind", [
  mlxHelperProgressSchema,
  mlxHelperResultSchema,
  mlxHelperErrorSchema
]);

export type MlxHelperRequest = z.infer<typeof mlxHelperRequestSchema>;
export type MlxHelperMessage = z.infer<typeof mlxHelperMessageSchema>;
