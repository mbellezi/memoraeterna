import { posix } from "node:path";

import {
  obsidianManagedFrontmatterSchema,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";

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
    memoraManaged: true,
    memoraSyncVersion: input.syncVersion,
    memoraContentHash: input.contentHash
  };
  const frontmatterText = serializeFrontmatter(frontmatter);
  const body = input.bodyMarkdown.trim();
  return {
    relativeDirectory: projectionDirectory(input),
    baseFileName: `${slugify(input.title)}.md`,
    frontmatter,
    frontmatterText,
    markdown: `${frontmatterText}\n${body}\n`
  };
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
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(markdown);
  if (!match) return null;
  const header = match[1];
  const body = match[2];
  if (header === undefined || body === undefined) return null;
  const values: Record<string, string> = {};
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    values[key] = unquoteYaml(raw);
  }
  const parsed = {
    memoraId: values.memora_id,
    memoraType: values.memora_type,
    ...(values.memora_source_id ? { memoraSourceId: values.memora_source_id } : {}),
    ...(values.memora_document_id ? { memoraDocumentId: values.memora_document_id } : {}),
    memoraManaged: values.memora_managed === "true",
    memoraSyncVersion: Number(values.memora_sync_version),
    memoraContentHash: values.memora_content_hash
  };
  const frontmatter = obsidianManagedFrontmatterSchema.safeParse(parsed);
  if (!frontmatter.success) return null;
  return { frontmatter: frontmatter.data, bodyMarkdown: body.trim() };
}

function serializeFrontmatter(frontmatter: ObsidianManagedFrontmatter): string {
  return [
    "---",
    `memora_id: ${yamlString(frontmatter.memoraId)}`,
    `memora_type: ${yamlString(frontmatter.memoraType)}`,
    ...(frontmatter.memoraSourceId ? [`memora_source_id: ${yamlString(frontmatter.memoraSourceId)}`] : []),
    ...(frontmatter.memoraDocumentId ? [`memora_document_id: ${yamlString(frontmatter.memoraDocumentId)}`] : []),
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
  if (input.sourceType === "Book" || input.sourceType === "BookChapter") {
    return posix.join(root, "Sources", "Books");
  }
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

function unquoteYaml(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value;
}
