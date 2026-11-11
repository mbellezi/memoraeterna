// Launching Memora in a journey (F5 T137, spec 5.3): the built, unpackaged app
// (`apps/desktop/out/main/index.js`, from `npm run build -w @app/desktop`) through Playwright's
// `_electron.launch`, on one scratch profile, with the IPC trace on, `NODE_ENV=production` and, by
// default, the AI cassette `firstrun-hybrid-f4` in replay (a call it does not hold fails; nothing
// reaches the network). Every inherited `MEMORA_*` knob is dropped first, so a journey runs only
// with what it states. Step screenshots are taken in both themes and scanned for contrast (X12).
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { _electron, type ElectronApplication, type Page } from "@playwright/test";

import { scanContrast, type ContrastResult } from "./contrast.js";
import {
  assertJourneysScratchPath,
  cloneProfile,
  profileDir,
  type JourneysRun
} from "./profile.js";

export const defaultCassette = "firstrun-hybrid-f4";
export const defaultLocale = "pt-BR";
/** The built main entry, relative to the checkout. */
export const builtMain = join("apps", "desktop", "out", "main", "index.js");
/** Knobs a journey never inherits nor sets: a cassette miss must fail, never run live. */
const forbiddenKnobs = ["MEMORA_AI_CASSETTE_LOCAL_MISSES", "MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE"];
/** Inherited `MEMORA_*` variables a journey keeps: where the vendored PostgreSQL lives. */
const keptKnobs = ["MEMORA_POSTGRES_SIDECAR_ROOT"];

export interface LaunchOptions {
  run: JourneysRun;
  /** An absolute folder inside the run (`profileDir(run, name)`). */
  userDataDir: string;
  /** The cassette replayed (a folder of `.cache/topics/cassettes/`), or false for none. */
  cassette?: string | false;
  /**
   * The DEV fake remote providers for Ask and explanations (`MEMORA_FAKE_REMOTE`, plan
   * `e2e/support/fake-remote-plan.json`). The app refuses them while the profile's writer is a
   * real remote route and wraps them in the cassette when one is on; see the harness's notes.
   */
  fakeRemote?: boolean;
  /** Chromium's `--lang` (the desktop locale the app reads). */
  locale?: string;
  /** More DEV knobs a spec needs; a forbidden one is refused. */
  env?: Record<string, string>;
  /** How long the first window may take. */
  timeoutMs?: number;
}

export interface MemoraSession {
  electronApp: ElectronApplication;
  page: Page;
  userDataDir: string;
  run: JourneysRun;
  /** Quits through the app's own shutdown (PostgreSQL stops cleanly); idempotent. */
  close(): Promise<void>;
}

export function electronBinary(): string {
  const binary: unknown = createRequire(import.meta.url)("electron");
  if (typeof binary !== "string") throw new Error("The electron package gave no binary path");
  return binary;
}

/** The environment of a launch: the inherited one without `MEMORA_*` knobs, plus the journey's. */
export function journeyEnvironment(
  inherited: Readonly<Record<string, string | undefined>>,
  journey: Record<string, string>
): Record<string, string> {
  for (const name of Object.keys(journey))
    if (forbiddenKnobs.includes(name)) throw new Error(`A journey never sets ${name}`);
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(inherited)) {
    if (value === undefined) continue;
    if (name.startsWith("MEMORA_") && !keptKnobs.includes(name)) continue;
    if (name === "ELECTRON_RUN_AS_NODE" || name === "ELECTRON_RENDERER_URL") continue;
    environment[name] = value;
  }
  return { ...environment, ...journey };
}

/**
 * The run's copy of a cassette: an APFS clone of `.cache/topics/cassettes/<name>` made once per run
 * under `<run>/cassettes/`, without the source's `misses/`, so the misses a run leaves are its own
 * and the recorded cassette is never written.
 */
