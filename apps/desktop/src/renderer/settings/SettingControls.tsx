import { useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";

import { RunningRing, SolidCheck, SolidTriangle } from "../components/ui/solid-glyphs";
import { InlineAction } from "./InlineAction";
import { cn } from "../lib/cn";

/**
 * The controls the Knowledge and Integrations sections share (F5 T164, design record §7.6 and the
 * Settings v2 mockup): a switch that says its word, a native select, radio cards, a number field, a
 * status line with its glyph, a group heading and the disclosure of a "page" row. Tokens only; every
 * control is named by its row's label (`aria-labelledby`) so a screen reader hears the setting.
 */

/** The heading of a group of rows, the same one `GenericSection` draws. */
export function SettingsGroup({
  section,
  group,
  title,
  first,
  intro,
  children
}: {
  section: string;
  group: string;
  title: string;
  first: boolean;
  /** One line under the heading that holds for every row of the group. */
  intro?: ReactNode;
  children: ReactNode;
}) {
  const headingId = `settings-group-${section}-${group}`;
  return (
    <section aria-labelledby={headingId}>
      <h3
        id={headingId}
        className={cn("m-0 text-sm font-semibold text-foreground", first ? "mt-8" : "mt-10")}
      >
        {title}
      </h3>
      {intro ? (
        <p className="m-0 mt-1 max-w-[34rem] text-sm text-secondary-foreground [text-wrap:pretty]">
          {intro}
        </p>
      ) : null}
      <div>{children}</div>
    </section>
  );
}

/** The id of the label of a setting row, for a control that names itself by it. */
export const labelIdOf = (entryId: string): string => `settings-label-${entryId}`;

/** On or off, with the word beside it (colour is never the only signal). */
export function SwitchControl({
  t,
  checked,
  onChange,
  label,
  describedBy,
  disabled = false
}: {
  t: Translator;
  checked: boolean;
  onChange: (next: boolean) => void;
  /** The accessible name: the setting's label. */
  label: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-2">
      <span aria-hidden="true" className="text-sm text-secondary-foreground">
        {t(checked ? "settingsShell.row.valueOn" : "settingsShell.row.valueOff")}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative h-5 w-9 shrink-0 cursor-pointer rounded-full border-0 p-0",
          "transition-colors [transition-duration:var(--motion-fast)]",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "bg-accent" : "bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)]"
        )}
      >
        <span
          aria-hidden="true"
          className={cn(
            "absolute left-[3px] top-[3px] size-3.5 rounded-full",
            "transition-transform [transition-duration:var(--motion-fast)]",
            checked ? "translate-x-4 bg-accent-foreground" : "translate-x-0 bg-border-strong"
          )}
        />
      </button>
    </span>
  );
}

