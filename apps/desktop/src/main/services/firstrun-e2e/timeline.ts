// The clock of the first-run end-to-end test (F4 T90, exit criterion E6). Pure: the runner feeds it
// the download events and the samples of its poll; this file keeps the instants and reduces them
// to the numbers E6 reports.
//
//   T0  app launch on an empty userData: the database starts, migrates, the services start.
//   T1  a note of the first source in a named topic with at least one shown relation.
//   D   the time on the critical path the live record spent waiting for the downloads: the moments
//       a model was downloading (or being verified) while nothing else could make progress.
import type { ModelDownloadEvent } from "../../../shared/app-events.js";

/** What the run is doing: starting, configuring (the first-run setup), importing, or draining. */
export type RunPhase = "launch" | "setup" | "user" | "drain";

/** Named instants of one run, as milliseconds since T0. */
export class Marks {
  private readonly at = new Map<string, number>();

  public constructor(
    public readonly t0: Date,
    private readonly now: () => Date = () => new Date(),
    /** Told once per name, when it is first reached (the runner logs it for whoever watches the run). */
    private readonly onMark?: (name: string, ms: number) => void
  ) {}

  /** Milliseconds since T0 of an instant (now when none is given). */
  public since(at: Date = this.now()): number {
    return Math.max(0, at.getTime() - this.t0.getTime());
  }

  /** Records the first time a name is reached; a later call keeps the first. */
  public mark(name: string, at: Date = this.now()): number {
    const existing = this.at.get(name);
    if (existing !== undefined) return existing;
    const ms = this.since(at);
    this.at.set(name, ms);
    this.onMark?.(name, ms);
    return ms;
  }

  public get(name: string): number | null {
    return this.at.get(name) ?? null;
  }

  public toObject(): Record<string, number> {
    return Object.fromEntries([...this.at].sort((a, b) => a[1] - b[1]));
  }
}

/**
 * Whether the harness itself is working (an import call, a class test): while it is, a download that
 * is also running is not on the critical path.
 */
export class Busy {
  private depth = 0;

  public get active(): boolean {
    return this.depth > 0;
  }

  public async during<T>(work: () => Promise<T>): Promise<T> {
    this.depth += 1;
    try {
      return await work();
    } finally {
      this.depth -= 1;
    }
  }
}

/** One local model's install as the download events told it. */
export interface ModelInstallTrace {
  catalogId: string;
  /** The first event of the install (downloading or verifying), as milliseconds since T0. */
  requestedAtMs: number | null;
  readyAtMs: number | null;
  failedAtMs: number | null;
  /** The size the install announced. */
  totalBytes: number;
  downloadedBytes: number;
  error: string | null;
  /** Events heard for this model. */
  events: number;
}

/** Follows the `model.download` events: when each model was requested, when it was ready. */
export class DownloadTrace {
  private readonly installs = new Map<string, ModelInstallTrace>();
  private readonly active = new Set<string>();

  public constructor(private readonly marks: Pick<Marks, "since">) {}

  public record(event: ModelDownloadEvent, at: Date = new Date()): void {
    const ms = this.marks.since(at);
    const install = this.installs.get(event.catalogId) ?? {
      catalogId: event.catalogId,
      requestedAtMs: null,
      readyAtMs: null,
      failedAtMs: null,
      totalBytes: 0,
      downloadedBytes: 0,
      error: null,
      events: 0
    };
    install.events += 1;
    install.totalBytes = Math.max(install.totalBytes, event.totalBytes);
    install.downloadedBytes = event.downloadedBytes;
    if (event.status === "downloading" || event.status === "verifying") {
      // A new request after a failure starts a new install.
      if (install.requestedAtMs === null || install.failedAtMs !== null) {
        install.requestedAtMs = ms;
        install.readyAtMs = null;
        install.failedAtMs = null;
        install.error = null;
      }
      this.active.add(event.catalogId);
    } else {
      this.active.delete(event.catalogId);
      if (event.status === "ready") {
        install.requestedAtMs ??= ms;
        install.readyAtMs = ms;
      } else if (event.status === "failed") {
        install.failedAtMs = ms;
        install.error = event.error;
      }
    }
    this.installs.set(event.catalogId, install);
  }

  /** Whether any model is downloading or being verified now. */
  public downloading(): boolean {
    return this.active.size > 0;
  }

  public get(catalogId: string): ModelInstallTrace | null {
    const install = this.installs.get(catalogId);
    return install ? { ...install } : null;
  }

  public all(): ModelInstallTrace[] {
    return [...this.installs.values()]
      .map((install) => ({ ...install }))
      .sort((a, b) => (a.requestedAtMs ?? Infinity) - (b.requestedAtMs ?? Infinity));
  }

  /** The first request to the last model ready, across the installs that got there; null if none did. */
  public window(): { startMs: number; endMs: number; ms: number } | null {
    const installs = this.all().filter(
      (install) => install.requestedAtMs !== null && install.readyAtMs !== null
    );
    if (installs.length === 0) return null;
    const startMs = Math.min(...installs.map((install) => install.requestedAtMs!));
    const endMs = Math.max(...installs.map((install) => install.readyAtMs!));
    return { startMs, endMs, ms: Math.max(0, endMs - startMs) };
  }
}

