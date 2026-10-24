import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  acquireSoakLock,
  insideSoakProfiles,
  isSoakProfilePath,
  resolveSoakPaths,
  soakDataRootKnobName,
  soakWorktreeProblem,
  underAgentWorktrees
} from "./soak-data-root.js";

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
const folder = (prefix: string) => {
  const path = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(path);
  return path;
};

describe("the soak's paths", () => {
  it("are the checkout's own .cache when no data root is named, as F3's harness had them", () => {
    const worktree = folder("soak-paths-");
    const paths = resolveSoakPaths({}, { workspaceRoot: worktree, isPackaged: false });
    expect(paths).toMatchObject({
      cacheRoot: join(worktree, ".cache"),
      external: false,
      profilesDirectory: join(worktree, ".cache", "profiles"),
      corpusDirectory: join(worktree, ".cache", "corpus", "wikipedia"),
      lockFile: join(worktree, ".cache", "f2", "LOCAL_MODEL_BUSY")
    });
    expect(paths.runDirectory("f3", "soak24-1")).toBe(
      join(worktree, ".cache", "f3", "soak", "soak24-1")
    );
    expect(paths.setupFile("f3")).toBe(join(worktree, ".cache", "f3", "soak", "setup.json"));
  });

  it("move together to the data root: profiles, corpus, run folder and the lock, none under the worktree", () => {
    const worktree = folder("soak-worktree-");
    const dataRoot = folder("soak-data-");
    const paths = resolveSoakPaths(
      { [soakDataRootKnobName]: dataRoot },
      { workspaceRoot: worktree, isPackaged: false }
    );
    expect(paths.external).toBe(true);
    const all = [
      paths.profilesDirectory,
      paths.corpusDirectory,
      paths.lockFile,
      paths.runDirectory("f4", "soak7-20261028T0000"),
      paths.setupFile("f4")
    ];
    expect(all).toEqual([
      join(dataRoot, "profiles"),
      join(dataRoot, "corpus", "wikipedia"),
      join(dataRoot, "f2", "LOCAL_MODEL_BUSY"),
      join(dataRoot, "f4", "soak", "soak7-20261028T0000"),
      join(dataRoot, "f4", "soak", "setup.json")
    ]);
    for (const path of all) expect(path.startsWith(worktree)).toBe(false);
  });

  it("refuse a data root that is relative, the filesystem root, under .claude/worktrees, missing, or packaged", () => {
    const worktree = folder("soak-worktree-");
    const options = { workspaceRoot: worktree, isPackaged: false };
    const refused = (value: string, packaged = false) =>
      resolveSoakPaths({ [soakDataRootKnobName]: value }, { ...options, isPackaged: packaged });
    expect(() => refused("cache")).toThrow(expect.objectContaining({ code: "dataRoot" }));
    expect(() => refused("/")).toThrow(/filesystem root/u);
    expect(() => refused(join(worktree, ".claude", "worktrees", "agent-1", ".cache"))).toThrow(
      /agents prune/u
    );
    expect(() => refused(join(worktree, "nowhere"))).toThrow(/not an existing folder/u);
    expect(() => refused(worktree, true)).toThrow(expect.objectContaining({ code: "packaged" }));
  });

  it("tell a clone inside the data root's profiles from the worktree's own folders", () => {
    const worktree = folder("soak-worktree-");
    const dataRoot = folder("soak-data-");
    const paths = resolveSoakPaths(
      { [soakDataRootKnobName]: dataRoot },
      { workspaceRoot: worktree, isPackaged: false }
    );
    expect(insideSoakProfiles(join(dataRoot, "profiles", "env-soak7"), paths)).toBe(true);
    expect(insideSoakProfiles(join(dataRoot, "profiles"), paths)).toBe(false);
    expect(insideSoakProfiles(join(worktree, ".cache", "profiles", "env-soak7"), paths)).toBe(
      false
    );
    expect(insideSoakProfiles(join(dataRoot, "elsewhere"), paths)).toBe(false);
  });

  it("see through a link out of the profiles folder", async () => {
    const dataRoot = folder("soak-data-");
    const elsewhere = folder("soak-elsewhere-");
    mkdirSync(join(dataRoot, "profiles", "real"), { recursive: true });
    symlinkSync(elsewhere, join(dataRoot, "profiles", "linked"));
    const paths = resolveSoakPaths(
      { [soakDataRootKnobName]: dataRoot },
      { workspaceRoot: folder("soak-worktree-"), isPackaged: false }
    );
    expect(await isSoakProfilePath(join(dataRoot, "profiles", "real"), paths)).toBe(true);
    expect(await isSoakProfilePath(join(dataRoot, "profiles", "linked"), paths)).toBe(false);
    expect(await isSoakProfilePath(join(dataRoot, "profiles", "missing"), paths)).toBe(false);
  });
});

