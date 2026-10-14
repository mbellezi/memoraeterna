/**
 * Orders that reach a model prompt must be a function of the content, never of database IDs: every
 * import mints new UUIDs, so an ID tie-break makes identical content produce different prompts.
 * Locale-independent on purpose, so the result is the same on every machine.
 */
export function compareContent(left: string | undefined, right: string | undefined): number {
  const a = left ?? "";
  const b = right ?? "";
  return a === b ? 0 : a < b ? -1 : 1;
}

/** A content key for a note-like item: the fields a reader sees, joined by an unlikely separator. */
export function contentKey(...parts: ReadonlyArray<string | null | undefined>): string {
  return parts.map((part) => part ?? "").join("\u0000");
}
