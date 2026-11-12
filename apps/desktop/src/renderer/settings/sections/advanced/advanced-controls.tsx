import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "../../../lib/cn";
import { clampValue, formatValue, parseNumber, type MatchingControlSpec } from "./matching-model";

/**
 * The controls Advanced and Diagnostics put at the right of a row: a switch for a yes or no, a
 * select for a choice, a number field for a quantity and a slider for a speed. Each keeps what it
 * shows until the saved value moves, so a control never flickers back while a save is on its way.
 */

const fieldBox =
  "h-8 rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground outline-none transition-colors " +
  "hover:bg-surface-hover focus-visible:border-accent focus-visible:outline-2 focus-visible:outline-offset-1 " +
  "focus-visible:outline-accent disabled:cursor-not-allowed disabled:border-border disabled:bg-soft disabled:text-muted-foreground";

/** A switch: a button with `role="switch"`, named by the setting's label. */
export function SettingSwitch({
  label,
  checked,
  onChange,
  disabled = false,
  id
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border-0 p-0 transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed",
        checked
          ? "bg-accent disabled:opacity-60"
          : "bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)] disabled:[box-shadow:inset_0_0_0_1px_var(--border-subtle)]"
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[3px] size-3.5 rounded-full transition-[left]",
          checked ? "left-[19px] bg-accent-foreground" : "left-[3px] bg-border-strong"
        )}
      />
    </button>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/** A native select with the app's box and chevron; the arrows move the choice as the system does. */
export function SettingSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  id,
  width = "15rem"
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
  /** The field's width; a long choice does not stretch the row. */
  width?: string;
}) {
  return (
    <span className="relative inline-flex max-w-full items-center" style={{ width }}>
      <select
        id={id}
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        className={cn(fieldBox, "w-full cursor-pointer appearance-none truncate pr-8")}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 size-3.5 text-secondary-foreground"
      />
    </span>
  );
}

/**
 * A quantity typed as text (a comma or a dot for the decimals): committed on Enter or on leaving,
 * Escape gives the saved value back, the arrows add or take a step. It is clamped to the limits.
 */
export function NumberField({
  id,
  label,
  value,
  control,
  locale,
  onCommit,
  disabled = false,
  suffix
}: {
  id: string;
  label: string;
  value: number;
  control: Pick<MatchingControlSpec, "kind" | "min" | "max" | "step">;
  locale: string;
  onCommit: (next: number) => void;
  disabled?: boolean;
  suffix?: ReactNode;
}) {
  const spec = control as MatchingControlSpec;
  const [draft, setDraft] = useState(() => formatValue(control, value, locale));
  // A saved or restored value replaces the text being edited.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(formatValue(control, value, locale));
  }
  const commit = (text: string) => {
    const parsed = parseNumber(text, locale);
    const next = parsed === null ? value : clampValue(spec, parsed);
    setDraft(formatValue(control, next, locale));
    if (next !== value) onCommit(next);
  };
  const nudge = (direction: 1 | -1) => {
    const base = parseNumber(draft, locale) ?? value;
    const next = clampValue(spec, Math.round((base + direction * control.step) * 100) / 100);
    setDraft(formatValue(control, next, locale));
    if (next !== value) onCommit(next);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      setDraft(formatValue(control, value, locale));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      nudge(event.key === "ArrowUp" ? 1 : -1);
    }
  };
  return (
    <span className="inline-flex items-center gap-2">
      <input
        id={id}
        role="spinbutton"
        inputMode={control.kind === "decimal" ? "decimal" : "numeric"}
        aria-label={label}
        aria-valuemin={control.min}
        aria-valuemax={control.max}
        aria-valuenow={value}
        disabled={disabled}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={onKeyDown}
        className={cn(fieldBox, "w-28 text-right tabular-nums")}
      />
      {suffix ? <span className="text-sm text-secondary-foreground">{suffix}</span> : null}
    </span>
  );
}

/** A slider whose value is saved when the person lets go (or leaves it), never at every tick. */
export function SettingRange({
  label,
  value,
  min,
  max,
  step,
  format,
  onCommit,
  disabled = false
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onCommit: (next: number) => void;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const done = (at: number) => {
    if (at !== value) onCommit(at);
  };
  const id = useId();
  return (
    <span className="inline-flex items-center gap-3">
      <input
        id={id}
        type="range"
        aria-label={label}
        aria-valuetext={format(draft)}
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(Number(event.target.value))}
        onPointerUp={(event) => done(Number(event.currentTarget.value))}
        onKeyUp={(event) => done(Number(event.currentTarget.value))}
        onBlur={(event) => done(Number(event.currentTarget.value))}
        className="h-5 w-36 cursor-pointer accent-[var(--accent)] disabled:cursor-not-allowed"
      />
      <output
        htmlFor={id}
        className="w-10 text-right text-sm tabular-nums text-secondary-foreground"
      >
        {format(draft)}
      </output>
    </span>
  );
}

/**
 * A text field saved on Enter or on leaving; Escape gives the saved text back. `valid` says whether
 * the text may be saved, and an invalid text stays in the field with `aria-invalid`.
 */
export function TextField({
  id,
  label,
  value,
  onCommit,
  valid,
  disabled = false,
  width = "13rem"
}: {
  id?: string;
  label: string;
  value: string;
  onCommit: (next: string) => void;
  valid: (text: string) => boolean;
  disabled?: boolean;
  width?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(value);
  }
  const ok = valid(draft);
  const commit = () => {
    const next = draft.trim();
    if (!valid(draft)) return;
    setDraft(next);
    if (next !== value) onCommit(next);
  };
  return (
    <input
      id={id}
      type="text"
      aria-label={label}
      aria-invalid={ok ? undefined : true}
      disabled={disabled}
      value={draft}
      spellCheck={false}
      style={{ width }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        } else if (event.key === "Escape") {
          event.preventDefault();
          setDraft(value);
        }
      }}
      className={cn(
        fieldBox,
        "max-w-full",
        ok ? "" : "border-danger focus-visible:border-danger focus-visible:outline-danger"
      )}
    />
  );
}

/**
 * The value a control shows while a save is on its way: it takes the person's choice at once and
 * lets go of it when the saved value reaches it or the save fails. Returns the value to show and
 * the function that holds a choice.
 */
export function useHeldValue<T>(saved: T): readonly [T, (next: T | null) => void] {
  const [held, setHeld] = useState<{ value: T } | null>(null);
  // The choice is let go of when the saved value reaches it (state adjusted while rendering).
  if (held !== null && Object.is(held.value, saved)) setHeld(null);
  return [held ? held.value : saved, (next) => setHeld(next === null ? null : { value: next })];
}