export async function prepareCassette(run: JourneysRun, name: string): Promise<string> {
  if (!/^[a-z0-9][a-z0-9.-]*$/u.test(name)) throw new Error(`Not a cassette name: ${name}`);
  const target = join(run.scratchDir, "cassettes", name);
  if (existsSync(target)) return target;
  const source = join(run.repoRoot, ".cache", "topics", "cassettes", name);
  if (!existsSync(join(source, "cassette.json"))) throw new Error(`No cassette at ${source}`);
  await cloneProfile(source, target, run.repoRoot);
  await rm(join(target, "misses"), { recursive: true, force: true });
  return target;
}

/** What a run's cassette missed: the count per task type (no prompt, no output). */
export async function cassetteMisses(
  cassetteDir: string
): Promise<{ total: number; byTask: Record<string, number> }> {
  const folder = join(cassetteDir, "misses");
  const names = existsSync(folder)
    ? (await readdir(folder)).filter((n) => n.endsWith(".json"))
    : [];
  const byTask: Record<string, number> = {};
  for (const name of names) {
    let task = "unknown";
    try {
      const miss = JSON.parse(await readFile(join(folder, name), "utf8")) as { taskType?: unknown };
      if (typeof miss.taskType === "string") task = miss.taskType;
    } catch {
      // Counted as unknown.
    }
    byTask[task] = (byTask[task] ?? 0) + 1;
  }
  return { total: names.length, byTask };
}

/** The plan of the fake remote providers a journey may start (zero faults, fixed latency). */
export const fakeRemotePlan = join("e2e", "support", "fake-remote-plan.json");

