import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  isMeasurementProfilePath,
  profileResetMarkerFile,
  readProfileResetKnob,
  readProfileResetMarker,
  runProfileResetStartup,
  type ProfileResetStartupOptions
} from "./profile-reset.js";

let workspace: string;
let outside: string;
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "memora-profile-reset-"));
  outside = await mkdtemp(join(tmpdir(), "memora-profile-outside-"));
});
afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function makeProfile(
  root: string,
  name: string,
  descriptor: unknown = { developmentOnly: true }
) {
  const userData = join(root, name);
  await mkdir(join(userData, "database"), { recursive: true });
  await writeFile(join(userData, "database", "dev-connection.json"), JSON.stringify(descriptor));
  return userData;
}

describe("MEMORA_PROFILE_RESET knob", () => {
  it("is off when unset and accepts only 1", () => {
    const dev = { isPackaged: false };
    expect(readProfileResetKnob({}, dev)).toBe(false);
    expect(readProfileResetKnob({ MEMORA_PROFILE_RESET: "  " }, dev)).toBe(false);
    expect(readProfileResetKnob({ MEMORA_PROFILE_RESET: "1" }, dev)).toBe(true);
    for (const value of ["0", "true", "yes", "2"])
      expect(() => readProfileResetKnob({ MEMORA_PROFILE_RESET: value }, dev)).toThrow("must be 1");
  });

  it("is refused in a packaged build", () => {
    expect(() => readProfileResetKnob({ MEMORA_PROFILE_RESET: "1" }, { isPackaged: true })).toThrow(
      "refused in packaged builds"
    );
    // Unset stays a normal start even when packaged.
    expect(readProfileResetKnob({}, { isPackaged: true })).toBe(false);
  });

  it("is refused beside any other DEV knob that changes the library", () => {
    for (const other of [
      "MEMORA_LEGACY_WIPE",
      "MEMORA_GOLDEN_RUN",
      "MEMORA_GOLDEN_SOURCE_PAIRS",
      "MEMORA_GOLDEN_RESET",
      "MEMORA_MATCHING_PILOT",
      "MEMORA_MATCHING_BENCHMARK"
    ])
      expect(() =>
        readProfileResetKnob({ MEMORA_PROFILE_RESET: "1", [other]: "x" }, { isPackaged: false })
      ).toThrow(other);
  });
});

describe("measurement profile path", () => {
  it("accepts a folder inside .cache/profiles and nothing else", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-f");
    expect(await isMeasurementProfilePath(profile, workspace)).toBe(true);
    // The profiles folder itself, a sibling cache folder, an unrelated folder and a missing one.
    expect(await isMeasurementProfilePath(join(workspace, ".cache", "profiles"), workspace)).toBe(
      false
    );
    const sibling = await makeProfile(join(workspace, ".cache"), "other");
    expect(await isMeasurementProfilePath(sibling, workspace)).toBe(false);
    expect(await isMeasurementProfilePath(await makeProfile(outside, "dev"), workspace)).toBe(
      false
    );
    expect(
      await isMeasurementProfilePath(join(workspace, ".cache", "profiles", "nope"), workspace)
    ).toBe(false);
  });

  it("rejects a profile folder that is a link to a folder outside .cache/profiles", async () => {
    const real = await makeProfile(outside, "owner-dev");
    await mkdir(join(workspace, ".cache", "profiles"), { recursive: true });
    const link = join(workspace, ".cache", "profiles", "linked");
    await symlink(real, link);
    expect(await isMeasurementProfilePath(link, workspace)).toBe(false);
    // The path of the owner's default profile is outside by construction.
    expect(
      await isMeasurementProfilePath(
        "/Users/example/Library/Application Support/@app/desktop",
        workspace
      )
    ).toBe(false);
  });
});

