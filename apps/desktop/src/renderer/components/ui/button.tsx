import type { ButtonHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Button({ className, type = "button", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-slate-300 bg-slate-950 px-3 text-sm font-medium text-white transition-colors hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-55",
        className
      )}
      {...props}
    />
  );
}
