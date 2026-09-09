import { z } from "zod";
import { WikiPageContentSchema } from "./wiki.js";

export const organizationVersion = "wiki-three-tools-v1";
export const OrganizationLimitsSchema = z.object({
  tools: z.number().int().min(1).max(12).default(12),
  modelCalls: z.number().int().min(1).max(13).default(13),
  outputTokens: z.number().int().min(256).max(8192).default(4096),
  reportedInputTokens: z.number().int().min(1000).max(120000).default(60000),
  deadlineMs: z.number().int().min(1000).max(300000).default(300000)
}).strict();
export const OrganizationSlotsSchema = z.object({
  guidance: z.string().max(12000).optional(), advanced: z.string().max(12000).optional()
}).strict().superRefine((slots, ctx) => {
  for (const [key, value] of Object.entries(slots)) {
    const remaining = value?.replace(/\{\{(?:title|language)\}\}/g, "") ?? "";
    if (/\{\{|\}\}/.test(remaining)) ctx.addIssue({ code: "custom", path: [key], message: "organization.errors.placeholder" });
  }
});
export const OrganizationDomainSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100),
  sourceIds: z.array(z.string().uuid()).max(100), pageIds: z.array(z.string().uuid()).max(100),
  slots: OrganizationSlotsSchema, pageSynthesis: OrganizationSlotsSchema
}).strict();
export const OrganizationConfigurationSchema = z.object({
  global: OrganizationSlotsSchema, pageSynthesis: OrganizationSlotsSchema,
  domains: z.array(OrganizationDomainSchema).max(30)
}).strict().superRefine((v,ctx)=>{
  if(new Set(v.domains.map(d=>d.id)).size!==v.domains.length) ctx.addIssue({code:"custom",message:"organization.errors.invalid"});
});
export const defaultOrganizationConfiguration = OrganizationConfigurationSchema.parse({ global: {}, pageSynthesis: {}, domains: [] });
export const builtInOrganizationSlots = {
  guidance: "Preserve attribution, disagreements and uncertainty. Prefer a concise synthesis grounded in original passages. Keep useful human interpretation intact.",
  advanced: "Synthesize {{title}} in {{language}}. Search original evidence, read relevant revisions, then propose one coherent page change. Cite only passages you read. Existing conceptual relationships are interpretations, not independent evidence."
};
export function resolveOrganizationInstructions(config: z.infer<typeof OrganizationConfigurationSchema>, domainId: string | null, title: string, language: string) {
  const domain = domainId ? config.domains.find(d=>d.id===domainId) : null;
  if (domainId && !domain) throw new Error("organization.errors.scope");
  const slots = { ...builtInOrganizationSlots }, origins = { guidance: "built_in", advanced: "built_in" };
  for (const [origin, layer] of [["global",config.global],["function",config.pageSynthesis],["domain",domain?.slots],["domain_function",domain?.pageSynthesis]] as const) {
    for (const key of ["guidance","advanced"] as const) if(layer?.[key]!==undefined) { slots[key]=layer[key]; origins[key]=origin; }
  }
  return { slots: { guidance: slots.guidance.replaceAll("{{title}}",title).replaceAll("{{language}}",language), advanced: slots.advanced.replaceAll("{{title}}",title).replaceAll("{{language}}",language) }, origins, domainId };
}
export const OrganizationStartSchema = z.object({
  targetPageId: z.string().uuid().nullable().default(null), title: z.string().trim().min(1).max(300),
  sourceIds: z.array(z.string().uuid()).min(1).max(100), includeDescendants: z.boolean().default(false),
  profileId: z.string().uuid().optional(), privacy: z.enum(["offline_only","allow_remote"]).default("offline_only"),
  domainId: z.string().uuid().nullable().default(null), relationContext: z.boolean().default(false),
  policy: z.enum(["human_review","apply_unprotected"]).default("human_review"),
  limits: OrganizationLimitsSchema.default(()=>OrganizationLimitsSchema.parse({}))
}).strict();
export const OrganizationActionSchema = z.discriminatedUnion("tool", [
  z.object({tool:z.literal("searchEvidence"), query:z.string().max(500), limit:z.number().int().min(1).max(20).default(20)}).strict(),
  z.object({tool:z.literal("readRevision"), handle:z.string().regex(/^e\d{1,3}$/), selector:z.literal("full")} ).strict(),
  z.object({tool:z.literal("proposePageChange"), target:z.literal("page"), expectedRevisionId:z.string().uuid().nullable(),
    explanation:z.string().trim().min(1).max(2000), sections:z.array(z.object({
      sectionId:z.string().uuid().nullable(), title:z.string().trim().max(300), markdown:z.string().trim().min(1).max(12000),
      citations:z.array(z.string().regex(/^e\d{1,3}$/)).min(1).max(20).refine(v=>new Set(v).size===v.length,{message:'organization.errors.evidence'})
    }).strict()).min(1).max(6)
  }).strict()
]);
export type OrganizationAction = z.infer<typeof OrganizationActionSchema>;
export type OrganizationProposal = Extract<OrganizationAction,{tool:"proposePageChange"}>;
export type OrganizationConfiguration = z.infer<typeof OrganizationConfigurationSchema>;
export type OrganizationStart = z.infer<typeof OrganizationStartSchema>;
export const OrganizationProfileSchema = z.object({
  profileId:z.string().uuid(), providerConfigId:z.string().uuid().nullable(),localModelId:z.string().uuid().nullable(),
  provider:z.string(),modelId:z.string(),runtime:z.string(),revision:z.string().nullable(),
  privacy:z.enum(["offline_only","allow_remote"]), parameters:z.record(z.string(),z.unknown()), identityHash:z.string(),
  contextWindow:z.number().positive().nullable()
}).strict();
export type OrganizationProfile = z.infer<typeof OrganizationProfileSchema>;
export const OrganizationEvidenceSchema = z.object({
  handle:z.string(), chunkId:z.string().uuid(),sourceItemId:z.string().uuid(),documentId:z.string().uuid(),sourceSpanId:z.string().uuid().nullable(),
  contentHash:z.string(),excerpt:z.string().max(12000),sourceTitle:z.string(),documentCreatedAt:z.string(),locator:z.string().nullable()
}).strict();
export const OrganizationSnapshotSchema = z.object({
  version:z.literal(organizationVersion), targetId:z.string().uuid(), expectedRevisionId:z.string().uuid().nullable(),
  targetHuman:z.boolean(),baseContent:WikiPageContentSchema, sourceIds:z.array(z.string().uuid()), profile:OrganizationProfileSchema,
  contentLanguage:z.enum(["en","pt-BR","it","fr","es"]),configurationId:z.string().uuid().nullable(), configurationHash:z.string(),
  instructions:z.object({slots:z.object({guidance:z.string(),advanced:z.string()}),origins:z.object({guidance:z.string(),advanced:z.string()}),domainId:z.string().uuid().nullable()}),
  limits:OrganizationLimitsSchema, policy:z.enum(["human_review","apply_unprotected"]),sample:z.boolean(),
  evidence:z.array(OrganizationEvidenceSchema).max(200), relations:z.array(z.object({
    id:z.string().uuid(),evidenceId:z.string().uuid(),fingerprint:z.string(),sourceItemId:z.string().uuid(),targetSourceItemId:z.string().uuid(),review:z.string(),updatedAt:z.string(),
    sourceIdea:z.string(),targetIdea:z.string(),explanation:z.string(),sourceHandle:z.string(),targetHandle:z.string()
  }).strict()).max(20)
}).strict();
export type OrganizationSnapshot = z.infer<typeof OrganizationSnapshotSchema>;
export const OrganizationCheckpointSchema = z.object({
  tools:z.number().int().nonnegative(), calls:z.number().int().nonnegative(), repairs:z.number().int().min(0).max(1),
  startedAt:z.string().nullable(), readHandles:z.array(z.string()), discoveredHandles:z.array(z.string()),
  transcript:z.array(z.object({action:OrganizationActionSchema.nullable(),result:z.unknown()})).max(13),
  reportedInputTokens:z.number().nonnegative(), reportedOutputTokens:z.number().nonnegative(),costEstimate:z.number().nonnegative(),
  usageCounts:z.object({input:z.number().int().nonnegative(),output:z.number().int().nonnegative(),cost:z.number().int().nonnegative()}).default({input:0,output:0,cost:0}),
  waitingForModel:z.boolean().default(false),
  usageIncomplete:z.boolean(),callPending:z.boolean(),error:z.string().nullable()
}).strict();
export type OrganizationCheckpoint=z.infer<typeof OrganizationCheckpointSchema>;
export const OrganizationRunSchema = z.object({
  id:z.string().uuid(), jobId:z.string().uuid().nullable(),status:z.enum(["queued","analyzing","awaiting_review","applied","sample_passed","rejected","canceled","failed"]),
  snapshot:OrganizationSnapshotSchema,checkpoint:OrganizationCheckpointSchema,proposal:OrganizationActionSchema.nullable(),
  receiptRevisionId:z.string().uuid().nullable(),createdAt:z.string(),updatedAt:z.string()
}).strict();
export type OrganizationRun=z.infer<typeof OrganizationRunSchema>;
export const OrganizationRunSummarySchema=z.object({id:z.string().uuid(),status:OrganizationRunSchema.shape.status,modelState:z.enum(["none","waiting","active"]),title:z.string(),sample:z.boolean(),receiptRevisionId:z.string().uuid().nullable(),createdAt:z.string(),updatedAt:z.string()}).strict();
export type OrganizationRunSummary=z.infer<typeof OrganizationRunSummarySchema>;
export const OrganizationSettingsSchema=z.object({
  activeId:z.string().uuid().nullable(),revisions:z.array(z.object({id:z.string().uuid(),configuration:OrganizationConfigurationSchema,hash:z.string(),createdAt:z.string(),samplePassed:z.boolean()})),
  activations:z.array(z.object({id:z.string().uuid(),revisionId:z.string().uuid(),createdAt:z.string()}))
});
export const OrganizationCommandSchema=z.discriminatedUnion("command",[
  z.object({command:z.literal("settings")}).strict(),
  z.object({command:z.literal("saveDraft"),configuration:OrganizationConfigurationSchema}).strict(),
  z.object({command:z.literal("activate"),revisionId:z.string().uuid(),expectedActiveId:z.string().uuid().nullable()}).strict(),
  z.object({command:z.literal("sample"),revisionId:z.string().uuid(),domainId:z.string().uuid().nullable().default(null),profileId:z.string().uuid(),privacy:z.enum(["offline_only","allow_remote"])}).strict(),
  z.object({command:z.literal("start"),input:OrganizationStartSchema}).strict(),
  z.object({command:z.literal("list")}).strict(),
  z.object({command:z.literal("get"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("cancel"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("retry"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("review"),id:z.string().uuid(),decision:z.enum(["accept","reject"])}).strict()
]);
export type OrganizationCommand=z.infer<typeof OrganizationCommandSchema>;

export const OrganizationResponseSchema=z.union([OrganizationSettingsSchema,OrganizationRunSchema,z.array(OrganizationRunSummarySchema),z.string().uuid(),z.null()]);

/** Replace run-local handles with the section's stable displayed citation order. */
export function organizationCitationMarkdown(section:{markdown:string;citations:string[]}):string {
  return section.markdown.replace(/\[(e\d{1,3})\]/g,(marker,handle:string)=>{
    const index=[...new Set(section.citations)].indexOf(handle);return index>=0?`[${index+1}]`:marker;
  });
}
