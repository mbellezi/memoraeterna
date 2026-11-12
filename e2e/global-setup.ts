// Global setup of `npm run journeys` (F5 T137, spec 5.1 and 5.3). It takes both slots (refusing
// while another Memora Electron runs or another task holds LOCAL_MODEL_BUSY), builds the app, and
// makes BASE-J, the profile every spec clones:
//
//   an empty userData at `.cache/f5/scratch/journeys/<run>/profiles/base`, the first run in Hybrid
//   played in the built app through `window.app` (the onboarding's own calls, in the order of
//   `S/first-run-sequence.ts`), the writer signed in with the DEV Codex credential stub (the one
//   step a harness cannot play: a browser sign-in), the two first-run models installed from the DEV
//   seed folder (checked complete before the first launch: no model is ever downloaded), then the
//   E6 PLOS paper imported with the default plan, every AI call served by the cassette
//   `firstrun-hybrid-f4`. When the work settles (no job running or queued, debounced ones
//   included, `waitForSettled`) the Knowledge controls are paused with autonomy Off, so every
//   clone starts quiet, and the app quits.
//
// A cassette miss fails the setup (MEMORA_AI_CASSETTE_LOCAL_MISSES stays unset) and names the task
// types that missed: the orchestrator then records `journeys-f5` (R4). The returned teardown gives
// the slots back.
//
// Knobs: MEMORA_JOURNEYS_RUN (run id), MEMORA_JOURNEYS_BUILD=skip (use the existing build),
// MEMORA_JOURNEYS_BASE_FROM=<an earlier run's profiles/base> (clone it instead of building one).
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  assertModelsSeeded,
  cassetteMisses,
  defaultCassette,
  firstRunModelIds,
  firstRunRankerEnv,
  firstRunRankerState,
  importGoldenSource,
  invokeApp,
  launchMemora,
  modelSeedDir,
  waitForDatabase,
  type ListedLocalModel,
  type MemoraSession
} from "./support/app.js";
import {
  aiConfigRepositoryOn,
  countRows,
  openProfileDb,
  waitForSettled,
  type ProfileDb
} from "./support/db.js";
import {
  cloneProfile,
  emptyProfile,
  journeysRun,
  profileDir,
  type JourneysRun
} from "./support/profile.js";
import { acquireJourneySlots, busyLockPath, mainCheckoutRoot } from "./support/slots.js";

const firstSourceKey = "plos-one-murre-dros-2015";
const contentLanguage = "pt-BR";
const classTests = ["embed", "write-fast", "write-quality", "answer", "judge"] as const;
/** The capabilities Settings gives a Codex writer (`codexCapabilities` of the first-run harness). */
const codexCapabilities = [
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "requires-network"
];
/**
 * The DEV Codex credential stub (`devCodexCredential`, `M/services/dev/fake-codex-provider.ts`): a
 * fixed dummy, never a token, expiring in 2100 so nothing tries to refresh it. With the cassette in
 * replay no writer call leaves the machine.
 */
const devCodexCredential = {
  access: "dev-fake-codex-access-token",
  refresh: "dev-fake-codex-refresh-token",
  expires: 4_102_444_800_000,
  accountId: "dev-fake-codex-account"
};
const minutes = (count: number) => count * 60_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

function log(message: string) {
  console.log(`journeys setup: ${message}`);
}

export interface BaseJRecord {
  run: string;
  builtAt: string;
  from: string | null;
  writer: { providerConfigId: string; modelId: string };
  classTests: { route: string; state: string }[];
  ranker: string;
  counts: { sources: number; notes: number; topics: number; relations: number };
  misses: { total: number; byTask: Record<string, number> };
}

async function until<T>(
  what: string,
  timeoutMs: number,
  pollMs: number,
  probe: () => Promise<T | null>
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null) return value;
    if (Date.now() >= deadline)
      throw new Error(`${what} did not happen within ${timeoutMs / 1000} s`);
    await sleep(pollMs);
  }
}

/** The recorded writer of the cassette (`firstrun-record.json`): a replay must use the same model. */
async function recordedWriterModel(run: JourneysRun): Promise<string> {
  const path = join(
    run.repoRoot,
    ".cache",
    "topics",
    "cassettes",
    defaultCassette,
    "firstrun-record.json"
  );
  const record = JSON.parse(await readFile(path, "utf8")) as {
    writer?: { kind?: string; modelId?: string };
  };
  if (record.writer?.kind !== "codex" || !record.writer.modelId)
    throw new Error(`${defaultCassette} was not recorded with a Codex writer`);
  return record.writer.modelId;
}

