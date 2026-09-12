import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { GripVertical } from "lucide-react";
import type { Translator } from "@app/i18n";

export const wikiTreeLimits = { min: 240, max: 520, default: 320, reading: 360, divider: 16 };
export function wikiTreeBounds(available: number) {
  const max = Math.max(0, Math.min(wikiTreeLimits.max, available - wikiTreeLimits.reading - wikiTreeLimits.divider));
  return { min: Math.min(wikiTreeLimits.min, max), max };
}
export function clampWikiTreeWidth(width: number, available: number) {
  const { min, max } = wikiTreeBounds(available);
  return Math.round(Math.max(min, Math.min(max, Number.isFinite(width) ? width : wikiTreeLimits.default)));
}
export function wikiTreeKeyboardWidth(key: string, width: number, available: number, shift = false) {
  const { min, max } = wikiTreeBounds(available);
  const step = shift ? 40 : 16;
  const next = key === "ArrowLeft" ? width - step : key === "ArrowRight" ? width + step : key === "Home" ? min : key === "End" ? max : undefined;
  return next === undefined ? undefined : clampWikiTreeWidth(next, available);
}

export function WikiNavigationPane({ children, width = wikiTreeLimits.default, onWidthChange, t }: {
  children: ReactNode;
  width?: number | undefined;
  onWidthChange?: ((width: number) => void) | undefined;
  t: Translator;
}) {
  const nav = useRef<HTMLElement>(null);
  const id = useId();
  const [available, setAvailable] = useState(1200);
  const [draft, setDraft] = useState<number | null>(null);
  const drag = useRef<{ pointerId: number; startX: number; startWidth: number; width: number } | null>(null);
  useEffect(() => {
    const parent = nav.current?.parentElement;
    if (!parent) return;
    const measure = () => { if (parent.clientWidth > 0) setAvailable(parent.clientWidth); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  const bounds = wikiTreeBounds(available);
  const actual = clampWikiTreeWidth(draft ?? width, available);
  const commit = (value: number) => {
    // Viewport constraints are temporary; only user gestures replace the preference.
    const next = Math.max(wikiTreeLimits.min, Math.min(wikiTreeLimits.max, Math.round(value)));
    onWidthChange?.(next);
    setDraft(onWidthChange ? null : next);
  };
  const cancel = () => { drag.current = null; setDraft(null); };
  return <>
    <nav ref={nav} id={id} aria-label={t("wiki.navigation")} style={{ width: actual }} className="min-h-0 shrink-0 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg bg-surface/50 p-1">
      {children}
    </nav>
    <div role="separator" tabIndex={0} aria-orientation="vertical" aria-controls={id}
      aria-label={t("wiki.resizeTree")} aria-valuemin={Math.round(bounds.min)} aria-valuemax={Math.round(bounds.max)} aria-valuenow={actual}
      aria-valuetext={t("wiki.treeWidth", { values: { width: actual } })} title={t("wiki.resizeTreeHint")}
      className="group flex w-4 shrink-0 touch-none cursor-col-resize select-none items-center justify-center rounded focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
      onKeyDown={event => {
        if (event.key === "Escape" && drag.current) { event.preventDefault(); event.stopPropagation(); cancel(); return; }
        const next = wikiTreeKeyboardWidth(event.key, actual, available, event.shiftKey);
        if (next === undefined) return;
        event.preventDefault(); commit(next);
      }}
      onPointerDown={event => {
        if (event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startX: event.clientX, startWidth: actual, width: actual };
        setDraft(actual);
      }}
      onPointerMove={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const next = clampWikiTreeWidth(drag.current.startWidth + event.clientX - drag.current.startX, available);
        drag.current.width = next; setDraft(next);
      }}
      onPointerUp={event => {
        if (drag.current?.pointerId !== event.pointerId) return;
        const next = drag.current.width; drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId); commit(next);
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (drag.current) cancel(); }}
      onDoubleClick={() => commit(wikiTreeLimits.default)}>
      <div className="flex h-full w-px items-center justify-center bg-border group-hover:bg-accent group-focus-visible:bg-accent">
        <GripVertical aria-hidden="true" className="h-7 w-3 shrink-0 rounded bg-surface text-muted-foreground group-hover:text-accent" />
      </div>
    </div>
  </>;
}
