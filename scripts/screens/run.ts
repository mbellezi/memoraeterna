/**
 * `npm run screens -- [--screen id[,id…]] [--check] [--no-shots] [--mode m] [--theme t] [--width w]
 *                     [--locale en|pt-BR|es|fr|it] [--focus <css selector>]`
 *
 * Renders each requested surface (every surface whose implementation and screen module exist, by
 * default) in each mode (loading, empty, error, success), theme (light, dark) and width (960,
 * 1440) in a bare offscreen Electron over a fake `window.app`, and writes
 * `.cache/f5/screens/<run>/<surface>/<mode>-<theme>-<width>.png` and `.cache/f5/screens/<run>/check.json`.
 * `--locale` (default en) renders every surface in that language, through the same `createTranslator`
 * the app gives its components; a run is one locale, and `--check` proves the page really carried it.
 * `--focus <selector>` focuses the first element that matches after the surface is mounted (as the
 * keyboard would, so `:focus-visible` shows) and writes `<mode>-<theme>-<width>-focus.png`; a
 * selector that matches nothing fails the capture. It is how a screenshot shows a focus ring.
 * A surface that fills the window (the shell, the rail) is captured edge to edge at the stated width;
 * the others sit on a 1 rem stand. `--check` exits 1 unless every surface reported `[data-surface=<id>][data-state=<mode>]` within
 * five seconds in every combination (an object panel also shows its path ribbon in success).
 *
 * One capture runs at a time on the machine: the lock file lives in the repository's shared git
 * directory, so the worktrees of parallel cards take the same one. Run it at background QoS
 * (`taskpolicy -b`) while an F4 run holds the slots. It starts no Memora process and loads no model.
 * The capture appends each result as it finishes and is stopped only when it makes no progress for
 * `idleLimitMs`, so a long run over many surfaces is not cut by a fixed total time.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  screenModes,
  surfaces,
  type ScreenMode,
  type SurfaceEntry
} from "../../apps/desktop/src/renderer/workspace/surfaces";
import {
  defaultLanguageCode,
  isSupportedLanguageCode,
  supportedLanguageCodes,
  type LanguageCode
} from "../../packages/i18n/src/index";
import { buildBundle, rendererRoot, repositoryRoot } from "./build-bundle";
import type { MountResult, ScreenTheme } from "./harness";

export const allThemes: readonly ScreenTheme[] = ["light", "dark"];
export const allWidths: readonly number[] = [960, 1440];
const viewportHeight = 900;
/** The capture prints a line per finished job; this long without one (a job gives up at 20 s) kills it. */
export const idleLimitMs = 90 * 1000;

export interface ScreensArgs {
  screens: string[];
  check: boolean;
  shots: boolean;
  modes: ScreenMode[];
  themes: ScreenTheme[];
  widths: number[];
  locale: LanguageCode;
  /** A CSS selector to focus before each shot, or null. */
  focus: string | null;
}

export function parseScreensArgs(argv: readonly string[]): ScreensArgs {
  const args: ScreensArgs = {
    screens: [],
    check: false,
    shots: true,
    modes: [],
    themes: [],
    widths: [],
    locale: defaultLanguageCode,
    focus: null
  };
  const values = (flag: string, index: number): string => {
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index] ?? "";
    if (flag === "--check") args.check = true;
    else if (flag === "--no-shots") args.shots = false;
    else if (flag === "--screen") {
      args.screens.push(...values(flag, index++).split(",").filter(Boolean));
    } else if (flag === "--mode") {
      const mode = values(flag, index++) as ScreenMode;
      if (!screenModes.includes(mode)) throw new Error(`Unknown mode ${mode}`);
      args.modes.push(mode);
    } else if (flag === "--theme") {
      const theme = values(flag, index++) as ScreenTheme;
      if (!allThemes.includes(theme)) throw new Error(`Unknown theme ${theme}`);
      args.themes.push(theme);
    } else if (flag === "--width") {
      const width = Number(values(flag, index++));
      if (!Number.isInteger(width) || width < 960) throw new Error("--width is at least 960");
      args.widths.push(width);
    } else if (flag === "--focus") {
      args.focus = values(flag, index++);
    } else if (flag === "--locale") {
      const locale = values(flag, index++);
      if (!isSupportedLanguageCode(locale))
        throw new Error(`Unknown locale ${locale}; one of ${supportedLanguageCodes.join(", ")}`);
      args.locale = locale;
    } else throw new Error(`Unknown argument ${flag}`);
  }
  return args;
}

