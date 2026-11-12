// Launching Memora in a journey (F5 T137, spec 5.3): the built, unpackaged app
// (`apps/desktop/out/main/index.js`, from `npm run build -w @app/desktop`) through Playwright's
// `_electron.launch`, on one scratch profile, with the IPC trace on, `NODE_ENV=production` and, by
// default, the AI cassette `firstrun-hybrid-f4` in replay (a call it does not hold fails, never runs
// live). Local models install only from the DEV seed folder: the product falls back to a download
// for a file the seed lacks, so the global setup refuses before the first launch unless the seed
// holds every pinned file of both first-run models (`assertModelsSeeded`). Every inherited
// `MEMORA_*` knob is dropped first, so a journey runs only with what it states. Step screenshots are taken in both themes and scanned for contrast (X12).
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { assertLocalModelSeeded, findLocalModelCatalogEntry, LocalModelSeedError } from "@app/ai";
import { machineRunsMlx, presetCatalogIds } from "@app/domain";
import { _electron, type ElectronApplication, type Page } from "@playwright/test";

import { scanContrast, type ContrastResult } from "./contrast.js";
import { stubOpenDialog } from "./dialog.js";
import {
  assertJourneysScratchPath,
  cloneProfile,
  profileDir,
  type JourneysRun
} from "./profile.js";

export const defaultCassette = "firstrun-hybrid-f4";
/** FR2's second source (`defaultSecondSourceKey` of the first-run harness): J0 checks the cassette serves it. */
export const secondSourceKey = "wikibooks-en-memory-and-language";
export const defaultLocale = "pt-BR";
/** The built main entry, relative to the checkout. */
export const builtMain = join("apps", "desktop", "out", "main", "index.js");
/** Knobs a journey never inherits nor sets: a cassette miss must fail, never run live. */
const forbiddenKnobs = ["MEMORA_AI_CASSETTE_LOCAL_MISSES", "MEMORA_ALLOW_DEFAULT_PROFILE_UPGRADE"];
/** Inherited `MEMORA_*` variables a journey keeps: where the vendored PostgreSQL lives. */
const keptKnobs = ["MEMORA_POSTGRES_SIDECAR_ROOT"];

/** The DEV seed folder the app installs local models from (`MEMORA_LOCAL_MODEL_SEED_DIR`). */
export function modelSeedDir(run: Pick<JourneysRun, "repoRoot">): string {
  return join(run.repoRoot, ".cache", "models");
}

/** The first run's two models on a machine: the embedder and the ranker, MLX where MLX runs. */
export function firstRunModelIds(
  machine: { platform: string; arch: string } = { platform: process.platform, arch: process.arch }
): { embedding: string; ranker: string } {
  return {
    embedding: presetCatalogIds.embedding,
    ranker: machineRunsMlx(machine) ? presetCatalogIds.rankerMlx : presetCatalogIds.rankerGguf
  };
}

/**
 * The environment that makes a launch install the first-run ranker from the seed folder. With a
 * cassette on, the app disables `FirstRunRanker` (`enabled: aiCassette === null`), so it never asks
 * for the ranker itself; the DEV knob `MEMORA_LOCAL_MODEL_INSTALL` installs it at start instead.
 */
export function firstRunRankerEnv(ranker = firstRunModelIds().ranker): Record<string, string> {
  return { MEMORA_LOCAL_MODEL_INSTALL: ranker };
}

export interface ListedLocalModel {
  catalogId: string;
  status: string;
  capabilities: readonly string[];
  lastError: string | null;
}

/**
 * Where the first-run ranker stands in `localModels.list`: `ready` once it is installed and validated
 * for reranking, null while it is on its way, and a thrown error when its install failed.
 */
export function firstRunRankerState(
  models: readonly ListedLocalModel[],
  ranker = firstRunModelIds().ranker
): "ready" | null {
  const model = models.find((entry) => entry.catalogId === ranker);
  if (model?.status === "failed") throw new Error(`${ranker} failed: ${model.lastError}`);
  return model?.status === "ready" && model.capabilities.includes("reranking") ? "ready" : null;
}

/**
 * Refuses unless the seed folder holds every pinned file of each model at its declared size (the
 * install verifies the bytes). Without it the app's download would fetch what the seed lacks from
 * the model host: a journey never downloads a model.
 */
export async function assertModelsSeeded(
  seedDir: string,
  catalogIds: readonly string[] = Object.values(firstRunModelIds()),
  check: typeof assertLocalModelSeeded = assertLocalModelSeeded
): Promise<void> {
  for (const catalogId of catalogIds) {
    const entry = findLocalModelCatalogEntry(catalogId);
    if (!entry) throw new Error(`The local model catalog has no entry ${catalogId}`);
    try {
      await check(entry, seedDir);
    } catch (error) {
      if (!(error instanceof LocalModelSeedError)) throw error;
      throw new Error(
        `The seed folder ${seedDir} cannot install ${catalogId} (${error.message}); ` +
          "a journey never downloads a model: seed it first (the first-run harness's seed folder)",
        { cause: error }
      );
    }
  }
}

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
    MEMORA_LOCAL_MODEL_SEED_DIR: modelSeedDir(run),
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

