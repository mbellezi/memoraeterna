/**
 * Turns the marks Cmd-K writes (`lib/omni-marks.ts`) into the report of bar X3(b) (spec 3.5). Pure:
 * `e2e/cmdk-latency.spec.ts` reads the marks with `page.evaluate` and hands them here, and the
 * tests hand it synthetic ones.
 *
 * A key's latency is the first `omni:paint` whose `seq` is at least the key's own, minus the key's
 * time stamp: a key whose query was superseded before it was sent resolves at the paint of the
 * request that took its place, which is what the person sees. Besides the latency, the report
 * gives the queue wait of the keys whose own query was sent (`omni:send` minus `omni:key`) and the
 * share of keys whose query was never sent.
 */

/** A mark as `performance.getEntriesByType("mark")` gives it, reduced to what the analysis reads. */
export interface OmniMark {
  name: string;
  /** Milliseconds from the document's time origin. */
  startTime: number;
  detail?: unknown;
}

export interface Spread {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export interface OmniLatencyReport {
  /** Keys that edited the query. */
  keys: number;
  /** Keys followed by a paint of their own query or a later one. */
  resolved: number;
  /** Keys with no paint after them (the window closed first). */
  unresolved: number;
  /** Key to paint, in milliseconds, one per resolved key, in key order. */
  latencies: number[];
  latency: Spread;
  /** `omni:send` minus `omni:key`, for the keys whose own query was sent. */
  queueWait: Spread;
  /** `tookMs` of every painted answer: the service's own time, with no queue and no render. */
  service: Spread;
  /** Keys whose own query was sent. */
  sent: number;
  /** The share of keys whose query was never sent (0 to 1; 0 when there are no keys). */
  neverSentShare: number;
}

/** The nearest-rank percentile (`p` in 0-100) of `values`; null for none. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1] ?? null;
}

export function spread(values: readonly number[]): Spread {
  return {
    count: values.length,
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values)
  };
}

const seqOf = (mark: OmniMark): number | null => {
  const detail = mark.detail;
  if (typeof detail !== "object" || detail === null) return null;
  const seq = (detail as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
};

interface Sequenced {
  seq: number;
  at: number;
}

const sequenced = (marks: readonly OmniMark[], name: string): Sequenced[] =>
  marks.flatMap((mark) => {
    const seq = mark.name === name ? seqOf(mark) : null;
    return seq === null ? [] : [{ seq, at: mark.startTime }];
  });

export function analyzeOmniLatency(marks: readonly OmniMark[]): OmniLatencyReport {
  const keys = sequenced(marks, "omni:key").sort((a, b) => a.seq - b.seq);
  const sends = new Map<number, number>();
  // A key that was sent twice (a retry) counts from its first send.
  for (const send of sequenced(marks, "omni:send").sort((a, b) => a.at - b.at))
    if (!sends.has(send.seq)) sends.set(send.seq, send.at);
  const paints = sequenced(marks, "omni:paint").sort((a, b) => a.at - b.at);

  const latencies: number[] = [];
  const waits: number[] = [];
  let unresolved = 0;
  for (const key of keys) {
    const paint = paints.find((entry) => entry.seq >= key.seq && entry.at >= key.at);
    if (paint) latencies.push(paint.at - key.at);
    else unresolved += 1;
    const sentAt = sends.get(key.seq);
    if (sentAt !== undefined) waits.push(Math.max(0, sentAt - key.at));
  }
  const service = marks.flatMap((mark) => {
    const took =
      mark.name === "omni:paint" ? (mark.detail as { tookMs?: unknown } | null)?.tookMs : null;
    return typeof took === "number" && Number.isFinite(took) ? [took] : [];
  });
  return {
    keys: keys.length,
    resolved: latencies.length,
    unresolved,
    latencies,
    latency: spread(latencies),
    queueWait: spread(waits),
    service: spread(service),
    sent: waits.length,
    neverSentShare: keys.length === 0 ? 0 : (keys.length - waits.length) / keys.length
  };
}
