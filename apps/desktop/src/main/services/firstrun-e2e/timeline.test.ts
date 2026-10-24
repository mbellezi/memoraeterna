import { describe, expect, it } from "vitest";

import type { ModelDownloadEvent } from "../../../shared/app-events.js";
import {
  Busy,
  DownloadTrace,
  Marks,
  criticalPathDownload,
  startSampler,
  statusAtStalls
} from "./timeline.js";
import type { PipelineSample } from "./timeline.js";

const t0 = new Date("2026-10-24T12:00:00.000Z");
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

function event(
  catalogId: string,
  status: ModelDownloadEvent["status"],
  overrides: Partial<ModelDownloadEvent> = {}
): ModelDownloadEvent {
  return {
    type: "model.download",
    localModelId: "00000000-0000-4000-8000-000000000001",
    catalogId,
    status,
    currentFile: null,
    downloadedBytes: 0,
    totalBytes: 1000,
    bytesPerSecond: 0,
    etaSeconds: null,
    error: null,
    ...overrides
  };
}

describe("the marks of a run", () => {
  it("counts milliseconds from T0 and keeps the first time a name is reached", () => {
    let clock = at(0);
    const marks = new Marks(t0, () => clock);
    clock = at(2);
    expect(marks.mark("launch.database")).toBe(2000);
    clock = at(5);
    expect(marks.mark("launch.database")).toBe(2000);
    expect(marks.mark("t1", at(90))).toBe(90_000);
    expect(marks.get("t1")).toBe(90_000);
    expect(marks.get("missing")).toBeNull();
    expect(Object.keys(marks.toObject())).toEqual(["launch.database", "t1"]);
    expect(marks.since(at(-3))).toBe(0);
  });
});

describe("the marks told to a watcher", () => {
  it("tell it once per name, with the milliseconds since T0", () => {
    const heard: Array<[string, number]> = [];
    const marks = new Marks(
      t0,
      () => at(7),
      (name, ms) => heard.push([name, ms])
    );
    marks.mark("launch.database");
    marks.mark("launch.database");
    marks.mark("t1", at(40));
    expect(heard).toEqual([
      ["launch.database", 7000],
      ["t1", 40_000]
    ]);
  });
});

describe("the download trace", () => {
  it("records when each model was requested and when it was ready", () => {
    const trace = new DownloadTrace(new Marks(t0));
    expect(trace.downloading()).toBe(false);
    trace.record(event("embedder", "downloading"), at(1));
    trace.record(event("embedder", "downloading", { downloadedBytes: 500 }), at(2));
    expect(trace.downloading()).toBe(true);
    trace.record(event("embedder", "verifying", { downloadedBytes: 1000 }), at(3));
    trace.record(event("embedder", "ready", { downloadedBytes: 1000 }), at(4));
    trace.record(event("ranker", "downloading", { totalBytes: 2000 }), at(4));
    expect(trace.downloading()).toBe(true);
    trace.record(event("ranker", "ready", { totalBytes: 2000 }), at(10));
    expect(trace.downloading()).toBe(false);
    expect(trace.get("embedder")).toMatchObject({
      requestedAtMs: 1000,
      readyAtMs: 4000,
      failedAtMs: null,
      totalBytes: 1000,
      events: 4
    });
    expect(trace.all().map((install) => install.catalogId)).toEqual(["embedder", "ranker"]);
    expect(trace.window()).toEqual({ startMs: 1000, endMs: 10_000, ms: 9000 });
  });

  it("keeps a failure and starts a new install on a new request", () => {
    const trace = new DownloadTrace(new Marks(t0));
    trace.record(event("ranker", "downloading"), at(1));
    trace.record(
      event("ranker", "failed", { error: "errors.localModels.checksumMismatch" }),
      at(2)
    );
    expect(trace.downloading()).toBe(false);
    expect(trace.get("ranker")).toMatchObject({
      requestedAtMs: 1000,
      failedAtMs: 2000,
      error: "errors.localModels.checksumMismatch"
    });
    expect(trace.window()).toBeNull();
    trace.record(event("ranker", "downloading"), at(5));
    trace.record(event("ranker", "ready"), at(6));
    expect(trace.get("ranker")).toMatchObject({
      requestedAtMs: 5000,
      readyAtMs: 6000,
      failedAtMs: null,
      error: null
    });
  });

  it("reports a model that was ready at once (installed earlier) with its own instant", () => {
    const trace = new DownloadTrace(new Marks(t0));
    trace.record(event("embedder", "ready"), at(3));
    expect(trace.get("embedder")).toMatchObject({ requestedAtMs: 3000, readyAtMs: 3000 });
    expect(trace.downloading()).toBe(false);
  });
});

const sample = (
  atMs: number,
  phase: PipelineSample["phase"],
  downloading: boolean,
  busy: boolean
): PipelineSample => ({ atMs, phase, downloading, busy });

