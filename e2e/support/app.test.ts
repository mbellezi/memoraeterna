import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readSoakPlan } from "../../apps/desktop/src/main/services/dev/soak-plan.js";
import { cassetteMisses, fakeRemotePlan, journeyEnvironment } from "./app.js";
import { repositoryRoot } from "./profile.js";

describe("journeyEnvironment", () => {
  it("drops inherited MEMORA_ knobs and Electron overrides, keeps the rest and the sidecar root", () => {
    const env = journeyEnvironment(
      {
        PATH: "/bin",
        HOME: "/home/x",
        MEMORA_SOAK: "scripts/soak/plan.json",
        MEMORA_AI_CASSETTE_LOCAL_MISSES: "live",
        MEMORA_POSTGRES_SIDECAR_ROOT: "/vendor/sidecars",
        ELECTRON_RUN_AS_NODE: "1",
        ELECTRON_RENDERER_URL: "http://localhost:5173",
        UNSET: undefined
      },
      { MEMORA_USER_DATA_DIR: "/scratch/p", MEMORA_IPC_TRACE: "1" }
    );
    expect(env).toEqual({
      PATH: "/bin",
      HOME: "/home/x",
      MEMORA_POSTGRES_SIDECAR_ROOT: "/vendor/sidecars",
      MEMORA_USER_DATA_DIR: "/scratch/p",
      MEMORA_IPC_TRACE: "1"
    });
  });

  it("refuses the knobs a journey never sets", () => {
    expect(() => journeyEnvironment({}, { MEMORA_AI_CASSETTE_LOCAL_MISSES: "live" })).toThrow();
    expect(() => journeyEnvironment({}, { MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE: "1" })).toThrow();
  });
});

describe("cassetteMisses", () => {
  it("counts a run's misses per task type without reading their content further", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journeys-cassette-"));
    try {
      expect(await cassetteMisses(dir)).toEqual({ total: 0, byTask: {} });
      await mkdir(join(dir, "misses"));
      await writeFile(join(dir, "misses", "a.json"), JSON.stringify({ taskType: "embedding" }));
      await writeFile(join(dir, "misses", "b.json"), JSON.stringify({ taskType: "embedding" }));
      await writeFile(join(dir, "misses", "c.json"), "not json");
      expect(await cassetteMisses(dir)).toEqual({
        total: 3,
        byTask: { embedding: 2, unknown: 1 }
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the fake remote plan", () => {
  it("is a valid soak plan whose journeys profile injects no fault", () => {
    const { profile } = readSoakPlan(join(repositoryRoot, fakeRemotePlan), "journeys");
    for (const side of [profile.remote!.openAiCompatible, profile.remote!.codexWire]) {
      expect(Object.values(side.faults.rates).every((rate) => rate === 0)).toBe(true);
      expect(side.faults.windows).toEqual([]);
      expect(side.faults.forced).toEqual([]);
      expect(side.latency.fit).toBeNull();
    }
  });
});
