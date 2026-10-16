import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { findLocalModelCatalogEntry, localModelSeedDirectories } from "@app/ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { localModelInstallKnob } from "../../apps/desktop/src/main/services/local-model-install-startup.js";
import {
  checkProfile,
  createProfile,
  findRunningProcess,
  parseProfilesArgs,
  populateRecipe,
  profileDefinitions,
  profileKinds,
  profileRecordFile,
  profilesRoot,
  rankerCatalogIds,
  rankerInstallKnob,
  rankerInstallRecipe,
  resetStartEnvironment,
  type AppRunInput,
  type CreateProfileInput,
  type ProfileDeps
} from "./env-profiles.js";

let workspace: string;
let devProfile: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-env-profiles-"));
  devProfile = join(workspace, "dev-userdata");
  await mkdir(join(devProfile, "database"), { recursive: true });
  await writeFile(
    join(devProfile, "database", "dev-connection.json"),
    JSON.stringify({ developmentOnly: true })
  );
  await writeFile(join(devProfile, "credentials.json"), "{}");
  await mkdir(join(workspace, ".cache", "golden", "cassettes", "golden-small-v9-a"), {
    recursive: true
  });
  await writeFile(
    join(workspace, ".cache", "golden", "cassettes", "golden-small-v9-a", "cassette.json"),
    "{}"
  );
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

const startedAt = new Date("2026-10-15T20:00:00.000Z");

interface Harness {
  deps: ProfileDeps;
  apps: AppRunInput[];
  clones: Array<[string, string]>;
  logs: string[];
}

/** Clones with a real recursive copy; the "app" writes the reset marker the way the knob does. */
function harness(
  options: {
    language?: string;
    exitCode?: number | null;
    marker?: boolean;
    library?: { sources: number; notes: number };
    markerAt?: string;
    alive?: number[];
  } = {}
): Harness {
  const apps: AppRunInput[] = [];
  const clones: Array<[string, string]> = [];
  const logs: string[] = [];
  const deps: ProfileDeps = {
    clone: async (from, to) => {
      clones.push([from, to]);
      await cp(from, to, { recursive: true });
    },
    runApp: async (input) => {
      apps.push(input);
      if (options.marker !== false)
        await writeFile(
          join(input.env.MEMORA_USER_DATA_DIR!, "profile-reset.json"),
          JSON.stringify({
            format: "memora-profile-reset",
            version: 1,
            resetAt: options.markerAt ?? "2026-10-15T20:00:05.000Z",
            contentLanguage: options.language ?? "pt-BR",
            removed: { sources: 30, notes: 160, files: 12, failedFiles: 0 },
            library: options.library ?? { sources: 0, notes: 0 }
          })
        );
      return { exitCode: options.exitCode ?? 0, timedOut: false, stopped: false };
    },
    isProcessAlive: (pid) => options.alive?.includes(pid) ?? false,
    now: () => startedAt,
    log: (line) => logs.push(line)
  };
  return { deps, apps, clones, logs };
}

const create = (extra: Partial<CreateProfileInput> = {}) => ({
  kind: "env-g" as const,
  from: devProfile,
  workspaceRoot: workspace,
  ...extra
});

describe("profile definitions", () => {
  it("define ENV-G, ENV-F and ENV-C as specified", () => {
    expect(profileKinds).toEqual(["env-g", "env-f", "env-c"]);
    expect(profileDefinitions["env-g"]).toMatchObject({
      roots: 10,
      notes: 160,
      manifest: "scripts/golden/manifest.json",
      cassette: { source: "golden-small-v9-a", copy: "golden-small-f2" },
      contentLanguage: "pt-BR"
    });
    expect(profileDefinitions["env-f"]).toMatchObject({
      roots: 60,
      notes: 138,
      cassette: { source: "matching-fixture-v9-a", copy: "matching-fixture-f2" }
    });
    expect(profileDefinitions["env-c"]).toMatchObject({
      roots: 800,
      notes: 18_632,
      cassette: null,
      populate: "corpus"
    });
  });
});

