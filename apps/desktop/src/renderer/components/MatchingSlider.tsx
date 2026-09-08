import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";

const adjustmentKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

export function MatchingSlider({ id, label, value, defaultValue, resetLabel, onCommit }: {
  id: string;
  label: string;
  value: number;
  defaultValue: number;
  resetLabel: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = useRef(false);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dirty.current) setDraft(value);
  }, [value]);

  function commit(next: number) {
    if (!dirty.current) return;
    dirty.current = false;
    if (next !== value) onCommit(next);
  }

  function cancel() {
    dragging.current = false;
    dirty.current = false;
    setDraft(value);
  }

  return <div className="grid gap-2">
    <label htmlFor={id} className="text-sm font-medium">{label}</label>
    <div className="flex items-center justify-end gap-3">
      <output htmlFor={id} className="font-bold tabular-nums text-amber-700 dark:text-amber-300">{draft.toFixed(2)}</output>
      <button type="button" title={resetLabel} aria-label={`${label}: ${resetLabel}`}
        className="rounded-md p-1.5 text-slate-500 hover:bg-slate-100 focus-visible:outline-2 dark:hover:bg-slate-800"
        onClick={() => {
          dirty.current = false;
          setDraft(defaultValue);
          if (value !== defaultValue) onCommit(defaultValue);
        }}>
        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </div>
    <input id={id} type="range" min={0} max={1} step={0.01} value={draft}
      aria-label={label} className="w-full accent-amber-600"
      onChange={(event) => { dirty.current = true; setDraft(Number(event.currentTarget.value)); }}
      onPointerDown={(event) => {
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        dragging.current = false;
        commit(Number(event.currentTarget.value));
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={() => { if (dragging.current) cancel(); }}
      onKeyUp={(event) => { if (adjustmentKeys.has(event.key)) commit(Number(event.currentTarget.value)); }}
      onBlur={(event) => { if (dragging.current) cancel(); else commit(Number(event.currentTarget.value)); }}
    />
  </div>;
}
