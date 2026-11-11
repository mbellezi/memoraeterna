import { useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";

/** Half a pixel of rounding is not an overflow. */
const slack = 0.5;

/** The level after one look: the next one down while the content is wider than the room, else the same. */
export function stepLevel(input: {
  level: number;
  levels: number;
  contentWidth: number;
  roomWidth: number;
}): number {
  const { level, levels, contentWidth, roomWidth } = input;
  return level < levels - 1 && contentWidth > roomWidth + slack ? level + 1 : level;
}

/**
 * Which of a label's forms a box can hold, fullest first (level 0). A label that does not fit
 * drops a whole clause or shortens to a shorter form; it is never cut in the middle of a word
 * (design record §5.3, gate D's orchestrator review). The box is the room (`box`, an element whose
 * width does not depend on its content) and the content is what is drawn in it (`content`, laid out
 * at its natural width); both are callback refs. Whenever either changes size the hook starts again
 * at `minLevel` and steps to the next level while the content is wider than the room, inside the
 * observer's callback and before the browser paints. A change of `key` (the labels' text) starts
 * again too. There is no timer. Where nothing has a width (jsdom) every label fits and the level
 * stays at `minLevel`.
 */
export function useOverflowLevel<B extends HTMLElement, C extends HTMLElement>(
  levels: number,
  key: string,
  minLevel = 0
): { box: (node: B | null) => void; content: (node: C | null) => void; level: number } {
  const [state, setState] = useState({ level: minLevel, key, minLevel });
  let current = state;
  if (state.key !== key || state.minLevel !== minLevel) {
    // The labels or the floor changed: start again from the fullest form that is allowed.
    current = { level: minLevel, key, minLevel };
    setState(current);
  }
  const [room, setRoom] = useState<B | null>(null);
  const [drawn, setDrawn] = useState<C | null>(null);

  useLayoutEffect(() => {
    if (!room || !drawn || typeof ResizeObserver === "undefined") return undefined;
    const settle = () => {
      let at = minLevel;
      flushSync(() => setState({ level: at, key, minLevel }));
      for (let guard = 0; guard < levels; guard += 1) {
        const next = stepLevel({
          level: at,
          levels,
          contentWidth: drawn.getBoundingClientRect().width,
          roomWidth: room.clientWidth
        });
        if (next === at) break;
        at = next;
        flushSync(() => setState({ level: at, key, minLevel }));
      }
    };
    const observer = new ResizeObserver(settle);
    observer.observe(room);
    return () => observer.disconnect();
  }, [room, drawn, key, minLevel, levels]);

  return { box: setRoom, content: setDrawn, level: current.level };
}