describe("create", () => {
  it("clones the DEV profile, resets it once, copies the cassette and records the profile", async () => {
    const { deps, apps, clones, logs } = harness();
    const result = await createProfile(create(), deps);
    const profile = join(workspace, ".cache", "profiles", "env-g");
    expect(result.profileDirectory).toBe(profile);
    // The clone of the profile, then the clone of the cassette (never over an existing copy).
    expect(clones).toEqual([
      [devProfile, profile],
      [
        join(workspace, ".cache", "golden", "cassettes", "golden-small-v9-a"),
        join(workspace, ".cache", "golden", "cassettes", "golden-small-f2")
      ]
    ]);
    expect(await readFile(join(profile, "credentials.json"), "utf8")).toBe("{}");
    expect(apps).toHaveLength(1);
    expect(apps[0]!.cwd).toBe(workspace);
    expect(apps[0]!.logPath).toBe(join(workspace, ".cache", "profiles", "env-g.reset.log"));
    expect(apps[0]!.env).toMatchObject({
      MEMORA_USER_DATA_DIR: profile,
      MEMORA_WORKSPACE_ROOT: workspace,
      MEMORA_PROFILE_RESET: "1"
    });
    expect(result.record).toMatchObject({
      format: "memora-measurement-profile",
      kind: "env-g",
      name: "env-g",
      contentLanguage: "pt-BR",
      clonedFrom: devProfile,
      reset: { removed: { sources: 30, notes: 160 }, library: { sources: 0, notes: 0 } },
      cassette: { source: "golden-small-v9-a", copy: "golden-small-f2", copied: true },
      manifest: "scripts/golden/manifest.json"
    });
    expect(
      JSON.parse(await readFile(join(profile, profileRecordFile), "utf8")) as { kind: string }
    ).toMatchObject({ kind: "env-g" });
    expect(logs.join("\n")).toContain("copied the cassette golden-small-v9-a to golden-small-f2");
    // The source profile is only read.
    expect(await readFile(join(devProfile, "credentials.json"), "utf8")).toBe("{}");
    await expect(stat(join(devProfile, "profile-reset.json"))).rejects.toThrow();
    expect((await checkProfile({ kind: "env-g", workspaceRoot: workspace })).ok).toBe(true);
  });

  it("starts the app with the profile, the knob and no other DEV knob", () => {
    const env = resetStartEnvironment(
      {
        PATH: "/bin",
        MEMORA_GOLDEN_RUN: "m.json",
        MEMORA_GOLDEN_RESET: "1",
        MEMORA_GOLDEN_TOPICS: "full",
        MEMORA_LEGACY_WIPE: "preview",
        MEMORA_AI_CASSETTE: "record",
        MEMORA_AI_CASSETTE_DIR: "x",
        MEMORA_MATCHING_PILOT: "1",
        MEMORA_USER_DATA_DIR: "/Users/example/Library/Application Support/@app/desktop"
      },
      "/repo/.cache/profiles/env-f",
      "/repo"
    );
    expect(env).toEqual({
      PATH: "/bin",
      MEMORA_USER_DATA_DIR: "/repo/.cache/profiles/env-f",
      MEMORA_WORKSPACE_ROOT: "/repo",
      MEMORA_PROFILE_RESET: "1",
      MEMORA_DEV_BACKGROUND: "1"
    });
  });

  it("removes the Electron single-instance files and any inherited marker from the clone", async () => {
    for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket", "profile.json"])
      await writeFile(join(devProfile, file), "x");
    await writeFile(join(devProfile, "profile-reset.json"), "{}");
    const { deps } = harness();
    const { profileDirectory } = await createProfile(
      create({ kind: "env-f", name: "env-f2" }),
      deps
    );
    for (const file of ["SingletonLock", "SingletonCookie", "SingletonSocket"])
      await expect(stat(join(profileDirectory, file))).rejects.toThrow();
    const record = JSON.parse(await readFile(join(profileDirectory, profileRecordFile), "utf8"));
    expect(record).toMatchObject({ kind: "env-f", name: "env-f2" });
  });

  it("does not overwrite a cassette copy that already holds recordings", async () => {
    const copy = join(workspace, ".cache", "golden", "cassettes", "golden-small-f2");
    await mkdir(copy, { recursive: true });
    const { deps, clones } = harness();
    const { record } = await createProfile(create(), deps);
    expect(clones).toHaveLength(1);
    expect(record!.cassette).toMatchObject({ copied: false });
  });

  it("records ENV-C without a cassette", async () => {
    const { deps, clones } = harness();
    const { record } = await createProfile(create({ kind: "env-c" }), deps);
    expect(clones).toHaveLength(1);
    expect(record).toMatchObject({ kind: "env-c", cassette: null, manifest: null });
  });

  it("a dry run checks everything and changes nothing", async () => {
    const { deps, apps, clones, logs } = harness();
    const result = await createProfile(create({ dryRun: true }), deps);
    expect(result).toMatchObject({ dryRun: true, record: null });
    expect([apps, clones]).toEqual([[], []]);
    expect(logs.join("\n")).toContain("[dry run] clone");
    await expect(stat(profilesRoot(workspace))).rejects.toThrow();
  });

  it("refuses a source that is missing, not a DEV profile or still running", async () => {
    const { deps, clones } = harness({ alive: [4242] });
    await expect(createProfile(create({ from: join(workspace, "nope") }), deps)).rejects.toThrow(
      "does not exist"
    );
    const plain = join(workspace, "plain");
    await mkdir(plain);
    await expect(createProfile(create({ from: plain }), deps)).rejects.toThrow("not a DEV profile");
    await mkdir(join(devProfile, "database", "postgres-data"), { recursive: true });
    await writeFile(join(devProfile, "database", "postgres-data", "postmaster.pid"), "4242\n/x\n");
    await expect(createProfile(create(), deps)).rejects.toThrow("PostgreSQL sidecar (pid 4242)");
    await writeFile(join(devProfile, "database", "postgres-data", "postmaster.pid"), "999\n");
    await symlink("host-4242", join(devProfile, "SingletonLock"));
    await expect(createProfile(create(), deps)).rejects.toThrow("the app (pid 4242)");
    expect(clones).toEqual([]);
    expect(await findRunningProcess(devProfile, () => false)).toBeNull();
  });

  it("refuses an existing profile unless forced, and a forced one not made by this script", async () => {
    const { deps } = harness();
    await createProfile(create(), deps);
    await expect(createProfile(create(), deps)).rejects.toThrow("use --force");
    await createProfile(create({ force: true }), deps);
    const foreign = join(profilesRoot(workspace), "other");
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, "keep.txt"), "mine");
    await expect(createProfile(create({ name: "other", force: true }), deps)).rejects.toThrow(
      "not made by this script"
    );
    expect(await readFile(join(foreign, "keep.txt"), "utf8")).toBe("mine");
  });

  it("refuses a bad name", async () => {
    const { deps, clones } = harness();
    for (const name of ["../x", "A", "a/b", "", "-a"])
      await expect(createProfile(create({ name }), deps)).rejects.toThrow(
        "profile name must match"
      );
    expect(clones).toEqual([]);
  });

  it("refuses a content language that is not the cassette's", async () => {
    const { deps } = harness({ language: "en" });
    await expect(createProfile(create(), deps)).rejects.toThrow(
      "content language is en, but ENV-G's cassette was recorded in pt-BR"
    );
    // The profile is left for inspection but is not recorded as made.
    await expect(stat(join(profilesRoot(workspace), "env-g", profileRecordFile))).rejects.toThrow();
    expect((await checkProfile({ kind: "env-g", workspaceRoot: workspace })).ok).toBe(false);
    // An explicit expectation for another recording is accepted.
    const forced = harness({ language: "en" });
    const { record } = await createProfile(
      create({ force: false, contentLanguage: "en", name: "env-en" }),
      forced.deps
    );
    expect(record!.contentLanguage).toBe("en");
  });

  it("fails when the reset never recorded its marker, recorded an old one or left a library", async () => {
    await expect(
      createProfile(create(), harness({ marker: false, exitCode: 1 }).deps)
    ).rejects.toThrow("The reset did not complete (exit code 1)");
    await expect(
      createProfile(create({ name: "old" }), harness({ markerAt: "2026-10-15T19:00:00.000Z" }).deps)
    ).rejects.toThrow("did not complete");
    await expect(
      createProfile(create({ name: "left" }), harness({ library: { sources: 2, notes: 5 } }).deps)
    ).rejects.toThrow("library is not empty after the reset (2 sources, 5 notes)");
  });
});

