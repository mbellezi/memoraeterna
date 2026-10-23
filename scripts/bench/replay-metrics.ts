/**
 * Measurements of the prompt-replay harness (F4 T69): speed of a call from its token counts and its
 * clock, the memory the writer's helper held while it ran and the swap the machine used, and the small
 * statistics the report needs. Probes are injected so tests never read the machine.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const mib = 1024 * 1024;

export function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** The p-th percentile (0-100, nearest rank) of a list, or null when it is empty. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1]!;
}

export interface CallSpeed {
  /** Prompt tokens per second until the first answer text; null when the call did not stream. */
  prefillTps: number | null;
  /** Tokens per second after the first answer text; null when it cannot be told. */
  decodeTps: number | null;
}

/**
 * Speed of one call. The first answer text arrives after the prompt was read and one token was
 * written, so prefill is the prompt over the time to first text and decode is the remaining output
 * tokens over the remaining time. Counts the runtime does not report leave the speed unknown.
 */
export function callSpeed(input: {
  inputTokens: number | undefined;
  outputTokens: number | undefined;
  wallMs: number;
  ttftMs: number | null | undefined;
}): CallSpeed {
  const { inputTokens, outputTokens, wallMs, ttftMs } = input;
  const prefillTps =
    inputTokens !== undefined && ttftMs != null && ttftMs > 0
      ? inputTokens / (ttftMs / 1000)
      : null;
  const decodeMs = ttftMs != null ? wallMs - ttftMs : wallMs;
  const decodeTps =
    outputTokens !== undefined && outputTokens > 1 && decodeMs > 0
      ? (outputTokens - (ttftMs != null ? 1 : 0)) / (decodeMs / 1000)
      : null;
  return { prefillTps, decodeTps };
}

/** `vm.swapusage` as `total = 1024.00M  used = 120.50M  free = 903.50M  (encrypted)`; MiB used, or null. */
export function parseSwapUsedMiB(text: string): number | null {
  const match = /used\s*=\s*([\d.]+)\s*([KMGT])/iu.exec(text);
  if (!match) return null;
  const scale: Record<string, number> = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024 };
  return Number(match[1]) * scale[match[2]!.toUpperCase()]!;
}

/**
 * `phys_footprint` and its lifetime peak from `footprint -f bytes --noCategories`: the figure Activity
 * Monitor calls Memory, which counts the GPU buffers MLX allocates and the resident set does not.
 */
export function parseFootprint(text: string): { footprintMiB: number; peakMiB: number } | null {
  const current = /phys_footprint:\s*(\d+)\s*B/u.exec(text)?.[1];
  const peak = /phys_footprint_peak:\s*(\d+)\s*B/u.exec(text)?.[1];
  if (current === undefined || peak === undefined) return null;
  return { footprintMiB: Number(current) / mib, peakMiB: Number(peak) / mib };
}

export interface MemorySample {
  /** Resident set of the writer's helper process, in MiB; null when there is none to read. */
  helperRssMiB: number | null;
  /** The helper's physical footprint now and its peak since it started, in MiB. */
  helperFootprintMiB: number | null;
  helperFootprintPeakMiB: number | null;
  swapUsedMiB: number | null;
  /** `kern.memorystatus_level`: the percentage of memory the system still calls available. */
  memoryLevel: number | null;
}

export interface MemoryProbe {
  sample(pid: number | undefined): Promise<MemorySample>;
}

async function readCommand(command: string, args: string[]): Promise<string | null> {
  try {
    return (await execFileAsync(command, args, { timeout: 5_000 })).stdout;
  } catch {
    return null;
  }
}

/** The machine's own probes: `ps` for the helper, `sysctl` for swap and the memory level. */
export const systemMemoryProbe: MemoryProbe = {
  async sample(pid) {
    const [rss, footprint, swap, level] = await Promise.all([
      pid === undefined
        ? Promise.resolve(null)
        : readCommand("ps", ["-o", "rss=", "-p", String(pid)]),
      pid === undefined
        ? Promise.resolve(null)
        : readCommand("footprint", ["-p", String(pid), "-f", "bytes", "--noCategories"]),
      readCommand("sysctl", ["-n", "vm.swapusage"]),
      readCommand("sysctl", ["-n", "kern.memorystatus_level"])
    ]);
    const rssKiB = rss === null ? Number.NaN : Number(rss.trim());
    const levelValue = level === null ? Number.NaN : Number(level.trim());
    const physical = footprint === null ? null : parseFootprint(footprint);
    return {
      helperRssMiB: Number.isFinite(rssKiB) ? rssKiB / 1024 : null,
      helperFootprintMiB: physical?.footprintMiB ?? null,
      helperFootprintPeakMiB: physical?.peakMiB ?? null,
      swapUsedMiB: swap === null ? null : parseSwapUsedMiB(swap),
      memoryLevel: Number.isFinite(levelValue) ? levelValue : null
    };
  }
};

export interface MemorySummary {
  samples: number;
  peakHelperRssMiB: number | null;
  /** The highest physical-footprint peak the helper reported during the window. */
  peakHelperFootprintMiB: number | null;
  peakSwapUsedMiB: number | null;
  minMemoryLevel: number | null;
}

function reduceSamples(samples: readonly MemorySample[]): MemorySummary {
  const numbers = (pick: (sample: MemorySample) => number | null) =>
    samples.map(pick).filter((value): value is number => value !== null);
  const rss = numbers((sample) => sample.helperRssMiB);
  const footprint = samples.flatMap((sample) =>
    [sample.helperFootprintMiB, sample.helperFootprintPeakMiB].filter(
      (value): value is number => value !== null
    )
  );
  const swap = numbers((sample) => sample.swapUsedMiB);
  const level = numbers((sample) => sample.memoryLevel);
  return {
    samples: samples.length,
    peakHelperRssMiB: rss.length === 0 ? null : Math.max(...rss),
    peakHelperFootprintMiB: footprint.length === 0 ? null : Math.max(...footprint),
    peakSwapUsedMiB: swap.length === 0 ? null : Math.max(...swap),
    minMemoryLevel: level.length === 0 ? null : Math.min(...level)
  };
}

/**
 * Samples memory while a window is open: once at the start, every `intervalMs`, and once at the stop.
 * A probe that fails leaves its field empty for that sample; sampling never fails a call. A sample that
 * is still being read when the next one is due is not queued behind: the due sample joins it, so a slow
 * probe never makes the stop wait for a backlog.
 */
export class MemorySampler {
  private readonly samples: MemorySample[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;

  public constructor(
    private readonly probe: MemoryProbe,
    private readonly pid: () => number | undefined,
    private readonly intervalMs = 1_000
  ) {}

  public start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** Takes one sample now, or joins the one being read (the timer calls it; tests call it directly). */
  public tick(): Promise<void> {
    if (this.running) return this.running;
    const run = (async () => {
      try {
        this.samples.push(await this.probe.sample(this.pid()));
      } catch {
        // A sample that cannot be read is a gap, not a failure.
      }
    })().finally(() => {
      this.running = null;
    });
    this.running = run;
    return run;
  }

  public async stop(): Promise<MemorySummary> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
    await this.tick();
    return reduceSamples(this.samples);
  }
}
