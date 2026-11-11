// Performance marks of the renderer (F5 T137): a journey reads the `performance.mark` entries the
// app writes (for example `omni:key` and `omni:paint`, spec 3.5) with `page.evaluate`, so a
// measurement is the app's own clock, not the test runner's.
import type { Page } from "@playwright/test";

export interface MarkEntry {
  name: string;
  /** Milliseconds from the document's time origin. */
  startTime: number;
  detail: unknown;
}

/** The marks whose name starts with `prefix` (all marks when it is empty), in time order. */
export async function readMarks(page: Page, prefix = ""): Promise<MarkEntry[]> {
  return page.evaluate(
    (wanted) =>
      performance
        .getEntriesByType("mark")
        .filter((entry) => entry.name.startsWith(wanted))
        .map((entry) => ({
          name: entry.name,
          startTime: entry.startTime,
          detail: (entry as PerformanceMark).detail ?? null
        })),
    prefix
  );
}

/** Clears the marks whose name starts with `prefix` (every mark when it is empty). */
export async function clearMarks(page: Page, prefix = ""): Promise<void> {
  await page.evaluate((wanted) => {
    for (const name of new Set(performance.getEntriesByType("mark").map((entry) => entry.name)))
      if (name.startsWith(wanted)) performance.clearMarks(name);
  }, prefix);
}

/** The nearest-rank percentile (`p` in 0-100) of `values`; null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  if (!(p >= 0 && p <= 100)) throw new Error("A percentile is between 0 and 100");
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}
