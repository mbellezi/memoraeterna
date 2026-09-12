import { z } from 'zod';
import { AutomaticWikiPolicySchema, CuratorChangeSetSchema, initialCuratorLimits } from './automatic-wiki.js';
import { OrganizationEvidenceSchema, OrganizationProfileSchema,OrganizationParticipationSchema } from './organization.js';
import { PromptPinSchema } from './prompt-catalog.js';
import { WikiPageSchema } from './wiki.js';
export const curatorVersion = 'wiki-curator-v2';
export const CuratorStartSchema = z.object({ policyId:z.string().uuid(), policyRevisionId:z.string().uuid(), sourceIds:z.array(z.string().uuid()).min(1).max(100), noteIds:z.array(z.string().uuid()).max(100).default([]) }).strict();
export const CuratorTargetSchema=z.object({kind:z.enum(['page','source','atomic_note','entity']),id:z.string().uuid(),fingerprint:z.string(),title:z.string(),sourceIds:z.array(z.string().uuid()),chunkIds:z.array(z.string().uuid()),text:z.string().max(12000)}).strict();
export const CuratorSnapshotSchema=z.object({version:z.literal(curatorVersion),policy:AutomaticWikiPolicySchema,sourceIds:z.array(z.string().uuid()),profile:OrganizationProfileSchema,promptPin:PromptPinSchema,contentLanguage:z.enum(['en','pt-BR','it','fr','es']),evidence:z.array(OrganizationEvidenceSchema).max(12),references:z.array(CuratorTargetSchema).max(300),pages:z.array(WikiPageSchema).max(100),inputFingerprint:z.string(),groupId:z.string().uuid(),outputTokens:z.number().int().positive().max(8192),limits:AutomaticWikiPolicySchema.shape.limits,admittedAt:z.string(),participation:OrganizationParticipationSchema.nullable().default(null),sample:z.literal(false).default(false)}).strict();
export const CuratorSupportVerdictSchema=z.object({supported:z.boolean(),checkedTargets:z.array(z.string().regex(/^new_[a-z][a-z0-9_]{0,63}$/)).min(1).max(3),issues:z.array(z.object({path:z.string().min(1).max(300),message:z.string().min(1).max(500)}).strict()).max(12)}).strict().superRefine((v,ctx)=>{if(v.supported&&v.issues.length||!v.supported&&!v.issues.length)ctx.addIssue({code:'custom',path:['issues'],message:'Supported requires no issues; unsupported requires at least one concrete issue.'});});
export const CuratorSupportAssessmentSchema=z.object({proposalHash:z.string().min(1),aiTaskRunId:z.string().uuid(),verdict:CuratorSupportVerdictSchema}).strict();
export const CuratorCheckpointSchema=z.object({version:z.literal(curatorVersion),calls:z.number().int().nonnegative(),tools:z.number().int().nonnegative(),repairs:z.number().int().min(0).max(1),startedAt:z.string(),callPending:z.boolean(),waitingForModel:z.boolean(),proposal:CuratorChangeSetSchema.nullable(),supportAssessment:CuratorSupportAssessmentSchema.nullable().default(null),previousOutput:z.string().max(90000),validationIssues:z.array(z.object({path:z.string().max(300),message:z.string().max(500)}).strict()).max(12).default([]),error:z.string().nullable(),reportedInputTokens:z.number().nonnegative(),reportedOutputTokens:z.number().nonnegative(),costEstimate:z.number().nonnegative(),usageCounts:z.object({input:z.number().int(),output:z.number().int(),cost:z.number().int()}),usageIncomplete:z.boolean()}).strict();
export const CuratorRunSchema=z.object({id:z.string().uuid(),jobId:z.string().uuid().nullable(),status:z.enum(['queued','analyzing','awaiting_review','applied','rejected','canceled','failed']),snapshot:CuratorSnapshotSchema,checkpoint:CuratorCheckpointSchema,proposal:CuratorChangeSetSchema.nullable(),receiptRevisionId:z.string().uuid().nullable(),createdAt:z.string(),updatedAt:z.string()}).strict();
export const CuratorPolicyDraftSchema=z.object({sourceIds:z.array(z.string().uuid()).min(1).max(100),includeDescendants:z.boolean().default(false),excludedSourceIds:z.array(z.string().uuid()).max(100).default([]),profileOverrideId:z.string().uuid().nullable().default(null),limits:AutomaticWikiPolicySchema.shape.limits.default(initialCuratorLimits)}).strict();
export const CuratorPreviewSchema=z.object({policy:AutomaticWikiPolicySchema,sourceTitles:z.array(z.object({id:z.string().uuid(),title:z.string()})),profile:OrganizationProfileSchema.nullable(),promptIds:z.array(z.string()),previewHash:z.string(),modelError:z.string().nullable()}).strict();
export const CuratorCommandSchema=z.discriminatedUnion('command',[
 z.object({command:z.literal('preview'),input:CuratorPolicyDraftSchema}).strict(),
 z.object({command:z.literal('activate'),policyId:z.string().uuid(),revisionId:z.string().uuid(),previewHash:z.string()}).strict(),
 z.object({command:z.literal('pause'),policyId:z.string().uuid()}).strict(),
 z.object({command:z.literal('policies')}).strict(),
 z.object({command:z.literal('start'),input:CuratorStartSchema}).strict(),
 z.object({command:z.literal('list')}).strict(),
 ...(['get','cancel','retry','accept','reject'] as const).map(command=>z.object({command:z.literal(command),id:z.string().uuid()}).strict())
]);
export const CuratorResponseSchema=z.union([CuratorPreviewSchema,CuratorRunSchema,z.array(CuratorRunSchema),AutomaticWikiPolicySchema,z.array(AutomaticWikiPolicySchema),z.null()]);
export type CuratorSnapshot=z.infer<typeof CuratorSnapshotSchema>;
export type CuratorCheckpoint=z.infer<typeof CuratorCheckpointSchema>;
export type CuratorRun=z.infer<typeof CuratorRunSchema>;
export type CuratorChangeSet=z.infer<typeof CuratorChangeSetSchema>;
export type AutomaticWikiPolicy=z.infer<typeof AutomaticWikiPolicySchema>;
export type CuratorTarget=z.infer<typeof CuratorTargetSchema>;
export type CuratorCommand=z.infer<typeof CuratorCommandSchema>;

