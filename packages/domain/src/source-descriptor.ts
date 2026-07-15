import { z } from "zod";

import { StableIdSchema } from "./primitives.js";

export const CreatorRoles = [
  "author",
  "editor",
  "translator",
  "organizer",
  "channel",
  "host",
  "contributor"
] as const;

export const CreatorRoleSchema = z.enum(CreatorRoles);

export const CreatorSchema = z.object({
  name: z.string().trim().min(1).max(300),
  role: CreatorRoleSchema,
  sortName: z.string().trim().min(1).max(300).optional(),
  affiliation: z.string().trim().min(1).max(300).optional(),
  externalIds: z.record(z.string().trim().min(1), z.string().trim().min(1)).optional()
}).strict();

export type Creator = z.infer<typeof CreatorSchema>;

export const MetadataProvenanceSourceSchema = z.enum(["manual", "extracted", "enriched"]);

export const MetadataFieldProvenanceSchema = z.object({
  source: MetadataProvenanceSourceSchema,
  evidence: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  observedAt: z.string().datetime().optional()
}).strict();

export type MetadataFieldProvenance = z.infer<typeof MetadataFieldProvenanceSchema>;

export const SourceDescriptorProvenanceSchema = z.record(
  z.string().trim().min(1),
  MetadataFieldProvenanceSchema
).default({});

export const CoverReferenceSchema = z.object({
  assetId: StableIdSchema.optional(),
  sourceUrl: z.string().url().optional(),
  mimeType: z.string().trim().min(1).optional()
}).strict().refine((cover) => cover.assetId !== undefined || cover.sourceUrl !== undefined, {
  message: "A cover must reference an asset or source URL."
});

export const PageRangeSchema = z.object({
  start: z.string().trim().min(1),
  end: z.string().trim().min(1).optional()
}).strict();

const commonDescriptorShape = {
  title: z.string().trim().min(1).max(1000),
  subtitle: z.string().trim().min(1).max(1000).optional(),
  language: z.string().trim().min(2).max(16).default("und"),
  creators: z.array(CreatorSchema).default([]),
  publicationDate: z.string().trim().min(4).max(32).optional(),
  description: z.string().trim().min(1).max(50_000).optional(),
  tags: z.array(z.string().trim().min(1).max(200)).max(200).default([]),
  cover: CoverReferenceSchema.optional(),
  provenance: SourceDescriptorProvenanceSchema
} as const;

const parentShape = {
  parentSourceItemId: StableIdSchema
} as const;

export const PersonalNoteDescriptorSchema = z.object({
  type: z.literal("PersonalNote"),
  ...commonDescriptorShape,
  context: z.string().trim().min(1).max(10_000).optional()
}).strict();

export const DailyNoteDescriptorSchema = z.object({
  type: z.literal("DailyNote"),
  ...commonDescriptorShape,
  noteDate: z.iso.date()
}).strict();

export const WebArticleDescriptorSchema = z.object({
  type: z.literal("WebArticle"),
  ...commonDescriptorShape,
  url: z.string().url().optional(),
  siteName: z.string().trim().min(1).max(500).optional(),
  imageUrl: z.string().url().optional()
}).strict();

export const BookDescriptorSchema = z.object({
  type: z.literal("Book"),
  ...commonDescriptorShape,
  edition: z.string().trim().min(1).max(100).optional(),
  publisher: z.string().trim().min(1).max(500).optional(),
  isbn10: z.string().transform(normalizeIsbn).pipe(z.string().refine(isValidIsbn10, "Invalid ISBN-10")).optional(),
  isbn13: z.string().transform(normalizeIsbn).pipe(z.string().refine(isValidIsbn13, "Invalid ISBN-13")).optional(),
  series: z.string().trim().min(1).max(500).optional(),
  volume: z.string().trim().min(1).max(100).optional(),
  pageCount: z.number().int().positive().optional(),
  subjects: z.array(z.string().trim().min(1).max(300)).max(200).default([])
}).strict();

export const BookChapterDescriptorSchema = z.object({
  type: z.literal("BookChapter"),
  ...commonDescriptorShape,
  ...parentShape,
  chapterNumber: z.string().trim().min(1).max(100).optional(),
  pages: PageRangeSchema.optional()
}).strict();

export const PeriodicalIssueDescriptorSchema = z.object({
  type: z.literal("PeriodicalIssue"),
  ...commonDescriptorShape,
  publicationTitle: z.string().trim().min(1).max(1000),
  issn: z.string().trim().regex(/^\d{4}-?\d{3}[\dXx]$/).optional(),
  volume: z.string().trim().min(1).max(100).optional(),
  issue: z.string().trim().min(1).max(100).optional(),
  publisher: z.string().trim().min(1).max(500).optional(),
  pageCount: z.number().int().positive().optional()
}).strict();

export const AcademicPaperDescriptorSchema = z.object({
  type: z.literal("AcademicPaper"),
  ...commonDescriptorShape,
  doi: z.string().transform(normalizeDoi).pipe(z.string().regex(/^10\.\d{4,9}\/\S+$/i)).optional(),
  venue: z.string().trim().min(1).max(1000).optional(),
  year: z.number().int().min(1000).max(9999).optional(),
  abstract: z.string().trim().min(1).max(100_000).optional(),
  keywords: z.array(z.string().trim().min(1).max(300)).max(200).default([]),
  pages: PageRangeSchema.optional()
}).strict();

