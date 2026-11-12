/**
 * The label fitter of both icicles (design record §18): the Map's tree chart and the Inbox's
 * structural diff decide what a block says from the room it has, with one measuring function, so a
 * block never shows a bare number and a label is never cut inside a word. Pure over a `measure`
 * function (text in, pixels out), so the rules are tested without a browser.
 *
 * - The Map chart: a block shorter than 14 px has no label (its name is in the tooltip and is
 *   announced on focus); a taller one says its name and its count, or only its name when both do
 *   not fit. The person's own text (a topic name) may end in a tail ellipsis, the count never does.
 * - The Inbox diff: name and count, then name alone, then a letter key whose legend names the
 *   block and gives its count, then nothing for a sliver the table still lists.
 */

/** How wide a text is drawn, in px, in the font the label uses. */
export type MeasureText = (text: string) => number;

/** Rows shorter than this carry no label (design record §7.5). */
export const mapNoLabelBelow = 14;
/** Neighbouring blocks shorter than this merge into one "more" block. */
export const mapMergeBelow = 18;
/** A merged block is at least this tall. */
export const mapMergedMinHeight = 16;
/** A block at least this tall can put its count under its name. */
export const mapTwoLinesFrom = 34;

/** What a block of the Map chart shows. */
export type MapLabelForm = "none" | "name" | "nameCount" | "stacked";

/** Horizontal padding inside a block, both sides together. */
export const labelPadding = 16;

export function fitMapLabel(input: {
  widthPx: number;
  heightPx: number;
  name: string;
  count: string;
  measure: MeasureText;
}): MapLabelForm {
  const { widthPx, heightPx, name, count, measure } = input;
  if (heightPx < mapNoLabelBelow) return "none";
  const room = widthPx - labelPadding;
  if (room <= 0) return "none";
  // Tall enough for two lines: the count sits under the name and only has to fit by itself.
  if (heightPx >= mapTwoLinesFrom) return measure(count) <= room ? "stacked" : "name";
  return measure(`${name} ${count}`) <= room ? "nameCount" : "name";
}

/** What a block of the Inbox diff shows. */
export type DiffLabelForm = "nameCount" | "name" | "key" | "none";

/** The narrowest block that can hold a keyed circle. */
export const keyedMinWidth = 20;
/** The block's glyph and the gap after it, beside the name. */
export const glyphRoom = 20;

export function fitDiffLabel(input: {
  widthPx: number;
  name: string;
  count: string;
  measure: MeasureText;
}): DiffLabelForm {
  const { widthPx, name, count, measure } = input;
  const room = widthPx - labelPadding - glyphRoom;
  if (room > 0 && measure(name) <= room && measure(count) <= room) return "nameCount";
  if (room > 0 && measure(name) <= room) return "name";
  return widthPx >= keyedMinWidth ? "key" : "none";
}

/** The keys a legend uses, in order: a, b, … z. A block past the last one is not keyed. */
export const keyLetters = "abcdefghijklmnopqrstuvwxyz".split("");

/**
 * Gives a letter to each topic that needs one, in the order they are first asked for, so a topic
 * keeps its letter on both sides of the diff. A topic past the 26th gets none.
 */
export function createKeyAssigner(): (topicId: string) => string | null {
  const assigned = new Map<string, string>();
  return (topicId) => {
    const known = assigned.get(topicId);
    if (known !== undefined) return known;
    const next = keyLetters[assigned.size];
    if (next === undefined) return null;
    assigned.set(topicId, next);
    return next;
  };
}

/**
 * A measuring function over a canvas, in the font of the text it measures. Where there is no
 * canvas (a test, a server render) every character is 6.6 px, which is about Inter at 12 px.
 */
export function createMeasure(font: string): MeasureText {
  let context: { font: string; measureText: (text: string) => { width: number } } | null = null;
  if (typeof document !== "undefined") {
    try {
      context = document.createElement("canvas").getContext("2d");
    } catch {
      context = null;
    }
  }
  if (!context) return (text) => text.length * 6.6;
  context.font = font;
  const cache = new Map<string, number>();
  const canvas = context;
  return (text) => {
    const known = cache.get(text);
    if (known !== undefined) return known;
    const width = canvas.measureText(text).width;
    // jsdom's canvas has no text metrics: fall back to the estimate.
    const measured = width > 0 ? width : text.length * 6.6;
    cache.set(text, measured);
    return measured;
  };
}
