import type { InputHTMLAttributes } from "react";
import { cn } from "../../lib/cn";

export function Switch({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="checkbox"
      className={cn(
        "h-5 w-5 rounded border-slate-300 text-cyan-700 accent-cyan-700 focus:ring-cyan-100",
        className
      )}
      {...props}
    />
  );
}
