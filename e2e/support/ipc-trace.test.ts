import { describe, expect, it } from "vitest";

import { ipcTraceGlobalKey as mainKey } from "../../apps/desktop/src/main/services/dev/ipc-trace.js";
import { ipcChannels } from "../../apps/desktop/src/shared/ipc.js";
import { inboxActChannel, ipcTraceGlobalKey, uncausedInvocations } from "./ipc-trace.js";
import { percentile } from "./perf.js";

describe("uncausedInvocations", () => {
  const at = (channel: string, time: number) => ({ channel, at: time });

  it("keeps an invocation with no cause in the window before it", () => {
    const entries = [at("a", 100), at("b", 1_600), at("c", 5_000), at("d", 5_000)];
    // b is 1,550 ms after its latest cause; c and d exactly 1,000 ms after theirs (still caused).
    expect(uncausedInvocations(entries, [50, 4_000])).toEqual([at("b", 1_600)]);
    expect(uncausedInvocations(entries, [5_000, 100, 1_000])).toEqual([]);
  });

  it("counts a cause at the same millisecond and none after the invocation", () => {
    expect(uncausedInvocations([at("a", 2_000)], [2_000])).toEqual([]);
    expect(uncausedInvocations([at("a", 2_000)], [2_001])).toEqual([at("a", 2_000)]);
    expect(uncausedInvocations([at("a", 2_000)], [])).toEqual([at("a", 2_000)]);
  });

  it("reads the ring the main process publishes", () => {
    expect(ipcTraceGlobalKey).toBe(mainKey);
  });

  it("names the Inbox verdict channel the app registers", () => {
    expect(inboxActChannel).toBe(ipcChannels.inboxAct);
  });
});

describe("percentile", () => {
  it("uses the nearest rank", () => {
    const values = Array.from({ length: 100 }, (_value, index) => 100 - index);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNull();
    expect(() => percentile([1], 101)).toThrow();
  });
});
