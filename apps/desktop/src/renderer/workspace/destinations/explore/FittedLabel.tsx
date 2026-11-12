import { useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from "react";

import { cn } from "../../../lib/cn";
import { fitBesideCount, fitLabel, fitLines, type Measure } from "./label-fit";

/**
 * A list label that never ends inside a word (design record 5.3): it is cut at word boundaries,
 * keeping its distinguishing end, and only the rows that are drawn are fitted (a virtualized tree
 * of 3,000 topics draws a window, so it fits a window). The widths of strings are measured once per
 * font and kept; the labels are fitted again when the row is resized, when the fonts finish
 * loading and when the theme changes. The full text stays in the row's accessible name and the
 * caller gives the tooltip. The CSS tail ellipsis is the last resort for a single long word. A row
 * that must show its name (the open row and its ancestors) uses {@link WrappedLabel}: whole words
 * on at most two lines.
 */

// ---------------------------------------------------------------------------
// One epoch for the page: fonts loaded, theme changed. Labels fit again when it moves.

let epoch = 0;
const listeners = new Set<() => void>();
const widths = new Map<string, number>();
let stopObserving: (() => void) | null = null;

function bump(): void {
  epoch += 1;
  widths.clear();
  for (const listener of [...listeners]) listener();
}

function observe(): () => void {
  const fonts = typeof document === "undefined" ? undefined : document.fonts;
  const onLoaded = () => bump();
  fonts?.addEventListener("loadingdone", onLoaded);
  void fonts?.ready.then(onLoaded);
  const themes =
    typeof MutationObserver === "undefined" || typeof document === "undefined"
      ? null
      : new MutationObserver(onLoaded);
  themes?.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "data-theme", "lang"]
  });
  return () => {
    fonts?.removeEventListener("loadingdone", onLoaded);
    themes?.disconnect();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stopObserving ??= observe();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopObserving?.();
      stopObserving = null;
    }
  };
}
const snapshot = () => epoch;

/** Counts how many strings were measured, for the test of the 3,000-topic window. */
export const labelFitStats = { measured: 0 };

let canvas: CanvasRenderingContext2D | null | undefined;
function context(): CanvasRenderingContext2D | null {
  if (canvas !== undefined) return canvas;
  try {
    canvas =
      typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d");
  } catch {
    canvas = null;
  }
  return canvas;
}

/** A measure that asks `raw` once per string, however many labels share it. */
export function cachedMeasure(raw: Measure): Measure {
  const known = new Map<string, number>();
  return (text) => {
    let width = known.get(text);
    if (width === undefined) {
      width = raw(text);
      known.set(text, width);
    }
    return width;
  };
}

/** A measure for one font: the canvas's, or an average glyph width where there is no canvas. */
function measureFor(font: string, size: number): Measure {
  return (text) => {
    const key = `${font}\u0000${text}`;
    const known = widths.get(key);
    if (known !== undefined) return known;
    labelFitStats.measured += 1;
    const ctx = context();
    let width: number;
    if (ctx) {
      ctx.font = font;
      width = ctx.measureText(text).width;
    } else width = [...text].length * size * 0.55;
    widths.set(key, width);
    return width;
  };
}

function fontOf(node: Element): { font: string; size: number } {
  const style = getComputedStyle(node);
  const size = Number.parseFloat(style.fontSize) || 13;
  return {
    font: `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`,
    size
  };
}

/** The label fitted into `width` for a font; the strings it measures are counted in the stats. */
export function fitInto(text: string, font: string, size: number, width: number) {
  return fitLabel(text, measureFor(font, size), width);
}

/** The label fitted into `width` beside a count that is dropped before any word is cut. */
export function fitBeside(
  text: string,
  font: string,
  size: number,
  width: number,
  countRoom: number
) {
  return fitBesideCount(text, measureFor(font, size), width, countRoom);
}

/** The label wrapped into at most `maxLines` lines of `width` for a font. */
export function wrapInto(
  text: string,
  font: string,
  size: number,
  width: number,
  maxLines: number
) {
  return fitLines(text, measureFor(font, size), width, maxLines);
}

/** The width a box gives its text, followed without a timer. */
function useBoxWidth(box: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = box.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    // The observer reports the width when it starts to watch, and on every resize after it.
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry?.contentRect.width ?? node.clientWidth);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [box]);
  return width;
}

export interface FittedLabelProps {
  text: string;
  className?: string;
  /**
   * The row's count sits beside the label and takes this many px; when the label does not fit beside
   * it, the count is dropped first (told through `onDropCount`) before any word is cut.
   */
  countRoom?: number;
  onDropCount?: ((dropped: boolean) => void) | undefined;
}

export function FittedLabel({ text, className, countRoom = 0, onDropCount }: FittedLabelProps) {
  const box = useRef<HTMLSpanElement>(null);
  const stamp = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [shown, setShown] = useState(text);
  const [dropped, setDropped] = useState(false);
  const width = useBoxWidth(box);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const { font, size } = fontOf(node);
    // The width beside the count, whether or not the count is in the flow just now.
    const beside = dropped ? width - countRoom : width;
    const fitted = fitBeside(text, font, size, beside, countRoom);
    setShown((current) => (current === fitted.text ? current : fitted.text));
    setDropped(fitted.countDropped);
    // The epoch is read so a change of fonts or theme fits the label again.
  }, [text, width, stamp, countRoom, dropped]);

  useLayoutEffect(() => {
    onDropCount?.(dropped);
  }, [dropped, onDropCount]);

  return (
    <span
      ref={box}
      data-fit-label=""
      className={cn("min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap", className)}
    >
      <span aria-hidden="true">{shown}</span>
      <span className="sr-only">{text}</span>
    </span>
  );
}

export interface WrappedLabelProps {
  text: string;
  className?: string;
  /** Lines at most; the last one ends after its last whole word when the text needs more. */
  maxLines?: number;
  /** Told how many lines are drawn, so the row can be as tall as its name. */
  onLines?: ((lines: number) => void) | undefined;
}

/**
 * A label that is never cut by its width: whole words on at most `maxLines` lines (the open row of
 * the navigator and its ancestors, which must show their name). A word longer than a line sits on
 * a line of its own and is cut by that line's tail ellipsis, the last resort.
 */
export function WrappedLabel({ text, className, maxLines = 2, onLines }: WrappedLabelProps) {
  const box = useRef<HTMLSpanElement>(null);
  const stamp = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [lines, setLines] = useState<readonly string[]>([text]);
  const width = useBoxWidth(box);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const { font, size } = fontOf(node);
    const wrapped = wrapInto(text, font, size, width, maxLines).lines;
    setLines((current) =>
      current.length === wrapped.length && current.every((line, at) => line === wrapped[at])
        ? current
        : wrapped
    );
  }, [text, width, stamp, maxLines]);

  useLayoutEffect(() => {
    onLines?.(lines.length);
  }, [lines, onLines]);

  return (
    <span
      ref={box}
      data-wrap-label=""
      className={cn("min-w-0 flex-1 overflow-hidden leading-5", className)}
    >
      <span aria-hidden="true">
        {lines.map((line, at) => (
          <span key={at} className="block overflow-hidden text-ellipsis whitespace-nowrap">
            {line}
          </span>
        ))}
      </span>
      <span className="sr-only">{text}</span>
    </span>
  );
}
