import { randomUUID } from "node:crypto";

import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParameterCapabilitiesSchema,
  AiOutputSchemaSchema,
  AiSchemaModeSchema,
  AiTaskTypeSchema,
  type AiCapability,
  type AiOutputContract,
  type AiOutputSchema
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
    operation: z.string().min(1).max(200).optional(),
    /**
     * The JSON Schema of the answer (F3 D35): the strict schema of the contract a caller stated, for a
     * remote runtime and only for a strict-compatible contract, or the schema a local runtime derived
     * from it (F4 D23). Adapters map it to their wire format. It is kept out of the cassette key; the
     * entry body stores it.
     */
    outputSchema: AiOutputSchemaSchema.optional()
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
    /** How structured output was requested from the runtime that answered; absent when unknown. */
    schemaMode: AiSchemaModeSchema.optional(),
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

/** How far a call has come, as a fraction from 0 to 1, with an optional message key. */
export interface AiProgressStep {
  kind?: "progress";
  progress: number;
  messageKey?: string;
}

/**
 * A piece of the answer text as the model writes it (F3 D22): the answer only, never reasoning.
 * `restart` marks the first piece of a retried attempt: what the call streamed before is void and
 * the answer starts again.
 */
export interface AiTextDelta {
  kind: "text";
  delta: string;
  restart?: boolean;
}

export type AiProgressEvent = AiProgressStep | AiTextDelta;

export type AiProgressListener = (event: AiProgressEvent) => void;

export interface TextDeltaStream {
  /** An attempt starts: the text it streams replaces what an earlier attempt sent. */
  attempt(): void;
  /** Streams a piece of the answer text; an empty piece is not a delta. */
  delta(text: string): void;
}

/** Streams the answer text of one call to `listener`, marking the pieces of a retried attempt. */
export function createTextDeltaStream(listener: AiProgressListener | undefined): TextDeltaStream {
  let streamed = false;
  let restart = false;
  return {
    attempt() {
      restart = streamed;
    },
    delta(text) {
      if (!listener || text.length === 0) return;
      listener(
        restart ? { kind: "text", delta: text, restart: true } : { kind: "text", delta: text }
      );
      streamed = true;
      restart = false;
    }
  };
}

export interface AiTaskHandle {
  id: string;
  result: Promise<AiTaskResult>;
  cancel: () => void;
  onProgress: (listener: (event: AiProgressEvent) => void) => () => void;
}

/**
 * Texts per `embedMany` execution and per remote request (F3 D37). The service admits one lane
 * request per `perExecution` texts, so a P0 call waits for at most one bounded batch; a remote
 * adapter sends at most `perRequest` texts in one HTTP request.
 */
export const embedManyLimits = { perExecution: 32, perRequest: 64 } as const;

/**
 * What an `embedMany` call needs besides its texts. `parameters` and `modelId` are those of the
 * equivalent single `run` request: a cassette keys each text by that request, so the vectors of a
 * batch and of single calls stay interchangeable (D37).
 */
export interface AiEmbedManyOptions {
  inputType?: "query" | "document";
  /** The vector dimension; defaults to the effective `parameters.dimensions`, else 768. */
  dimensions?: number;
  parameters?: Record<string, unknown>;
  modelId?: string;
  workloadClass?: AiWorkloadClass;
  operation?: string;
  signal?: AbortSignal;
}

/**
 * The vectors of one `embedMany` call, in the order of its texts, with the audit fields a single
 * embedding result has (tokens of the whole batch, requests, retried usage).
 */
export type AiEmbedManyResult = Omit<AiTaskResult, "taskType" | "output"> & {
  embeddings: number[][];
  /** Tokens of each text, when the runtime reports them per text (a cassette records them so). */
  itemInputTokens?: number[];
  /** How many texts came from a cassette (replay) rather than from the runtime. */
  replayedItems?: number;
};

/** The result of a batch as the task result its single calls would add up to. */
export function embedManyTaskResult(result: AiEmbedManyResult): AiTaskResult {
  const task: AiTaskResult & Partial<AiEmbedManyResult> = {
    ...result,
    taskType: "embedding",
    output: result.embeddings
  };
  delete task.embeddings;
  delete task.itemInputTokens;
  delete task.replayedItems;
  return task;
}

export interface AiModelAdapter {
  describe(): AiModelDescriptor;
  canHandle(request: AiTaskRequest): boolean;
  isLoaded?(): boolean;
  ensureLoaded?(signal?: AbortSignal): Promise<void>;
  run(request: AiTaskRequest, signal?: AbortSignal): Promise<AiTaskResult>;
  /**
   * A runtime that constrains decoding by a schema (the helper's `schema` capability) derives it from
   * the output contract a caller states (F4 D23, D24); null runs the call without one. Absent, the
   * runtime takes no contract: a remote adapter is sent the contract's strict schema by the service.
   */
  outputSchemaFor?(contract: AiOutputContract): AiOutputSchema | null;
  /**
   * Embeds several texts in one execution; the vectors are those the single `run` of each text would
   * give (a runtime that cannot promise that does not offer this). Absent, the service runs the texts
   * one by one.
   */
  embedMany?(texts: readonly string[], options?: AiEmbedManyOptions): Promise<AiEmbedManyResult>;
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
