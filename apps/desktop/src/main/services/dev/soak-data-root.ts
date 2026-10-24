import { statSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SoakKnobRefusal } from "./soak-refusal.js";

/**
 * Where a soak reads and writes (F4 T89, D1, spec 0.21). F3's harness resolved the profiles, the
 * public corpus, the run folder and the local-model lock under the checkout's own ignored `.cache`,
 * so a soak could run only from that checkout, where the dev server's watcher restarts it on an edit.
 * `MEMORA_SOAK_DATA_ROOT` names an absolute folder, the `.cache` of the main checkout, that holds all
 * four, so the 7-day soak runs from a worktree outside it (never under `.claude/worktrees/`, which
 * agents prune) on a frozen branch, and the machine-wide local-model lock stays the main checkout's.
 * Without the knob nothing changes: everything is `<workspaceRoot>/.cache`.
 */

export const soakDataRootKnobName = "MEMORA_SOAK_DATA_ROOT";

/** Which phase's run folder a plan profile writes to: F3's `f3/soak/<run>` or F4's `f4/soak/<run>`. */
export type SoakRunFamily = "f3" | "f4";

export interface SoakPaths {
  /** The folder with `profiles/`, `corpus/`, `f2/` and the run folders. */
  readonly cacheRoot: string;
  /** True when `MEMORA_SOAK_DATA_ROOT` named it. */
  readonly external: boolean;
  /** Every soak profile lives in a folder directly or deeply inside this one. */
  readonly profilesDirectory: string;
  /** The public Wikipedia corpus (`en.jsonl`, `pt.jsonl`). */
  readonly corpusDirectory: string;
  /** The machine-wide local-model lock of the data root (`LOCAL_MODEL_BUSY`, F2 D45). */
  readonly lockFile: string;
  runDirectory(family: SoakRunFamily, run: string): string;
  /** Where the scripted profile setup writes its result. */
  setupFile(family: SoakRunFamily): string;
}

type Env = Readonly<Record<string, string | undefined>>;

function pathsAt(cacheRoot: string, external: boolean): SoakPaths {
  return {
    cacheRoot,
    external,
    profilesDirectory: join(cacheRoot, "profiles"),
    corpusDirectory: join(cacheRoot, "corpus", "wikipedia"),
    lockFile: join(cacheRoot, "f2", "LOCAL_MODEL_BUSY"),
    runDirectory: (family, run) => join(cacheRoot, family, "soak", run),
    setupFile: (family) => join(cacheRoot, family, "soak", "setup.json")
  };
}

/**
 * The paths of a soak: the data root the knob names, else `<workspaceRoot>/.cache`. Refused when
 * packaged, for a relative path, the filesystem root, a folder under `.claude/worktrees/` (agents
 * prune those) and a folder that does not exist (a typo must not create a second `.cache`).
 */
export function resolveSoakPaths(
  env: Env,
  options: { workspaceRoot: string; isPackaged: boolean }
): SoakPaths {
  const raw = env[soakDataRootKnobName]?.trim();
  if (!raw) return pathsAt(join(resolve(options.workspaceRoot), ".cache"), false);
  if (options.isPackaged)
    throw new SoakKnobRefusal("packaged", `${soakDataRootKnobName} is refused in packaged builds`);
  if (!isAbsolute(raw))
    throw new SoakKnobRefusal("dataRoot", `${soakDataRootKnobName} must be an absolute path`);
  const root = resolve(raw);
  if (dirname(root) === root)
    throw new SoakKnobRefusal("dataRoot", `${soakDataRootKnobName} cannot be the filesystem root`);
  if (root.split(sep).includes(".claude") && root.includes(`${sep}worktrees${sep}`))
    throw new SoakKnobRefusal(
      "dataRoot",
      `${soakDataRootKnobName} cannot be inside .claude/worktrees/: agents prune those folders`
    );
  let directory = false;
  try {
    directory = statSync(root).isDirectory();
  } catch {
    // Reported below.
  }
  if (!directory)
    throw new SoakKnobRefusal("dataRoot", `${soakDataRootKnobName} is not an existing folder`);
  return pathsAt(root, true);
}

/** True when `userDataPath` is a folder strictly inside the data root's `profiles/` (paths only). */
export function insideSoakProfiles(userDataPath: string, paths: SoakPaths): boolean {
  const inside = relative(paths.profilesDirectory, resolve(userDataPath));
  return !(inside === "" || inside.startsWith("..") || isAbsolute(inside));
}

/** The same once both folders are resolved through symbolic links (a link out of the profiles does not count). */
export async function isSoakProfilePath(userDataPath: string, paths: SoakPaths): Promise<boolean> {
  try {
    const profiles = await realpath(paths.profilesDirectory);
    const profile = await realpath(resolve(userDataPath));
    const inside = relative(profiles, profile);
    return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
  } catch {
    return false;
  }
}

export interface SoakLockOptions {
  /** The data root's `LOCAL_MODEL_BUSY`. */
  path: string;
  /** Written first in the file, so the holder of the lock can be told: `soak:<profile>`. */
  owner: string;
  run: string;
  pid?: number;
}

/**
 * Takes the machine-wide local-model lock of the data root for the whole run (the soak holds both
 * slots for 169 h, D2) and returns the function that gives it up. The file is created exclusively; a
 * file that names this owner is the orchestrator's own claim for this run and is adopted; any other
 * holder refuses the run. Giving the lock up removes the file only while it still names this owner.
 */
export async function acquireSoakLock(options: SoakLockOptions): Promise<() => Promise<void>> {
  const line = `${options.owner} pid ${options.pid ?? process.pid} run ${options.run}\n`;
  await mkdir(dirname(options.path), { recursive: true });
  try {
    await writeFile(options.path, line, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const held = (await readFile(options.path, "utf8").catch(() => "")).trim();
    if (!held.startsWith(`${options.owner} `))
      throw new SoakKnobRefusal(
        "lock",
        `The local-model slot ${options.path} is held by: ${held.slice(0, 120) || "an unreadable lock"}`
      );
    await writeFile(options.path, line);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const held = (await readFile(options.path, "utf8").catch(() => "")).trim();
    if (held.startsWith(`${options.owner} `)) await rm(options.path, { force: true });
  };
}