/** The surfaces a run covers: the requested ones, else every surface that exists. */
export function selectSurfaces(
  requested: readonly string[],
  exists: (path: string) => boolean,
  entries: readonly SurfaceEntry[] = surfaces
): SurfaceEntry[] {
  const built = (entry: SurfaceEntry) => exists(entry.implementation) && exists(entry.screen);
  if (requested.length === 0) return entries.filter(built);
  return [...new Set(requested)].map((id) => {
    const entry = entries.find((candidate) => candidate.id === id);
    if (!entry) throw new Error(`Unknown surface ${id}; surfaces.ts lists the ids`);
    if (!exists(entry.implementation))
      throw new Error(`Surface ${id} is planned: ${entry.implementation} does not exist yet`);
    if (!exists(entry.screen))
      throw new Error(`Surface ${id} has no screen module at ${entry.screen}`);
    return entry;
  });
}

export interface CaptureJob {
  surface: string;
  mode: ScreenMode;
  theme: ScreenTheme;
  width: number;
}

/** Width is the outer loop, so the window is resized as seldom as possible. */
export function captureJobs(
  selected: readonly SurfaceEntry[],
  args: Pick<ScreensArgs, "modes" | "themes" | "widths">
): CaptureJob[] {
  const modes = args.modes.length > 0 ? args.modes : screenModes;
  const themes = args.themes.length > 0 ? args.themes : allThemes;
  const widths = args.widths.length > 0 ? args.widths : allWidths;
  const jobs: CaptureJob[] = [];
  for (const width of widths)
    for (const entry of selected)
      for (const mode of modes)
        for (const theme of themes) jobs.push({ surface: entry.id, mode, theme, width });
  return jobs;
}

export interface CheckSummary {
  passed: boolean;
  total: number;
  failed: number;
  failures: string[];
}

