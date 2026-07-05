import { z } from "zod";

import { AiCapabilitySchema, AiTaskTypeSchema } from "@app/domain";

export const aiProviderIdSchema = z.string().min(1);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

export const aiModelDescriptorSchema = z.object({
  providerId: aiProviderIdSchema,
  modelId: z.string().min(1),
  runtime: z.enum(["remote", "local", "sidecar"]),
  capabilities: z.array(AiCapabilitySchema).default([]),
  displayName: z.string().min(1).optional()
});
export type AiModelDescriptor = z.infer<typeof aiModelDescriptorSchema>;

export const aiTaskRequestSchema = z.object({
  taskType: AiTaskTypeSchema,
  input: z.unknown(),
  profileId: z.string().uuid().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
});
export type AiTaskRequest = z.infer<typeof aiTaskRequestSchema>;

export const aiTaskResultSchema = z.object({
  taskType: AiTaskTypeSchema,
  output: z.unknown(),
  providerId: aiProviderIdSchema,
  modelId: z.string().min(1),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costEstimate: z.number().nonnegative().optional()
});
export type AiTaskResult = z.infer<typeof aiTaskResultSchema>;

export interface AiModelAdapter {
  describe(): AiModelDescriptor;
  canHandle(request: AiTaskRequest): boolean;
  run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult>;
}