// Model transport uses only admitted short handles. The backend constructs the A0 envelope.
const modelReference=z.string().regex(/^(r[1-9][0-9]{0,2}|new_[a-z][a-z0-9_]{0,63})$/);
const DraftSectionSchema=z.object({id:z.string().uuid().nullable(),title:z.string().max(300),markdown:z.string().min(1).max(12000),originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)}).strict();
export const CuratorDraftSchema=z.object({
 explanation:z.string().min(1).max(2000),
 topics:z.array(z.object({handle:modelReference,title:z.string().min(1).max(300),purpose:z.string().min(1).max(2000),sections:z.array(DraftSectionSchema).min(1).max(6),links:z.array(modelReference).max(200).default([])}).strict()).max(3),
 indexes:z.array(z.object({handle:modelReference,title:z.string().min(1).max(300),purpose:z.string().min(1).max(2000),owner:z.union([z.object({topic:modelReference}).strict(),z.object({source:modelReference}).strict(),z.object({map:z.literal(true)}).strict()]),groups:z.array(z.object({id:z.string().uuid().nullable(),title:z.string().min(1).max(300),explanation:z.string().max(6000).nullable(),originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).max(12),targets:z.array(modelReference).min(1).max(200)}).strict()).min(1).max(12)}).strict()).max(3)
}).strict().superRefine((draft,ctx)=>{if(draft.topics.length+draft.indexes.length<1||draft.topics.length+draft.indexes.length>3)ctx.addIssue({code:'custom',path:['topics'],message:'A coherent group changes one to three topics/indexes combined.'});if(new Set([...draft.topics,...draft.indexes].map(t=>t.handle)).size!==draft.topics.length+draft.indexes.length)ctx.addIssue({code:'custom',path:['topics'],message:'Every proposed topic and index needs a unique handle.'});});