export const DocumentSectionDescriptorSchema = z.object({
  type: z.literal("DocumentSection"),
  ...commonDescriptorShape,
  ...parentShape,
  sectionNumber: z.string().trim().min(1).max(100).optional(),
  pages: PageRangeSchema.optional()
}).strict();

export const StandaloneArticleDescriptorSchema = z.object({
  type: z.literal("StandaloneArticle"),
  ...commonDescriptorShape,
  parentSourceItemId: StableIdSchema.optional(),
  doi: z.string().transform(normalizeDoi).pipe(z.string().regex(/^10\.\d{4,9}\/\S+$/i)).optional(),
  periodicalTitle: z.string().trim().min(1).max(1000).optional(),
  volume: z.string().trim().min(1).max(100).optional(),
  issue: z.string().trim().min(1).max(100).optional(),
  pages: PageRangeSchema.optional()
}).strict();

export const VideoDescriptorSchema = z.object({
  type: z.literal("Video"),
  ...commonDescriptorShape,
  url: z.string().url().optional(),
  channel: z.string().trim().min(1).max(500).optional(),
  durationSeconds: z.number().int().nonnegative().optional(),
  platform: z.string().trim().min(1).max(100).optional(),
  videoId: z.string().trim().min(1).max(200).optional(),
  thumbnailUrl: z.string().url().optional()
}).strict();

export const GenericDocumentDescriptorSchema = z.object({
  type: z.literal("GenericDocument"),
  ...commonDescriptorShape,
  creationDate: z.string().trim().min(4).max(32).optional(),
  mimeType: z.string().trim().min(1).max(300).optional()
}).strict();

export const SourceDescriptorSchema = z.discriminatedUnion("type", [
  PersonalNoteDescriptorSchema,
  DailyNoteDescriptorSchema,
  WebArticleDescriptorSchema,
  BookDescriptorSchema,
  BookChapterDescriptorSchema,
  PeriodicalIssueDescriptorSchema,
  AcademicPaperDescriptorSchema,
  DocumentSectionDescriptorSchema,
  StandaloneArticleDescriptorSchema,
  VideoDescriptorSchema,
  GenericDocumentDescriptorSchema
]);

export type SourceDescriptor = z.infer<typeof SourceDescriptorSchema>;

export const SourceDescriptorDraftSchema = z.object({
  sourceType: z.enum([
    "PersonalNote", "DailyNote", "WebArticle", "Book", "BookChapter", "PeriodicalIssue",
    "AcademicPaper", "DocumentSection", "StandaloneArticle", "Video", "GenericDocument"
  ]),
  values: z.record(z.string(), z.unknown()).default({}),
  provenance: SourceDescriptorProvenanceSchema,
  warnings: z.array(z.string()).default([]),
  coverData: z.object({
    data: z.instanceof(Uint8Array),
    mimeType: z.string().trim().min(1),
    fileName: z.string().trim().min(1)
  }).strict().optional()
}).strict();

export type SourceDescriptorDraft = z.infer<typeof SourceDescriptorDraftSchema>;

const provenancePriority: Readonly<Record<MetadataFieldProvenance["source"], number>> = {
  extracted: 0,
  enriched: 1,
  manual: 2
};

export function mergeDescriptorFields<T extends Record<string, unknown>>(
  current: T,
  incoming: Partial<T>,
  options: { acceptEnrichedOverExtracted?: boolean } = {}
): T {
  const currentProvenance = readProvenance(current.provenance);
  const incomingProvenance = readProvenance(incoming.provenance);
  const merged: Record<string, unknown> = { ...current };
  const mergedProvenance: Record<string, MetadataFieldProvenance> = { ...currentProvenance };

  for (const [key, value] of Object.entries(incoming)) {
    if (key === "provenance" || value === undefined) continue;
    const existing = currentProvenance[key];
    const next = incomingProvenance[key];
    if (!next || !existing || provenancePriority[next.source] > provenancePriority[existing.source]
        || (existing.source === "extracted" && next.source === "enriched" && options.acceptEnrichedOverExtracted)) {
      if (existing?.source === "manual" && next?.source !== "manual") continue;
      if (existing?.source === "extracted" && next?.source === "enriched" && !options.acceptEnrichedOverExtracted) continue;
      merged[key] = value;
      if (next) mergedProvenance[key] = next;
    }
  }
  merged.provenance = mergedProvenance;
  return merged as T;
}

export function normalizeIsbn(value: string): string {
  return value.replace(/[^\dXx]/g, "").toUpperCase();
}

export function isValidIsbn10(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{9}[\dX]$/.test(isbn)) return false;
  const total = [...isbn].reduce((sum, character, index) => {
    const digit = character === "X" ? 10 : Number(character);
    return sum + digit * (10 - index);
  }, 0);
  return total % 11 === 0;
}

export function isValidIsbn13(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (!/^\d{13}$/.test(isbn)) return false;
  const total = [...isbn.slice(0, 12)].reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0
  );
  return (10 - (total % 10)) % 10 === Number(isbn[12]);
}

export function isbn10To13(value: string): string | null {
  const isbn = normalizeIsbn(value);
  if (!isValidIsbn10(isbn)) return null;
  const base = `978${isbn.slice(0, 9)}`;
  const total = [...base].reduce(
    (sum, character, index) => sum + Number(character) * (index % 2 === 0 ? 1 : 3),
    0
  );
  return `${base}${(10 - (total % 10)) % 10}`;
}

export function normalizeDoi(value: string): string {
  return value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "").replace(/^doi:\s*/i, "");
}

function readProvenance(value: unknown): Record<string, MetadataFieldProvenance> {
  const parsed = SourceDescriptorProvenanceSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}
