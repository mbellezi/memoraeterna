import { useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

import { cn } from "../../../lib/cn";
import { fitLabel, type Measure } from "./label-fit";

/**
 * A list label that never ends inside a word (design record 5.3): it is cut at word boundaries,
 * keeping its distinguishing end, and only the rows that are drawn are fitted (a virtualized tree
 * of 3,000 topics draws a window, so it fits a window). The widths of strings are measured once per
 * font and kept; the labels are fitted again when the row is resized, when the fonts finish
 * loading and when the theme changes. The full text stays in the row's accessible name and the
 * caller gives the tooltip. The CSS tail ellipsis is the last resort for a single long word.
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

export interface FittedLabelProps {
  text: string;
  className?: string;
}

export function FittedLabel({ text, className }: FittedLabelProps) {
  const box = useRef<HTMLSpanElement>(null);
  const stamp = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [shown, setShown] = useState(text);
  const [width, setWidth] = useState(0);

  // The width the row gives the label, followed without a timer.
  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return undefined;
    setWidth(node.clientWidth);
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      const next = Math.floor(entry?.contentRect.width ?? node.clientWidth);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    const node = box.current;
    if (!node) return;
    const { font, size } = fontOf(node);
    const fitted = fitLabel(text, measureFor(font, size), width);
    setShown((current) => (current === fitted.text ? current : fitted.text));
    // The epoch is read so a change of fonts or theme fits the label again.
  }, [text, width, stamp]);

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