describe("runProfileResetStartup", () => {
  function startupOptions(
    userData: string,
    overrides: Partial<ProfileResetStartupOptions> = {},
    after = { sources: 0, notes: 0 }
  ) {
    const calls: string[] = [];
    const logs: string[] = [];
    const errors: string[] = [];
    const options: ProfileResetStartupOptions = {
      env: { MEMORA_PROFILE_RESET: "1" },
      isPackaged: false,
      userDataPath: userData,
      workspaceRoot: workspace,
      pool: {
        query: async () => {
          calls.push("count");
          return { rows: [after] } as never;
        }
      },
      libraryReset: {
        reset: async () => {
          calls.push("reset");
          return { deletedSources: 30, deletedAtomicNotes: 160, deletedFiles: 12, failedFiles: 0 };
        }
      },
      readContentLanguage: async () => {
        calls.push("language");
        return "pt-BR";
      },
      logger: {
        info: (line) => logs.push(String(line)),
        error: (line) => errors.push(String(line))
      },
      now: () => new Date("2026-10-15T20:00:00.000Z"),
      ...overrides
    };
    return { options, calls, logs, errors };
  }

  it("continues a normal start when the knob is unset, touching nothing", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-g");
    const { options, calls, logs, errors } = startupOptions(profile, { env: {} });
    expect(await runProfileResetStartup(options)).toBe("continue");
    expect([calls, logs, errors]).toEqual([[], [], []]);
  });

  it("resets, verifies the library is empty, records the marker last and quits", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-g");
    // A marker from an earlier reset must be gone before the reset starts.
    await writeFile(join(profile, profileResetMarkerFile), "{}");
    const { options, calls, logs, errors } = startupOptions(profile);
    expect(await runProfileResetStartup(options)).toBe("quit");
    expect(errors).toEqual([]);
    expect(calls).toEqual(["reset", "count", "language"]);
    expect(await readProfileResetMarker(profile)).toEqual({
      format: "memora-profile-reset",
      version: 1,
      resetAt: "2026-10-15T20:00:00.000Z",
      contentLanguage: "pt-BR",
      removed: { sources: 30, notes: 160, files: 12, failedFiles: 0 },
      library: { sources: 0, notes: 0 }
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("PROFILE_RESET {");
  });

  it("refuses the owner's profile and any folder outside .cache/profiles, resetting nothing", async () => {
    const owner = await makeProfile(outside, "desktop");
    const { options, calls, errors } = startupOptions(owner);
    expect(await runProfileResetStartup(options)).toBe("quit");
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("only resets a profile inside .cache/profiles/");
    expect(await readProfileResetMarker(owner)).toBeNull();
  });

  it("refuses a packaged build, another knob and a bad value, resetting nothing", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-g");
    for (const [overrides, text] of [
      [{ isPackaged: true }, "packaged"],
      [{ env: { MEMORA_PROFILE_RESET: "1", MEMORA_GOLDEN_RUN: "m.json" } }, "MEMORA_GOLDEN_RUN"],
      [{ env: { MEMORA_PROFILE_RESET: "true" } }, "must be 1"]
    ] as const) {
      const { options, calls, errors } = startupOptions(profile, overrides);
      expect(await runProfileResetStartup(options)).toBe("quit");
      expect(calls).toEqual([]);
      expect(errors.join("\n")).toContain(text);
    }
  });

  it("needs the DEV PostgreSQL sidecar descriptor", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-g", {
      developmentOnly: false
    });
    const { options, calls, errors } = startupOptions(profile);
    expect(await runProfileResetStartup(options)).toBe("quit");
    expect(calls).toEqual([]);
    expect(errors.join("\n")).toContain("DEV PostgreSQL sidecar");
  });

  it("writes no marker when the reset fails or leaves rows behind", async () => {
    const profile = await makeProfile(join(workspace, ".cache", "profiles"), "env-g");
    const left = startupOptions(profile, {}, { sources: 2, notes: 5 });
    expect(await runProfileResetStartup(left.options)).toBe("quit");
    expect(left.errors.join("\n")).toContain("not empty after the reset (2 sources, 5 notes)");
    expect(await readProfileResetMarker(profile)).toBeNull();

    const failing = startupOptions(profile, {
      libraryReset: {
        reset: async () => {
          throw new Error("could not connect to postgresql://user:secret@127.0.0.1:1/db");
        }
      }
    });
    expect(await runProfileResetStartup(failing.options)).toBe("quit");
    expect(failing.errors.join("\n")).toContain("[redacted]");
    expect(failing.errors.join("\n")).not.toContain("secret");
    await expect(readFile(join(profile, profileResetMarkerFile), "utf8")).rejects.toThrow();
  });
});
