import { readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Scratch-profile gate of the matching pilot and benchmark (F5 D26, T112). The runners write
 * artifacts into `<userData>/matching-{pilot,benchmark}/` and may reset or extend a library, so they
 * run only on a scratch profile: a folder strictly inside `<workspace>/.cache/profiles/` or
 * `<workspace>/.cache/f<N>/scratch/`, after symbolic links are resolved: a root whose real path is
 * not inside the real `<workspace>/.cache` is not a root, and the owner's default userData is
 * refused by name. The owner's own profile is outside both by construction. `isMeasurementProfilePath` (profile reset, explain probe, relations
 * rematch, corpus runner) is deliberately not widened: it also gates a wipe, which must never reach
 * a scratch folder that is not a cloned profile.
 */

export const matchingRunners = ["pilot", "benchmark"] as const;
export type MatchingRunner = (typeof matchingRunners)[number];

/** Message key of the refusal; the runners are DEV-only, so it is logged and never translated. */
export const notScratchProfileCode = "matching.errors.notScratchProfile";

export class MatchingProfileError extends Error {
  public readonly code = notScratchProfileCode;
  public constructor(detail: string) {
    super(`${notScratchProfileCode}: ${detail}`);
    this.name = "MatchingProfileError";
  }
}

/** The owner's default DEV userData folder (Electron's default for `@app/desktop`). */
export function defaultUserDataPath(home: string = homedir()): string {
  return join(home, "Library", "Application Support", "@app", "desktop");
}

/** True when `child` is `parent` or lies inside it (both already resolved); `strict` excludes `parent`. */
function isInside(parent: string, child: string, strict: boolean): boolean {
  const path = relative(parent, child);
  if (path === "") return !strict;
  return !path.startsWith("..") && !isAbsolute(path);
}

/**
 * The folders whose children are scratch profiles, as they exist now under `<workspace>/.cache`. A
 * root that is a link leaving the real `.cache` (to the owner's userData, say) is left out.
 */
async function scratchRoots(workspaceRoot: string): Promise<string[]> {
  const cache = resolve(workspaceRoot, ".cache");
  let cacheReal: string;
  try {
    cacheReal = await realpath(cache);
  } catch {
    return []; // No cache folder: nothing is a scratch profile.
  }
  const candidates = [join(cache, "profiles")];
  try {
    for (const entry of await readdir(cache, { withFileTypes: true }))
      if (/^f\d+$/u.test(entry.name)) candidates.push(join(cache, entry.name, "scratch"));
  } catch {
    // An unreadable cache folder holds no scratch root.
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate);
      if (isInside(cacheReal, real, true)) roots.push(real);
    } catch {
      // A root that does not exist holds no profile.
    }
  }
  return roots;
}

/**
 * True when `userDataPath` is absolute and is a folder strictly inside one scratch root once both
 * are resolved through symbolic links (a link out of the root does not count; neither does the root).
 */
export async function isScratchProfilePath(
  userDataPath: string,
  workspaceRoot: string
): Promise<boolean> {
  if (!userDataPath || !isAbsolute(userDataPath)) return false;
  try {
    const profile = await realpath(resolve(userDataPath));
    for (const root of await scratchRoots(workspaceRoot))
      if (isInside(root, profile, true)) return true;
  } catch {
    // An unreadable or missing profile is not a scratch profile.
  }
  return false;
}

export interface MatchingProfile {
  /** The profile folder, as given (absolute). */
  profilePath: string;
  /** `<profilePath>/matching-pilot` or `<profilePath>/matching-benchmark`. */
  outputDirectory: string;
}

/** True when the folder is the default userData or inside it, links resolved, case folded (macOS). */
async function isDefaultUserDataPath(userDataPath: string, home: string): Promise<boolean> {
  const canonical = async (path: string) => {
    try {
      return (await realpath(resolve(path))).toLowerCase();
    } catch {
      return resolve(path).toLowerCase();
    }
  };
  return isInside(await canonical(defaultUserDataPath(home)), await canonical(userDataPath), false);
}

/**
 * The scratch profile and the runner's artifact folder in it; throws before anything is written.
 * `home` is only for tests: the default userData is looked up under it.
 */
export async function readMatchingProfile(options: {
  userDataPath: string;
  workspaceRoot: string;
  runner: MatchingRunner;
  home?: string;
}): Promise<MatchingProfile> {
  if (
    !(await isScratchProfilePath(options.userDataPath, options.workspaceRoot)) ||
    (await isDefaultUserDataPath(options.userDataPath, options.home ?? homedir()))
  )
    throw new MatchingProfileError(
      "the matching runners and scripts need an absolute profile folder (MEMORA_USER_DATA_DIR or --profile) inside .cache/profiles/ or .cache/f<N>/scratch/, never the default userData"
    );
  const profilePath = resolve(options.userDataPath);
  return { profilePath, outputDirectory: join(profilePath, `matching-${options.runner}`) };
}
