import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  allowDefaultProfileUpgradeKnob,
  decideDefaultProfileStart,
  decideUserDataOverride,
  DefaultProfileUpgradeRefusedError,
  describeUserDataOverrideRefusal,
  isDefaultUserData,
  userDataOverrideRefusedExitCode
} from "./default-profile-guard.js";

describe("decideUserDataOverride", () => {
  it.each([
    ["unset", undefined, { ok: true }],
    ["an empty string", "", { ok: false, reason: "blank" }],
    ["spaces only", "   ", { ok: false, reason: "blank" }],
    ["tabs and a newline", "\t\n ", { ok: false, reason: "blank" }],
    ["a bare name", "profile", { ok: false, reason: "relative" }],
    ["a dot path", "./profile", { ok: false, reason: "relative" }],
    ["a parent path", "../profile", { ok: false, reason: "relative" }],
    ["a home shorthand the shell did not expand", "~/profile", { ok: false, reason: "relative" }],
    ["an absolute path", "/scratch/profile", { ok: true, path: "/scratch/profile" }],
    [
      "an absolute path with a trailing slash",
      "/scratch/profile/",
      { ok: true, path: "/scratch/profile" }
    ],
    [
      "an absolute path with spaces around it",
      "  /scratch/profile  ",
      { ok: true, path: "/scratch/profile" }
    ],
    [
      "an absolute path with a dot segment",
      "/scratch/../other/profile",
      { ok: true, path: "/other/profile" }
    ]
  ])("%s", (_name, raw, expected) => {
    expect(decideUserDataOverride(raw)).toEqual(expected);
  });

  it("refuses with a line that never carries the value", () => {
    const secret = "relative/token-0123456789";
    const decision = decideUserDataOverride(secret);
    expect(decision).toEqual({ ok: false, reason: "relative" });
    const line = describeUserDataOverrideRefusal("relative");
    expect(line).not.toContain(secret);
    expect(line).not.toContain("token");
    expect(line).toContain("MEMORA_USER_DATA_DIR");
    expect(line).toContain(String(userDataOverrideRefusedExitCode));
    expect(describeUserDataOverrideRefusal("blank")).toContain("blank");
    expect(userDataOverrideRefusedExitCode).toBe(78);
  });
});

