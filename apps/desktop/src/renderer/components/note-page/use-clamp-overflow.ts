import { useEffect, useState, type RefObject } from "react";

/**
 * Whether a line-clamped block hides part of its text, measured again when its size changes. The
 * observer is disconnected when the block unmounts.
 */
export function useClampOverflow(ref: RefObject<HTMLElement | null>, clamped: boolean): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element || !clamped || typeof ResizeObserver === "undefined") return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, clamped]);
  return overflows;
}