describe("the local-model lock of the data root", () => {
  it("is taken for the run and given up at its end", async () => {
    const dataRoot = folder("soak-data-");
    const path = join(dataRoot, "f2", "LOCAL_MODEL_BUSY");
    const release = await acquireSoakLock({ path, owner: "soak:soak7", run: "soak7-1", pid: 4242 });
    expect(existsSync(path)).toBe(true);
    await release();
    expect(existsSync(path)).toBe(false);
    await release();
  });

  it("refuses the run while another holder has the slot, and names the holder", async () => {
    const dataRoot = folder("soak-data-");
    const path = join(dataRoot, "f2", "LOCAL_MODEL_BUSY");
    mkdirSync(join(dataRoot, "f2"));
    writeFileSync(path, "T69 pid 77\n");
    await expect(acquireSoakLock({ path, owner: "soak:soak7", run: "soak7-1" })).rejects.toThrow(
      /held by: T69 pid 77/u
    );
    expect(existsSync(path)).toBe(true);
  });

  it("adopts a claim the orchestrator made for this owner, and gives up only what still names it", async () => {
    const dataRoot = folder("soak-data-");
    const path = join(dataRoot, "f2", "LOCAL_MODEL_BUSY");
    mkdirSync(join(dataRoot, "f2"));
    writeFileSync(path, "soak:soak7 pid 1 run waiting\n");
    const release = await acquireSoakLock({ path, owner: "soak:soak7", run: "soak7-1", pid: 9 });
    writeFileSync(path, "T70 pid 3\n");
    await release();
    expect(existsSync(path)).toBe(true);
  });
});

describe("where the 7-day soak may run from", () => {
  it("knows the folders agents prune", () => {
    expect(underAgentWorktrees("/x/memoraeterna/.claude/worktrees/wf_1")).toBe(true);
    expect(underAgentWorktrees("/x/memoraeterna/.claude/worktrees/wf_1/apps")).toBe(true);
    expect(underAgentWorktrees("/x/memoraeterna/.claude/worktrees")).toBe(false);
    expect(underAgentWorktrees("/x/memoraeterna-f4-soak")).toBe(false);
    expect(underAgentWorktrees("/x/claude/worktrees/a")).toBe(false);
  });

  it("is a worktree outside the checkout that owns the data root, with the data root named", () => {
    const checkout = folder("soak-main-");
    mkdirSync(join(checkout, ".git"));
    mkdirSync(join(checkout, ".cache"));
    const outside = folder("soak-tree-");
    const paths = resolveSoakPaths(
      { [soakDataRootKnobName]: join(checkout, ".cache") },
      { workspaceRoot: outside, isPackaged: false }
    );
    expect(soakWorktreeProblem(outside, paths)).toBeNull();
    // The main checkout itself, a worktree agents prune inside it, and a folder in the data root.
    expect(soakWorktreeProblem(checkout, paths)).toMatch(/inside the checkout/u);
    const pruned = join(checkout, ".claude", "worktrees", "wf_1");
    mkdirSync(pruned, { recursive: true });
    expect(soakWorktreeProblem(pruned, paths)).toMatch(/agents prune/u);
    const nested = join(checkout, ".cache", "f4", "soak-tree");
    mkdirSync(nested, { recursive: true });
    expect(soakWorktreeProblem(nested, paths)).toMatch(/inside the data root/u);
    // Without the knob there is no data root of the main checkout to run on.
    expect(
      soakWorktreeProblem(
        outside,
        resolveSoakPaths({}, { workspaceRoot: outside, isPackaged: false })
      )
    ).toMatch(/needs MEMORA_SOAK_DATA_ROOT/u);
  });
});
