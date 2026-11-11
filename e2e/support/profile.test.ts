import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assertJourneysScratchPath,
  cloneProfile,
  emptyProfile,
  journeysRun,
  journeysScratchRoot,
  newRunId,
  profileDir,
  repositoryRoot,
  runIdPattern
} from "./profile.js";

let repo: string;
let outside: string;
const run = "20261116T120000Z";

beforeAll(async () => {
  repo = await realpath(await mkdtemp(join(tmpdir(), "journeys-profile-")));
  outside = join(repo, "outside");
  await mkdir(join(journeysScratchRoot(repo), run), { recursive: true });
  await mkdir(join(repo, ".cache", "profiles", "env-c"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await symlink(outside, join(journeysScratchRoot(repo), run, "escape"));
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("assertJourneysScratchPath", () => {
  it("accepts a folder inside a run, existing or not", async () => {
    const path = join(journeysScratchRoot(repo), run, "profiles", "base");
    await expect(assertJourneysScratchPath(path, repo)).resolves.toBe(path);
  });

  it.each([
    ["a relative path", () => "relative/profile"],
    ["a path with ..", () => `${journeysScratchRoot(repo)}/${run}/../${run}/profiles/a`],
    ["the run folder itself", () => join(journeysScratchRoot(repo), run)],
    ["the journeys root", () => journeysScratchRoot(repo)],
    ["a folder whose run id is not one", () => join(journeysScratchRoot(repo), "latest", "a")],
    ["another scratch folder", () => join(repo, ".cache", "f5", "scratch", "seed30k")],
    ["a measurement profile", () => join(repo, ".cache", "profiles", "env-c")],
    ["a folder outside the cache", () => outside],
    ["a symbolic link out of the run", () => join(journeysScratchRoot(repo), run, "escape", "p")]
  ])("refuses %s", async (_case, path) => {
    await expect(assertJourneysScratchPath(path(), repo)).rejects.toThrow(/Refusing/u);
  });
});

describe("cloneProfile", () => {
  it("clones a source folder into a new folder of the run", async () => {
    const source = join(repo, ".cache", "profiles", "env-c");
    await writeFile(join(source, "marker.txt"), "x");
    const target = join(journeysScratchRoot(repo), run, "profiles", "clone-a");
    await cloneProfile(source, target, repo);
    expect(existsSync(join(target, "marker.txt"))).toBe(true);
    await expect(cloneProfile(source, target, repo)).rejects.toThrow(/exists/u);
  });

  it("refuses a target outside the run and a source whose PostgreSQL runs", async () => {
    const source = join(repo, "running");
    await mkdir(join(source, "database", "postgres-data"), { recursive: true });
    await writeFile(join(source, "database", "postgres-data", "postmaster.pid"), "1");
    await expect(
      cloneProfile(source, join(journeysScratchRoot(repo), run, "profiles", "b"), repo)
    ).rejects.toThrow(/running/u);
    await expect(
      cloneProfile(outside, join(repo, ".cache", "profiles", "x"), repo)
    ).rejects.toThrow(/Refusing/u);
  });

  it("makes an empty profile only inside a run", async () => {
    const target = join(journeysScratchRoot(repo), run, "profiles", "empty");
    await expect(emptyProfile(target, repo)).resolves.toBe(target);
    await expect(emptyProfile(join(repo, "elsewhere"), repo)).rejects.toThrow(/Refusing/u);
  });
});

describe("runs and names", () => {
  it("makes a run id from the clock and keeps the one in the environment", () => {
    expect(newRunId(new Date("2026-11-16T12:00:00.250Z"))).toBe("20261116T120000Z");
    expect(runIdPattern.test("20261116T120000Z-j0")).toBe(true);
    const env: Record<string, string | undefined> = {};
    const first = journeysRun(env, "/repo", new Date("2026-11-16T12:00:00Z"));
    expect(env.MEMORA_JOURNEYS_RUN).toBe(first.id);
    expect(journeysRun(env, "/repo", new Date("2027-01-01T00:00:00Z")).id).toBe(first.id);
    expect(first.profilesDir).toBe("/repo/.cache/f5/scratch/journeys/20261116T120000Z/profiles");
    expect(first.evidenceDir).toBe("/repo/.cache/f5/journeys/20261116T120000Z");
    expect(() => journeysRun({ MEMORA_JOURNEYS_RUN: "../x" }, "/repo")).toThrow();
  });

  it("names profiles safely and finds the checkout", () => {
    expect(profileDir({ profilesDir: "/p" }, "base")).toBe("/p/base");
    expect(() => profileDir({ profilesDir: "/p" }, "../base")).toThrow();
    expect(existsSync(join(repositoryRoot, "e2e", "support", "profile.ts"))).toBe(true);
  });
});
