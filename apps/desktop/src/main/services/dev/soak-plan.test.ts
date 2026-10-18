import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { catalogHeaderPolicy } from "../catalog-header-policy.js";
import { buildTimeline } from "./soak-driver.js";
import {
  SoakKnobRefusal,
  fakeRemoteKnobName,
  readSoakKnob,
  readSoakPlan,
  soakKnobName,
  soakRequested
} from "./soak-plan.js";
import { loadLatencyModel } from "./fake-remote-install.js";
import { prepareSoak } from "./soak-startup.js";

const repository = resolve(import.meta.dirname, "../../../../../..");
const planPath = join(repository, "scripts", "soak", "plan.json");

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A workspace with the plan copied in and a profile folder inside `.cache/profiles/`. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), "soak-plan-"));
  scratch.push(root);
  mkdirSync(join(root, "scripts", "soak"), { recursive: true });
  mkdirSync(join(root, ".cache", "profiles", "env-soak"), { recursive: true });
  const plan = join(root, "scripts", "soak", "plan.json");
  writeFileSync(plan, readFileSync(planPath, "utf8"));
  writeFileSync(join(root, "scripts", "soak", "other.json"), readFileSync(planPath, "utf8"));
  return { root, userDataPath: join(root, ".cache", "profiles", "env-soak") };
}

const knobs = {
  [fakeRemoteKnobName]: "scripts/soak/plan.json",
  [soakKnobName]: "scripts/soak/plan.json"
};

describe("the soak plan", () => {
  it("holds the 24 h soak and the 4 h pre-soak, both valid", () => {
    expect(readSoakPlan(planPath, "soak24").profile).toMatchObject({
      seed: 20261021,
      durationHours: 24
    });
    expect(readSoakPlan(planPath, "presoak4").profile.durationHours).toBe(4);
    expect(() => readSoakPlan(planPath, "soak25")).toThrow(/no profile soak25/u);
  });

  it("follows the driver of spec 5.9 over 24 hours", () => {
    const { profile } = readSoakPlan(planPath, "soak24");
    const timeline = buildTimeline(profile);
    const count = (kind: string) => timeline.filter((entry) => entry.kind === kind).length;
    expect(count("article")).toBe(72);
    expect(count("ask")).toBe(144);
    expect(count("explain")).toBe(288);
    expect(count("explain_burst")).toBe(24);
    expect(count("note_edit")).toBe(12);
    expect(count("source_reimport")).toBe(4);
    expect(count("typing_fault")).toBe(6);
    expect(count("gguf_abort")).toBe(3);
    // One helper kill every 3 h, plus or minus 30 minutes.
    const kills = timeline
      .filter((entry) => entry.kind === "mlx_kill")
      .map((entry) => entry.atMs / 60_000);
    expect(kills.length).toBeGreaterThanOrEqual(7);
    expect(kills.length).toBeLessThanOrEqual(8);
    kills.forEach((minute, index) => {
      expect(Math.abs(minute - (index + 1) * 180)).toBeLessThanOrEqual(30);
    });
    // The outage of the Codex-wire fake at hour 6 gets a probe 35 s after its end.
    const probe = timeline.find((entry) => entry.kind === "post_outage_probe");
    expect(probe?.atMs).toBe((362 + 15) * 60_000 + 35_000);
    expect(timeline.map((entry) => entry.atMs)).toEqual(
      timeline.map((entry) => entry.atMs).toSorted((a, b) => a - b)
    );
  });

  it("is the same timeline for the same seed, another for another seed", () => {
    const { profile } = readSoakPlan(planPath, "soak24");
    expect(buildTimeline(profile)).toEqual(buildTimeline(profile));
    const kills = (seed: number) =>
      buildTimeline({ ...profile, seed })
        .filter((entry) => entry.kind === "mlx_kill")
        .map((entry) => entry.atMs);
    expect(kills(profile.seed + 1)).not.toEqual(kills(profile.seed));
  });

  it("gives the pre-soak a forced burst of every fault kind on both fakes", () => {
    const { profile } = readSoakPlan(planPath, "presoak4");
    const forced = (fake: "openAiCompatible" | "codexWire") =>
      new Set(profile.remote[fake].faults.forced.map((entry) => entry.kind));
    for (const kind of [
      "rate_limit",
      "unavailable",
      "stall",
      "late_first_byte",
      "malformed"
    ] as const) {
      expect(forced("openAiCompatible").has(kind)).toBe(true);
      expect(forced("codexWire").has(kind)).toBe(true);
    }
    expect(profile.remote.codexWire.faults.windows).toEqual([
      expect.objectContaining({ kind: "outage" })
    ]);
    expect(profile.remote.openAiCompatible.faults.windows).toEqual([
      expect.objectContaining({ kind: "slow", factor: 10 })
    ]);
  });
});

