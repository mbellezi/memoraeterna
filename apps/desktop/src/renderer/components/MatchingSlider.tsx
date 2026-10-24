import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import { CalibratedValue } from "./settings/CalibratedValue";

const adjustmentKeys = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown"
]);

export function MatchingSlider({
  id,
  label,
  value,
  defaultValue,
  resetLabel,
  calibratedText,
  onCommit
}: {
  id: string;
  label: string;
  value: number;
  defaultValue: number;
  resetLabel: string;
  /** "Calibrated: 0.92", set while the value is not the calibrated one (F4 Q4): text, not colour. */
  calibratedText?: string | undefined;
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

  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="flex items-center justify-end gap-3">
        <output htmlFor={id} className="font-bold tabular-nums text-foreground">
          {draft.toFixed(2)}
        </output>
        <button
          type="button"
          title={resetLabel}
          aria-label={`${label}: ${resetLabel}`}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-soft focus-visible:outline-2 focus-visible:outline-accent"
          onClick={() => {
            dirty.current = false;
            setDraft(defaultValue);
            if (value !== defaultValue) onCommit(defaultValue);
          }}
        >
          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>
      <input
        id={id}
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={draft}
        aria-label={label}
        className="w-full accent-accent"
        onChange={(event) => {
          dirty.current = true;
          setDraft(Number(event.currentTarget.value));
        }}
        onPointerDown={(event) => {
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          commit(Number(event.currentTarget.value));
        }}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (dragging.current) cancel();
        }}
        onKeyUp={(event) => {
          if (adjustmentKeys.has(event.key)) commit(Number(event.currentTarget.value));
        }}
        onBlur={(event) => {
          if (dragging.current) cancel();
          else commit(Number(event.currentTarget.value));
        }}
      />
      {calibratedText ? <CalibratedValue text={calibratedText} /> : null}
    </div>
  );
}
