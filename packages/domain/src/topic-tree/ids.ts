// Item keys, content-key ordering and topic-title normalization.
//
// Items (notes and root sources, D8) are keyed `note:<uuid>` / `source:<uuid>`. Batch builds over
// a bare matrix use `row:<n>` keys instead (row keys never cross the worker boundary). Every order
// the engine depends on is a content-key order: content hash first, then the key, compared by code
// unit (D22), so a replay with fresh UUIDs but the same content rebuilds the same tree.
import { z } from "zod";

import type { TopicItemKind } from "../topics.js";

export type ItemKey = string;

const uuidSource = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const itemKeyPattern = new RegExp(`^(note|source):(${uuidSource})$`);
const rowKeyPattern = /^row:(0|[1-9][0-9]*)$/;

/** A product item key: `note:<uuid>` or `source:<uuid>`, lowercase. */
export const ItemKeySchema = z.string().regex(itemKeyPattern);

export function itemKey(kind: TopicItemKind, id: string): ItemKey {
  const key = `${kind}:${id.toLowerCase()}`;
  if (!itemKeyPattern.test(key)) throw new TypeError(`Invalid item key ${key}`);
  return key;
}

export function parseItemKey(key: string): { kind: TopicItemKind; id: string } | null {
  const match = itemKeyPattern.exec(key);
  if (!match) return null;
  return { kind: match[1] as TopicItemKind, id: match[2] as string };
}

/** Key of matrix row `row` in a batch build. */
export function rowItemKey(row: number): ItemKey {
  if (!Number.isInteger(row) || row < 0) throw new TypeError(`Invalid row ${row}`);
  return `row:${row}`;
}

export function rowOfItemKey(key: string): number | undefined {
  const match = rowKeyPattern.exec(key);
  return match ? Number(match[1]) : undefined;
}

/** Content hash standing in for a matrix row, so content-key order equals row order. */
export function rowContentHash(row: number): string {
  return String(row).padStart(12, "0");
}

/** Code-unit string order (never locale order): matches PostgreSQL's "C" collation. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface ContentKeyed {
  readonly key: ItemKey;
  readonly contentHash: string;
}

/** Content hash, then item key (D22). */
export function compareContentKeys(a: ContentKeyed, b: ContentKeyed): number {
  return compareStrings(a.contentHash, b.contentHash) || compareStrings(a.key, b.key);
}

const foldedLetters: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  ł: "l",
  đ: "d",
  ð: "d",
  þ: "th",
  ı: "i"
};

/**
 * I7 normalization: case- and accent-insensitive, whitespace-collapsed. It mirrors the database
 * backstop `f_unaccent(lower(title))` and is at least as strict, so a title the engine accepts is
 * never rejected by the unique index.
 */
export function normalizeTopicTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[ßæœøłđðþı]/gu, (letter) => foldedLetters[letter] ?? letter)
    .replace(/\s+/gu, " ")
    .trim();
}

export function sameTopicTitle(a: string, b: string): boolean {
  return normalizeTopicTitle(a) === normalizeTopicTitle(b);
}
