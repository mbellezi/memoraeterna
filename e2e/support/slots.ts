// The slots of a journeys run (F5 T137, D4, spec 5.3). A journey is a Memora Electron that runs the
// local models, so it holds both machine slots: it refuses to start while another Memora Electron
// runs (DEV, a packaged copy, another journey) or while `LOCAL_MODEL_BUSY` of the main checkout is
// held by another task, then creates that file with its own task id and removes it when it ends.
// It never waits: the slot plan decides when a run starts, not this harness.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/** Electron main processes: the npm `electron` binary or the packaged app (not their helpers). */
const electronMain =
  /(?:\/Electron\.app\/Contents\/MacOS\/Electron|\/Memora Eterna\.app\/Contents\/MacOS\/Memora Eterna)(?:\s|$)/u;
/**
 * Bare Electron tools that never start Memora (no database, no model): the screens capture and the
 * offscreen verification scripts. Anything else on the Electron binary counts as a Memora Electron.
 */
const bareElectronTools =
  /scripts\/(?:screens\/capture\.cjs|verify-graph-webgl\.mjs|verify-source-relations-ui\.mjs|verify-prompt-highlights\.mjs)/u;

export function processRows(): ProcessRow[] {
  const output = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
  return output
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => ({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] ?? "" }));
}

/** The Memora Electron main processes among `rows`, as `<pid> <command…>` (cut to 160 characters). */
export function memoraElectrons(rows: readonly ProcessRow[]): string[] {
  return rows
    .filter((row) => electronMain.test(row.command))
    .filter((row) => !row.command.includes("--type=") && !bareElectronTools.test(row.command))
    .map((row) => `${row.pid} ${row.command.slice(0, 160)}`);
}

/** The main checkout (the common git folder's parent): its `.cache/f2/LOCAL_MODEL_BUSY` is the machine's. */
export function mainCheckoutRoot(cwd: string): string {
  const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
    cwd,
    encoding: "utf8"
  }).trim();
  return dirname(resolve(cwd, common));
}

export function busyLockPath(mainRoot: string): string {
  return join(mainRoot, ".cache", "f2", "LOCAL_MODEL_BUSY");
}

export class SlotRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SlotRefusal";
  }
}

/** The lock's first line for this run: `<owner> pid <pid> run <run>` (the soak's format). */
export function lockLine(owner: string, run: string, pid: number): string {
  return `${owner} pid ${pid} run ${run}`;
}

/** Whether a lock's text was written by this owner and run (any pid: a crashed attempt of the same run). */
export function isOwnLock(text: string, owner: string, run: string): boolean {
  const first = text.split("\n", 1)[0]?.trim() ?? "";
  const match = /^(\S+)(?: pid \d+)? run (\S+)$/u.exec(first);
  return match !== null && match[1] === owner && match[2] === run;
}

export interface SlotOptions {
  lockPath: string;
  /** `journeys:<run>`. */
  owner: string;
  run: string;
  processes?: () => readonly ProcessRow[];
  pid?: number;
}

/**
 * Refuses when a Memora Electron runs or another task holds the lock; otherwise writes the lock and
 * returns its remover (idempotent; it removes the file only while it is still this run's).
 */
export async function acquireJourneySlots(options: SlotOptions): Promise<() => Promise<void>> {
  const running = memoraElectrons((options.processes ?? processRows)());
  if (running.length > 0)
    throw new SlotRefusal(
      `Another Memora Electron runs; a journey needs the DEV-app slot:\n  ${running.join("\n  ")}`
    );
  const pid = options.pid ?? process.pid;
  await mkdir(dirname(options.lockPath), { recursive: true });
  let held: string | null = null;
  try {
    held = await readFile(options.lockPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (held !== null && !isOwnLock(held, options.owner, options.run))
    throw new SlotRefusal(
      `${options.lockPath} is held by another task (${held.split("\n", 1)[0]?.slice(0, 120)}); ` +
        "a journey needs the local-model slot"
    );
  const line = `${lockLine(options.owner, options.run, pid)}\n`;
  try {
    await writeFile(options.lockPath, line, { flag: held === null ? "wx" : "w" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new SlotRefusal(`${options.lockPath} was taken by another task a moment ago`);
    throw error;
  }
  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    process.off("exit", releaseNow);
    try {
      if (isOwnLock(await readFile(options.lockPath, "utf8"), options.owner, options.run))
        await rm(options.lockPath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  };
  // A runner that dies without its teardown still gives the slot back.
  const releaseNow = () => {
    if (released) return;
    try {
      if (isOwnLock(readFileSync(options.lockPath, "utf8"), options.owner, options.run))
        execFileSync("rm", ["-f", options.lockPath]);
    } catch {
      // Nothing to give back.
    }
  };
  process.once("exit", releaseNow);
  return release;
}
