import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Switch({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-5 w-5 rounded border-slate-300 text-cyan-700 accent-cyan-700 focus:ring-cyan-100 dark:border-slate-700 dark:accent-cyan-500 dark:focus:ring-cyan-950",
        className
      )}
      {...props}
    />
  );
}
