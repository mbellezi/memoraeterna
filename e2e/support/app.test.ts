import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { LocalModelSeedError } from "@app/ai";

import { readSoakPlan } from "../../apps/desktop/src/main/services/dev/soak-plan.js";
import {
  defaultSecondSourceKey,
  firstRunModels
} from "../../apps/desktop/src/main/services/firstrun-e2e/config.js";
import {
  assertModelsSeeded,
  cassetteMisses,
  fakeRemotePlan,
  firstRunModelIds,
  firstRunRankerEnv,
  firstRunRankerState,
  journeyEnvironment,
  journeysWriterConfigId,
  secondSourceKey,
  setTheme,
  stepFailures
} from "./app.js";
import { settleInPage } from "./contrast.js";
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

describe("the first-run models a journey installs", () => {
  it("are the first-run harness's: the embedder and the ranker, MLX where MLX runs", () => {
    expect(firstRunModelIds({ platform: "darwin", arch: "arm64" })).toEqual({
      embedding: firstRunModels.embedding,
      ranker: firstRunModels.rankerMlx
    });
    expect(firstRunModelIds({ platform: "linux", arch: "x64" })).toEqual({
      embedding: firstRunModels.embedding,
      ranker: firstRunModels.rankerGguf
    });
  });

  it("are refused before any launch unless the seed folder holds every pinned file", async () => {
    // The app would download a file the seed lacks from the model host.
    const seed = await mkdtemp(join(tmpdir(), "journeys-seed-"));
    try {
      const { embedding, ranker } = firstRunModelIds();
      await expect(assertModelsSeeded(seed)).rejects.toThrow(
        new RegExp(`cannot install ${embedding}.*never downloads a model`, "u")
      );
      const checked: string[] = [];
      await assertModelsSeeded(seed, undefined, async (entry) => {
        checked.push(entry.id);
      });
      expect(checked).toEqual([embedding, ranker]);
      await expect(
        assertModelsSeeded(seed, undefined, async (entry) => {
          if (entry.id === ranker) throw new LocalModelSeedError("seed_incomplete", "missing");
        })
      ).rejects.toThrow(new RegExp(`cannot install ${ranker}`, "u"));
    } finally {
      await rm(seed, { recursive: true, force: true });
    }
  });
});

describe("the first-run ranker a journey waits for", () => {
  const { ranker } = firstRunModelIds();
  const listed = (status: string, capabilities: string[] = [], lastError: string | null = null) => [
    { catalogId: "other", status: "ready", capabilities: ["reranking"], lastError: null },
    { catalogId: ranker, status, capabilities, lastError }
  ];

  it("is installed at launch by the DEV knob, because the cassette turns the app's own install off", () => {
    expect(firstRunRankerEnv()).toEqual({ MEMORA_LOCAL_MODEL_INSTALL: ranker });
  });

  it("is ready only when installed and validated for reranking", () => {
    expect(firstRunRankerState([])).toBeNull();
    expect(firstRunRankerState(listed("installing"))).toBeNull();
    expect(firstRunRankerState(listed("ready", ["embedding"]))).toBeNull();
    expect(firstRunRankerState(listed("ready", ["reranking"]))).toBe("ready");
  });

  it("stops the wait with the install's error when it failed", () => {
    expect(() => firstRunRankerState(listed("failed", [], "bad checksum"))).toThrow(
      new RegExp(`${ranker} failed: bad checksum`, "u")
    );
  });
});

describe("setTheme", () => {
  const fakeSession = () => {
    const calls: string[] = [];
    const session = {
      electronApp: {
        evaluate: async (_run: unknown, theme: string) => calls.push(`native ${theme}`)
      },
      page: {
        emulateMedia: async (options: { colorScheme: string }) =>
          calls.push(`emulate ${options.colorScheme}`),
        waitForFunction: async (_check: unknown, dark: boolean) => calls.push(`wait dark=${dark}`),
        evaluate: async (run: unknown) => calls.push(run === settleInPage ? "settle" : "other")
      }
    };
    return { calls, session };
  };

  it("emulates the colour scheme on the page, because the native theme alone does not reach a window shown inactive", async () => {
    const { calls, session } = fakeSession();
    await setTheme(session as never, "dark");
    expect(calls).toEqual(["native dark", "emulate dark", "wait dark=true", "settle"]);
    calls.length = 0;
    await setTheme(session as never, "light");
    expect(calls.slice(0, 3)).toEqual(["native light", "emulate light", "wait dark=false"]);
  });
});

describe("stepFailures", () => {
  const scan = (drawnTheme: "light" | "dark" | undefined, failures: unknown[] = []) => ({
    checked: 3,
    failures,
    unverifiable: [],
    drawnTheme
  });

  it("fails a scan labelled light that was drawn dark, and passes scans drawn as asked", () => {
    expect(
      stepFailures({
        step: "home",
        contrast: { light: scan("light"), dark: scan("dark") }
      } as never)
    ).toEqual([]);
    const failures = stepFailures({
      step: "home",
      contrast: { light: scan("dark"), dark: scan("dark") }
    } as never);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^home light: the page was drawn in dark, not light/u);
  });

  it("names every contrast finding with its step, theme and ratio", () => {
    const failures = stepFailures({
      step: "explore",
      contrast: {
        light: scan("light"),
        dark: scan("dark", [{ text: "Fontes", ratio: 1.2, required: 3 }])
      }
    } as never);
    expect(failures).toEqual(['explore dark: "Fontes" 1.2:1 < 3:1']);
  });
});

describe("journeysWriterConfigId", () => {
  it("reads BASE-J's Codex writer from base-j.json, and refuses a record that names none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "journeys-writer-"));
    try {
      await writeFile(
        join(dir, "base-j.json"),
        JSON.stringify({ writer: { providerConfigId: "7f6c0f3e-1111-4222-8333-444455556666" } })
      );
      expect(await journeysWriterConfigId(dir)).toBe("7f6c0f3e-1111-4222-8333-444455556666");
      await writeFile(join(dir, "base-j.json"), JSON.stringify({ writer: {} }));
      await expect(journeysWriterConfigId(dir)).rejects.toThrow(/names no writer configuration/u);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("the second source J0 checks", () => {
  it("is FR2's second source", () => {
    expect(secondSourceKey).toBe(defaultSecondSourceKey);
  });
});
