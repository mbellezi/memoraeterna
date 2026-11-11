import { useEffect, useState, type ComponentPropsWithRef, type ReactNode } from "react";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";

/** Grey bars appear only after this long, so a fast answer never flashes them (design record 5.12). */
export const skeletonDelayMs = 150;

/** One bar in the shape of what is coming. It is decorative: the region around it says "loading". */
export function Skeleton({ className, ...props }: ComponentPropsWithRef<"div">) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "h-3 animate-[ui-shimmer_1.4s_var(--ease-in-out)_infinite] rounded-sm bg-[linear-gradient(90deg,var(--surface-soft),var(--surface-hover),var(--surface-soft))] bg-[length:200%_100%]",
        className
      )}
      {...props}
    />
  );
}

/** True once `delayMs` has passed since the first render (at once for 0). */
export function useAfterDelay(delayMs: number): boolean {
  const [elapsed, setElapsed] = useState(delayMs <= 0);
  useEffect(() => {
    if (delayMs <= 0) return undefined;
    const timer = setTimeout(() => setElapsed(true), delayMs);
    return () => clearTimeout(timer);
  }, [delayMs]);
  return elapsed;
}

/**
 * The loading state of a view: a busy status region that is always there (a screen reader hears
 * "Loading" at once) and whose bars, the children, show after 150 ms. There is no spinner.
 */
export function LoadingState({
  t,
  children,
  delayMs = skeletonDelayMs,
  className
}: {
  t: Translator;
  /** The bars, in the shape of what is coming. */
  children?: ReactNode;
  delayMs?: number;
  className?: string;
}) {
  const shown = useAfterDelay(delayMs);
  return (
    <div role="status" aria-busy="true" className={cn("grid min-w-0 gap-3", className)}>
      <span className="sr-only">{t("ui.loading")}</span>
      {shown ? children : null}
    </div>
  );
}

/** A few lines of text-shaped bars, the last one shorter. */
export function SkeletonLines({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("grid gap-2", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={index === lines - 1 && lines > 1 ? "w-2/3" : "w-full"} />
      ))}
    </div>
  );
}
