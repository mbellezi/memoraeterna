import {
  obsidianManagedFrontmatterSchema,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";

export interface ParsedManagedNote {
  frontmatter: ObsidianManagedFrontmatter;
  markdown: string;
}

export function parseManagedNote(content: string): ParsedManagedNote | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return null;
  const header = match[1];
  const body = match[2];
  if (header === undefined || body === undefined) return null;
  const values = new Map<string, string>();
  for (const line of header.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim(), parseScalar(line.slice(separator + 1).trim()));
  }
  const parsed = obsidianManagedFrontmatterSchema.safeParse({
    memoraId: values.get("memora_id"),
    memoraType: values.get("memora_type"),
    ...(values.get("memora_source_id") ? { memoraSourceId: values.get("memora_source_id") } : {}),
    ...(values.get("memora_document_id") ? { memoraDocumentId: values.get("memora_document_id") } : {}),
    memoraManaged: values.get("memora_managed") === "true",
    memoraSyncVersion: Number(values.get("memora_sync_version")),
    memoraContentHash: values.get("memora_content_hash")
  });
  return parsed.success ? { frontmatter: parsed.data, markdown: body.trim() } : null;
}

export async function hashMarkdown(markdown: string): Promise<string> {
  const normalized = markdown
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();
  const data = new TextEncoder().encode(normalized ? `${normalized}\n` : "");
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseScalar(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    try { return JSON.parse(value) as string; } catch { return value.slice(1, -1); }
  }
  return value;
}