describe("the knobs", () => {
  it("are off when unset", () => {
    const { root, userDataPath } = workspace();
    expect(
      prepareSoak({ env: {}, isPackaged: false, workspaceRoot: root, userDataPath })
    ).toBeNull();
    expect(soakRequested({}, { isPackaged: false, workspaceRoot: root, userDataPath })).toBe(false);
  });

  it("are refused when packaged", () => {
    const { root, userDataPath } = workspace();
    expect(() =>
      readSoakKnob(fakeRemoteKnobName, knobs, {
        isPackaged: true,
        workspaceRoot: root,
        userDataPath
      })
    ).toThrow(expect.objectContaining({ code: "packaged" }));
  });

  it("are refused on a profile that is not a clone inside .cache/profiles/", () => {
    const { root } = workspace();
    for (const userDataPath of [
      join(root, "library"),
      join(root, ".cache", "profiles"),
      tmpdir()
    ]) {
      expect(() =>
        readSoakKnob(soakKnobName, knobs, { isPackaged: false, workspaceRoot: root, userDataPath })
      ).toThrow(expect.objectContaining({ code: "outsideProfiles" }));
    }
  });

  it("are refused together with another DEV measurement knob", () => {
    const { root, userDataPath } = workspace();
    for (const other of ["MEMORA_AI_CASSETTE", "MEMORA_GOLDEN_RUN", "MEMORA_DEV_EXPLAIN_PROBE"]) {
      expect(() =>
        readSoakKnob(
          fakeRemoteKnobName,
          { ...knobs, [other]: "1" },
          { isPackaged: false, workspaceRoot: root, userDataPath }
        )
      ).toThrow(expect.objectContaining({ code: "conflictingKnob" }));
    }
  });

  it("refuse the driver without the fake providers, so a real remote route never takes the soak", () => {
    const { root, userDataPath } = workspace();
    expect(() =>
      readSoakKnob(
        soakKnobName,
        { [soakKnobName]: "scripts/soak/plan.json" },
        { isPackaged: false, workspaceRoot: root, userDataPath }
      )
    ).toThrow(expect.objectContaining({ code: "needsFakeRemote" }));
  });

  it("read the profile named by MEMORA_SOAK_PROFILE and refuse one that is not in the plan", () => {
    const { root, userDataPath } = workspace();
    const options = { isPackaged: false, workspaceRoot: root, userDataPath };
    expect(readSoakKnob(soakKnobName, knobs, options)?.profileName).toBe("soak24");
    expect(
      readSoakKnob(soakKnobName, { ...knobs, MEMORA_SOAK_PROFILE: "presoak4" }, options)?.profile
        .durationHours
    ).toBe(4);
    expect(() =>
      readSoakKnob(soakKnobName, { ...knobs, MEMORA_SOAK_PROFILE: "week" }, options)
    ).toThrow(SoakKnobRefusal);
  });

  it("refuse a plan outside the repository and two different plans", () => {
    const { root, userDataPath } = workspace();
    const options = { isPackaged: false, workspaceRoot: root, userDataPath };
    expect(() =>
      readSoakKnob(fakeRemoteKnobName, { [fakeRemoteKnobName]: "../plan.json" }, options)
    ).toThrow(expect.objectContaining({ code: "invalidPlan" }));
    expect(() =>
      prepareSoak({
        env: {
          [fakeRemoteKnobName]: "scripts/soak/other.json",
          [soakKnobName]: "scripts/soak/plan.json"
        },
        ...options
      })
    ).toThrow(expect.objectContaining({ code: "invalidPlan" }));
  });

  it("prepare a run directory under .cache/f3/soak and arm the AI service flag", () => {
    const { root, userDataPath } = workspace();
    const prepared = prepareSoak({
      env: knobs,
      isPackaged: false,
      workspaceRoot: root,
      userDataPath,
      now: () => new Date("2026-10-18T10:00:00Z"),
      logger: { error: () => undefined, info: () => undefined }
    });
    expect(prepared?.mode).toBe("soak");
    expect(prepared?.honourTreatAsRemote).toBe(true);
    expect(prepared?.directory).toBe(join(root, ".cache", "f3", "soak", "soak24-20261018T100000"));
  });
});

