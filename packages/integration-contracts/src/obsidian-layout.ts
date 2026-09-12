import { z } from 'zod';
import { normalizeProjectionText, outsideCodeFences, parseWikiRegions } from './obsidian-format.js';

export const obsidianLayoutCapability = 'obsidian-layout-v2' as const;
export const obsidianLayoutConfigSchema = z.object({ version: z.literal(2), language: z.enum(['en', 'pt-BR', 'it', 'fr', 'es']), attachments: z.enum(['omit', 'copy']).default('omit') }).strict();
export type ObsidianLayoutConfig = z.infer<typeof obsidianLayoutConfigSchema>;
export const sourceOriginalStart = '<!-- memora:original:start -->';
export const sourceOriginalEnd = '<!-- memora:original:end -->';
/** Format 2 source wrappers have one exact editable original. All other wrapper text is generated. */
export function sourceOriginal(body: string) {
  body = normalizeProjectionText(body);
  const regions = parseWikiRegions(body), mask = outsideCodeFences(body);
  if (!regions) return null;
  const start = mask.indexOf(sourceOriginalStart), end = mask.indexOf(sourceOriginalEnd);
  if (start < 0 || end < start || mask.indexOf(sourceOriginalStart, start + 1) >= 0 || mask.indexOf(sourceOriginalEnd, end + 1) >= 0 || end > regions.editorial.length) return null;
  const contentStart = start + sourceOriginalStart.length + 1;
  if (body[contentStart - 1] !== '\n' || body[end - 1] !== '\n') return null;
  return { original: body.slice(contentStart, end - 1), before: body.slice(0, contentStart), after: body.slice(end - 1), generated: regions.generated };
}
export function replaceSourceOriginal(body: string, original: string) { const regions = sourceOriginal(body); if (!regions) throw new Error('obsidianWiki.errors.format'); return regions.before + original + regions.after; }
export const obsidianEditorPresenceSchema = z.object({ vaultId: z.string().uuid(), openPaths: z.array(z.string().max(1024)).max(1000), pendingTargetIds: z.array(z.string().uuid()).max(1000), quiescedMigrationIds:z.array(z.string().uuid()).max(10).default([]) }).strict();
export const obsidianLayoutPreviewInputSchema = obsidianLayoutConfigSchema;
export const obsidianLayoutApplyInputSchema = z.object({ id: z.string().uuid(), excludeIds: z.array(z.string().uuid()).max(5000).default([]), editorsClosed: z.literal(true) }).strict();
export const obsidianLayoutStatusSchema = z.object({ config: obsidianLayoutConfigSchema.nullable(), migrations: z.array(z.object({ id: z.string().uuid(), status: z.string(), createdAt: z.string(), config: obsidianLayoutConfigSchema, targets: z.array(z.object({ id: z.string().uuid(), oldPath: z.string().nullable(), newPath: z.string(), status: z.string(), reason: z.string().nullable(), bytes: z.number(), links: z.array(z.string()).max(5000), base: z.string().nullable(), local: z.string().nullable(), proposed: z.string().nullable() }).strict()).max(5000) }).strict()).max(10) }).strict();
export type ObsidianLayoutStatus = z.infer<typeof obsidianLayoutStatusSchema>;

export const obsidianPresenceResponseSchema=z.object({migration:z.object({id:z.string().uuid(),targetIds:z.array(z.string().uuid()).max(5000)}).strict().nullable()}).strict();
