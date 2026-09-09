import { posix } from "node:path";

import { translate, type MessageKey } from "@app/i18n";
import {
  parseObsidianMarkdown,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";

const relationsStartMarker = "<!-- memora:relations:start -->";
const relationsEndMarker = "<!-- memora:relations:end -->";
const relationTypeMessageKeys: Readonly<Record<string, MessageKey>> = {
  supports: "knowledge.relations.types.supports",
  contrasts: "knowledge.relations.types.contrasts",
  extends: "knowledge.relations.types.extends",
  similar_to: "knowledge.relations.types.similar_to",
  depends_on: "knowledge.relations.types.depends_on",
  clarifies: "knowledge.relations.types.clarifies",
  mentions: "knowledge.relations.types.mentions",
  related: "knowledge.relations.types.related"
};

export interface ObsidianRelatedNote {
  noteId?:string;
  relationType: string;
  title: string;
  target: string;
}

export interface ObsidianProjectionInput {
  managedRoot: string;
  memoraId: string;
  memoraType: "source_item" | "atomic_note";
  sourceItemId?: string;
  documentId?: string;
  title: string;
  bodyMarkdown: string;
  contentHash: string;
  syncVersion: number;
  sourceType?: string;
  sourceUri?: string | null;
  rootSourceItemId?: string;
  rootTitle?: string;
  divisionId?: string;
  documentRevisionId?: string;
  isHierarchyRoot?: boolean;
  date: Date;
}

export interface RenderedObsidianProjection {
  relativeDirectory: string;
  baseFileName: string;
  frontmatter: ObsidianManagedFrontmatter;
  frontmatterText: string;
  markdown: string;
}

export function renderObsidianProjection(input: ObsidianProjectionInput): RenderedObsidianProjection {
  const frontmatter: ObsidianManagedFrontmatter = {
    memoraId: input.memoraId,
    memoraType: input.memoraType,
    ...(input.sourceItemId ? { memoraSourceId: input.sourceItemId } : {}),
    ...(input.documentId ? { memoraDocumentId: input.documentId } : {}),
    ...(input.rootSourceItemId ? { memoraRootSourceId: input.rootSourceItemId } : {}),
    ...(input.divisionId ? { memoraDivisionId: input.divisionId } : {}),
    ...(input.documentRevisionId ? { memoraDocumentRevisionId: input.documentRevisionId } : {}),
    memoraManaged: true,
    memoraSyncVersion: input.syncVersion,
    memoraContentHash: input.contentHash
  };
  const frontmatterText = serializeFrontmatter(frontmatter);
  const body = input.bodyMarkdown.trim();
  return {
    relativeDirectory: projectionDirectory(input),
    baseFileName: input.isHierarchyRoot ? "index.md" : `${slugify(input.title)}.md`,
    frontmatter,
    frontmatterText,
    markdown: `${frontmatterText}\n${body}\n`
  };
}

export function appendObsidianRelations(
  bodyMarkdown: string,
  locale: string,
  relatedNotes: ObsidianRelatedNote[]
): string {
  const grouped = new Map<string, ObsidianRelatedNote[]>();
  for (const relatedNote of relatedNotes) {
    const entries = grouped.get(relatedNote.relationType) ?? [];
    entries.push(relatedNote);
    grouped.set(relatedNote.relationType, entries);
  }
  const sections = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relationType, entries]) => {
      const key = relationTypeMessageKeys[relationType];
      const heading = key ? translate(locale, key) : relationType;
      const links = entries
        .sort((left, right) => left.title.localeCompare(right.title) || left.target.localeCompare(right.target))
        .map((entry) => `- [[${escapeWikilink(entry.target)}|${escapeWikilink(entry.title)}]]`);
      return `### ${heading}\n\n${links.join("\n")}`;
    });
  return [
    bodyMarkdown.trim(),
    relationsStartMarker,
    `## ${translate(locale, "library.sections.relations")}`,
    ...(sections.length > 0 ? sections : [translate(locale, "knowledge.relations.empty")]),
    relationsEndMarker
  ].join("\n\n");
}

export function stripObsidianRelations(bodyMarkdown: string): string {
  const start = bodyMarkdown.indexOf(relationsStartMarker);
  if (start < 0) return bodyMarkdown.trim();
  const end = bodyMarkdown.indexOf(relationsEndMarker, start + relationsStartMarker.length);
  if (end < 0) return bodyMarkdown.trim();
  return `${bodyMarkdown.slice(0, start)}${bodyMarkdown.slice(end + relationsEndMarker.length)}`.trim();
}

