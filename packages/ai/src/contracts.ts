import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParameterCapabilitiesSchema,
  AiTaskTypeSchema,
  type AiCapability
} from "@app/domain";

export const aiProviderIdSchema = z.string().min(1);
export type AiProviderId = z.infer<typeof aiProviderIdSchema>;

export const aiModelDescriptorSchema = z.object({
  providerId: aiProviderIdSchema,
  modelId: z.string().min(1),
  runtime: z.enum(["remote", "local", "sidecar"]),
  capabilities: z.array(AiCapabilitySchema).default([]),
  parameterCapabilities: AiModelParameterCapabilitiesSchema.default({}),
  displayName: z.string().min(1).optional(),
  limits: z.record(z.string(), z.unknown()).default({}),
  requirements: z.record(z.string(), z.unknown()).default({})
}).strict();
export type AiModelDescriptor = z.infer<typeof aiModelDescriptorSchema>;

export const aiTaskRequestSchema = z.object({
  taskType: AiTaskTypeSchema,
  input: z.unknown(),
  profileId: z.string().uuid().optional(),
  modelId: z.string().min(1).optional(),
  requiredCapabilities: z.array(AiCapabilitySchema).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();
export type AiTaskRequest = z.infer<typeof aiTaskRequestSchema>;

export const aiTaskResultSchema = z.object({
  taskType: AiTaskTypeSchema,
  output: z.unknown(),
  providerId: aiProviderIdSchema,
  modelId: z.string().min(1),
  runtime: z.enum(["remote", "local", "sidecar"]),
  durationMs: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  costEstimate: z.number().nonnegative().optional()
}).strict();
export type AiTaskResult = z.infer<typeof aiTaskResultSchema>;

export interface AiProgressEvent {
  progress: number;
  messageKey?: string;
}

export type AiProgressListener = (event: AiProgressEvent) => void;

export interface AiTaskHandle {
  id: string;
  result: Promise<AiTaskResult>;
  cancel: () => void;
  onProgress: (listener: (event: AiProgressEvent) => void) => () => void;
}

export interface AiModelAdapter {
  describe(): AiModelDescriptor;
  canHandle(request: AiTaskRequest): boolean;
  run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult>;
  runStreaming?(request: AiTaskRequest, signal: AbortSignal | undefined, onProgress: AiProgressListener): Promise<AiTaskResult>;
  listModels?(signal?: AbortSignal): Promise<AiModelDescriptor[]>;
  testConnection?(signal?: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

export function createTaskHandle(adapter: AiModelAdapter, request: AiTaskRequest): AiTaskHandle {
  const controller = new AbortController();
  const listeners = new Set<(event: AiProgressEvent) => void>();
  const result = (async () => {
    for (const listener of listeners) listener({ progress: 0 });
    const parsed = aiTaskRequestSchema.parse(request);
    const capabilities = adapter.describe().capabilities;
    const output = adapter.runStreaming && (capabilities.includes("streaming") || capabilities.includes("supports-progress-events"))
      ? await adapter.runStreaming(parsed, controller.signal, (event) => {
          for (const listener of listeners) listener(event);
        })
      : await adapter.run(parsed, controller.signal);
    for (const listener of listeners) listener({ progress: 1 });
    return aiTaskResultSchema.parse(output);
  })();
  return {
    id: randomUUID(),
    result,
    cancel: () => controller.abort(),
    onProgress(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  };
}

export function hasCapabilities(descriptor: AiModelDescriptor, required: readonly AiCapability[]): boolean {
  return required.every((capability) => descriptor.capabilities.includes(capability));
}
