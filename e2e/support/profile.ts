// Scratch profiles of the journeys (F5 T137, spec 5.1 and 5.3). Every profile a journey starts lives
// under `<repo>/.cache/f5/scratch/journeys/<run>/profiles/<name>`, made by an APFS clone (`cp -cR`)
// of BASE-J or of a named source; nothing else is accepted, so a journey can never start the owner's
// profiles, `.cache/profiles/*` or the default userData. The run's screenshots and reports go to
// `<repo>/.cache/f5/journeys/<run>/`.
//
// Profiles sit in a `profiles/` folder of the run because the DEV fake remote providers
// (`MEMORA_FAKE_REMOTE`) only start on a profile inside `<MEMORA_SOAK_DATA_ROOT>/profiles/`.
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The checkout this harness runs from (the parent of `e2e/`). */
export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const runKnob = "MEMORA_JOURNEYS_RUN";
/** `20261116T120000Z`, optionally with a short suffix: `20261116T120000Z-j0`. */
export const runIdPattern = /^\d{8}T\d{6}Z(?:-[a-z0-9]{1,24})?$/u;
const profileNamePattern = /^[a-z0-9][a-z0-9-]{0,47}$/u;

export function journeysScratchRoot(repoRoot: string): string {
  return join(repoRoot, ".cache", "f5", "scratch", "journeys");
}

export function journeysEvidenceRoot(repoRoot: string): string {
  return join(repoRoot, ".cache", "f5", "journeys");
}

/** A run id from the clock (UTC, to the second). */
export function newRunId(now: Date = new Date()): string {
  return `${now.toISOString().slice(0, 19).replace(/[-:]/gu, "")}Z`;
}

export interface JourneysRun {
  id: string;
  repoRoot: string;
  /** `.cache/f5/scratch/journeys/<run>`: the data root of the run (profiles, cassettes). */
  scratchDir: string;
  profilesDir: string;
  /** `.cache/f5/journeys/<run>`: screenshots, contrast scans, reports. */
  evidenceDir: string;
}

/**
 * The run this process belongs to. The config sets `MEMORA_JOURNEYS_RUN` once in the runner, so the
 * global setup and every worker (which inherit the environment) agree on it.
 */
export function journeysRun(
  env: Record<string, string | undefined> = process.env,
  repoRoot: string = repositoryRoot,
  now: Date = new Date()
): JourneysRun {
  const given = env[runKnob]?.trim();
  if (given && !runIdPattern.test(given))
    throw new Error(`${runKnob} must look like 20261116T120000Z (optionally -suffix)`);
  const id = given || newRunId(now);
  env[runKnob] = id;
  const scratchDir = join(journeysScratchRoot(repoRoot), id);
  return {
    id,
    repoRoot,
    scratchDir,
    profilesDir: join(scratchDir, "profiles"),
    evidenceDir: join(journeysEvidenceRoot(repoRoot), id)
  };
}

async function realpathOfNearestAncestor(path: string): Promise<string> {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...[...missing].reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Returns the real path of `path` when it is a folder strictly inside one run's folder,
 * `<repo>/.cache/f5/scratch/journeys/<run>/…`; throws otherwise. Symbolic links are resolved first,
 * so a link out of the scratch tree does not pass. The message names the path, never a credential.
 */
export async function assertJourneysScratchPath(path: string, repoRoot: string): Promise<string> {
  const refusal = () =>
    new Error(
      `Refusing ${path}: a journeys profile must be an absolute folder inside ` +
        `${join(journeysScratchRoot(repoRoot), "<run>")}${sep}`
    );
  if (!isAbsolute(path) || path.split(/[\\/]/u).includes("..")) throw refusal();
  const real = await realpathOfNearestAncestor(path);
  const root = await realpathOfNearestAncestor(journeysScratchRoot(repoRoot));
  const inside = relative(root, real);
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) throw refusal();
  const [run, ...rest] = inside.split(sep);
  if (run === undefined || !runIdPattern.test(run) || rest.length === 0 || rest.includes(""))
    throw refusal();
  return real;
}

/** Folders a clone never reads from: the owner's Application Support (default userData lives there). */
function forbiddenSource(real: string): boolean {
  const support = join(homedir(), "Library", "Application Support");
  const inside = relative(support, real);
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** The folder of profile `name` in a run. */
export function profileDir(run: Pick<JourneysRun, "profilesDir">, name: string): string {
  if (!profileNamePattern.test(name))
    throw new Error(`A journeys profile name is lower-case letters, digits and dashes: ${name}`);
  return join(run.profilesDir, name);
}

/**
 * APFS-clones `source` into `target` (`cp -cR`). The target must be a new folder inside a run; the
 * source must exist, must not be under the owner's Application Support, and must not hold a running
 * PostgreSQL (a `postmaster.pid`: cloning a live cluster gives a torn copy).
 */
export async function cloneProfile(
  source: string,
  target: string,
  repoRoot: string = repositoryRoot
): Promise<string> {
  const realTarget = await assertJourneysScratchPath(target, repoRoot);
  if (existsSync(realTarget)) throw new Error(`Refusing to clone over ${target}: it exists`);
  if (!isAbsolute(source)) throw new Error(`The clone source must be absolute: ${source}`);
  const realSource = await realpath(source);
  if (forbiddenSource(realSource))
    throw new Error(`Refusing to clone ${source}: it is under the owner's Application Support`);
  if (existsSync(join(realSource, "database", "postgres-data", "postmaster.pid")))
    throw new Error(`Refusing to clone ${source}: its PostgreSQL is running (postmaster.pid)`);
  await mkdir(dirname(realTarget), { recursive: true });
  await execFileAsync("cp", ["-cR", realSource, realTarget]);
  return realTarget;
}

/** Creates an empty profile folder inside a run (an empty `userData`: the app starts from nothing). */
export async function emptyProfile(target: string, repoRoot: string = repositoryRoot) {
  const real = await assertJourneysScratchPath(target, repoRoot);
  if (existsSync(real)) throw new Error(`Refusing ${target}: it exists`);
  await mkdir(real, { recursive: true });
  return real;
}
