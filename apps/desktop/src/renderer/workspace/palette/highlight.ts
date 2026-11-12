/**
 * Where a query's words are in a text, for Cmd-K and the search results panel (design record §11:
 * matches are marked wherever they occur, in the title, the path crumbs and the snippet, with an
 * underline and weight, never a colour). Pure.
 *
 * Matching ignores case and accents ("fermentacao" marks "Fermentação"). A word of one or two
 * letters marks only where a word begins, so "do" does not light up the middle of "estudo"; a longer
 * word marks wherever it occurs, because the trigram arm matches inside words too.
 */

/** The text without accents and in lower case, with where each folded character came from. */
function fold(text: string): { folded: string; origin: number[] } {
  let folded = "";
  const origin: number[] = [];
  let index = 0;
  for (const character of text) {
    const plain = character.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    for (let at = 0; at < plain.length; at += 1) origin.push(index);
    folded += plain;
    index += character.length;
  }
  return { folded, origin };
}

/** The text without accents and in lower case. */
export function foldText(text: string): string {
  return fold(text).folded;
}

/** The words of a query, folded, longest first, each once. */
export function queryTerms(query: string): string[] {
  const words = fold(query)
    .folded.split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
  return [...new Set(words)].sort((a, b) => b.length - a.length);
}

const isLetter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}]/u.test(character);

/** The `[start, end)` ranges of `text` the terms match, in order, never overlapping. */
export function markRanges(text: string, terms: readonly string[]): Array<[number, number]> {
  if (text === "" || terms.length === 0) return [];
  const { folded, origin } = fold(text);
  const found: Array<[number, number]> = [];
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(term, from);
      if (at === -1) break;
      from = at + 1;
      if (term.length < 3 && isLetter(folded[at - 1])) continue;
      const start = origin[at] ?? 0;
      const last = origin[at + term.length - 1] ?? start;
      // The end is the end of the original character the last folded character came from.
      const end = last + (String.fromCodePoint(text.codePointAt(last) ?? 32).length || 1);
      found.push([start, end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Array<[number, number]> = [];
  for (const range of found) {
    const previous = merged[merged.length - 1];
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([range[0], range[1]]);
  }
  return merged;
}

/** A text cut at its marks: `{ text, marked }` pieces whose texts join back into the original. */
export function markPieces(
  text: string,
  terms: readonly string[]
): Array<{ text: string; marked: boolean }> {
  const ranges = markRanges(text, terms);
  if (ranges.length === 0) return [{ text, marked: false }];
  const pieces: Array<{ text: string; marked: boolean }> = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start > cursor) pieces.push({ text: text.slice(cursor, start), marked: false });
    pieces.push({ text: text.slice(start, end), marked: true });
    cursor = end;
  }
  if (cursor < text.length) pieces.push({ text: text.slice(cursor), marked: false });
  return pieces;
}

/** Whether any term matches the text. */
export function matchesAny(text: string, terms: readonly string[]): boolean {
  return markRanges(text, terms).length > 0;
}