export async function launchMemora(options: LaunchOptions): Promise<MemoraSession> {
  const { run } = options;
  const userDataDir = await assertJourneysScratchPath(options.userDataDir, run.repoRoot);
  const main = join(run.repoRoot, builtMain);
  if (!existsSync(main))
    throw new Error(`${builtMain} is missing: run npm run build -w @app/desktop first`);
  const journey: Record<string, string> = {
    MEMORA_USER_DATA_DIR: userDataDir,
    MEMORA_WORKSPACE_ROOT: run.repoRoot,
    MEMORA_IPC_TRACE: "1",
    MEMORA_DEV_BACKGROUND: "1",
    MEMORA_LOCAL_MODEL_SEED_DIR: join(run.repoRoot, ".cache", "models"),
    NODE_ENV: "production"
  };
  const cassette = options.cassette ?? defaultCassette;
  if (cassette !== false) {
    journey.MEMORA_AI_CASSETTE = "replay";
    journey.MEMORA_AI_CASSETTE_DIR = await prepareCassette(run, cassette);
  }
  if (options.fakeRemote) {
    // The fakes start only on a profile inside `<MEMORA_SOAK_DATA_ROOT>/profiles/`: the run folder.
    journey.MEMORA_FAKE_REMOTE = fakeRemotePlan;
    journey.MEMORA_SOAK_PROFILE = "journeys";
    journey.MEMORA_SOAK_DATA_ROOT = run.scratchDir;
  }
  const env = journeyEnvironment(process.env, { ...journey, ...(options.env ?? {}) });
  const electronApp = await _electron.launch({
    executablePath: electronBinary(),
    args: [main, `--lang=${options.locale ?? defaultLocale}`],
    cwd: run.repoRoot,
    env,
    timeout: options.timeoutMs ?? 120_000
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    // `app.quit()` runs the app's graceful shutdown (services, local runtimes, PostgreSQL).
    const child = electronApp.process();
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((done) => child.once("exit", () => done()));
    await electronApp.evaluate(({ app }) => app.quit()).catch(() => undefined);
    const timer = new Promise<"timeout">((done) => setTimeout(() => done("timeout"), 90_000));
    if ((await Promise.race([exited, timer])) === "timeout") await electronApp.close();
  };
  try {
    const page = await electronApp.firstWindow({ timeout: options.timeoutMs ?? 120_000 });
    await page.waitForLoadState("domcontentloaded");
    return { electronApp, page, userDataDir, run, close };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Clones BASE-J (`<run>/profiles/base`) into `<run>/profiles/<name>` and launches it. */
export async function openClone(
  run: JourneysRun,
  name: string,
  options: Omit<LaunchOptions, "run" | "userDataDir"> = {}
): Promise<MemoraSession> {
  const userDataDir = await cloneProfile(
    profileDir(run, "base"),
    profileDir(run, name),
    run.repoRoot
  );
  return launchMemora({ ...options, run, userDataDir });
}

export type Theme = "light" | "dark";

/** Switches the window's theme the way the system would (`nativeTheme.themeSource`). */
export async function setTheme(session: Pick<MemoraSession, "electronApp" | "page">, theme: Theme) {
  await session.electronApp.evaluate(({ nativeTheme }, source) => {
    nativeTheme.themeSource = source;
  }, theme);
  await session.page.waitForFunction(
    (dark) => window.matchMedia("(prefers-color-scheme: dark)").matches === dark,
    theme === "dark"
  );
  // Two frames: the styles that follow the media query are applied and painted.
  await session.page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
}

/** Sets the window's content size (the minimum width is 960 px). */
export async function setContentSize(session: MemoraSession, width: number, height = 900) {
  await session.electronApp.evaluate(
    ({ BrowserWindow }, size) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height);
    },
    { width, height }
  );
  await session.page.waitForFunction((wanted) => window.innerWidth === wanted, width);
}

export interface StepRecord {
  step: string;
  screenshots: string[];
  contrast: Record<Theme, Pick<ContrastResult, "checked" | "failures" | "unverifiable">>;
}

/**
 * One journey step's evidence: a screenshot in light and in dark
 * (`.cache/f5/journeys/<run>/<spec>/<nn>-<step>-<theme>.png`) and the contrast scan of each, written
 * next to them as JSON. Returns the record; the caller asserts on `contrast.*.failures`.
 */
export async function captureStep(
  session: MemoraSession,
  spec: string,
  index: number,
  step: string,
  themes: readonly Theme[] = ["light", "dark"]
): Promise<StepRecord> {
  const folder = join(session.run.evidenceDir, spec);
  await mkdir(folder, { recursive: true });
  const base = `${String(index).padStart(2, "0")}-${step.replace(/[^a-z0-9-]+/giu, "-")}`;
  const record: StepRecord = {
    step,
    screenshots: [],
    contrast: {} as StepRecord["contrast"]
  };
  for (const theme of themes) {
    await setTheme(session, theme);
    const path = join(folder, `${base}-${theme}.png`);
    await session.page.screenshot({ path });
    record.screenshots.push(path);
    record.contrast[theme] = await scanContrast(session.page);
  }
  await writeFile(join(folder, `${base}.json`), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Calls `window.app.<path>(...args)` in the page, as the renderer would (arguments and answer are
 * structured-cloned). The harness drives setup steps this way; a journey's own steps use gestures.
 */
export async function invokeApp<T = unknown>(
  page: Page,
  path: string,
  ...args: unknown[]
): Promise<T> {
  return (await page.evaluate(
    async ({ path: wanted, args: values }) => {
      let owner: unknown = undefined;
      let target: unknown = (window as unknown as { app?: unknown }).app;
      for (const part of wanted.split(".")) {
        owner = target;
        target = (target as Record<string, unknown> | undefined)?.[part];
      }
      if (typeof target !== "function") throw new Error(`window.app.${wanted} is not a function`);
      return (target as (...input: unknown[]) => unknown).apply(owner, values);
    },
    { path, args }
  )) as T;
}

/** Waits for the preload's `window.app` and for the database to be ready. */
export async function waitForDatabase(page: Page, timeoutMs: number): Promise<void> {
  await page.waitForFunction(
    () => typeof (window as unknown as { app?: unknown }).app === "object",
    null,
    {
      timeout: timeoutMs
    }
  );
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = await invokeApp<{ state: string }>(page, "database.getStatus");
    if (status.state === "ready") return;
    if (status.state === "failed") throw new Error("The profile's database failed to start");
    if (Date.now() >= deadline)
      throw new Error(`The database was not ready within ${timeoutMs / 1000} s`);
    await new Promise((done) => setTimeout(done, 1_000));
  }
}
