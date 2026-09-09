import {
  parseObsidianMarkdown,
  type ObsidianManagedFrontmatter
} from "@app/integration-contracts";

export interface ParsedManagedNote {
  frontmatter: ObsidianManagedFrontmatter;
  markdown: string;
}

export function parseManagedNote(content: string): ParsedManagedNote | null {
  const parsed = parseObsidianMarkdown(content);
  return parsed ? { frontmatter: parsed.frontmatter, markdown: parsed.frontmatter.memoraWikiSchema ? parsed.bodyMarkdown : parsed.bodyMarkdown.trim() } : null;
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
