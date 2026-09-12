import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
};

const variants = {
  primary: "border-accent bg-accent text-accent-foreground hover:brightness-95",
  secondary: "border-border bg-surface text-foreground hover:bg-soft aria-pressed:bg-accent-soft aria-pressed:text-accent aria-pressed:border-accent/40",
  ghost: "border-transparent bg-transparent text-muted-foreground hover:bg-soft hover:text-foreground",
  danger: "border-rose-700 bg-rose-700 text-white hover:bg-rose-800"
};

export function Button({ className, type = "button", variant = type === "submit" ? "primary" : "secondary", ...props }: ButtonProps) {
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
