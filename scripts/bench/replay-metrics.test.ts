import { describe, expect, it, vi } from "vitest";

import {
  MemorySampler,
  callSpeed,
  mean,
  parseFootprint,
  parseSwapUsedMiB,
  percentile,
  systemMemoryProbe,
  type MemoryProbe,
  type MemorySample
} from "./replay-metrics.ts";

describe("statistics", () => {
  it("takes the nearest-rank percentile and the mean", () => {
    const values = [5, 1, 4, 2, 3];
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 95)).toBe(5);
    expect(percentile(values, 5)).toBe(1);
    expect(percentile([], 50)).toBeNull();
    expect(mean(values)).toBe(3);
    expect(mean([])).toBeNull();
  });
});

describe("the speed of a call", () => {
  it("reads prefill up to the first text and decode after it", () => {
    expect(
      callSpeed({ inputTokens: 2_000, outputTokens: 101, wallMs: 5_000, ttftMs: 1_000 })
    ).toEqual({
      prefillTps: 2_000,
      decodeTps: 25
    });
  });

  it("counts every output token over the whole call when nothing streamed", () => {
    expect(callSpeed({ inputTokens: 100, outputTokens: 50, wallMs: 2_000, ttftMs: null })).toEqual({
      prefillTps: null,
      decodeTps: 25
    });
  });

  it("leaves a speed unknown when the counts or the times say nothing", () => {
    expect(
      callSpeed({ inputTokens: undefined, outputTokens: undefined, wallMs: 100, ttftMs: 50 })
    ).toEqual({
      prefillTps: null,
      decodeTps: null
    });
    expect(
      callSpeed({ inputTokens: 10, outputTokens: 1, wallMs: 100, ttftMs: 100 }).decodeTps
    ).toBeNull();
    expect(
      callSpeed({ inputTokens: 10, outputTokens: 5, wallMs: 100, ttftMs: 0 }).prefillTps
    ).toBeNull();
  });
});

describe("physical footprint", () => {
  it("reads the footprint and its peak from the tool's auxiliary data", () => {
    const text = [
      "zsh [49355]: 64-bit    Footprint: 2425216 B (16384 bytes per page)",
      "Auxiliary data:",
      "    phys_footprint: 2097152 B",
      "    phys_footprint_peak: 4194304 B"
    ].join("\n");
    expect(parseFootprint(text)).toEqual({ footprintMiB: 2, peakMiB: 4 });
    expect(parseFootprint("nothing")).toBeNull();
  });
});

describe("swap usage", () => {
  it("reads the used amount of vm.swapusage in MiB", () => {
    expect(parseSwapUsedMiB("total = 1024.00M  used = 120.50M  free = 903.50M  (encrypted)")).toBe(
      120.5
    );
    expect(parseSwapUsedMiB("total = 4.00G  used = 2.00G  free = 2.00G")).toBe(2048);
    expect(parseSwapUsedMiB("nothing")).toBeNull();
  });
});

function probeOf(samples: MemorySample[]): MemoryProbe & { pids: Array<number | undefined> } {
  const pids: Array<number | undefined> = [];
  let next = 0;
  return {
    pids,
    async sample(pid) {
      pids.push(pid);
      const sample = samples[Math.min(next, samples.length - 1)]!;
      next += 1;
      return sample;
    }
  };
}

describe("the memory sampler", () => {
  it("keeps the peak of the helper's memory and swap and the lowest memory level", async () => {
    const probe = probeOf([
      {
        helperRssMiB: 1_000,
        helperFootprintMiB: 2_000,
        helperFootprintPeakMiB: 2_500,
        swapUsedMiB: 50,
        memoryLevel: 70
      },
      {
        helperRssMiB: 9_000,
        helperFootprintMiB: 20_000,
        helperFootprintPeakMiB: 21_000,
        swapUsedMiB: 60,
        memoryLevel: 40
      },
      {
        helperRssMiB: 8_000,
        helperFootprintMiB: 19_000,
        helperFootprintPeakMiB: 21_000,
        swapUsedMiB: 55,
        memoryLevel: 60
      }
    ]);
    const sampler = new MemorySampler(probe, () => 4242, 60_000);
    sampler.start();
    await sampler.tick();
    await sampler.tick();
    const summary = await sampler.stop();
    expect(summary).toEqual({
      samples: 3,
      peakHelperRssMiB: 9_000,
      peakHelperFootprintMiB: 21_000,
      peakSwapUsedMiB: 60,
      minMemoryLevel: 40
    });
    expect(probe.pids.every((pid) => pid === 4242)).toBe(true);
  });

  it("never queues samples behind a slow probe: a due sample joins the one being read", async () => {
    const releases: Array<() => void> = [];
    const slow: MemoryProbe = {
      sample: () =>
        new Promise<MemorySample>((resolve) => {
          releases.push(() =>
            resolve({
              helperRssMiB: 1,
              helperFootprintMiB: null,
              helperFootprintPeakMiB: null,
              swapUsedMiB: null,
              memoryLevel: null
            })
          );
        })
    };
    const sampler = new MemorySampler(slow, () => undefined, 60_000);
    sampler.start();
    const joined = [sampler.tick(), sampler.tick(), sampler.tick()];
    expect(releases).toHaveLength(1);
    const stopping = sampler.stop();
    releases.shift()!();
    await Promise.all(joined);
    // The stop takes its own, last sample once the one being read ended.
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    releases.shift()!();
    expect((await stopping).samples).toBe(2);
  });

  it("treats a probe that fails as a gap, not a failure", async () => {
    const failing: MemoryProbe = {
      async sample() {
        throw new Error("no ps");
      }
    };
    const sampler = new MemorySampler(failing, () => undefined, 60_000);
    sampler.start();
    expect(await sampler.stop()).toEqual({
      samples: 0,
      peakHelperRssMiB: null,
      peakHelperFootprintMiB: null,
      peakSwapUsedMiB: null,
      minMemoryLevel: null
    });
  });
});

describe.runIf(process.platform === "darwin")("the machine's probe", () => {
  it("reads this process's memory with ps and the swap with sysctl", async () => {
    const sample = await systemMemoryProbe.sample(process.pid);
    expect(sample.helperRssMiB).toBeGreaterThan(0);
    expect(sample.helperFootprintPeakMiB === null || sample.helperFootprintPeakMiB > 0).toBe(true);
    expect(sample.swapUsedMiB === null || sample.swapUsedMiB >= 0).toBe(true);
  });

  it("reports no resident set for a process that is not there", async () => {
    expect((await systemMemoryProbe.sample(undefined)).helperRssMiB).toBeNull();
  });
});
