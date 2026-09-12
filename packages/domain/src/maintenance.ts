import {AutomaticMaintenanceCommandSchema,AutomaticMaintenanceDashboardSchema,AutomaticMaintenanceRunSchema,AutomaticRoutineScheduleSchema} from './automatic-maintenance.js';
import { PromptPinSchema } from "./prompt-catalog.js";
import { z } from "zod";
import { OrganizationProfileSchema } from "./organization.js";
import { WikiPageContentSchema } from "./wiki.js";

export const maintenanceFunctions = ["weekly", "monthly", "cleanup"] as const;
export const MaintenanceCategorySchema = z.enum(["navigation", "knowledge", "evidence"]);
const ids = z.array(z.string().uuid()).max(200).refine(v => new Set(v).size === v.length);
export const MaintenanceBudgetSchema = z.object({
  calls: z.number().int().min(0).max(2).default(1),
  tokens: z.number().int().min(2048).max(64000).default(16000),
  spend: z.number().min(0).max(100).nullable().default(null),
  inspected: z.number().int().min(1).max(2000).default(200),
  changes: z.number().int().min(0).max(10).default(3)
}).strict();
export const MaintenancePeriodBudgetSchema = z.object({
  calls: z.number().int().min(0).max(100).default(8), tokens: z.number().int().min(2048).max(1000000).default(128000),
  spend: z.number().min(0).max(500).nullable().default(null), inspected: z.number().int().min(1).max(20000).default(2000),
  changes: z.number().int().min(0).max(100).default(20)
}).strict();
export const MaintenanceCadenceSchema = z.object({
  kind: z.enum(["weekly", "monthly", "custom"]).default("weekly"),
  timezone: z.string().max(100).refine(v => { try { new Intl.DateTimeFormat("en", { timeZone: v }); return true; } catch { return false; } }),
  hour: z.number().int().min(0).max(23).default(9), minute: z.number().int().min(0).max(59).default(0),
  weekday: z.number().int().min(0).max(6).default(1), day: z.number().int().min(1).max(31).default(1),
  everyDays: z.number().int().min(1).max(90).default(14), anchor: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v=>{const d=new Date(v+"T00:00:00Z");return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===v;}).default("2026-01-01")
}).strict();
export const MaintenancePolicySchema = z.object({
  name: z.string().trim().min(1).max(100), enabled: z.boolean().default(false),
  routine: z.enum(maintenanceFunctions).default("weekly"), cadence: MaintenanceCadenceSchema,
  scope: z.object({ wholeLibrary: z.boolean().default(false), includePageDescendants:z.boolean().default(true), pageIds: ids.default([]), sourceIds: ids.default([]), excludedPageIds: ids.default([]) }).strict().refine(s => s.wholeLibrary || s.pageIds.length + s.sourceIds.length > 0, { message: "maintenance.errors.scope" }),
  profileId: z.string().uuid().nullable().default(null), privacy: z.enum(["offline_only", "allow_remote"]).default("offline_only"),
  domainId: z.string().uuid().nullable().default(null), categories: z.array(MaintenanceCategorySchema).min(1).max(3).refine(v => new Set(v).size === v.length),
  review: z.literal("human_review").default("human_review"), modelEnabled: z.boolean().default(false),
  idleOnly: z.boolean().default(true), cooldownDays: z.number().int().min(1).max(180).default(30), minimumBenefit: z.number().min(0.5).max(1).default(0.7),
  budget: MaintenanceBudgetSchema.default(() => MaintenanceBudgetSchema.parse({})), periodBudget: MaintenancePeriodBudgetSchema.default(() => MaintenancePeriodBudgetSchema.parse({}))
}).strict().superRefine((p,c) => { for (const k of ["calls","tokens","spend","inspected","changes"] as const) if(p.periodBudget[k]!==null && (p.budget[k]===null || p.budget[k]!>p.periodBudget[k]!)) c.addIssue({code:"custom",path:["periodBudget",k],message:"maintenance.errors.budget"}); });
export type MaintenancePolicy = z.infer<typeof MaintenancePolicySchema>;
export type MaintenanceCadence = z.infer<typeof MaintenanceCadenceSchema>;
export const MaintenanceScheduleSchema = z.object({ id:z.string().uuid(), revision:z.number().int(), policy:MaintenancePolicySchema, nextAt:z.string(), lastRunId:z.string().uuid().nullable(), lastError:z.string().nullable().default(null), updatedAt:z.string() }).strict();
export type MaintenanceSchedule = z.infer<typeof MaintenanceScheduleSchema>;
export const MaintenanceObjectSchema = z.object({
  id:z.string().uuid(), kind:z.enum(["page","source","note"]), revisionId:z.string().uuid().nullable(), title:z.string(),
  fingerprint:z.string(), content:WikiPageContentSchema.nullable(), eligibleMove:z.boolean(), eligibleArchive:z.boolean(),
  path:z.array(z.object({id:z.string().uuid(),title:z.string()})), sourceIds:z.array(z.string().uuid()),
  signals:z.array(z.enum(["broken_reference","stale_evidence","unsupported_section","empty_page","orphan_page","overlapping_topic","unplaced_source","disconnected_note","overgrown_page","deep_branch","wide_branch","obsolete_draft"])),
  relatedIds:z.array(z.string().uuid()), excerpt:z.string().max(2000)
}).strict();
export type MaintenanceObject = z.infer<typeof MaintenanceObjectSchema>;
export const MaintenanceOperationSchema = z.discriminatedUnion("type",[
  z.object({type:z.literal("reparent"),pageId:z.string().uuid(),expectedRevisionId:z.string().uuid(),parentId:z.string().uuid().nullable(),parentRevisionId:z.string().uuid().nullable(),reason:z.string().trim().min(10).max(1000),benefit:z.number().min(0).max(1)}).strict(),
  z.object({type:z.literal("collection_link"),pageId:z.string().uuid(),expectedRevisionId:z.string().uuid(),collectionId:z.string().uuid(),collectionRevisionId:z.string().uuid(),reason:z.string().trim().min(10).max(1000),benefit:z.number().min(0).max(1)}).strict(),
  z.object({type:z.literal("archive"),pageId:z.string().uuid(),expectedRevisionId:z.string().uuid(),reason:z.string().trim().min(10).max(1000),benefit:z.number().min(0).max(1)}).strict()
]);
export const MaintenanceProposalSchema=z.object({operations:z.array(MaintenanceOperationSchema).max(10),explanation:z.string().trim().min(1).max(2000)}).strict();
export type MaintenanceProposal=z.infer<typeof MaintenanceProposalSchema>;
export const MaintenanceSnapshotSchema=z.object({instructionPromptIds:z.array(z.string()).default([]),promptPin:PromptPinSchema.nullable().default(null),version:z.literal("wiki-maintenance-v1"),policy:MaintenancePolicySchema,configurationId:z.string().uuid().nullable(),configurationHash:z.string(),instructions:z.object({slots:z.object({guidance:z.string(),advanced:z.string()}),origins:z.object({guidance:z.string(),advanced:z.string()}),domainId:z.string().uuid().nullable()}),profile:OrganizationProfileSchema.nullable(),language:z.enum(["en","pt-BR","it","fr","es"]),scopeKey:z.string(),period:z.string(),cutoff:z.string(),sample:z.boolean().default(false),manual:z.boolean().default(false)}).strict();
export type MaintenanceSnapshot=z.infer<typeof MaintenanceSnapshotSchema>;
export const MaintenanceCheckpointSchema=z.object({
  cursor:z.object({kind:z.enum(["page","source","note","done"]),id:z.string().uuid().nullable()}).default({kind:"page",id:null}),
  inspected:z.number().int().nonnegative().default(0),total:z.number().int().nonnegative().default(0),findings:z.number().int().nonnegative().default(0),deferred:z.number().int().nonnegative().default(0),
  candidates:z.array(MaintenanceObjectSchema).max(30).default([]),signals:z.record(z.string(),z.number()).default({}),
  calls:z.number().int().nonnegative().default(0),callPending:z.boolean().default(false),modelState:z.enum(["none","waiting","active"]).default("none"),
  analyzedKeys:z.array(z.string()).max(30).default([]),inputTokens:z.number().nonnegative().nullable().default(null),outputTokens:z.number().nonnegative().nullable().default(null),cost:z.number().nonnegative().nullable().default(null),usageIncomplete:z.boolean().default(false),
  error:z.string().nullable().default(null),startedAt:z.string().nullable().default(null)
}).strict();
export const MaintenanceRunSchema=z.object({id:z.string().uuid(),jobId:z.string().uuid(),scheduleIds:z.array(z.string().uuid()),status:z.enum(["queued","inspecting","analyzing","awaiting_review","no_change","applied","rejected","canceled","failed","sample_passed"]),snapshot:MaintenanceSnapshotSchema,checkpoint:MaintenanceCheckpointSchema,proposal:MaintenanceProposalSchema.nullable(),receipts:z.array(z.object({pageId:z.string().uuid(),revisionId:z.string().uuid()})),createdAt:z.string(),updatedAt:z.string()}).strict();
export type MaintenanceRun=z.infer<typeof MaintenanceRunSchema>;
export const MaintenanceSummarySchema=MaintenanceRunSchema.pick({id:true,jobId:true,scheduleIds:true,status:true,createdAt:true,updatedAt:true}).extend({name:z.string(),routine:z.enum(maintenanceFunctions),inspected:z.number(),total:z.number(),findings:z.number(),deferred:z.number(),changes:z.number(),error:z.string().nullable()});
export const MaintenanceDashboardSchema=z.object({schedules:z.array(MaintenanceScheduleSchema),runs:z.array(MaintenanceSummarySchema)});
const LegacyMaintenanceCommandSchema=z.discriminatedUnion("command",[
  z.object({command:z.literal("dashboard")}).strict(),
  z.object({command:z.literal("save"),id:z.string().uuid().optional(),expectedRevision:z.number().int().optional(),policy:MaintenancePolicySchema}).strict(),
  z.object({command:z.literal("preview"),cadence:MaintenanceCadenceSchema}).strict(),
  z.object({command:z.literal("run"),id:z.string().uuid(),requestId:z.string().uuid()}).strict(),
  z.object({command:z.literal("pause"),id:z.string().uuid(),expectedRevision:z.number().int()}).strict(),
  z.object({command:z.literal("get"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("cancel"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("retry"),id:z.string().uuid()}).strict(),
  z.object({command:z.literal("review"),id:z.string().uuid(),decision:z.enum(["accept","reject"])}).strict()
]);
export const MaintenanceCommandSchema=z.union([LegacyMaintenanceCommandSchema,AutomaticMaintenanceCommandSchema]);
export type MaintenanceCommand=z.infer<typeof MaintenanceCommandSchema>;
export const MaintenanceResponseSchema=z.union([AutomaticMaintenanceDashboardSchema,AutomaticMaintenanceRunSchema,AutomaticRoutineScheduleSchema,MaintenanceDashboardSchema,MaintenanceScheduleSchema,MaintenanceRunSchema,z.array(z.string()),z.null()]);

const formatters=new Map<string,Intl.DateTimeFormat>();
function localParts(date:Date,zone:string){
  let f=formatters.get(zone);if(!f){f=new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",hourCycle:"h23"});formatters.set(zone,f);}
  const p=Object.fromEntries(f.formatToParts(date).map(p=>[p.type,p.value]));return [Number(p.year),Number(p.month),Number(p.day),Number(p.hour),Number(p.minute)];
}
/** Fold: first occurrence. Gap: first valid local minute after the requested time. */
export function maintenanceLocalInstant(parts:number[],zone:string):Date {
  const nominal=Date.UTC(parts[0]!,parts[1]!-1,parts[2]!,parts[3]!,parts[4]!);
  const offsets=new Set([-36,-12,0,12,36].map(h=>{const instant=new Date(nominal+h*3600000),p=localParts(instant,zone);return Date.UTC(p[0]!,p[1]!-1,p[2]!,p[3]!,p[4]!)-instant.getTime();}));
  for(let gap=0;gap<=180;gap++){
    const desired=new Date(nominal+gap*60000),target=[desired.getUTCFullYear(),desired.getUTCMonth()+1,desired.getUTCDate(),desired.getUTCHours(),desired.getUTCMinutes()];
    const matches=[...offsets].map(offset=>new Date(desired.getTime()-offset)).filter(d=>localParts(d,zone).every((v,i)=>v===target[i])).sort((a,b)=>a.getTime()-b.getTime());
    if(matches[0])return matches[0];
  }
  throw new Error("maintenance.errors.calendar");
}
export function maintenanceOccurrences(c:MaintenanceCadence,after:Date,count=5):string[]{
  const p=localParts(after,c.timezone),day=new Date(Date.UTC(p[0]!,p[1]!-1,p[2]!)),result:string[]=[];
  for(let n=0;n<Math.max(400,count*95)&&result.length<count;n++){
    const d=new Date(day.getTime()+n*86400000),year=d.getUTCFullYear(),month=d.getUTCMonth(),date=d.getUTCDate();
    const matches=c.kind==="weekly"?d.getUTCDay()===c.weekday:c.kind==="monthly"?date===Math.min(c.day,new Date(Date.UTC(year,month+1,0)).getUTCDate()):Math.round((d.getTime()-Date.parse(c.anchor+"T00:00:00Z"))/86400000)%c.everyDays===0;
    if(matches){const instant=maintenanceLocalInstant([year,month+1,date,c.hour,c.minute],c.timezone);if(instant>after)result.push(instant.toISOString());}
  }
  return result;
}
export function maintenanceLatestOccurrence(c:MaintenanceCadence,now:Date):string {
  const start=new Date(now.getTime()-100*86400000);let current=maintenanceOccurrences(c,start,1)[0]!;
  for(let i=0;i<101;i++){const next=maintenanceOccurrences(c,new Date(current),1)[0]!;if(new Date(next)>now)return current;current=next;}
  return current;
}
export function maintenancePeriod(now:Date):string{return now.toISOString().slice(0,7);}
