import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { resolveWorkspaceRoot } from "./workspace-paths.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("resolveWorkspaceRoot", () => {
  it("finds the monorepo root when Electron starts in the desktop workspace", async () => {
    const workspaceRoot = await createTemporaryDirectory();
    const desktopRoot = join(workspaceRoot, "apps", "desktop");
    await mkdir(join(workspaceRoot, "packages", "db", "drizzle"), { recursive: true });
    await mkdir(desktopRoot, { recursive: true });

    expect(resolveWorkspaceRoot(desktopRoot, {})).toBe(workspaceRoot);
  });

  it("honors an explicit workspace root", () => {
    expect(resolveWorkspaceRoot("/ignored", { MEMORA_WORKSPACE_ROOT: "./configured-root" })).toBe(
      resolve("./configured-root")
    );
  });

  it("falls back to the original working directory when no marker exists", async () => {
    const directory = await createTemporaryDirectory();

    expect(resolveWorkspaceRoot(directory, {})).toBe(directory);
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "memora-workspace-"));
  temporaryDirectories.push(directory);
  return directory;
}