export function summarize(
  results: readonly (MountResult & { width: number })[],
  expected = results.length,
  exitCode = 0,
  locale: string = defaultLanguageCode
): CheckSummary {
  const failures = results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.surface} ${result.mode} ${result.theme} ${result.width}: ${result.reasons.join("; ") || "failed"}`
    );
  // The language must have reached the page, not only the plan.
  for (const result of results)
    if (result.locale !== locale)
      failures.push(
        `${result.surface} ${result.mode} ${result.theme} ${result.width}: rendered in ${result.locale}, expected ${locale}`
      );
  // An empty state that shows what the success state shows is not an empty state.
  const shown = new Map<string, string>();
  for (const result of results)
    if (result.ok && result.mode === "success")
      shown.set(`${result.surface} ${result.theme} ${result.width}`, result.signature);
  for (const result of results) {
    const key = `${result.surface} ${result.theme} ${result.width}`;
    if (result.ok && result.mode === "empty" && shown.get(key) === result.signature)
      failures.push(`${key}: empty shows what success shows`);
  }
  if (results.length < expected)
    failures.push(`the capture ended after ${results.length} of ${expected} captures`);
  if (exitCode !== 0) failures.push(`the capture process exited with ${exitCode}`);
  return {
    passed: failures.length === 0 && results.length > 0,
    total: expected,
    failed: failures.length,
    failures
  };
}

/** The results file: one JSON line per finished capture or blocked request (a cut last line is ignored). */
export function readCaptureLines(text: string): {
  results: (MountResult & { width: number })[];
  blocked: string[];
} {
  const results: (MountResult & { width: number })[] = [];
  const blocked: string[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as {
        result?: MountResult & { width: number };
        blocked?: string;
      };
      if (parsed.result) results.push(parsed.result);
      else if (typeof parsed.blocked === "string") blocked.push(parsed.blocked);
    } catch {
      // The last line of a capture that was killed can be cut.
    }
  }
  return { results, blocked };
}

/** Calls `onIdle` once when `touch` has not been called for `limitMs`. */
export function idleWatchdog(limitMs: number, onIdle: () => void): { touch(): void; stop(): void } {
  let timer = setTimeout(onIdle, limitMs);
  return {
    touch() {
      clearTimeout(timer);
      timer = setTimeout(onIdle, limitMs);
    },
    stop() {
      clearTimeout(timer);
    }
  };
}

/**
 * The one lock every checkout of this repository shares: the git directory common to the worktrees
 * (a worktree's own `.cache` is not shared). Outside a git checkout it falls back to the checkout.
 */
export function sharedLockFile(
  root: string,
  git: (args: string[], cwd: string) => string = (args, cwd) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
): string {
  try {
    const common = git(["rev-parse", "--git-common-dir"], root).trim();
    if (common !== "") return join(realpathSync(resolve(root, common)), "memora-screens.lock");
  } catch {
    // Not a git checkout.
  }
  mkdirSync(join(root, ".cache/f5/screens"), { recursive: true });
  return join(root, ".cache/f5/screens/.lock");
}

/** One capture at a time: a lock file holding the owner's pid; a dead owner's lock is replaced. */
export function takeLock(file: string, alive: (pid: number) => boolean = isAlive): () => void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(file, String(process.pid), { flag: "wx" });
      return () => rmSync(file, { force: true });
    } catch {
      const owner = Number(readFileSync(file, "utf8"));
      if (Number.isInteger(owner) && alive(owner))
        throw new Error(`Another screens capture is running (pid ${owner})`);
      rmSync(file, { force: true });
    }
  }
  throw new Error("Could not take the screens lock");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runId(now = new Date()): string {
  return now
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d+Z$/u, "")
    .replace("T", "-");
}

function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") throw new Error("The electron package gave no binary path");
  return binary;
}

async function runCapture(planFile: string, total: number): Promise<number> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("MEMORA_") && name !== "ELECTRON_RUN_AS_NODE"
    )
  );
  return new Promise((resolveCode, reject) => {
    const child = spawn(
      electronBinary(),
      [join(repositoryRoot, "scripts/screens/capture.cjs"), planFile],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "inherit"]
      }
    );
    const watchdog = idleWatchdog(idleLimitMs, () => {
      console.error(`screens: no progress for ${idleLimitMs / 1000} s; stopping the capture`);
      child.kill("SIGKILL");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      watchdog.touch();
      for (const line of chunk.toString().split("\n")) {
        const done = /^screens-capture (\d+)\//u.exec(line)?.[1];
        if (done !== undefined && Number(done) % 100 === 0)
          console.log(`screens: ${done}/${total} captured`);
      }
    });
    child.once("error", (error) => {
      watchdog.stop();
      reject(error);
    });
    child.once("exit", (code) => {
      watchdog.stop();
      resolveCode(code ?? 1);
    });
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseScreensArgs(argv);
  const selected = selectSurfaces(args.screens, (path) => existsSync(join(rendererRoot, path)));
  if (selected.length === 0)
    throw new Error("No surface has an implementation and a screen module");
  const jobs = captureJobs(selected, args);

  const base = join(repositoryRoot, ".cache/f5/screens");
  mkdirSync(base, { recursive: true });
  const release = takeLock(sharedLockFile(repositoryRoot));
  const scratch = mkdtempSync(join(tmpdir(), "memora-screens-bundle-"));
  const run = runId();
  const outDirectory = join(base, run);
  try {
    mkdirSync(outDirectory, { recursive: true });
    const bundle = await buildBundle(selected, scratch, rendererRoot, args.locale);
    console.log(
      `screens: ${selected.length} surface(s), ${jobs.length} capture(s) in ${args.locale}, bundle ${(bundle.bytes / 1e6).toFixed(1)} MB`
    );
    const resultsFile = join(scratch, "results.json");
    const planFile = join(scratch, "plan.json");
    writeFileSync(
      planFile,
      JSON.stringify({
        bundle: bundle.file,
        outDirectory,
        resultsFile,
        jobs,
        locale: args.locale,
        focus: args.focus,
        shots: args.shots,
        height: viewportHeight
      })
    );
    const code = await runCapture(planFile, jobs.length);
    const captured = readCaptureLines(
      existsSync(resultsFile) ? readFileSync(resultsFile, "utf8") : ""
    );
    if (captured.results.length === 0) throw new Error(`The capture process failed (${code})`);
    const summary = summarize(captured.results, jobs.length, code, args.locale);
    writeFileSync(
      join(outDirectory, "check.json"),
      `${JSON.stringify(
        {
          run,
          locale: args.locale,
          surfaces: selected.map((entry) => entry.id),
          ...summary,
          blockedRequests: captured.blocked,
          results: captured.results
        },
        null,
        2
      )}\n`
    );
    console.log(
      `screens: ${summary.failed} failure(s) in ${summary.total} capture(s); ${outDirectory}`
    );
    for (const failure of summary.failures.slice(0, 30)) console.log(`  FAIL ${failure}`);
    if (summary.failures.length > 30) console.log(`  ... ${summary.failures.length - 30} more`);
    return args.check && !summary.passed ? 1 : 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    }
  );
}