describe("the catalog-header catch-up under the soak", () => {
  it("stays on: the soak runs the product's behaviour, not a measurement run's", () => {
    expect(
      catalogHeaderPolicy({
        [fakeRemoteKnobName]: "scripts/soak/plan.json",
        [soakKnobName]: "scripts/soak/plan.json",
        MEMORA_SOAK_PROFILE: "soak24"
      })
    ).toEqual({ refresh: "on", reason: null });
  });

  it("is refused off, so a soak cannot quietly run without it", () => {
    const { root, userDataPath } = workspace();
    expect(() =>
      readSoakKnob(
        soakKnobName,
        { ...knobs, MEMORA_CATALOG_HEADERS: "off" },
        { isPackaged: false, workspaceRoot: root, userDataPath }
      )
    ).toThrow(expect.objectContaining({ code: "catalogHeadersOff" }));
  });
});

describe("the latency of the fakes", () => {
  const spec = {
    fit: ".cache/f3/soak/latency-fit.json",
    task: "summarization",
    fixedMs: 2_000,
    minMs: 400,
    maxMs: 60_000,
    firstByteFraction: 0.3
  };
  const fitFile = {
    format: "memora-soak-latency-fit",
    version: 1,
    generatedAt: "2026-10-18T10:00:00.000Z",
    sources: [".cache/golden/cassettes/x"],
    tasks: {
      summarization: {
        count: 3,
        quantilesMs: [1_000, 2_000, 3_000, 5_000, 90_000],
        p50: 3_000,
        p90: 80_000,
        p99: 90_000
      }
    }
  };

  it("draws from the fit of the task the plan names, within its bounds", () => {
    const { root } = workspace();
    mkdirSync(join(root, ".cache", "f3", "soak"), { recursive: true });
    writeFileSync(join(root, ".cache", "f3", "soak", "latency-fit.json"), JSON.stringify(fitFile));
    const model = loadLatencyModel(spec, root);
    expect(model.sample(0)).toBe(1_000);
    expect(model.sample(0.5)).toBe(3_000);
    expect(model.sample(0.9999)).toBe(60_000);
  });

  it("uses the fixed time without a fit, and refuses a missing fit or task instead of guessing", () => {
    const { root } = workspace();
    expect(loadLatencyModel({ ...spec, fit: null }, root).sample(0.3)).toBe(2_000);
    expect(() => loadLatencyModel(spec, root)).toThrow(/latency fit .* missing or invalid/u);
    mkdirSync(join(root, ".cache", "f3", "soak"), { recursive: true });
    writeFileSync(join(root, ".cache", "f3", "soak", "latency-fit.json"), JSON.stringify(fitFile));
    expect(() => loadLatencyModel({ ...spec, task: "reranking" }, root)).toThrow(
      /no task reranking/u
    );
  });
});