/** A native select (the OS draws the list), with the row's chevron. */
export function SelectControl<T extends string>({
  value,
  options,
  onChange,
  label,
  describedBy,
  disabled = false,
  width
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>;
  onChange: (next: T) => void;
  label: string;
  describedBy?: string;
  disabled?: boolean;
  width?: string;
}) {
  return (
    <span className="relative inline-flex max-w-full">
      <select
        value={value}
        aria-label={label}
        {...(describedBy ? { "aria-describedby": describedBy } : {})}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
        style={width ? { width } : undefined}
        className={cn(
          "h-8 max-w-full cursor-pointer appearance-none rounded-md border border-border-strong",
          "bg-surface py-0 pl-3 pr-8 text-sm text-foreground hover:bg-surface-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          "disabled:cursor-not-allowed disabled:border-border disabled:bg-soft disabled:text-muted-foreground"
        )}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-secondary-foreground"
      />
    </span>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  description: string;
}

/**
 * A decision that is the point of the section, as radio cards (Settings v2 mockup): the label, one
 * plain sentence for each choice, the chosen one filled and ringed. The arrows move focus only;
 * Space or Enter chooses (a card is never chosen by passing through it).
 */
export function ChoiceCards<T extends string>({
  value,
  options,
  onChange,
  label,
  describedBy,
  disabled = false
}: {
  value: T;
  options: ReadonlyArray<ChoiceOption<T>>;
  onChange: (next: T) => void;
  label: string;
  describedBy?: string;
  disabled?: boolean;
}) {
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const keys: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1
    };
    const cards = [...(group.current?.querySelectorAll<HTMLElement>("[role=radio]") ?? [])];
    const at = cards.indexOf(event.currentTarget);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? cards.length - 1
          : keys[event.key] !== undefined
            ? (at + (keys[event.key] ?? 0) + cards.length) % cards.length
            : -1;
    if (next < 0) return;
    event.preventDefault();
    cards[next]?.focus();
  };
  return (
    <div
      ref={group}
      role="radiogroup"
      aria-label={label}
      {...(describedBy ? { "aria-describedby": describedBy } : {})}
      className="grid w-full grid-cols-3 gap-2"
    >
      {options.map((option) => {
        const chosen = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={chosen}
            tabIndex={chosen ? 0 : -1}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            onKeyDown={move}
            className={cn(
              "flex min-w-0 flex-col items-start gap-1 rounded-lg border p-3 text-left",
              "transition-colors [transition-duration:var(--motion-fast)]",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              "disabled:cursor-not-allowed disabled:opacity-60",
              chosen
                ? "border-border-strong bg-accent-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)]"
                : "border-border bg-surface hover:bg-surface-hover"
            )}
          >
            <span className="flex items-center gap-2 text-base font-semibold leading-5 text-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "relative size-4 shrink-0 rounded-full border-2",
                  chosen ? "border-accent" : "border-border-strong"
                )}
              >
                {chosen ? <span className="absolute inset-[3px] rounded-full bg-accent" /> : null}
              </span>
              {option.label}
            </span>
            <span className="text-xs leading-4 text-secondary-foreground [text-wrap:pretty]">
              {option.description}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/**
 * A number typed in, with a prefix or a suffix: committed on blur or Enter, put back by Escape. What
 * was typed is parsed by the caller (a comma is a decimal mark in some languages); a text that does
 * not parse says so in place and writes nothing.
 */
export function NumberField({
  value,
  format,
  parse,
  onCommit,
  label,
  describedBy,
  prefix,
  suffix,
  invalidMessage,
  disabled = false,
  inputRef
}: {
  value: number;
  format: (value: number) => string;
  /** The number in the text, or null when it is not one. */
  parse: (text: string) => number | null;
  onCommit: (value: number) => void;
  label: string;
  describedBy?: string;
  prefix?: string;
  suffix?: string;
  invalidMessage: string;
  disabled?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  const [draft, setDraft] = useState(format(value));
  const [invalid, setInvalid] = useState(false);
  // A saved or restored value replaces the text being edited.
  const [shown, setShown] = useState(value);
  if (shown !== value) {
    setShown(value);
    setDraft(format(value));
    setInvalid(false);
  }
  const errorId = useId();
  const commit = () => {
    const parsed = parse(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    setDraft(format(parsed));
    if (parsed !== value) onCommit(parsed);
  };
  return (
    <span className="inline-grid justify-items-end gap-1">
      <span
        className={cn(
          "inline-flex h-8 min-w-28 items-center justify-end gap-1.5 rounded-md border px-2.5 text-sm",
          "bg-surface text-muted-foreground focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent",
          invalid ? "border-danger" : "border-border-strong",
          disabled && "bg-soft opacity-60"
        )}
      >
        {prefix ? <span aria-hidden="true">{prefix}</span> : null}
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          value={draft}
          disabled={disabled}
          aria-label={label}
          aria-invalid={invalid}
          aria-describedby={
            [describedBy, invalid ? errorId : null].filter(Boolean).join(" ") || undefined
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            else if (event.key === "Escape") {
              event.preventDefault();
              setDraft(format(value));
              setInvalid(false);
            }
          }}
          className="h-[1.875rem] w-16 border-0 bg-transparent p-0 text-right tabular-nums text-foreground outline-none"
        />
        {suffix ? <span aria-hidden="true">{suffix}</span> : null}
      </span>
      {invalid ? (
        <span id={errorId} role="alert" className="max-w-56 text-right text-xs text-danger">
          {invalidMessage}
        </span>
      ) : null}
    </span>
  );
}

export type StatusTone = "ok" | "idle" | "warn" | "working";

/** A status in one line: a solid glyph and the words, so the state is never colour alone. */
export function StatusLine({
  tone,
  children,
  role,
  plain = false
}: {
  tone: StatusTone;
  children: ReactNode;
  role?: "status";
  /** Wrap line by line, not balanced: for a line that ends in an action, which balancing would strand. */
  plain?: boolean;
}) {
  return (
    <span
      {...(role ? { role } : {})}
      className="flex min-w-0 flex-wrap items-start gap-x-2 gap-y-0.5 text-xs leading-5 text-secondary-foreground"
    >
      <span className="mt-0.5 inline-flex h-4 items-center">
        {tone === "ok" ? (
          <SolidCheck className="text-success" />
        ) : tone === "warn" ? (
          <SolidTriangle className="text-warning" />
        ) : tone === "working" ? (
          <RunningRing />
        ) : (
          <span aria-hidden="true" className="inline-block size-2 rounded-full bg-border-strong" />
        )}
      </span>
      <span className={cn("min-w-0 flex-1 basis-40", !plain && "[text-wrap:pretty]")}>
        {children}
      </span>
    </span>
  );
}

/** A read that failed, said quietly in its place, with the way to try again. */
export function ReadProblem({
  t,
  message,
  onRetry
}: {
  t: (key: MessageKey) => string;
  message: string;
  onRetry: () => void;
}) {
  return (
    <span
      role="alert"
      className="flex flex-wrap items-center gap-x-2 text-xs text-secondary-foreground"
    >
      <SolidTriangle className="size-3.5 text-warning" />
      <span>{message}</span>
      <InlineAction size="xs" onClick={onRetry}>
        {t("shell.actions.retry")}
      </InlineAction>
    </span>
  );
}
