import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

/** A native button; `ref` reaches it (React 19 passes refs as props). */
type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "link" | "danger" | "chip";
  /** `sm` is the 28 px button of a dense row of chips (design record 5.11); the default is 32+. */
  size?: "default" | "sm";
};

// The pressed secondary button keeps a boundary of 3:1 or more: it swaps `--border-strong` for the
// solid accent (never a translucent one), which `npm run contrast` checks on every surface.
const variants = {
  primary: "border-accent bg-accent text-accent-foreground hover:brightness-95",
  secondary:
    "border-border-strong bg-surface text-foreground hover:bg-soft aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:border-accent",
  ghost:
    "border-transparent bg-transparent text-muted-foreground hover:bg-soft hover:text-foreground",
  // An action that reads as a link (accent text); `cn` does not merge classes, so variants own colour.
  link: "border-transparent bg-transparent text-accent hover:bg-soft hover:text-accent-hover",
  danger: "border-rose-700 bg-rose-700 text-white hover:bg-rose-800",
  // A filter or prefix chip that toggles (`aria-pressed`): the pressed one is soft-filled, semibold
  // and ringed with `--border-strong`, as the segmented control's pressed segment is (design record
  // 5.11); accent colour stays with links, focus and the selection bar.
  chip: cn(
    "border-border bg-transparent text-secondary-foreground hover:bg-soft hover:text-foreground",
    "aria-pressed:border-border-strong aria-pressed:bg-soft aria-pressed:font-semibold aria-pressed:text-foreground",
    "aria-pressed:[box-shadow:0_0_0_1px_var(--border-strong)]"
  )
};

// The height and padding sit inside the base string (the default's markup is pinned by snapshots).
const sizes = {
  default: { height: "min-h-[34px]", padding: "px-3 py-1.5" },
  sm: { height: "min-h-7", padding: "px-2.5 py-0.5" }
};

export function Button({
  className,
  type = "button",
  variant = type === "submit" ? "primary" : "secondary",
  size = "default",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        `inline-flex ${sizes[size].height} min-w-0 max-w-full items-center justify-center gap-1.5 whitespace-normal rounded-lg border ${sizes[size].padding} text-xs font-medium leading-5 [overflow-wrap:anywhere] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:size-3.5 [&>svg]:shrink-0`,
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