/** The writer: the stub credential where the sign-in leaves it, then the product's own save calls. */
async function signInWriter(session: MemoraSession, db: ProfileDb, modelId: string) {
  const encrypted = await session.electronApp.evaluate(({ safeStorage }, secret) => {
    if (!safeStorage.isEncryptionAvailable()) return null;
    return safeStorage.encryptString(secret).toString("base64");
  }, JSON.stringify(devCodexCredential));
  if (!encrypted)
    throw new Error("safeStorage is not available: the credential stub cannot be stored");
  const reference = `ai:${randomUUID()}`;
  const file = join(session.userDataDir, "credentials", "ai-secrets.json");
  if (existsSync(file)) throw new Error("The empty profile already holds credentials");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ version: 1, secrets: { [reference]: encrypted } }, null, 2)}\n`,
    {
      mode: 0o600
    }
  );
  // The row a browser sign-in leaves, written through the repository (no SQL here, D38's guard).
  const { id: providerConfigId } = await aiConfigRepositoryOn(db).upsertProvider({
    provider: "openai-codex",
    displayName: "ChatGPT / Codex",
    credentialRef: reference,
    metadata: { modelId, capabilities: codexCapabilities }
  });
  await invokeApp(session.page, "ai.saveProvider", {
    id: providerConfigId,
    provider: "openai-codex",
    displayName: "ChatGPT / Codex",
    modelId,
    capabilities: codexCapabilities
  });
  const profile = await invokeApp<{ id: string }>(session.page, "ai.createProfile", {
    name: "Writer",
    isDefault: true,
    privacyMode: "allow_remote",
    outputLanguage: "ui"
  });
  await invokeApp(session.page, "ai.updateProfile", {
    id: profile.id,
    providerConfigId,
    modelId,
    runtime: "remote",
    capabilities: codexCapabilities
  });
  return providerConfigId;
}

/** Steps 0-2 of the first run in Hybrid, as the onboarding calls them. */
async function playFirstRun(session: MemoraSession, db: ProfileDb, writerModel: string) {
  const { page } = session;
  const embedderCatalogId = firstRunModelIds().embedding;
  const state = await invokeApp<{ show: boolean }>(page, "onboarding.state");
  if (!state.show) throw new Error("The first-run view is not due on the empty profile");
  const settings = await invokeApp<{ language: string }>(page, "settings.getApp");
  await invokeApp(page, "settings.updateApp", { language: settings.language, contentLanguage });
  await invokeApp(page, "hardware.profile");
  await invokeApp(page, "localModels.list");
  const providerConfigId = await signInWriter(session, db, writerModel);
  log("writer signed in with the DEV credential stub");
  await invokeApp(page, "localModels.download", {
    catalogId: embedderCatalogId,
    acceptLicense: false
  });
  await until(`${embedderCatalogId} ready`, minutes(20), 2_000, async () => {
    const models = await invokeApp<
      { catalogId: string; status: string; lastError: string | null }[]
    >(page, "localModels.list");
    const model = models.find((entry) => entry.catalogId === embedderCatalogId);
    if (model?.status === "failed")
      throw new Error(`${embedderCatalogId} failed: ${model.lastError}`);
    return model?.status === "ready" ? true : null;
  });
  log("embedder installed from the seed folder");
  const preset = await invokeApp<{
    applied: boolean;
    blocked: { route?: string; reason: string }[];
  }>(page, "ai.applyPreset", { preset: "hybrid", test: false });
  if (!preset.applied || preset.blocked.length > 0)
    throw new Error(`The Hybrid preset was not applied: ${JSON.stringify(preset.blocked)}`);
  const tests: { route: string; state: string }[] = [];
  for (const route of classTests) {
    const view = await invokeApp<{
      judge: { test?: { state: string } };
      classes: { id: string; test?: { state: string } }[];
    }>(page, "ai.testClassRoute", route);
    const test =
      route === "judge" ? view.judge.test : view.classes.find((entry) => entry.id === route)?.test;
    tests.push({ route, state: test?.state ?? "untested" });
  }
  log(`class tests: ${tests.map((test) => `${test.route} ${test.state}`).join(", ")}`);
  // With a cassette on the app never asks for the ranker (`FirstRunRanker` is disabled, so its
  // setting is never written); both setup launches install it from the seed folder instead.
  const ranker = await until("the first-run ranker", minutes(30), 3_000, async () =>
    firstRunRankerState(await invokeApp<ListedLocalModel[]>(page, "localModels.list"))
  );
  if (ranker !== "ready") throw new Error(`The first-run ranker ended ${ranker}, not ready`);
  await invokeApp(page, "onboarding.finish", { outcome: "completed" });
  return { providerConfigId, tests, ranker };
}

async function buildBaseJ(run: JourneysRun): Promise<BaseJRecord> {
  const base = profileDir(run, "base");
  const recordPath = join(run.scratchDir, "base-j.json");
  const from = process.env.MEMORA_JOURNEYS_BASE_FROM?.trim();
  if (from) {
    // An earlier run's `<run>/profiles/base`; its record and its empty-library twin sit beside it.
    await cloneProfile(from, base, run.repoRoot);
    await cloneProfile(
      join(dirname(from), "base-empty"),
      profileDir(run, "base-empty"),
      run.repoRoot
    );
    const earlier = join(dirname(dirname(from)), "base-j.json");
    if (!existsSync(earlier)) throw new Error(`${from} has no base-j.json beside its run`);
    const record = { ...(JSON.parse(await readFile(earlier, "utf8")) as BaseJRecord), from };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    log(`BASE-J cloned from ${from}`);
    return record;
  }
  // Both first-run models come from the seed folder or the setup stops here, before anything is
  // created: the product would download a file the seed lacks.
  await assertModelsSeeded(modelSeedDir(run));
  log("both first-run models are seeded");
  await emptyProfile(base, run.repoRoot);
  const writerModel = await recordedWriterModel(run);
  let session = await launchMemora({ run, userDataDir: base, env: firstRunRankerEnv() });
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(session.page, minutes(3));
    db = await openProfileDb(base);
    const firstRun = await playFirstRun(session, db, writerModel);
    // The empty-library twin (live screens' empty states): onboarded, paused, no source. A live
    // cluster is never cloned, so the app quits first and starts again on BASE-J.
    await invokeApp(session.page, "knowledgeControls.update", { paused: true, autonomy: "off" });
    await db.close();
    db = null;
    await session.close();
    await cloneProfile(base, profileDir(run, "base-empty"), run.repoRoot);
    session = await launchMemora({ run, userDataDir: base, env: firstRunRankerEnv() });
    await waitForDatabase(session.page, minutes(3));
    db = await openProfileDb(base);
    await invokeApp(session.page, "knowledgeControls.update", { paused: false, autonomy: "auto" });
    await importGoldenSource(session, firstSourceKey);
    log("the PLOS paper is importing");
    const settled = await waitForSettled(db, { timeoutMs: minutes(60) });
    log(`settled (left aside: ${JSON.stringify(settled.setAside)})`);
    const counts = {
      sources: await countRows(db, "source_items"),
      notes: await countRows(db, "atomic_notes"),
      topics: await countRows(db, "topics"),
      relations: await countRows(db, "atomic_note_relations")
    };
    await invokeApp(session.page, "knowledgeControls.update", { paused: true, autonomy: "off" });
    const misses = await cassetteMisses(join(run.scratchDir, "cassettes", defaultCassette));
    const record: BaseJRecord = {
      run: run.id,
      builtAt: new Date().toISOString(),
      from: null,
      writer: { providerConfigId: firstRun.providerConfigId, modelId: writerModel },
      classTests: firstRun.tests,
      ranker: firstRun.ranker,
      counts,
      misses
    };
    await writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    log(`BASE-J: ${JSON.stringify(counts)}; cassette misses ${misses.total}`);
    if (misses.total > 0)
      throw new Error(
        `BASE-J missed ${misses.total} cassette calls (${JSON.stringify(misses.byTask)}): ` +
          `${defaultCassette} does not serve the built app's import; record journeys-f5 (R4)`
      );
    if (counts.notes === 0 || counts.topics === 0)
      throw new Error(
        `BASE-J has ${counts.notes} notes and ${counts.topics} topics after the import`
      );
    return record;
  } finally {
    await db?.close();
    await session.close();
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const run = journeysRun();
  await mkdir(run.evidenceDir, { recursive: true });
  const release = await acquireJourneySlots({
    lockPath: busyLockPath(mainCheckoutRoot(run.repoRoot)),
    owner: `journeys:${run.id}`,
    run: run.id
  });
  log(`run ${run.id}: both slots held`);
  try {
    if (process.env.MEMORA_JOURNEYS_BUILD?.trim() !== "skip") {
      log("building the app (npm run build -w @app/desktop)");
      execFileSync("npm", ["run", "build", "-w", "@app/desktop"], {
        cwd: run.repoRoot,
        stdio: "inherit"
      });
    }
    const record = await buildBaseJ(run);
    log(`BASE-J ready (${record.counts.notes} notes)`);
  } catch (error) {
    await release();
    throw error;
  }
  return release;
}
