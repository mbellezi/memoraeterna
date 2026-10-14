import { z } from "zod";

export const knowledgeAutomationPolicyKey = "knowledge.automation.policy.v1";
export const wikiAreaIds = {
  themes: "93eb6590-c9a3-4b82-8f79-000000000001",
  entities: "93eb6590-c9a3-4b82-8f79-000000000002",
  syntheses: "93eb6590-c9a3-4b82-8f79-000000000003",
  investigations: "93eb6590-c9a3-4b82-8f79-000000000004",
  maps: "93eb6590-c9a3-4b82-8f79-000000000005",
  people: "93eb6590-c9a3-4b82-8f79-000000000006",
  organizations: "93eb6590-c9a3-4b82-8f79-000000000007",
  places: "93eb6590-c9a3-4b82-8f79-000000000008",
  works: "93eb6590-c9a3-4b82-8f79-000000000009"
} as const;
export const AutomationTaskSchema = z
  .object({
    event: z
      .object({
        kind: z.string(),
        operation: z.string(),
        targetId: z.string().uuid(),
        targetTitle: z.string().nullable(),
        createdAt: z.string(),
        causalRunId: z.string().uuid().nullable()
      })
      .strict()
      .optional(),
    relatedRunId: z.string().uuid().nullable().optional(),
    relatedRunVersion: z.string().nullable().optional(),
    id: z.string(),
    kind: z.enum(["organization", "maintenance", "delivery", "inspection", "schedule", "sync"]),
    title: z.string(),
    status: z.string(),
    reason: z.string().nullable(),
    updatedAt: z.string(),
    policyId: z.string().nullable(),
    sourceIds: z.array(z.string()),
    version: z.string().nullable(),
    detailCount: z.number().int().positive().default(1),
    policyRevisionId: z.string().nullable().default(null)
  })
  .strict();
export const AutomationDashboardSchema = z
  .object({
    policyId: z.string().uuid(),
    policyRevisionId: z.string().uuid().nullable(),
    ready: z.boolean(),
    model: z.string().nullable(),
    tasks: z.array(AutomationTaskSchema),
    next: z.number().int().nullable(),
    total: z.number().int(),
    sources: z
      .object({ total: z.number().int(), integrated: z.number().int(), pending: z.number().int() })
      .strict()
  })
  .strict();
export const AutomationCommandSchema = z.discriminatedUnion("command", [
  z
    .object({
      command: z.literal("automationInspections"),
      policyId: z.string().uuid(),
      revisionId: z.string().max(100).nullable().default(null),
      sourceIds: z.array(z.string().uuid()).max(1000),
      offset: z.number().int().min(0).default(0)
    })
    .strict(),
  z
    .object({
      command: z.literal("automationDeliveries"),
      policyId: z.string().uuid(),
      revisionId: z.string().max(100).nullable().default(null),
      sourceIds: z.array(z.string().uuid()).max(1000),
      offset: z.number().int().min(0).default(0)
    })
    .strict(),
  z
    .object({ command: z.literal("automationAssets"), offset: z.number().int().min(0).default(0) })
    .strict(),
  z
    .object({ command: z.literal("automationSources"), offset: z.number().int().min(0).default(0) })
    .strict(),
  z
    .object({
      command: z.literal("automationDashboard"),
      offset: z.number().int().min(0).default(0),
      filter: z.enum(["all", "attention"]).default("all")
    })
    .strict()
]);
export const SourceJourneySchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          processing: z.string(),
          wiki: z.string(),
          obsidian: z.string()
        })
        .strict()
    ),
    next: z.number().int().nullable()
  })
  .strict();
export type AutomationTask = z.infer<typeof AutomationTaskSchema>;
export const KnowledgeAssetsSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string(),
          sourceId: z.string().uuid().nullable(),
          sourceTitle: z.string().nullable(),
          bytes: z.number().nonnegative()
        })
        .strict()
    ),
    next: z.number().int().nullable()
  })
  .strict();
export const AutomationDeliveriesSchema = z
  .object({ items: z.array(AutomationTaskSchema), next: z.number().int().nullable() })
  .strict();
