/**
 * Fitting a label into a width without cutting a word (design record 5.3, 20.1 row 34). Pure: the
 * caller measures text, so the rules are tested without a browser. The same rule serves every list
 * label of the app (the navigator, Pinned and Recents, the Library, Cmd-K, the Inbox):
 *
 * - a label that fits is shown whole;
 * - otherwise it is cut only at word boundaries, keeping the distinguishing end: whole head words,
 *   an ellipsis, then whole tail words ("Microbiologia…cap. 3", "Temperatura…final");
 * - when not even one head word fits beside the tail, a leading ellipsis keeps the tail words
 *   ("…alcoólica");
 * - only when the last word alone does not fit is it cut at its end with an ellipsis, the last
 *   resort (the caller's CSS tail ellipsis).
 *
 * A row that must show its name (the open row, its ancestors, a tentative row) wraps instead
 * (`fitLines`): at most N lines, the last one ended after its last whole word.
 */

/** Width of a string in px, as drawn. */
export type Measure = (text: string) => number;

export const ellipsis = "…";

const words = (text: string): string[] => text.trim().split(/\s+/u).filter(Boolean);

/** A tail word too short to tell labels apart ("3", "II", "p.") takes the word before it along. */
const thinWord = (word: string): boolean => word.replace(/[^\p{L}\p{N}]/gu, "").length < 3;

export interface FittedLabel {
  /** What to draw. */
  text: string;
  /** Whether words were left out. */
  cut: boolean;
}

/**
 * The label in `width` px. `measure` must measure with the font the label is drawn in. A width that
 * is not known yet (0 or less) leaves the label whole, so a row that is not laid out is not cut.
 */
export function fitLabel(label: string, measure: Measure, width: number): FittedLabel {
  const whole = words(label).join(" ");
  if (width <= 0 || whole === "" || measure(whole) <= width) return { text: whole, cut: false };
  const parts = words(whole);
  // One word that does not fit: the end is cut by the caller's own ellipsis.
  if (parts.length === 1) return { text: whole, cut: true };

  let tailCount = 1;
  while (tailCount < parts.length - 1 && thinWord(parts[parts.length - tailCount] ?? ""))
    tailCount += 1;
  const tail = parts.slice(parts.length - tailCount).join(" ");

  // Whole head words, as many as fit beside the ellipsis and the tail.
  const headRoom = parts.length - tailCount;
  for (let head = headRoom; head >= 1; head -= 1) {
    const text = `${parts.slice(0, head).join(" ")}${ellipsis}${tail}`;
    if (measure(text) <= width) return { text, cut: true };
  }
  // No head word fits beside the tail: the tail alone, with a leading ellipsis, then fewer tail
  // words, as long as what is left still tells the label apart (a lone "on" or "3" does not).
  for (let count = tailCount; count >= 1; count -= 1) {
    const kept = parts.slice(parts.length - count);
    if (count === 1 && thinWord(kept[0] ?? "") && parts.length > 1) break;
    const text = `${ellipsis}${kept.join(" ")}`;
    if (measure(text) <= width) return { text, cut: true };
  }
  // The tail is too long, or too thin to stand alone: the head words that fit, then an ellipsis.
  for (let head = parts.length - 1; head >= 1; head -= 1) {
    const text = `${parts.slice(0, head).join(" ")}${ellipsis}`;
    if (measure(text) <= width) return { text, cut: true };
  }
  // Not even the first word: it keeps its start, and the caller's ellipsis cuts it.
  return { text: whole, cut: true };
}

/**
 * The label in at most `maxLines` lines of `width` px, broken greedily at spaces. When it needs
 * more lines, the last line ends after its last whole word that fits beside an ellipsis. A word
 * longer than a line sits on its own line and is left to the caller's overflow rule.
 */
export function fitLines(
  label: string,
  measure: Measure,
  width: number,
  maxLines: number
): { lines: string[]; cut: boolean } {
  const parts = words(label);
  if (width <= 0 || parts.length === 0 || maxLines < 1)
    return { lines: [parts.join(" ")], cut: false };
  const lines: string[] = [];
  let line = "";
  let used = 0;
  for (const part of parts) {
    const next = line === "" ? part : `${line} ${part}`;
    if (line === "" || measure(next) <= width) {
      line = next;
      used += 1;
      continue;
    }
    lines.push(line);
    line = part;
    used += 1;
    if (lines.length === maxLines) {
      // The line that would be the next one was started by the word just placed.
      used -= 1;
      line = "";
      break;
    }
  }
  if (line !== "") lines.push(line);
  if (lines.length <= maxLines && used === parts.length) return { lines, cut: false };
  // Too long: the last allowed line gives up words until it fits with the ellipsis.
  const kept = lines.slice(0, maxLines);
  let last = words(kept[kept.length - 1] ?? "");
  while (last.length > 1 && measure(`${last.join(" ")}${ellipsis}`) > width)
    last = last.slice(0, -1);
  kept[kept.length - 1] = `${last.join(" ")}${ellipsis}`;
  return { lines: kept, cut: true };
}
