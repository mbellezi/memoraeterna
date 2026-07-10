import { unzipSync } from "fflate";

import { normalizeMarkdown, sha256 } from "./markdown-normalizer.js";
import type { ConversionInput, MarkdownConversionResult } from "./types.js";

export interface ZipLimits {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
}

const defaultLimits: ZipLimits = {
  maxEntries: 200,
  maxEntryBytes: 50 * 1024 * 1024,
  maxTotalBytes: 250 * 1024 * 1024,
  maxDepth: 4
};

export async function convertZip(
  input: ConversionInput,
  convertEntry: (input: ConversionInput) => Promise<MarkdownConversionResult>,
  limits: ZipLimits = defaultLimits
): Promise<MarkdownConversionResult> {
  const entries = unzipSync(input.data);
  const names = Object.keys(entries);
  if (names.length > limits.maxEntries) throw new Error("ZIP entry limit exceeded.");
  let totalBytes = 0;
  const parts: string[] = [];
  const warnings = [];
  for (const name of names) {
    if (name.startsWith("/") || name.split(/[\\/]/).includes("..")) throw new Error("ZIP path traversal rejected.");
    if (name.split(/[\\/]/).filter(Boolean).length > limits.maxDepth) throw new Error("ZIP depth limit exceeded.");
    const data = entries[name];
    if (!data || name.endsWith("/")) continue;
    if (data.byteLength > limits.maxEntryBytes) throw new Error("ZIP entry size limit exceeded.");
    totalBytes += data.byteLength;
    if (totalBytes > limits.maxTotalBytes) throw new Error("ZIP total size limit exceeded.");
    try {
      const converted = await convertEntry({ data, fileName: name, ...(input.profile ? { profile: input.profile } : {}) });
      parts.push(`# ${name}\n\n${converted.markdown}`);
      warnings.push(...converted.warnings);
    } catch {
      warnings.push({
        code: "zip_entry_unsupported",
        messageKey: "errors.common.unsupportedFile",
        detail: name,
        recoverable: true
      });
    }
  }
  const markdown = normalizeMarkdown(parts.join("\n\n"));
  return {
    status: markdown ? "converted" : "requires_ocr",
    markdown,
    contentHash: sha256(markdown),
    blocks: [],
    assets: [],
    engine: "native-zip",
    engineVersion: "1",
    profile: input.profile ?? "standard",
    options: { ...limits },
    warnings,
    quality: { textCoverage: names.length === 0 ? 0 : parts.length / names.length },
    metadata: { entryCount: names.length, convertedEntryCount: parts.length }
  };
}