/**
 * Switches the window's theme: the colour scheme is emulated on the page and the native theme follows.
 * `nativeTheme.themeSource` alone is not enough: a window shown inactive (or covered by another app)
 * keeps `prefers-color-scheme: light` in the renderer although `nativeTheme.shouldUseDarkColors` is
 * true, so a "dark" capture would be a light page.
 */
export async function setTheme(session: Pick<MemoraSession, "electronApp" | "page">, theme: Theme) {
  await session.electronApp.evaluate(({ nativeTheme }, source) => {
    nativeTheme.themeSource = source;
  }, theme);
  await session.page.emulateMedia({ colorScheme: theme });
  await session.page.waitForFunction(
    (dark) => window.matchMedia("(prefers-color-scheme: dark)").matches === dark,
    theme === "dark",
    { polling: 100 }
  );
  // Two frames: the styles that follow the media query are applied and painted.
  await session.page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
  // The colour transitions that switch started end, or a scan reads a colour half way between themes.
  await session.page.evaluate(settleTransitions);
  await session.page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
  );
}

/**
 * Resolves when every CSS transition of the page has ended or been cancelled. Only transitions: an
 * infinite animation (a spinner, a skeleton's pulse) never finishes and must not be waited for. It runs
 * in the page, so it names nothing outside itself.
 */
export function settleTransitions(): Promise<unknown> {
  const transitions = document
    .getAnimations()
    .filter(
      (animation) => typeof CSSTransition !== "undefined" && animation instanceof CSSTransition
    );
  return Promise.all(transitions.map((animation) => animation.finished.catch(() => null)));
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

/** The default processing plan of `fileImportInputSchema` (a structure review sends it back). */
const defaultProcessingPlan = {
  preset: "full_knowledge",
  requestedStages: [],
  scope: "source_only",
  targetSourceItemIds: [],
  forceRegeneration: false,
  previousArtifactPolicy: "reuse_valid"
};

/** A golden source's file and the descriptor a person would have filled in. */
export async function goldenSource(repoRoot: string, key: string) {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, "scripts", "golden", "manifest.json"), "utf8")
  ) as {
    sources: {
      key: string;
      import?: string;
      format: string;
      title: string;
      language: string;
      descriptor: object;
    }[];
  };
  const entry = manifest.sources.find((source) => source.key === key);
  if (!entry || entry.import !== "file") throw new Error(`${key} is not a golden file source`);
  const extension = { pdf: ".pdf", html: ".html", markdown: ".md", text: ".txt" }[entry.format];
  const path = join(repoRoot, ".cache", "golden", "sources", `${key}${extension ?? ""}`);
  if (!existsSync(path))
    throw new Error(`The golden source ${key} is not in .cache/golden/sources`);
  return {
    path,
    descriptor: { ...entry.descriptor, title: entry.title, language: entry.language }
  };
}

/**
 * Imports a golden file source with the default plan, as a person would: the stubbed picker answers
 * its file; a structure review is confirmed as detected.
 */
export async function importGoldenSource(session: MemoraSession, key: string): Promise<void> {
  const source = await goldenSource(session.run.repoRoot, key);
  await stubOpenDialog(session.electronApp, [source.path]);
  const result = await invokeApp<{
    duplicate?: unknown;
    requiresStructureReview?: boolean;
    structureId?: string | null;
  } | null>(session.page, "ingestion.importFile", { descriptor: source.descriptor });
  if (!result) throw new Error(`The stubbed dialog did not return ${key}`);
  if (result.duplicate) throw new Error(`${key} is already in the library`);
  if (result.requiresStructureReview && result.structureId) {
    const structure = await invokeApp<{ id: string; divisions: Record<string, unknown>[] }>(
      session.page,
      "ingestion.getStructure",
      result.structureId
    );
    const fields = [
      "id",
      "parentId",
      "kind",
      "title",
      "level",
      "position",
      "startSelector",
      "endSelector",
      "startPage",
      "endPage",
      "markdownStart",
      "markdownEnd",
      "confidence",
      "evidence",
      "reviewStatus",
      "isProcessable",
      "metadata"
    ];
    const divisions = structure.divisions.map((division) =>
      Object.fromEntries(
        fields
          .filter((field) => division[field] !== undefined)
          .map((field) => [field, division[field]])
      )
    );
    await invokeApp(session.page, "ingestion.confirmStructure", {
      structureId: structure.id,
      divisions,
      plan: defaultProcessingPlan
    });
  }
}
