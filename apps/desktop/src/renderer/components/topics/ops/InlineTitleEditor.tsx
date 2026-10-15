import { useEffect, useRef, useState } from "react";

import { cn } from "../../../lib/cn";

export interface InlineTitleEditorProps {
  /** The name being edited; it starts selected. */
  initial: string;
  /** What a screen reader calls the field. */
  label: string;
  /** The element that explains a refusal, when one is shown. */
  describedBy?: string | undefined;
  invalid?: boolean;
  busy?: boolean;
  lang?: string | undefined;
  className?: string;
  /** Enter, or leaving the field with a changed name. */
  onCommit: (value: string) => void;
  /** Escape, or leaving the field unchanged. */
  onCancel: () => void;
}

/**
 * A name edited where it is shown (a navigator row, the heading of a Topic page). Enter saves,
 * Escape cancels, and leaving the field saves a changed name and drops an unchanged one. Keys stay
 * here: a tree's arrow keys and a row's Enter must not act on a field being typed in.
 */
export function InlineTitleEditor({
  initial,
  label,
  describedBy,
  invalid = false,
  busy = false,
  lang,
  className,
  onCommit,
  onCancel
}: InlineTitleEditorProps) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // Enter and Escape already decided; the blur that follows them must not decide again.
  const decided = useRef(false);

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    ref.current?.select();
  }, []);

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      lang={lang}
      aria-label={label}
      aria-describedby={describedBy}
      aria-invalid={invalid || undefined}
      readOnly={busy}
      spellCheck={false}
      autoComplete="off"
      className={cn(
        "h-6 min-w-0 flex-1 rounded-sm border bg-surface px-1.5 text-sm text-foreground outline-none focus:border-accent focus:ring-2 focus:ring-accent/15",
        invalid ? "border-danger" : "border-border-strong",
        className
      )}
      onChange={(event) => {
        decided.current = false;
        setValue(event.target.value);
      }}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          decided.current = true;
          onCommit(value);
        } else if (event.key === "Escape") {
          event.preventDefault();
          decided.current = true;
          onCancel();
        }
      }}
      onBlur={() => {
        // Switching to another window is not a decision.
        if (decided.current || busy || !document.hasFocus()) return;
        decided.current = true;
        if (value.trim() === initial.trim()) onCancel();
        else onCommit(value);
      }}
    />
  );
}
