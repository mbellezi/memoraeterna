import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

/**
 * Scratch-profile gate of the matching pilot and benchmark (F5 D26, T112). The runners write
 * artifacts into `<userData>/matching-{pilot,benchmark}/` and may reset or extend a library, so they
 * run only on a scratch profile: a folder strictly inside `<workspace>/.cache/profiles/` or
 * `<workspace>/.cache/f<N>/scratch/`, after symbolic links are resolved. The owner's own profile is
 * outside both by construction. `isMeasurementProfilePath` (profile reset, explain probe, relations
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

/** The folders whose children are scratch profiles, as they exist now under `<workspace>/.cache`. */
async function scratchRoots(workspaceRoot: string): Promise<string[]> {
  const cache = resolve(workspaceRoot, ".cache");
  const candidates = [join(cache, "profiles")];
  try {
    for (const entry of await readdir(cache, { withFileTypes: true }))
      if (/^f\d+$/u.test(entry.name)) candidates.push(join(cache, entry.name, "scratch"));
  } catch {
    // No cache folder: nothing is a scratch profile.
  }
  const roots: string[] = [];
  for (const candidate of candidates) {
    try {
      roots.push(await realpath(candidate));
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
    for (const root of await scratchRoots(workspaceRoot)) {
      const path = relative(root, profile);
      if (path !== "" && !path.startsWith("..") && !isAbsolute(path)) return true;
    }
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

/** The scratch profile and the runner's artifact folder in it; throws before anything is written. */
export async function readMatchingProfile(options: {
  userDataPath: string;
  workspaceRoot: string;
  runner: MatchingRunner;
}): Promise<MatchingProfile> {
  if (!(await isScratchProfilePath(options.userDataPath, options.workspaceRoot)))
    throw new MatchingProfileError(
      "the matching runners and scripts need an absolute profile folder (MEMORA_USER_DATA_DIR or --profile) inside .cache/profiles/ or .cache/f<N>/scratch/"
    );
  const profilePath = resolve(options.userDataPath);
  return { profilePath, outputDirectory: join(profilePath, `matching-${options.runner}`) };
}
