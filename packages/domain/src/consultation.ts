import { z } from 'zod';
import { OrganizationEvidenceSchema, OrganizationContextSchema } from './organization.js';
export const ConsultationInputSchema=z.object({
  requestId:z.string().uuid(),question:z.string().trim().min(3).max(1000),sourceIds:z.array(z.string().uuid()).max(100).default([]),pageId:z.string().uuid().nullable().default(null),includeDescendants:z.boolean().default(false),
  profileId:z.string().uuid(),privacy:z.enum(['offline_only','allow_remote']).default('offline_only'),domainId:z.string().uuid().nullable().default(null),reviewedOnly:z.boolean().default(false),mode:z.enum(['text','hybrid']).default('text'),relationContext:z.boolean().default(true)
}).strict();
export const ConsultationAnswerSchema=z.object({
  paragraphs:z.array(z.object({markdown:z.string().trim().min(1).max(6000),citations:z.array(z.string().regex(/^e\d{1,3}$/)).min(1).max(12).refine(v=>new Set(v).size===v.length),contextIds:z.array(z.string().uuid()).max(20).default([])}).strict()).min(1).max(6),
  gaps:z.array(z.string().max(1000)).max(8)
}).strict();
export const ConsultationResultSchema=z.object({
  id:z.string().uuid(),question:z.string(),scope:z.object({pageId:z.string().uuid().nullable(),sourceIds:z.array(z.string().uuid()),includeDescendants:z.boolean(),reviewedOnly:z.boolean()}),answer:ConsultationAnswerSchema,evidence:z.array(OrganizationEvidenceSchema),contexts:z.array(OrganizationContextSchema),
  coverage:z.object({retrieved:z.number(),selected:z.number(),sourceCount:z.number(),limited:z.boolean(),vector:z.enum(['disabled','available','unavailable']),signals:z.array(z.string()),stale:z.boolean()}),
  model:z.string(),inputTokens:z.number().nullable(),outputTokens:z.number().nullable(),costEstimate:z.number().nullable(),configurationHash:z.string()
}).strict();
export type ConsultationInput=z.infer<typeof ConsultationInputSchema>;
export type ConsultationResult=z.infer<typeof ConsultationResultSchema>;
