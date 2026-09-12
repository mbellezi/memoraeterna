import { z } from 'zod';

/** Precision is evidence, not a UI formatting choice. Unknown dates stay null. */
export const KnowledgeDateSchema=z.discriminatedUnion('precision',[
 z.object({precision:z.literal('year'),value:z.string().regex(/^\d{4}$/)}).strict(),
 z.object({precision:z.literal('month'),value:z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)}).strict(),
 z.object({precision:z.literal('day'),value:z.iso.date()}).strict(),
 z.object({precision:z.literal('instant'),value:z.iso.datetime({offset:true})}).strict()
]);
export const InterpretationDraftSchema=z.object({
 statement:z.string().min(1).max(3000),perspective:z.enum(['user_statement','attributed_statement','ai_interpretation']),
 context:z.enum(['current','historical','uncertain']),eventTime:KnowledgeDateSchema.nullable(),
 validFrom:KnowledgeDateSchema.nullable(),validUntil:KnowledgeDateSchema.nullable(),publicationTime:KnowledgeDateSchema.nullable(),
 relationships:z.array(z.object({kind:z.enum(['supports','contradicts','supersedes']),revisionId:z.string().uuid(),reason:z.string().min(1).max(1000)}).strict()).max(12),
 procedure:z.object({steps:z.array(z.string().min(1).max(1000)).min(1).max(12),workedWhen:z.string().min(1).max(2000),assumptions:z.array(z.string().min(1).max(1000)).min(1).max(12),limits:z.array(z.string().min(1).max(1000)).min(1).max(12),corrections:z.array(z.string().min(1).max(1000)).max(12)}).strict().nullable(),
 originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)
}).strict();
export const KnowledgeSourceDatesSchema=z.array(z.object({sourceItemId:z.string().uuid(),noteDate:z.iso.date().nullable(),publicationDate:z.string().nullable()}).strict()).max(100);
export const InterpretationRecordSchema=InterpretationDraftSchema.omit({originalHandles:true}).extend({
 sourceDates:KnowledgeSourceDatesSchema.optional(),version:z.literal('knowledge-interpretation-v1'),assertionId:z.string().uuid(),revisionId:z.string().uuid(),
 recordedAt:z.array(z.object({documentId:z.string().uuid(),at:z.string()})).min(1).max(12),revisedAt:z.string(),
 evidence:z.array(z.object({sourceItemId:z.string().uuid(),documentId:z.string().uuid(),chunkId:z.string().uuid(),sourceSpanId:z.string().uuid().nullable(),contentHash:z.string(),excerpt:z.string(),sourceTitle:z.string(),documentCreatedAt:z.string(),locator:z.string().nullable()}).strict()).min(1).max(12)
}).strict();
export const NoteEvolutionSchema=z.object({version:z.literal('note-evolution-v1'),kind:z.enum(['merge','split','cross_source']),
 noteIds:z.array(z.string().uuid()).min(1).max(6),reason:z.string().min(1).max(2000),
 notes:z.array(z.object({title:z.string().min(1).max(300),ideaStatement:z.string().min(1).max(3000),bodyMarkdown:z.string().min(1).max(12000),originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)}).strict()).min(1).max(6)
}).strict().superRefine((v,c)=>{
 if(new Set(v.noteIds).size!==v.noteIds.length)c.addIssue({code:'custom',path:['noteIds'],message:'Select each note once.'});
 if(v.kind==='merge'&&(v.noteIds.length<2||v.notes.length!==1)||v.kind==='split'&&(v.noteIds.length!==1||v.notes.length<2)||v.kind==='cross_source'&&v.notes.length!==1)c.addIssue({code:'custom',path:['notes'],message:'Merge requires several inputs and one output; split requires one input and several outputs; cross-source creates one note.'});
});
export type InterpretationRecord=z.infer<typeof InterpretationRecordSchema>;
export type NoteEvolution=z.infer<typeof NoteEvolutionSchema>;

/** Shared by canonical repair and both review surfaces; IDs remain backend-owned. */
export function noteEvolutionReplacementIds(id:string,change:Pick<NoteEvolution,'kind'|'noteIds'>,outputIds:readonly string[]):string[]{
 if(!change.noteIds.includes(id))return[id];
 return change.kind==='cross_source'?[id,...outputIds]:[...outputIds];
}
