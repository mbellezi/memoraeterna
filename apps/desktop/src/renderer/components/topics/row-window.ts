import { useCallback, useState, useSyncExternalStore } from "react";
import { navRowHeight, viewportRows, type RowViewport } from "./topic-navigation";

/** What a list renders before it has been measured (and on the server): a screenful. */
const firstViewport: RowViewport = { first: 0, end: 40 };

/** The nearest ancestor that scrolls vertically: where the rows are scrolled into view. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
  }
  return null;
}

/**
 * Which rows of a tall list of fixed-height rows are scrolled into view. The list sits inside a
 * scrolling ancestor together with other content, so the position is measured against the list
 * itself, on scroll and whenever the ancestor, the list or the content around it changes size.
 * The snapshot changes only when the first or last row in view changes.
 */
export class RowWindow {
  private element: HTMLElement | null = null;
  private snapshot: RowViewport = firstViewport;
  private readonly listeners = new Set<() => void>();
  private unbind: (() => void) | null = null;

  /** A list that is not windowed still finds its rows here but measures nothing. */
  constructor(private readonly measured: boolean) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.bind();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.release();
    };
  };
  readonly getSnapshot = () => this.snapshot;
  readonly getServerSnapshot = () => firstViewport;

  /** The ref of the list element. */
  readonly attach = (element: HTMLElement | null) => {
    this.release();
    this.element = element;
    this.bind();
  };

  /** The drawn row with this key, if any. */
  find(key: string): HTMLElement | null {
    const rows = this.element?.querySelectorAll<HTMLElement>("[data-nav-key]");
    return Array.from(rows ?? []).find((row) => row.dataset.navKey === key) ?? null;
  }

  /** Scrolls so the row is in view, with some context around it; nothing moves if it already is. */
  scrollToRow(index: number) {
    const element = this.element;
    const scroller = element ? scrollParent(element) : null;
    if (!element || !scroller) return;
    const listTop =
      element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top +
      scroller.scrollTop;
    const rowTop = listTop + index * navRowHeight;
    const margin = navRowHeight * 2;
    if (rowTop < scroller.scrollTop + margin) scroller.scrollTop = Math.max(0, rowTop - margin);
    else if (rowTop + navRowHeight > scroller.scrollTop + scroller.clientHeight - margin) {
      scroller.scrollTop = rowTop + navRowHeight + margin - scroller.clientHeight;
    }
  }

  private bind() {
    const element = this.element;
    if (!this.measured || this.unbind || !element || this.listeners.size === 0) return;
    const scroller = scrollParent(element);
    if (!scroller) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = scroller.getBoundingClientRect().top - element.getBoundingClientRect().top;
      const next = viewportRows(top, scroller.clientHeight, Number.MAX_SAFE_INTEGER);
      if (next.first === this.snapshot.first && next.end === this.snapshot.end) return;
      this.snapshot = next;
      for (const listener of [...this.listeners]) listener();
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(measure);
    };
    scroller.addEventListener("scroll", schedule, { passive: true });
    const observer = new ResizeObserver(schedule);
    observer.observe(scroller);
    observer.observe(element);
    // The content around the list (status lines, Pinned, Recents) moves it without a scroll.
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    measure();
    this.unbind = () => {
      scroller.removeEventListener("scroll", schedule);
      observer.disconnect();
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }

  private release() {
    this.unbind?.();
    this.unbind = null;
  }
}

/** The window of a list: the rows in view, the object that scrolls to a row, and the list's ref. */
export function useRowWindow(measured: boolean): {
  rows: RowWindow;
  viewport: RowViewport;
  attach: (element: HTMLElement | null) => void;
} {
  const [rows] = useState(() => new RowWindow(measured));
  const viewport = useSyncExternalStore(rows.subscribe, rows.getSnapshot, rows.getServerSnapshot);
  const attach = useCallback((element: HTMLElement | null) => rows.attach(element), [rows]);
  return { rows, viewport, attach };
}
