/**
 * `npm run screens -- [--screen id[,id…]] [--check] [--no-shots] [--mode m] [--theme t] [--width w]`
 *
 * Renders each requested surface (every surface whose implementation and screen module exist, by
 * default) in each mode (loading, empty, error, success), theme (light, dark) and width (960,
 * 1440) in a bare offscreen Electron over a fake `window.app`, and writes
 * `.cache/f5/screens/<run>/<surface>/<mode>-<theme>-<width>.png` and `.cache/f5/screens/<run>/check.json`.
 * `--check` exits 1 unless every surface reported `[data-surface=<id>][data-state=<mode>]` within
 * five seconds in every combination (an object panel also shows its path ribbon in success).
 *
 * One capture runs at a time (a lock file); run it at background QoS (`taskpolicy -b`) while an F4
 * run holds the slots. It starts no Memora process and loads no model.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  screenModes,
  surfaces,
  type ScreenMode,
  type SurfaceEntry
} from "../../apps/desktop/src/renderer/workspace/surfaces";
import { buildBundle, rendererRoot, repositoryRoot } from "./build-bundle";
import type { MountResult, ScreenTheme } from "./harness";

export const allThemes: readonly ScreenTheme[] = ["light", "dark"];
export const allWidths: readonly number[] = [960, 1440];
const viewportHeight = 900;
const captureTimeoutMs = 15 * 60 * 1000;

export interface ScreensArgs {
  screens: string[];
  check: boolean;
  shots: boolean;
  modes: ScreenMode[];
  themes: ScreenTheme[];
  widths: number[];
}

export function parseScreensArgs(argv: readonly string[]): ScreensArgs {
  const args: ScreensArgs = {
    screens: [],
    check: false,
    shots: true,
    modes: [],
    themes: [],
    widths: []
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

export function summarize(results: readonly (MountResult & { width: number })[]): CheckSummary {
  const failures = results
    .filter((result) => !result.ok)
    .map(
      (result) =>
        `${result.surface} ${result.mode} ${result.theme} ${result.width}: ${result.reasons.join("; ") || "failed"}`
    );
  return {
    passed: failures.length === 0 && results.length > 0,
    total: results.length,
    failed: failures.length,
    failures
  };
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

async function runCapture(planFile: string): Promise<number> {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !name.startsWith("MEMORA_") && name !== "ELECTRON_RUN_AS_NODE"
    )
  );
  return new Promise((resolve, reject) => {
    const child = spawn(
      electronBinary(),
      [join(repositoryRoot, "scripts/screens/capture.cjs"), planFile],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "inherit", "inherit"]
      }
    );
    const timer = setTimeout(() => child.kill("SIGKILL"), captureTimeoutMs);
    child.once("error", reject);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
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
  const release = takeLock(join(base, ".lock"));
  const scratch = mkdtempSync(join(tmpdir(), "memora-screens-bundle-"));
  const run = runId();
  const outDirectory = join(base, run);
  try {
    mkdirSync(outDirectory, { recursive: true });
    const bundle = await buildBundle(selected, scratch);
    console.log(
      `screens: ${selected.length} surface(s), ${jobs.length} capture(s), bundle ${(bundle.bytes / 1e6).toFixed(1)} MB`
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
        shots: args.shots,
        height: viewportHeight
      })
    );
    const code = await runCapture(planFile);
    if (code !== 0 || !existsSync(resultsFile))
      throw new Error(`The capture process failed (${code})`);
    const captured = JSON.parse(readFileSync(resultsFile, "utf8")) as {
      results: (MountResult & { width: number })[];
      blocked: string[];
    };
    const summary = summarize(captured.results);
    writeFileSync(
      join(outDirectory, "check.json"),
      `${JSON.stringify(
        {
          run,
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
      `screens: ${summary.total - summary.failed}/${summary.total} reached their state; ${outDirectory}`
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
