/**
 * The marks Cmd-K writes to measure its own latency (F5 spec 3.5, bar X3(b)); `e2e/cmdk-latency.spec.ts`
 * reads them with `page.evaluate` and `workspace/palette/omni-latency.ts` turns them into a report.
 *
 *   omni:key    a key that edits the query, at the event's own time stamp: `{ seq, query }`
 *   omni:send   a request left for the main process: `{ seq, requestId }` (`seq` is the latest key)
 *   omni:paint  the results of a request reached the screen: `{ seq, tookMs }` (the `seq` it was sent
 *               at, and the service's own time for it)
 *
 * `seq` is one counter for the page, so a key's latency is the first paint whose `seq` is at least
 * its own, minus its time stamp. Marks are bounded: past `omniMarkLimit` of them the oldest go.
 * Every call is best effort: a page with no `performance.mark` (a test) records nothing.
 */

export const omniMarkNames = {
  key: "omni:key",
  send: "omni:send",
  paint: "omni:paint"
} as const;
export const omniMarkLimit = 2000;

let keySeq = 0;

/** The sequence number of the latest key; 0 before the first one. */
export function latestKeySeq(): number {
  return keySeq;
}

/** Test only: starts the page's counter again. */
export function resetOmniMarks(): void {
  keySeq = 0;
}

function write(name: string, options: { startTime?: number; detail: unknown }): void {
  try {
    if (typeof performance === "undefined" || typeof performance.mark !== "function") return;
    performance.mark(name, options);
    bound();
  } catch {
    // Measuring never breaks the palette.
  }
}

/** Past the limit, drops what the page recorded so far: the journey reads and clears often. */
function bound(): void {
  let total = 0;
  for (const name of Object.values(omniMarkNames))
    total += performance.getEntriesByName(name, "mark").length;
  if (total <= omniMarkLimit) return;
  for (const name of Object.values(omniMarkNames)) performance.clearMarks(name);
}

/** A key that edits the query: starts a new sequence number and returns it. */
export function markKey(startTime: number, query: string): number {
  keySeq += 1;
  write(omniMarkNames.key, { startTime, detail: { seq: keySeq, query } });
  return keySeq;
}

export function markSend(seq: number, requestId: string): void {
  write(omniMarkNames.send, { detail: { seq, requestId } });
}

export function markPaint(seq: number, tookMs: number | null = null): void {
  write(omniMarkNames.paint, { detail: { seq, tookMs } });
}
