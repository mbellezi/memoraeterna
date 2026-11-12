import { describe, expect, it } from "vitest";

import { analyzeOmniLatency, percentile, type OmniMark } from "./omni-latency";

const key = (seq: number, at: number): OmniMark => ({
  name: "omni:key",
  startTime: at,
  detail: { seq, query: "x" }
});
const send = (seq: number, at: number): OmniMark => ({
  name: "omni:send",
  startTime: at,
  detail: { seq, requestId: `r${seq}` }
});
const paint = (seq: number, at: number, tookMs?: number): OmniMark => ({
  name: "omni:paint",
  startTime: at,
  detail: { seq, ...(tookMs === undefined ? {} : { tookMs }) }
});

describe("the Cmd-K latency analysis", () => {
  it("measures a key to the first paint of its own query", () => {
    const report = analyzeOmniLatency([
      key(1, 100),
      send(1, 101),
      paint(1, 140),
      key(2, 180),
      send(2, 181),
      paint(2, 260)
    ]);
    expect(report.latencies).toEqual([40, 80]);
    expect(report).toMatchObject({
      keys: 2,
      resolved: 2,
      unresolved: 0,
      sent: 2,
      neverSentShare: 0
    });
    expect(report.queueWait.max).toBe(1);
  });

  it("resolves a superseded key at the next paint, and counts it as never sent", () => {
    // Key 1 is on its way when keys 2 and 3 arrive: the next request carries key 3.
    const report = analyzeOmniLatency([
      key(1, 0),
      send(1, 1),
      key(2, 80),
      key(3, 160),
      paint(1, 120),
      send(3, 121),
      paint(3, 200)
    ]);
    // Key 2 resolves at the paint of seq 3 (200), not at the paint of seq 1 (120).
    expect(report.latencies).toEqual([120, 120, 40]);
    expect(report.sent).toBe(2);
    expect(report.neverSentShare).toBeCloseTo(1 / 3);
    // Key 3 waited for the request in flight: 121 - 160 never goes below zero.
    expect(report.queueWait.max).toBe(1);
  });

  it("never resolves a key at a paint that came before it", () => {
    const report = analyzeOmniLatency([paint(5, 10), key(2, 50)]);
    expect(report.resolved).toBe(0);
    expect(report.unresolved).toBe(1);
    expect(report.latency.p95).toBeNull();
  });

  it("reports the nearest-rank percentiles and tolerates no marks", () => {
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95)).toBe(100);
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 50)).toBe(50);
    expect(percentile([], 95)).toBeNull();
    const none = analyzeOmniLatency([]);
    expect(none).toMatchObject({ keys: 0, neverSentShare: 0, latencies: [] });
  });

  it("reports the service's own time from the paint marks that carry it", () => {
    const report = analyzeOmniLatency([key(1, 0), paint(1, 30, 12), key(2, 40), paint(2, 90, 20)]);
    expect(report.service).toMatchObject({ count: 2, p50: 12, max: 20 });
  });

  it("ignores marks it does not know and details it cannot read", () => {
    const report = analyzeOmniLatency([
      { name: "other", startTime: 1, detail: { seq: 1 } },
      { name: "omni:key", startTime: 2, detail: null },
      key(1, 3),
      paint(1, 9)
    ]);
    expect(report.latencies).toEqual([6]);
  });
});