describe("D, the download time on the critical path", () => {
  it("counts only the moments a model was downloading and nothing else could progress", () => {
    const samples = [
      sample(0, "launch", false, true),
      // The setup waits for the embedder: 4 s with a download and nothing busy.
      sample(2000, "setup", true, false),
      sample(4000, "setup", true, false),
      // The first source imports while the ranker downloads: busy, not on the path.
      sample(6000, "user", true, true),
      sample(10_000, "user", true, true),
      // The imports are done and the ranker is still coming: 5 s on the path.
      sample(12_000, "user", true, false),
      sample(15_000, "user", true, false),
      sample(17_000, "user", false, false)
    ];
    expect(criticalPathDownload(samples, 20_000)).toEqual({
      totalMs: 4000 + 5000,
      setupMs: 4000,
      userMs: 5000,
      stalls: 4
    });
  });

  it("is zero when the downloads always overlapped the work, and when none ran", () => {
    expect(
      criticalPathDownload(
        [
          sample(0, "setup", true, true),
          sample(1000, "user", true, true),
          sample(2000, "user", false, false)
        ],
        5000
      ).totalMs
    ).toBe(0);
    expect(criticalPathDownload([], 5000)).toEqual({
      totalMs: 0,
      setupMs: 0,
      userMs: 0,
      stalls: 0
    });
  });

  it("stops at the end it is given and ignores samples out of order", () => {
    const samples = [sample(3000, "setup", true, false), sample(0, "setup", true, false)];
    expect(criticalPathDownload(samples, 2000).totalMs).toBe(2000);
    expect(criticalPathDownload(samples, 10_000).totalMs).toBe(10_000);
  });
});

describe("the status while the run waited for a download", () => {
  it("counts the readings of a wait, names the classes and finds the ones that said nothing was wrong", () => {
    const wait = (status: PipelineSample["status"]): PipelineSample => ({
      atMs: 0,
      phase: "setup",
      downloading: true,
      busy: false,
      ...(status ? { status } : {})
    });
    const samples: PipelineSample[] = [
      wait({ state: "blocked", class: "download", reason: "model_downloading", held: 3 }),
      wait({ state: "blocked", class: "download", reason: "model_downloading" }),
      wait({ state: "blocked", class: "no_model", reason: "no_decider" }),
      // A task waits and the sentence names no class: unexplained (E5 (i)).
      wait({ state: "idle" }),
      wait({ state: "running", held: 2 }),
      // Nothing of the Gardener's waits: idle is the right sentence (T86), and it is counted apart.
      wait({ state: "idle", held: 0 }),
      // Not a wait: the pipeline was busy, or nothing was downloading, or no status was read.
      { atMs: 1, phase: "user", downloading: true, busy: true, status: { state: "running" } },
      { atMs: 2, phase: "user", downloading: false, busy: false, status: { state: "idle" } },
      wait(undefined)
    ];
    expect(statusAtStalls(samples)).toEqual({
      stalls: 6,
      unexplained: 2,
      quiet: 1,
      classes: { download: 2, no_model: 1, idle: 2, running: 1 }
    });
    expect(statusAtStalls([])).toEqual({ stalls: 0, unexplained: 0, quiet: 0, classes: {} });
  });
});

describe("the busy flag of the harness", () => {
  it("is active while the work it wraps runs, also when the work throws", async () => {
    const busy = new Busy();
    expect(busy.active).toBe(false);
    let inside = false;
    await busy.during(async () => {
      inside = busy.active;
    });
    expect(inside).toBe(true);
    expect(busy.active).toBe(false);
    await expect(
      busy.during(async () => {
        throw new Error("x");
      })
    ).rejects.toThrow("x");
    expect(busy.active).toBe(false);
    const both = Promise.all([
      busy.during(async () => busy.active),
      busy.during(async () => busy.active)
    ]);
    await expect(both).resolves.toEqual([true, true]);
  });
});

describe("the sampler", () => {
  it("reads on every tick with the phase and the clock, skips a reading that throws, and stops at once", async () => {
    let clock = 0;
    let phase: "setup" | "user" = "setup";
    let calls = 0;
    const sampler = startSampler({
      intervalMs: 1_000_000,
      marks: { since: () => clock },
      phase: () => phase,
      read: async () => {
        calls += 1;
        if (calls === 3) throw new Error("the database is closing");
        return { downloading: calls % 2 === 1, busy: false };
      }
    });
    // The first reading is taken at once; the others on demand.
    await sampler.tick();
    clock = 5;
    phase = "user";
    await sampler.tick();
    await sampler.tick();
    const samples = await sampler.stop();
    expect(samples).toEqual([
      { atMs: 0, phase: "setup", downloading: true, busy: false },
      { atMs: 0, phase: "setup", downloading: false, busy: false },
      { atMs: 5, phase: "user", downloading: false, busy: false }
    ]);
  });
});