/** One reading of the poll: whether a download was running and whether anything else could progress. */
export interface PipelineSample {
  /** Milliseconds since T0. */
  atMs: number;
  phase: RunPhase;
  downloading: boolean;
  /** A job ran or was due, an ingestion run was unfinished, or the harness itself was working. */
  busy: boolean;
  /** What the Gardener's status said at that instant, read while a download held everything up. */
  status?: StatusReading;
}

/** The part of the Gardener's status (T86, `GardenerStatusService.snapshot()`) the first run reads. */
export interface StatusReading {
  state: string;
  class?: string | undefined;
  reason?: string | undefined;
  /**
   * The Gardener's tasks that waited at that moment (queued, set aside or due later). A status read
   * without the count is held to the stricter rule: it must name a class.
   */
  held?: number;
}

export interface StatusAtStalls {
  /** Samples where a download held everything up and the status was read. */
  stalls: number;
  /** Of those, the ones where a Gardener task waited and the sentence named no class (E5 (i)). */
  unexplained: number;
  /** Of those, the ones where no Gardener task waited: `idle` is the right sentence there (T86). */
  quiet: number;
  /** The blocker classes the status named, with how often (`idle` or `running` when none). */
  classes: Record<string, number>;
}

/**
 * What the status said while the run waited for a download (E5 (i) on the first run): a moment at
 * which a Gardener task waits needs a sentence that names why, so one without a class there is
 * unexplained. With nothing waiting, the product says the Gardener is idle (T86: a download explains
 * only the work it holds up), which is right.
 */
export function statusAtStalls(samples: readonly PipelineSample[]): StatusAtStalls {
  const result: StatusAtStalls = { stalls: 0, unexplained: 0, quiet: 0, classes: {} };
  for (const sample of samples) {
    if (!sample.downloading || sample.busy || !sample.status) continue;
    result.stalls += 1;
    const named = sample.status.class ?? sample.status.state;
    result.classes[named] = (result.classes[named] ?? 0) + 1;
    if (sample.status.held === 0) result.quiet += 1;
    else if (!sample.status.class) result.unexplained += 1;
  }
  return result;
}

export interface CriticalPathDownload {
  /** D: the sum of the intervals that began with a download and nothing else to do. */
  totalMs: number;
  /** The part of D in the first-run setup (the person waits for the embedding model). */
  setupMs: number;
  /** The part of D after the setup (the imports wait for a model). */
  userMs: number;
  /** Intervals counted. */
  stalls: number;
}

/**
 * D from the samples: each sample holds until the next one (the last until `endMs`), and counts when a
 * model was downloading and nothing was busy. The setup and the user's part are told apart by the
 * phase the sample was taken in.
 */
export function criticalPathDownload(
  samples: readonly PipelineSample[],
  endMs: number
): CriticalPathDownload {
  const result: CriticalPathDownload = { totalMs: 0, setupMs: 0, userMs: 0, stalls: 0 };
  const ordered = [...samples].sort((a, b) => a.atMs - b.atMs);
  for (const [index, sample] of ordered.entries()) {
    const until = ordered[index + 1]?.atMs ?? endMs;
    const length = Math.max(0, Math.min(until, endMs) - sample.atMs);
    if (length === 0 || !sample.downloading || sample.busy) continue;
    result.totalMs += length;
    result.stalls += 1;
    if (sample.phase === "setup" || sample.phase === "launch") result.setupMs += length;
    else result.userMs += length;
  }
  return result;
}

export interface Sampler {
  /** Takes one more reading at once. */
  tick(): Promise<void>;
  /** Stops and returns every sample. */
  stop(): Promise<PipelineSample[]>;
}

/**
 * Reads the pipeline every `intervalMs` until stopped. A reading that throws is skipped (the next
 * one is taken on time): a sampler never fails the run it measures.
 */
export function startSampler(options: {
  intervalMs: number;
  marks: Pick<Marks, "since">;
  phase: () => RunPhase;
  read: () => Promise<{ downloading: boolean; busy: boolean; status?: StatusReading }>;
  sleep?: (ms: number) => Promise<void>;
}): Sampler {
  const samples: PipelineSample[] = [];
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        setTimeout(done, ms).unref?.();
      }));
  let stopped = false;
  let wake: () => void = () => undefined;
  const stopSignal = new Promise<void>((done) => {
    wake = done;
  });
  const tick = async (): Promise<void> => {
    const atMs = options.marks.since();
    const phase = options.phase();
    try {
      const reading = await options.read();
      samples.push({ atMs, phase, ...reading });
    } catch {
      // Skipped.
    }
  };
  const loop = (async () => {
    while (!stopped) {
      await tick();
      if (stopped) break;
      await Promise.race([sleep(options.intervalMs), stopSignal]);
    }
  })();
  return {
    tick,
    stop: async () => {
      stopped = true;
      wake();
      await loop;
      return samples.toSorted((a, b) => a.atMs - b.atMs);
    }
  };
}