describe("check and recipe", () => {
  it("reports the problems of a profile that is missing, foreign or without its cassette", async () => {
    expect(await checkProfile({ kind: "env-f", workspaceRoot: workspace })).toMatchObject({
      ok: false,
      problems: ["the profile does not exist"]
    });
    await mkdir(join(profilesRoot(workspace), "foreign"), { recursive: true });
    const foreign = await checkProfile({
      kind: "env-f",
      name: "foreign",
      workspaceRoot: workspace
    });
    expect(foreign.ok).toBe(false);
    expect(foreign.problems[0]).toContain("not made by create");
    const { deps } = harness();
    await createProfile(create({ kind: "env-f" }), deps);
    // ENV-F's cassette source is not in this workspace, so there is nothing to copy.
    expect((await checkProfile({ kind: "env-f", workspaceRoot: workspace })).problems).toEqual([
      "the cassette copy matching-fixture-f2 is missing"
    ]);
    expect(
      (await checkProfile({ kind: "env-g", name: "env-f", workspaceRoot: workspace })).problems
    ).toContain("the profile is env-f, not env-g");
  });

  it("starts every recipe with the optional install of the ranker (T22c)", () => {
    for (const kind of profileKinds) {
      const text = populateRecipe({ kind, workspaceRoot: "/repo", maxTokens: 1000 });
      const [header, install] = text.split("\n\n");
      expect(header).toContain(profileDefinitions[kind].label);
      expect(install).toContain("Optional first start");
      expect(install).toContain("MEMORA_USER_DATA_DIR=/repo/.cache/profiles/" + kind);
      expect(install).toContain("MEMORA_LOCAL_MODEL_SEED_DIR=/repo/.cache/models");
      expect(install).toContain("MEMORA_LOCAL_MODEL_INSTALL=mlx-qwen3-reranker-0.6b");
      expect(install).toContain("MEMORA_SMOKE_AUTO_QUIT_MS=");
      expect(install).toContain("npm run dev -w @app/desktop");
      // The install start does not run the golden or corpus runner.
      expect(install).not.toMatch(/MEMORA_(GOLDEN|TOPIC_CORPUS|AI_CASSETTE)\w*=/u);
      expect(text.indexOf("Optional first start")).toBeLessThan(
        text.indexOf(
          kind === "env-c" ? "MEMORA_TOPIC_CORPUS_STAGE=seed" : "MEMORA_AI_CASSETTE=record"
        )
      );
    }
    expect(rankerInstallRecipe({ profile: "/p", workspaceRoot: "/repo" })).toContain(
      "MEMORA_USER_DATA_DIR=/p"
    );
  });

  it("names the knob and catalog ids the app reads, and the seed folder layout it expects", () => {
    expect(rankerInstallKnob).toBe(localModelInstallKnob);
    for (const id of Object.values(rankerCatalogIds)) {
      expect(findLocalModelCatalogEntry(id)).toBeDefined();
      // `.cache/models/<folder>/<pinned files>` is what the seed downloader reads.
      expect(localModelSeedDirectories[id]).toMatch(/^qwen3-reranker-0\.6b-/u);
    }
  });

  it("prints the record and replay commands with the G1 knobs", () => {
    const text = populateRecipe({ kind: "env-g", workspaceRoot: "/repo", maxTokens: 400000 });
    expect(text).toContain("MEMORA_USER_DATA_DIR=/repo/.cache/profiles/env-g");
    expect(text).toContain("MEMORA_GOLDEN_RUN=scripts/golden/manifest.json");
    expect(text).toContain("MEMORA_AI_CASSETTE_DIR=.cache/golden/cassettes/golden-small-f2");
    expect(text).toContain("MEMORA_GOLDEN_TOPICS=full");
    expect(text).toContain("MEMORA_GOLDEN_TOPICS_ARRIVAL=per-source");
    expect(text).toContain("MEMORA_AI_CASSETTE=record");
    expect(text).toContain("MEMORA_GOLDEN_MAX_TOKENS=400000");
    expect(text).toContain("MEMORA_AI_CASSETTE=replay");
    expect(text).toContain("MEMORA_GOLDEN_RESET=1");
    expect(populateRecipe({ kind: "env-f", workspaceRoot: "/repo" })).toContain(
      "MEMORA_GOLDEN_MAX_TOKENS=<cap on live tokens>"
    );
    const corpus = populateRecipe({ kind: "env-c", workspaceRoot: "/repo", maxTokens: 90000 });
    expect(corpus).toContain("MEMORA_TOPIC_CORPUS=1");
    expect(corpus).toContain("MEMORA_USER_DATA_DIR=/repo/.cache/profiles/env-c");
    // Seed without a cassette, then build and arrive recorded to corpus-f2 under the token cap.
    const [seed, build, arrive] = corpus.split(/\n\d\. /u).slice(1);
    expect(seed).toContain("MEMORA_TOPIC_CORPUS_STAGE=seed");
    expect(seed).toContain("MEMORA_TOPIC_CORPUS_HOLDOUT=articles:40");
    expect(seed).not.toContain("MEMORA_AI_CASSETTE");
    for (const step of [build, arrive]) {
      expect(step).toContain("MEMORA_AI_CASSETTE=record");
      expect(step).toContain("corpus-f2");
      expect(step).toContain("MEMORA_TOPIC_CORPUS_MAX_TOKENS=90000");
    }
    expect(build).toContain("MEMORA_TOPIC_CORPUS_STAGE=build");
    expect(arrive).toContain("MEMORA_TOPIC_CORPUS_STAGE=arrive");
  });
});