export function collisionFileName(baseFileName: string, date: Date, attempt: number, memoraId: string): string {
  if (attempt === 0) return baseFileName;
  const extension = posix.extname(baseFileName);
  const stem = baseFileName.slice(0, -extension.length);
  const dateSuffix = compactDate(date);
  if (attempt === 1) return `${stem}--${dateSuffix}${extension}`;
  if (attempt <= 99) return `${stem}--${dateSuffix}-${String(attempt).padStart(2, "0")}${extension}`;
  return `${stem}--${memoraId.replace(/-/g, "").slice(0, 6).toUpperCase()}${extension}`;
}

export function parseManagedMarkdown(markdown: string): {
  frontmatter: ObsidianManagedFrontmatter;
  bodyMarkdown: string;
} | null {
  const parsed = parseObsidianMarkdown(markdown);
  return parsed ? { frontmatter: parsed.frontmatter, bodyMarkdown: parsed.frontmatter.memoraWikiSchema ? parsed.bodyMarkdown : parsed.bodyMarkdown.trim() } : null;
}

function serializeFrontmatter(frontmatter: ObsidianManagedFrontmatter): string {
  return [
    "---",
    `memora_id: ${yamlString(frontmatter.memoraId)}`,
    `memora_type: ${yamlString(frontmatter.memoraType)}`,
    ...(frontmatter.memoraSourceId ? [`memora_source_id: ${yamlString(frontmatter.memoraSourceId)}`] : []),
    ...(frontmatter.memoraDocumentId ? [`memora_document_id: ${yamlString(frontmatter.memoraDocumentId)}`] : []),
    ...(frontmatter.memoraRootSourceId ? [`memora_root_source_id: ${yamlString(frontmatter.memoraRootSourceId)}`] : []),
    ...(frontmatter.memoraDivisionId ? [`memora_division_id: ${yamlString(frontmatter.memoraDivisionId)}`] : []),
    ...(frontmatter.memoraDocumentRevisionId ? [`memora_document_revision_id: ${yamlString(frontmatter.memoraDocumentRevisionId)}`] : []),
    "memora_managed: true",
    `memora_sync_version: ${frontmatter.memoraSyncVersion}`,
    `memora_content_hash: ${yamlString(frontmatter.memoraContentHash)}`,
    "---"
  ].join("\n");
}

function projectionDirectory(input: ObsidianProjectionInput): string {
  const root = sanitizeManagedRoot(input.managedRoot);
  const year = String(input.date.getUTCFullYear());
  const month = String(input.date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(input.date.getUTCDate()).padStart(2, "0");
  if (input.memoraType === "atomic_note") return posix.join(root, "Atomic", year, month, day);
  if (input.sourceType === "WebArticle") {
    const host = safeHost(input.sourceUri) ?? "captured";
    return posix.join(root, "Sources", "Web", year, month, host);
  }
  if (input.sourceType === "Video") return posix.join(root, "Sources", "Videos", year, month);
  if (input.sourceType === "Book") return posix.join(root, "Books", slugify(input.title));
  if (input.sourceType === "BookChapter") return posix.join(root, "Books", slugify(input.rootTitle ?? "book"), "Chapters");
  if (input.sourceType === "PeriodicalIssue") return posix.join(root, "Periodicals", slugify(input.title));
  if (input.sourceType === "StandaloneArticle" && input.rootTitle) return posix.join(root, "Periodicals", slugify(input.rootTitle), "Articles");
  if (input.sourceType === "AcademicPaper") return posix.join(root, "Papers", slugify(input.title));
  if (input.sourceType === "DocumentSection") return posix.join(root, "Papers", slugify(input.rootTitle ?? "paper"), "Sections");
  if (input.sourceType === "DailyNote") return posix.join(root, "Sources", "Daily", year, month);
  if (input.sourceType === "PersonalNote") return posix.join(root, "Sources", "Notes");
  return posix.join(root, "Sources", "Documents");
}

export function slugify(value: string): string {
  const slug = value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120);
  return slug || "untitled";
}

function sanitizeSegment(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").replace(/^\.+$/, "").trim();
}

function sanitizeManagedRoot(value: string): string {
  const segments = value.split(/[\\/]+/).map(sanitizeSegment).filter(Boolean);
  return segments.length > 0 ? posix.join(...segments) : "Memora";
}

function safeHost(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return sanitizeSegment(new URL(value).hostname.toLowerCase()) || null;
  } catch {
    return null;
  }
}

function compactDate(date: Date): string {
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, "0")}${String(date.getUTCDate()).padStart(2, "0")}`;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeWikilink(value: string): string {
  return value.replace(/[\\|\[\]]/g, "\\$&");
}
