import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

/** A native button; `ref` reaches it (React 19 passes refs as props). */
type ButtonProps = ComponentPropsWithRef<"button"> & {
  variant?: "primary" | "secondary" | "ghost" | "link" | "danger";
};

const variants = {
  primary: "border-accent bg-accent text-accent-foreground hover:brightness-95",
  secondary:
    "border-border-strong bg-surface text-foreground hover:bg-soft aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:border-accent/40",
  ghost:
    "border-transparent bg-transparent text-muted-foreground hover:bg-soft hover:text-foreground",
  // An action that reads as a link (accent text); `cn` does not merge classes, so variants own colour.
  link: "border-transparent bg-transparent text-accent hover:bg-soft hover:text-accent-hover",
  danger: "border-rose-700 bg-rose-700 text-white hover:bg-rose-800"
};

export function Button({
  className,
  type = "button",
  variant = type === "submit" ? "primary" : "secondary",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-h-[34px] min-w-0 max-w-full items-center justify-center gap-1.5 whitespace-normal rounded-lg border px-3 py-1.5 text-xs font-medium leading-5 [overflow-wrap:anywhere] transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-45 [&>svg]:size-3.5 [&>svg]:shrink-0",
        variants[variant],
        className
      )}
      {...props}
    />
  );
}
