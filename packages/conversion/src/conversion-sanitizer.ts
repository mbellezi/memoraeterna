import { findControlCharacterIndexes, sanitizeExtractedValue } from "@app/domain";

import { sha256 } from "./markdown-normalizer.js";
import type { ConversionBlock, MarkdownConversionResult } from "./types.js";

/**
 * Removes U+0000 and the other C0 controls (except tab, line feed and carriage return) from every
 * text a converter returned. Engines such as Docling emit U+0000 for glyphs without a Unicode
 * mapping (for example the minus sign of a math font), and PostgreSQL cannot store it.
 *
 * Block offsets index into the Markdown, so they are shifted by the number of characters removed
 * before them, and the content hash is recomputed only when the Markdown itself changed. A result
 * without control characters is returned as the same object.
 */
export function sanitizeConversionResult(
  result: MarkdownConversionResult
): MarkdownConversionResult {
  const { markdown, blocks, contentHash, ...rest } = result;
  const removed = findControlCharacterIndexes(markdown);
  const cleanRest = sanitizeExtractedValue(rest);
  const cleanBlocks = sanitizeBlocks(blocks, removed);
  if (removed.length === 0 && cleanRest === rest && cleanBlocks === blocks) return result;
  const cleanMarkdown = removed.length === 0 ? markdown : sanitizeExtractedValue(markdown);
  return {
    ...cleanRest,
    markdown: cleanMarkdown,
    blocks: cleanBlocks,
    contentHash: removed.length === 0 ? contentHash : sha256(cleanMarkdown)
  };
}

function sanitizeBlocks(blocks: ConversionBlock[], removed: number[]): ConversionBlock[] {
  let changed = false;
  const cleaned = blocks.map((block) => {
    const clean = sanitizeExtractedValue(block);
    if (removed.length === 0) {
      if (clean !== block) changed = true;
      return clean;
    }
    changed = true;
    return {
      ...clean,
      markdownStart: shiftOffset(clean.markdownStart, removed),
      markdownEnd: shiftOffset(clean.markdownEnd, removed)
    };
  });
  return changed ? cleaned : blocks;
}

/** Offset in the cleaned Markdown: the original offset minus the removed characters before it. */
function shiftOffset(offset: number, removed: number[]): number {
  let low = 0;
  let high = removed.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (removed[middle]! < offset) low = middle + 1;
    else high = middle;
  }
  return offset - low;
}
