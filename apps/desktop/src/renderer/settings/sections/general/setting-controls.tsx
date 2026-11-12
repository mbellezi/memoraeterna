import { useEffect, useRef, useState, type ComponentPropsWithRef } from "react";
import { ChevronDown } from "lucide-react";

import type { Json } from "../../../../shared/settings-registry";
import { cn } from "../../../lib/cn";
import { useSettings } from "../../settings-context";

/**
 * The controls the General, Library and Privacy sections share: a select, a switch with its word,
 * and the way a control keeps the choice it just made on screen until the saved value arrives. They
 * sit at the right of a `SettingRow` and use tokens only; the segmented control and the buttons are
 * the primitives of `components/ui`.
 */

export interface SelectOption<V extends string> {
  value: V;
  label: string;
}

/** A native select drawn like the rest: 34 px high, the strong border, the chevron inside. */
export function SettingSelect<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
  className
}: {
  /** The select's accessible name (the row's label). */
  label: string;
  value: V;
  options: readonly SelectOption<V>[];
  onChange: (value: V) => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("relative inline-flex max-w-full", className)}>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as V)}
        className={cn(
          "h-[34px] w-full min-w-44 max-w-full appearance-none truncate rounded-lg border border-border-strong bg-surface",
          "py-0 pl-3 pr-9 text-sm text-foreground outline-none transition-colors hover:bg-soft",
          "focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-accent",
          "disabled:cursor-not-allowed disabled:opacity-45"
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-secondary-foreground"
      />
    </span>
  );
}

/**
 * An on or off control that says which it is: the word ("On", "Off") beside a track and a thumb. The
 * state is also the track's fill and the thumb's side, so colour is never the only signal.
 */
export function SettingSwitch({
  label,
  checked,
  onLabel,
  offLabel,
  onChange,
  disabled = false,
  ...props
}: {
  label: string;
  checked: boolean;
  onLabel: string;
  offLabel: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
} & Omit<ComponentPropsWithRef<"button">, "onChange" | "role" | "aria-checked" | "aria-label">) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      {...props}
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-lg border-0 bg-transparent p-1 text-sm text-secondary-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-not-allowed disabled:opacity-45"
      )}
    >
      <span className="min-w-[4.5ch] text-right">{checked ? onLabel : offLabel}</span>
      <span
        aria-hidden="true"
        className={cn(
          "relative inline-block h-5 w-9 shrink-0 rounded-full border transition-colors [transition-duration:var(--motion-fast)]",
          checked
            ? "border-accent bg-accent group-hover:bg-accent-hover"
            : "border-border-strong bg-soft group-hover:bg-surface-hover"
        )}
      >
        <span
          className={cn(
            "absolute left-0.5 top-0.5 size-3.5 rounded-full transition-transform [transition-duration:var(--motion-fast)]",
            checked ? "translate-x-4 bg-accent-foreground" : "translate-x-0 bg-secondary-foreground"
          )}
        />
      </span>
    </button>
  );
}

/** The state of a save the person asked for: nothing, running, or failed (nothing was changed). */
export type SaveState = "idle" | "saving" | "failed";

/**
 * The value a control shows for one registry entry, and how it saves a new one. The saved value is
 * what `settings.describe` says; while a save is running, and until the saved value catches up, the
 * control shows the choice the person made, so it never springs back and forth. A save that fails
 * puts the saved value back and says so (`state`). `write` goes through main (`window.app.settings`),
 * which announces the change; the surface's store reads again on that event.
 */
export function useSavedChoice<V extends Json>(
  id: string,
  write: (value: V) => Promise<unknown>
): { value: V | undefined; state: SaveState; save: (value: V) => void } {
  const settings = useSettings();
  const stored = settings.describe(id)?.value as V | undefined;
  const [pending, setPending] = useState<{ value: V; from: V | undefined } | null>(null);
  const [state, setState] = useState<SaveState>("idle");
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );
  // The saved value moved after the save ended (it caught up, or something else changed it): the
  // choice is no longer needed and the saved value is the truth again. State adjusted while rendering.
  if (pending !== null && state === "idle" && stored !== pending.from) setPending(null);

  const save = (value: V) => {
    setPending({ value, from: stored });
    setState("saving");
    write(value)
      .then(() => {
        if (alive.current) setState("idle");
      })
      .catch(() => {
        if (!alive.current) return;
        setPending(null);
        setState("failed");
      });
  };
  return { value: pending !== null ? pending.value : stored, state, save };
}
