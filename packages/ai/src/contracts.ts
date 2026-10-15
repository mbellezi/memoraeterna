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

export const aiModelDescriptorSchema = z
  .object({
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1),
    runtime: z.enum(["remote", "local", "sidecar"]),
    capabilities: z.array(AiCapabilitySchema).default([]),
    parameterCapabilities: AiModelParameterCapabilitiesSchema.default({}),
    displayName: z.string().min(1).optional(),
    limits: z.record(z.string(), z.unknown()).default({}),
    requirements: z.record(z.string(), z.unknown()).default({})
  })
  .strict();
export type AiModelDescriptor = z.infer<typeof aiModelDescriptorSchema>;

/**
 * Workload classes of the AI runtime. Each has its own total deadline, and a class a caller states
 * explicitly also selects its class route (`class:<class>`, D18). A class derived from the task
 * type only sets deadlines: note matching runs the `reranking` task, whose derived class is
 * `decide`, but it never resolves the `class:decide` route of the dedicated rankers.
 */
export const aiWorkloadClassSchema = z.enum([
  "embed",
  "decide",
  "write-fast",
  "write-quality",
  "answer"
]);
export type AiWorkloadClass = z.infer<typeof aiWorkloadClassSchema>;

export const aiTaskRequestSchema = z
  .object({
    taskType: AiTaskTypeSchema,
    input: z.unknown(),
    profileId: z.string().uuid().optional(),
    modelId: z.string().min(1).optional(),
    requiredCapabilities: z.array(AiCapabilitySchema).default([]),
    parameters: z.record(z.string(), z.unknown()).default({}),
    metadata: z.record(z.string(), z.unknown()).default({}),
    /** The class the caller stated; absent, the task type's class applies (deadlines only). */
    workloadClass: aiWorkloadClassSchema.optional(),
    /** The calling operation, which may have its own route (`op:<operation>`). */
    operation: z.string().min(1).max(200).optional()
  })
  .strict();
export type AiTaskRequest = z.infer<typeof aiTaskRequestSchema>;

export const aiTaskResultSchema = z
  .object({
    taskType: AiTaskTypeSchema,
    output: z.unknown(),
    providerId: aiProviderIdSchema,
    modelId: z.string().min(1),
    runtime: z.enum(["remote", "local", "sidecar"]),
    durationMs: z.number().int().nonnegative(),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    tokenUsage: z.record(z.string(), z.number().finite().nonnegative()).optional(),
    costEstimate: z.number().nonnegative().optional(),
    /** Requests the provider received for this call, the successful one included; absent when unknown. */
    attempts: z.number().int().positive().optional(),
    /**
     * Wire options the adapter chose itself for the successful request (for example a decide call
     * sent without the reasoning summary), so the audit records what the provider received.
     */
    requestOptions: z.record(z.string(), z.json()).optional(),
    /**
     * Tokens the provider reported for attempts that failed before the answer. They are already part of
     * the totals above wherever the answer's own count is known.
     */
    retriedUsage: z
      .object({
        inputTokens: z.number().int().nonnegative().optional(),
        outputTokens: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional()
  })
  .strict();
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
  isLoaded?(): boolean;
  ensureLoaded?(signal?: AbortSignal): Promise<void>;
  run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult>;
  runStreaming?(
    request: AiTaskRequest,
    signal: AbortSignal | undefined,
    onProgress: AiProgressListener
  ): Promise<AiTaskResult>;
  listModels?(signal?: AbortSignal): Promise<AiModelDescriptor[]>;
  testConnection?(signal?: AbortSignal): Promise<void>;
  dispose?(): Promise<void>;
}

/**
 * Whether a call runs through `runStreaming`. A remote generation always streams when the adapter can,
 * whatever capabilities are stored for the model, because only a streamed call has the connect,
 * first-byte and stall deadlines that keep a silent server from holding the execution slot. Any other
 * adapter streams when its model declares it.
 */
export function runsStreaming(
  adapter: AiModelAdapter,
  taskType: AiTaskRequest["taskType"]
): boolean {
  if (!adapter.runStreaming) return false;
  const descriptor = adapter.describe();
  if (descriptor.runtime === "remote" && taskType !== "embedding") return true;
  return (
    descriptor.capabilities.includes("streaming") ||
    descriptor.capabilities.includes("supports-progress-events")
  );
}

export function createTaskHandle(adapter: AiModelAdapter, request: AiTaskRequest): AiTaskHandle {
  const controller = new AbortController();
  const listeners = new Set<(event: AiProgressEvent) => void>();
  const result = (async () => {
    for (const listener of listeners) listener({ progress: 0 });
    const parsed = aiTaskRequestSchema.parse(request);
    const output = runsStreaming(adapter, parsed.taskType)
      ? await adapter.runStreaming!(parsed, controller.signal, (event) => {
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

export function hasCapabilities(
  descriptor: AiModelDescriptor,
  required: readonly AiCapability[]
): boolean {
  return required.every((capability) => descriptor.capabilities.includes(capability));
}
