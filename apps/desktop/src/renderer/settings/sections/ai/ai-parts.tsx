import { type ComponentPropsWithRef, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { RunningRing, SolidCheck, SolidTriangle } from "../../../components/ui/solid-glyphs";
import { cn } from "../../../lib/cn";

/**
 * The small pieces the AI section's rows are built from: a status line (a solid glyph and a word, so
 * colour is never the only signal), a native select that keeps a 32 px height and a chevron, a
 * switch, an expander for the pages that open in place, and the quiet line an area says its failure
 * in. They use the tokens only; the section's buttons and inputs are the shared primitives.
 */

export type Tone = "ok" | "idle" | "warn" | "danger" | "working";

const toneClass: Record<Tone, string> = {
  ok: "text-success",
  idle: "text-muted-foreground",
  warn: "text-warning",
  danger: "text-danger",
  working: "text-accent"
};

/** One line of state: the glyph at the left, the words in the secondary colour. */
export function StatusLine({
  tone,
  children,
  className,
  live = false,
  icon
}: {
  tone: Tone;
  children: ReactNode;
  className?: string;
  /** Announced when it changes (a test result, a save). */
  live?: boolean;
  /** A glyph of its own in the place of the tone's (a line that is not a state, such as "your text goes to ..."). */
  icon?: ReactNode;
}) {
  return (
    <span
      {...(live ? { role: "status" } : {})}
      className={cn(
        "inline-flex min-w-0 items-start gap-1.5 text-xs leading-5 text-secondary-foreground",
        className
      )}
    >
      <span className={cn("mt-[3px] inline-flex shrink-0", toneClass[tone])}>
        {icon ? (
          icon
        ) : tone === "ok" ? (
          <SolidCheck className="size-3.5" />
        ) : tone === "warn" || tone === "danger" ? (
          <SolidTriangle className="size-3.5" />
        ) : tone === "working" ? (
          <RunningRing className="mt-0.5" />
        ) : (
          <span
            aria-hidden="true"
            className="m-[3px] inline-block size-2 rounded-full border-[1.5px] border-current"
          />
        )}
      </span>
      <span className="min-w-0 [text-wrap:pretty]">{children}</span>
    </span>
  );
}

/** A quiet sentence in place for the failure of an area (never a modal, never red-filled). */
export function AreaNotice({
  message,
  className
}: {
  message: string | null | undefined;
  className?: string;
}) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("m-0 text-xs leading-5 text-secondary-foreground", className)}>
      <span className="inline-flex items-start gap-1.5">
        <SolidTriangle className="mt-[3px] size-3.5 text-danger" />
        <span className="[text-wrap:pretty]">{message}</span>
      </span>
    </p>
  );
}

const selectClasses = cn(
  "h-8 min-w-0 w-full appearance-none rounded-md border border-border-strong bg-surface py-0 pl-3 pr-8",
  "text-sm text-foreground text-ellipsis hover:bg-surface-hover",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
  "disabled:cursor-default disabled:border-border disabled:bg-soft disabled:text-muted-foreground"
);

/** A native select (it keeps the platform's menu and keyboard) with the chevron drawn over it. */
export function NativeSelect({
  className,
  wrapperClassName,
  children,
  ...props
}: ComponentPropsWithRef<"select"> & { wrapperClassName?: string }) {
  return (
    <span className={cn("relative inline-flex min-w-0 max-w-full", wrapperClassName)}>
      <select className={cn(selectClasses, className)} {...props}>
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute right-2.5 top-2.5 size-3.5 text-secondary-foreground"
      />
    </span>
  );
}

/** A text field at the section's 32 px height and 13 px type (the shared `Input` is 36 px at 12). */
export function TextField({ className, ...props }: ComponentPropsWithRef<"input">) {
  return (
    <input
      className={cn(
        "h-8 min-w-0 w-full rounded-md border border-border-strong bg-surface px-3 text-sm text-foreground",
        "placeholder:text-muted-foreground",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-default disabled:border-border disabled:bg-soft disabled:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

/** A labelled field of a form: the label above, the control, one line of help under it. */
export function Field({
  label,
  htmlFor,
  hint,
  children
}: {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="grid min-w-0 gap-1">
      <label htmlFor={htmlFor} className="text-xs font-medium text-secondary-foreground">
        {label}
      </label>
      {children}
      {hint ? <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">{hint}</p> : null}
    </div>
  );
}

/** A switch: a button with `role="switch"`, the on state in the accent. */
export function SwitchControl({
  checked,
  className,
  ...props
}: Omit<ComponentPropsWithRef<"button">, "role" | "aria-checked"> & { checked: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn(
        "relative h-5 w-9 shrink-0 rounded-full border-0 p-0 transition-colors [transition-duration:var(--motion-fast)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-default",
        checked
          ? "bg-accent"
          : "bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)] disabled:[box-shadow:inset_0_0_0_1px_var(--border)]",
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className={cn(
          "absolute top-[3px] size-3.5 rounded-full transition-[left] [transition-duration:var(--motion-fast)]",
          checked ? "left-[19px] bg-accent-foreground" : "left-[3px] bg-border-strong"
        )}
      />
    </button>
  );
}

/** A group's heading, as the generic section draws it, so every section's groups look alike. */
export function GroupHeading({
  id,
  first,
  children
}: {
  id: string;
  first: boolean;
  children: ReactNode;
}) {
  return (
    <h3 id={id} className={`m-0 text-sm font-semibold text-foreground ${first ? "mt-8" : "mt-10"}`}>
      {children}
    </h3>
  );
}

/** A line of introduction under a group's heading. */
export function GroupIntro({ children }: { children: ReactNode }) {
  return (
    <p className="m-0 mt-1 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]">
      {children}
    </p>
  );
}