describe("arguments", () => {
  it("parses the three commands", () => {
    expect(parseProfilesArgs(["create", "env-f", "--from", "/dev", "--dry-run"])).toMatchObject({
      kind: "create",
      profile: "env-f",
      from: "/dev",
      dryRun: true,
      force: false,
      timeoutMs: 900_000
    });
    expect(parseProfilesArgs(["recipe", "env-g", "--max-tokens", "5"])).toMatchObject({
      kind: "recipe",
      profile: "env-g",
      maxTokens: 5
    });
    expect(parseProfilesArgs(["check", "env-c", "--name", "env-c2"])).toMatchObject({
      kind: "check",
      profile: "env-c",
      name: "env-c2"
    });
    expect(parseProfilesArgs([])).toEqual({ kind: "help" });
  });

  it("rejects unknown commands, profiles and bad values", () => {
    expect(() => parseProfilesArgs(["clone", "env-g"])).toThrow("Unknown command");
    expect(() => parseProfilesArgs(["create", "env-x", "--from", "/d"])).toThrow("must be one of");
    expect(() => parseProfilesArgs(["create", "env-g"])).toThrow("--from is required");
    expect(() => parseProfilesArgs(["create", "env-g", "--from", "/d", "--timeout", "5"])).toThrow(
      "--timeout"
    );
    expect(() => parseProfilesArgs(["recipe", "env-g", "--max-tokens", "0"])).toThrow(
      "--max-tokens"
    );
    expect(() => parseProfilesArgs(["check", "env-g", "--name", "../x"])).toThrow("profile name");
    expect(() => parseProfilesArgs(["check", "env-g", "extra"])).toThrow("Unexpected argument");
  });
});
