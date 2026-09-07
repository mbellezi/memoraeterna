import { z } from "zod";

export const monitoringQuerySchema = z.object({
  view: z.enum(["ai", "debug"]).default("ai"),
  kind: z.enum(["all", "embedding", "llm", "operation"]).default("all"),
  status: z.enum(["all", "running", "succeeded", "failed", "canceled", "interrupted"]).default("all"),
  search: z.string().max(200).default(""),
  since: z.string().datetime().optional(),
  until: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).max(1_000_000).default(0)
}).strict();
export const monitoringPruneSchema = z.object({
  amount: z.number().int().min(1).max(3650),
  unit: z.enum(["days", "months"]),
  scope: z.enum(["all", "payloads"]).default("all"),
  preview: z.boolean().default(true)
}).strict();
export const monitoringRowSchema = z.object({
  id: z.string().uuid(), kind: z.enum(["ai", "operation"]), operation: z.string(),
  taskType: z.string().nullable(), stage: z.string(),
  context: z.record(z.string(), z.unknown()),
  sources: z.array(z.object({ id: z.string().uuid(), title: z.string() })),
  provider: z.string().nullable(), modelId: z.string().nullable(), runtime: z.string().nullable(),
  profileId: z.string().nullable(), aiTaskRunId: z.string().nullable(),
  status: z.enum(["running", "succeeded", "failed", "canceled", "interrupted"]),
  startedAt: z.string().datetime(), finishedAt: z.string().datetime().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  tokenUsage: z.record(z.string(), z.number().finite().nonnegative()),
  costEstimate: z.number().nonnegative().nullable(),
  debugRecorded: z.boolean(), hasPayload: z.boolean(), error: z.string().nullable()
}).strict();
export const monitoringDetailSchema = monitoringRowSchema.extend({
  parameters: z.record(z.string(), z.unknown()), details: z.record(z.string(), z.unknown()),
  input: z.unknown(), output: z.unknown()
});
export const monitoringPageSchema = z.object({
  rows: z.array(monitoringRowSchema),
  totals: z.object({
    count: z.number(), failed: z.number(), running: z.number(), tokens: z.number().nullable(),
    inputTokens: z.number().nullable(), outputTokens: z.number().nullable(),
    reasoningTokens: z.number().nullable(), cachedInputTokens: z.number().nullable(),
    costEstimate: z.number().nullable(), missingUsage: z.number(), missingCost: z.number()
  })
});
export const monitoringPruneResultSchema = z.object({ cutoff: z.string().datetime(), count: z.number().int().nonnegative() });
export type MonitoringQuery = z.infer<typeof monitoringQuerySchema>;
export type MonitoringRow = z.infer<typeof monitoringRowSchema>;
export type MonitoringDetail = z.infer<typeof monitoringDetailSchema>;
export type MonitoringPage = z.infer<typeof monitoringPageSchema>;
export type MonitoringPrune = z.infer<typeof monitoringPruneSchema>;
