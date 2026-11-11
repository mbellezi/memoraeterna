import { mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMeasurementProfilePath } from "./profile-reset.js";
import {
  defaultUserDataPath,
  isScratchProfilePath,
  MatchingProfileError,
  notScratchProfileCode,
  readMatchingProfile
} from "./matching-profile.js";

let workspace: string;
let outside: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-matching-profile-"));
  outside = await mkdtemp(join(tmpdir(), "memora-matching-outside-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function folder(...parts: string[]) {
  const path = join(...parts);
  await mkdir(path, { recursive: true });
  return path;
}

describe("scratch profile path", () => {
  it("accepts a folder inside .cache/profiles and inside .cache/f<N>/scratch", async () => {
    const cloned = await folder(workspace, ".cache", "profiles", "env-f");
    const scratch = await folder(workspace, ".cache", "f5", "scratch", "pilot");
    const nested = await folder(workspace, ".cache", "f12", "scratch", "journeys", "run-1", "base");
    for (const path of [cloned, scratch, nested])
      expect(await isScratchProfilePath(path, workspace)).toBe(true);
  });

  it("refuses the roots themselves, siblings, other cache folders and a missing folder", async () => {
    const profiles = await folder(workspace, ".cache", "profiles");
    const scratchRoot = await folder(workspace, ".cache", "f5", "scratch");
    expect(await isScratchProfilePath(profiles, workspace)).toBe(false);
    expect(await isScratchProfilePath(scratchRoot, workspace)).toBe(false);
    expect(await isScratchProfilePath(join(workspace, ".cache", "f5"), workspace)).toBe(false);
    expect(await isScratchProfilePath(await folder(workspace, ".cache", "other"), workspace)).toBe(
      false
    );
    // The folder name needs digits: `fx` and `f5-old` are not scratch roots.
    expect(
      await isScratchProfilePath(await folder(workspace, ".cache", "fx", "scratch", "a"), workspace)
    ).toBe(false);
    expect(
      await isScratchProfilePath(
        await folder(workspace, ".cache", "f5-old", "scratch", "a"),
        workspace
      )
    ).toBe(false);
    expect(await isScratchProfilePath(await folder(workspace, "pilot"), workspace)).toBe(false);
    expect(await isScratchProfilePath(join(profiles, "nope"), workspace)).toBe(false);
    expect(await isScratchProfilePath(await folder(outside, "dev"), workspace)).toBe(false);
  });

  it("refuses a link that leaves the scratch roots, in either place", async () => {
    const real = await folder(outside, "owner-dev");
    await folder(workspace, ".cache", "profiles");
    await folder(workspace, ".cache", "f5", "scratch");
    const profileLink = join(workspace, ".cache", "profiles", "linked");
    const scratchLink = join(workspace, ".cache", "f5", "scratch", "linked");
    await symlink(real, profileLink);
    await symlink(real, scratchLink);
    expect(await isScratchProfilePath(profileLink, workspace)).toBe(false);
    expect(await isScratchProfilePath(scratchLink, workspace)).toBe(false);
    // A path that climbs out with `..` resolves outside too.
    const climbing = join(workspace, ".cache", "f5", "scratch", "..", "..", "..");
    expect(await isScratchProfilePath(climbing, workspace)).toBe(false);
  });

  it("refuses a scratch root that is a link leaving .cache, and what lies behind it (D26)", async () => {
    const behind = await folder(outside, "elsewhere", "env-f");
    await folder(workspace, ".cache", "f5");
    await folder(workspace, ".cache", "f6", "scratch", "ok");
    await symlink(join(outside, "elsewhere"), join(workspace, ".cache", "profiles"));
    await symlink(join(outside, "elsewhere"), join(workspace, ".cache", "f5", "scratch"));
    for (const path of [
      join(workspace, ".cache", "profiles", "env-f"),
      join(workspace, ".cache", "f5", "scratch", "env-f"),
      behind
    ])
      expect(await isScratchProfilePath(path, workspace)).toBe(false);
    // A real root beside the links still works.
    expect(
      await isScratchProfilePath(join(workspace, ".cache", "f6", "scratch", "ok"), workspace)
    ).toBe(true);
  });

  it("refuses the default userData even when a scratch root links to it", async () => {
    const home = await folder(outside, "home");
    const defaultData = await folder(defaultUserDataPath(home));
    await folder(workspace, ".cache", "f5");
    await symlink(
      join(home, "Library", "Application Support", "@app"),
      join(workspace, ".cache", "f5", "scratch")
    );
    const viaLink = join(workspace, ".cache", "f5", "scratch", "desktop");
    for (const userDataPath of [viaLink, defaultData])
      await expect(
        readMatchingProfile({ userDataPath, workspaceRoot: workspace, runner: "pilot", home })
      ).rejects.toBeInstanceOf(MatchingProfileError);
    expect(await readdir(defaultData)).toEqual([]);
  });

  it("refuses the default userData path and a relative path", async () => {
    await folder(workspace, ".cache", "profiles", "env-f");
    expect(
      await isScratchProfilePath(
        join(homedir(), "Library", "Application Support", "@app", "desktop"),
        workspace
      )
    ).toBe(false);
    expect(await isScratchProfilePath(".cache/profiles/env-f", workspace)).toBe(false);
    expect(await isScratchProfilePath("", workspace)).toBe(false);
  });

  it("leaves the measurement-profile predicate unchanged for f<N>/scratch", async () => {
    const scratch = await folder(workspace, ".cache", "f5", "scratch", "pilot");
    const cloned = await folder(workspace, ".cache", "profiles", "env-f");
    expect(await isScratchProfilePath(scratch, workspace)).toBe(true);
    expect(await isMeasurementProfilePath(scratch, workspace)).toBe(false);
    expect(await isMeasurementProfilePath(cloned, workspace)).toBe(true);
  });
});

describe("readMatchingProfile", () => {
  it("returns the profile and the runner's artifact folder, and writes nothing", async () => {
    const userDataPath = await folder(workspace, ".cache", "f5", "scratch", "pilot");
    const pilot = await readMatchingProfile({
      userDataPath,
      workspaceRoot: workspace,
      runner: "pilot"
    });
    expect(pilot.outputDirectory).toBe(join(userDataPath, "matching-pilot"));
    const benchmark = await readMatchingProfile({
      userDataPath,
      workspaceRoot: workspace,
      runner: "benchmark"
    });
    expect(benchmark.profilePath).toBe(userDataPath);
    expect(benchmark.outputDirectory).toBe(join(userDataPath, "matching-benchmark"));
    expect(await readdir(userDataPath)).toEqual([]);
  });

  it("throws matching.errors.notScratchProfile for anything else", async () => {
    const userDataPath = await folder(outside, "dev");
    const error = await readMatchingProfile({
      userDataPath,
      workspaceRoot: workspace,
      runner: "pilot"
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MatchingProfileError);
    expect((error as MatchingProfileError).code).toBe(notScratchProfileCode);
    expect((error as Error).message).toContain("matching.errors.notScratchProfile");
    expect(await readdir(userDataPath)).toEqual([]);
  });
});