describe("decideDefaultProfileStart", () => {
  const journalLastWhen = 1_000;
  const histories = {
    null: { maxCreatedAt: null },
    older: { maxCreatedAt: 999 },
    zero: { maxCreatedAt: 0 },
    equal: { maxCreatedAt: 1_000 },
    newer: { maxCreatedAt: 1_001 }
  } as const;
  const refused = { start: false, reason: "pending-migrations-on-default-profile" } as const;
  const started = { start: true } as const;

  it.each([
    // [name, isPackaged, isDefault, knob, history, expected]
    ["packaged, default, pending, no knob", true, true, undefined, "older", started],
    ["unpackaged, not default, pending, no knob", false, false, undefined, "older", started],
    ["unpackaged, default, fresh history, no knob", false, true, undefined, "null", started],
    ["unpackaged, default, history equal to the journal", false, true, undefined, "equal", started],
    [
      "unpackaged, default, history newer than the journal",
      false,
      true,
      undefined,
      "newer",
      started
    ],
    ["unpackaged, default, history older, no knob", false, true, undefined, "older", refused],
    ["unpackaged, default, history at zero, no knob", false, true, undefined, "zero", refused],
    ["unpackaged, default, history older, knob 1", false, true, "1", "older", started],
    ["knob true", false, true, "true", "older", refused],
    ["knob with a leading space", false, true, " 1", "older", refused],
    ["knob with a trailing space", false, true, "1 ", "older", refused],
    ["knob 01", false, true, "01", "older", refused],
    ["knob 0", false, true, "0", "older", refused],
    ["knob empty", false, true, "", "older", refused],
    ["knob yes", false, true, "yes", "older", refused]
  ] as const)("%s", (_name, isPackaged, isDefault, knob, history, expected) => {
    expect(
      decideDefaultProfileStart({
        isPackaged,
        isDefault,
        knob,
        history: histories[history],
        journalLastWhen
      })
    ).toEqual(expected);
  });

  it("names the knob in the error it raises for a refusal, and no path", () => {
    const error = new DefaultProfileUpgradeRefusedError();
    expect(error.message).toContain(allowDefaultProfileUpgradeKnob);
    expect(error.message).not.toMatch(/\//u);
    expect(error.reason).toBe("pending-migrations-on-default-profile");
  });
});

describe("isDefaultUserData", () => {
  let root = "";
  let defaultPath = "";

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "memora-default-guard-")));
    defaultPath = join(root, "Library", "Application Support", "@app", "desktop");
    await mkdir(defaultPath, { recursive: true });
    await mkdir(join(root, "Library", "Application Support", "@app", "desktop-scratch"));
    await symlink(defaultPath, join(root, "link-to-default"));
    await symlink(join(root, "Library"), join(root, "link-to-library"));
    await symlink(join(root, "link-to-default"), join(root, "link-to-link"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const check = (userDataPath: string, platform: NodeJS.Platform = "darwin") =>
    isDefaultUserData({ userDataPath, defaultUserDataPath: defaultPath, platform });

  it("is true for the default path itself, as an explicit absolute value", async () => {
    expect(await check(defaultPath)).toBe(true);
    const override = decideUserDataOverride(defaultPath);
    expect(override.ok && override.path ? await check(override.path) : null).toBe(true);
  });

  it("is true with a trailing slash and with dot segments", async () => {
    expect(await check(`${defaultPath}/`)).toBe(true);
    expect(await check(`${defaultPath}//`)).toBe(true);
    expect(await check(join(defaultPath, "..", "desktop"))).toBe(true);
  });

  it("is true through a symlink to the folder, a symlink to a parent or a chain of links", async () => {
    expect(await check(join(root, "link-to-default"))).toBe(true);
    expect(
      await check(join(root, "link-to-library", "Application Support", "@app", "desktop"))
    ).toBe(true);
    expect(await check(join(root, "link-to-link"))).toBe(true);
  });

  it("is true in another case on darwin and win32, false on a case-sensitive platform", async () => {
    // Paths that do not exist, so that the answer never depends on the file system running the test.
    const check = (platform: NodeJS.Platform) =>
      isDefaultUserData({
        userDataPath: "/nowhere-guard/Library/Application Support/@app/DESKTOP",
        defaultUserDataPath: "/nowhere-guard/library/application support/@app/desktop",
        platform
      });
    expect(await check("darwin")).toBe(true);
    expect(await check("win32")).toBe(true);
    expect(await check("linux")).toBe(false);
  });

  it("is true for a composed and a decomposed name on darwin", async () => {
    const composed = isDefaultUserData({
      userDataPath: "/nowhere/Usuário/desktop",
      defaultUserDataPath: "/nowhere/Usuário/desktop",
      platform: "darwin"
    });
    expect(await composed).toBe(true);
  });

  it("is false for a sibling, a child, a parent and a name that only starts the same", async () => {
    expect(
      await check(join(root, "Library", "Application Support", "@app", "desktop-scratch"))
    ).toBe(false);
    expect(await check(join(defaultPath, "scratch"))).toBe(false);
    expect(await check(join(root, "Library", "Application Support", "@app"))).toBe(false);
    expect(await check(`${defaultPath}2`)).toBe(false);
    expect(await check(join(root, "elsewhere", "desktop"))).toBe(false);
  });

  it("compares paths that do not exist yet, as a fresh machine has them", async () => {
    const fresh = join(root, "fresh-machine", "Library", "@app", "desktop");
    expect(
      await isDefaultUserData({
        userDataPath: fresh,
        defaultUserDataPath: `${fresh}/`,
        platform: "darwin"
      })
    ).toBe(true);
    expect(
      await isDefaultUserData({
        userDataPath: join(root, "fresh-machine", "Library", "@app", "other"),
        defaultUserDataPath: fresh,
        platform: "darwin"
      })
    ).toBe(false);
  });

  it("does not throw on a dangling symlink and compares its own place", async () => {
    await symlink(join(root, "elsewhere"), join(root, "dangling"));
    expect(await check(join(root, "dangling"))).toBe(false);
  });
});
