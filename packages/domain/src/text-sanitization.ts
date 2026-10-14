/**
 * Text that comes out of untrusted documents (PDF Info/XMP metadata, outline titles, converter
 * output) can carry code points that PostgreSQL text and jsonb values cannot store. U+0000 is the
 * one that aborts an insert; the other C0 controls are valid in storage but are never meaningful
 * in extracted titles, metadata or Markdown. Clean text is always returned unchanged (the same
 * string, or the same object for deep sanitizing), so content hashes of clean text never move.
 */

const MAX_DEPTH = 256;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;

/** C0 controls (U+0000..U+001F) other than tab, line feed and carriage return. */
export function isStrippedControlCode(code: number): boolean {
  return code < 0x20 && code !== TAB && code !== LINE_FEED && code !== CARRIAGE_RETURN;
}

/** UTF-16 indexes of the characters {@link stripControlCharacters} removes, in ascending order. */
export function findControlCharacterIndexes(value: string): number[] {
  const indexes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (isStrippedControlCode(value.charCodeAt(index))) indexes.push(index);
  }
  return indexes;
}

/** Removes U+0000 and the other C0 controls except tab, line feed and carriage return. */
export function stripControlCharacters(value: string): string {
  const indexes = findControlCharacterIndexes(value);
  if (indexes.length === 0) return value;
  let result = "";
  let cursor = 0;
  for (const index of indexes) {
    result += value.slice(cursor, index);
    cursor = index + 1;
  }
  return result + value.slice(cursor);
}

/** Removes only U+0000, the sole character PostgreSQL text and jsonb values reject. */
export function stripNulCharacters(value: string): string {
  return value.includes("\0") ? value.replaceAll("\0", "") : value;
}

/**
 * Persistence guard: returns the value with U+0000 removed from every string, array item, object
 * value and object key. Everything else, including every other character, is kept as is. Dates,
 * byte arrays and other non-plain objects pass through untouched, and an unchanged value is
 * returned as the same reference.
 */
export function sanitizeStoredValue<T>(value: T): T {
  return sanitizeDeep(value, stripNulCharacters, 0) as T;
}

/**
 * Extraction guard: like {@link sanitizeStoredValue} but also removes the other C0 controls
 * except tab, line feed and carriage return, for text read from PDFs and converters.
 */
export function sanitizeExtractedValue<T>(value: T): T {
  return sanitizeDeep(value, stripControlCharacters, 0) as T;
}

function sanitizeDeep(value: unknown, strip: (text: string) => string, depth: number): unknown {
  if (typeof value === "string") return strip(value);
  if (value === null || typeof value !== "object" || depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const original: unknown = value[index];
      const cleaned = sanitizeDeep(original, strip, depth + 1);
      if (cleaned !== original && !copy) copy = value.slice();
      if (copy) copy[index] = cleaned;
    }
    return copy ?? value;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return value;
  const entries = Object.entries(value as Record<string, unknown>);
  let changed = false;
  const cleanedEntries = entries.map(([key, original]) => {
    const cleanedKey = strip(key);
    const cleaned = sanitizeDeep(original, strip, depth + 1);
    if (cleanedKey !== key || cleaned !== original) changed = true;
    return [cleanedKey, cleaned] as const;
  });
  return changed ? Object.fromEntries(cleanedEntries) : value;
}
