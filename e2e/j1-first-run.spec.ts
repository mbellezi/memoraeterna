// J1 first run (F5 T154, spec 5.3, amendments A6 and A7, bar X7): an empty profile starts in the
// first-run view; once it is set up, Home is the first-run surface; the first source is added and
// the person lands in Explore with that Source pushed, the navigator showing the tree being born and a
// note row with its path chip. T0 (the launch) to T1 (that note row) is recorded: F4 E6's replay bar is
// 10 minutes for the whole first run.
//
// What a browser cannot be driven to do is played the way the harness's own global setup plays it
// (`global-setup.ts`, the same calls in the same order as `S/first-run-sequence.ts`): the ChatGPT /
// Codex sign-in is replaced by the DEV credential stub where the sign-in leaves it, and the setup of
// step 2 (writer, the two models from the seed folder, the Hybrid preset, the class tests) is issued
// through `window.app`. Step 1 (the languages) is walked in the first-run view itself. No model is
// downloaded (the seed folder is checked first) and every AI call is served by the cassette
// `firstrun-hybrid-f4`; a miss fails the journey.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  assertModelsSeeded,
  captureStep,
  cassetteMisses,
  defaultCassette,
  firstRunModelIds,
  goldenSource,
  invokeApp,
  launchMemora,
  modelSeedDir,
  setContentSize,
  setTheme,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import { stubOpenDialog } from "./support/dialog.js";
import { aiConfigRepositoryOn, openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter, readGestures, resetGestures } from "./support/gestures.js";
import { emptyProfile, journeysRun, profileDir, type JourneysRun } from "./support/profile.js";
import { pressShortcut } from "./support/shortcuts.js";

/** The first source of FR2 (as `global-setup.ts`). */
const firstSourceKey = "plos-one-murre-dros-2015";
const contentLanguage = "pt-BR";
const classTests = ["embed", "write-fast", "write-quality", "answer", "judge"] as const;
const codexCapabilities = [
  "text-generation",
  "structured-output",
  "summarization",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "requires-network"
];
/** The DEV Codex credential stub (`devCodexCredential`): a fixed dummy, never a token. */
const devCodexCredential = {
  access: "dev-fake-codex-access-token",
  refresh: "dev-fake-codex-refresh-token",
  expires: 4_102_444_800_000,
  accountId: "dev-fake-codex-account"
};
/** The bar of X1 for the first source: 2 gestures from the file choice (the first run is recorded at 1). */
const x1Bar = 2;
const minutes = (count: number) => count * 60_000;
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

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
    if (Date.now() >= deadline) throw new Error(`${what} did not happen in ${timeoutMs / 1000} s`);
    await sleep(pollMs);
  }
}

/** The writer the cassette was recorded with: a replay must use the same model. */
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
    throw new Error("safeStorage is not available: the credential stub is not stored");
  const reference = `ai:${randomUUID()}`;
  const file = join(session.userDataDir, "credentials", "ai-secrets.json");
  if (existsSync(file)) throw new Error("The empty profile already holds credentials");
  await mkdir(dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ version: 1, secrets: { [reference]: encrypted } }, null, 2)}\n`,
    { mode: 0o600 }
  );
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
}

/** Step 2 of the first run in Hybrid, after the languages. */
async function playSetup(session: MemoraSession, db: ProfileDb, writerModel: string) {
  const { page } = session;
  const embedder = firstRunModelIds().embedding;
  await invokeApp(page, "hardware.profile");
  await invokeApp(page, "localModels.list");
  await signInWriter(session, db, writerModel);
  await invokeApp(page, "localModels.download", { catalogId: embedder, acceptLicense: false });
  await until(`${embedder} ready`, minutes(20), 2_000, async () => {
    const models = await invokeApp<
      { catalogId: string; status: string; lastError: string | null }[]
    >(page, "localModels.list");
    const model = models.find((entry) => entry.catalogId === embedder);
    if (model?.status === "failed") throw new Error(`${embedder} failed: ${model.lastError}`);
    return model?.status === "ready" ? true : null;
  });
  const preset = await invokeApp<{ applied: boolean; blocked: { reason: string }[] }>(
    page,
    "ai.applyPreset",
    { preset: "hybrid", test: false }
  );
  if (!preset.applied || preset.blocked.length > 0)
    throw new Error(`The Hybrid preset was not applied: ${JSON.stringify(preset.blocked)}`);
  for (const route of classTests) await invokeApp(page, "ai.testClassRoute", route);
  // With a cassette on the app disables its own first-run ranker (`main/index.ts`: the FirstRunRanker is
  // `enabled` only without one); the DEV install knob puts it in from the seed folder at start, and
  // "ready" is the model validated for reranking.
  const rankerId = firstRunModelIds().ranker;
  const ranker = await until("the first-run ranker", minutes(30), 3_000, async () => {
    const models = await invokeApp<
      { catalogId: string; status: string; capabilities: string[]; lastError: string | null }[]
    >(page, "localModels.list");
    const model = models.find((entry) => entry.catalogId === rankerId);
    if (model?.status === "failed") throw new Error(`${rankerId} failed: ${model.lastError}`);
    return model?.status === "ready" && model.capabilities.includes("reranking") ? "ready" : null;
  });
  if (ranker !== "ready") throw new Error(`The first-run ranker ended ${ranker}, not ready`);
}

interface Ref {
  kind: string;
  id: string;
  title: string;
}
interface Located {
  object: Ref;
  primaryPath: Ref[];
}

/** The topics of a located note's primary path, as the chip shows them. */
function chipTopics(located: Located): Ref[] {
  return located.primaryPath.filter(
    (ref, index) =>
      ref.kind === "topic" &&
      !(ref.kind === located.object.kind && ref.id === located.object.id) &&
      !(index === 0 && ref.title === "")
  );
}

const placedRows = (page: Page): Locator =>
  page
    .locator('[data-surface="source"][data-panel-top] [data-note-rows] li')
    .filter({ has: page.locator("[data-path-chip]") });

/**
 * Waits for the first note row with its path chip. It stops early, with the reason, when the work
 * behind the import failed (a job went to `failed`): a cassette that does not serve the import
 * (misses) ends the import here, and waiting out the timeout would only say less.
 */
async function waitForPlacedRow(
  page: Page,
  db: ProfileDb,
  cassetteDir: string,
  before: { failed: number; misses: number },
  timeoutMs: number
): Promise<Locator> {
  const first = placedRows(page).first();
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await first.isVisible()) return first;
    const [row] = await db.query<{ failed: number }>(
      "select count(*)::int as failed from jobs where status::text = 'failed'"
    );
    if ((row?.failed ?? 0) > before.failed) {
      const misses = await cassetteMisses(cassetteDir);
      throw new Error(
        `the work behind the import failed (${(row?.failed ?? 0) - before.failed} jobs); ` +
          `${defaultCassette} missed ${misses.total - before.misses} calls ` +
          `${JSON.stringify(misses.byTask)}: if they are misses, record journeys-f5 (R4)`
      );
    }
    if (Date.now() >= deadline) throw new Error("no note row with a path chip appeared in time");
    await page.waitForTimeout(5_000);
  }
}

async function captureAndCheck(session: MemoraSession, index: number, step: string) {
  const record = await captureStep(session, "j1", index, step);
  for (const theme of ["light", "dark"] as const)
    expect
      .soft(
        record.contrast[theme].failures.map((f) => `"${f.text}" ${f.ratio}:1 < ${f.required}:1`),
        `${step} ${theme} contrast (X12)`
      )
      .toEqual([]);
  await setTheme(session, "light");
}

test("J1 first run: onboarding, Home as the first-run surface, the first source opens Explore with its Source", async () => {
  test.setTimeout(75 * 60_000);
  const run = journeysRun();
  // Both first-run models come from the seed folder or the journey stops before it starts anything.
  await assertModelsSeeded(modelSeedDir(run));
  const cassetteDir = join(run.scratchDir, "cassettes", defaultCassette);
  const missesBefore = await cassetteMisses(cassetteDir);
  const writerModel = await recordedWriterModel(run);
  const userDataDir = await emptyProfile(profileDir(run, "j1"), run.repoRoot);
  const t0 = Date.now();
  const mark: Record<string, number> = {};
  const lap = (name: string) => (mark[name] = Date.now() - t0);
  const session = await launchMemora({
    run,
    userDataDir,
    env: { MEMORA_LOCAL_MODEL_INSTALL: firstRunModelIds().ranker }
  });
  const { page } = session;
  let db: ProfileDb | null = null;
  let report: Record<string, unknown> = {};
  try {
    await waitForDatabase(page, minutes(3));
    lap("databaseReady");
    db = await openProfileDb(userDataDir);

    // The first-run view stands where the shell would: the languages step, then step 2.
    expect(await invokeApp<{ show: boolean }>(page, "onboarding.state")).toMatchObject({
      show: true
    });
    await expect(page.locator('[data-surface="shell"]')).toHaveCount(0);
    await expect(page.locator("main form select")).toHaveCount(2, { timeout: 60_000 });
    await page.locator("main form select").nth(1).selectOption(contentLanguage);
    await page.locator("main form button[type=submit]").click();
    // The step saved: the settings hold the content language the form was given.
    await expect
      .poll(
        async () =>
          (await invokeApp<{ contentLanguage: string }>(page, "settings.getApp")).contentLanguage,
        { timeout: 60_000 }
      )
      .toBe(contentLanguage);
    lap("languagesDone");

    // Step 2, issued through window.app (a sign-in cannot be played); then the first-run view is done.
    await playSetup(session, db, writerModel);
    lap("setupDone");
    await invokeApp(page, "onboarding.finish", { outcome: "completed" });
    await invokeApp(page, "knowledgeControls.update", { paused: false, autonomy: "auto" });
    await page.reload();
    await setContentSize(session, 1440, 900);

    // Home is the first-run surface, and the rail holds exactly five destinations (X7).
    const home = page.locator('[data-surface="destination-home"]');
    await expect(home).toBeVisible({ timeout: 60_000 });
    await expect(home).not.toHaveAttribute("data-state", "loading", { timeout: 60_000 });
    await expect(home).not.toHaveAttribute("data-state", "error");
    const destinations = await page
      .locator('[data-surface="rail"] button[aria-keyshortcuts]')
      .evaluateAll(
        (buttons) =>
          buttons
            .map((button) => button.getAttribute("aria-keyshortcuts") ?? "")
            .filter((keys) => /^Meta\+[1-5]$/u.test(keys)).length
      );
    expect(destinations, "X7: the rail's destinations").toBe(5);
    lap("homeFirstRun");
    await captureAndCheck(session, 1, "home-first-run");

    // The first source: Cmd-N, the stubbed picker answers it, the Source opens on Explore at once.
    const file = await goldenSource(run.repoRoot, firstSourceKey);
    await stubOpenDialog(session.electronApp, [file.path]);
    await installGestureCounter(page);
    await resetGestures(page);
    const [failedRow] = await db.query<{ failed: number }>(
      "select count(*)::int as failed from jobs where status::text = 'failed'"
    );
    const failedBefore = failedRow?.failed ?? 0;
    lap("beforeImport");
    await pressShortcut(session, "Meta+N");
    const sourcePanel = page.locator('[data-surface="source"][data-panel-top]');
    await expect(sourcePanel).toBeVisible({ timeout: minutes(5) });
    lap("sourcePushed");
    await expect(
      page.locator('[data-surface="rail"] [aria-keyshortcuts="Meta+2"][aria-current="page"]'),
      "the first source did not open Explore"
    ).toBeVisible();
    await expect(
      page.locator(
        ".fixed.bottom-4.right-4 [role='status'], .fixed.bottom-4.right-4 [role='alert']"
      )
    ).toHaveCount(0);
    expect((await readGestures(page)).total, "the first source needed more than Cmd-N").toBe(1);
    await captureAndCheck(session, 2, "source-pushed");

    // The first note with its path: T1. The navigator shows the topic the chip names.
    const firstRow = await waitForPlacedRow(
      page,
      db,
      cassetteDir,
      { failed: failedBefore, misses: missesBefore.total },
      minutes(30)
    );
    lap("firstNoteWithPath");
    const gestures = await readGestures(page);
    const noteAddress = await firstRow.locator("button[data-address]").getAttribute("data-address");
    const chip = (await firstRow.locator("[data-path-chip]").getAttribute("data-path")) ?? "";
    const located = await invokeApp<Located | null>(page, "objects.locate", {
      address: noteAddress
    });
    expect(located, "objects.locate found no note for the row").not.toBeNull();
    const topics = chipTopics(located!);
    expect(topics.length).toBeGreaterThan(0);
    expect(chip, "the chip differs from objects.locate (primary)").toBe(
      topics.map((topic) => topic.title).join(" › ")
    );
    const navigator = page.locator('[data-region="navigator"]');
    await expect(
      navigator.locator(`[role="treeitem"][data-nav-key="t:${topics[0]!.id}"]`),
      "the navigator does not show the new tree"
    ).toBeVisible({ timeout: 60_000 });
    const fromFileChoice = gestures.total - 1;
    expect(fromFileChoice, "X1 for the first source").toBeLessThanOrEqual(x1Bar);
    await captureAndCheck(session, 3, "first-note-with-path");

    const t1 = mark.firstNoteWithPath!;
    const missesAfter = await cassetteMisses(cassetteDir);
    const missed = missesAfter.total - missesBefore.total;
    await invokeApp(page, "knowledgeControls.update", { paused: true, autonomy: "off" });
    report = {
      t0ToT1Ms: t1,
      t0ToT1: `${Math.floor(t1 / 60_000)}:${String(Math.floor((t1 % 60_000) / 1000)).padStart(2, "0")}`,
      f4E6BarMs: 10 * 60_000,
      laps: mark,
      x1FirstRun: { fromFileChoice, fromCmdN: gestures.total, log: gestures.log },
      chip,
      railDestinations: destinations,
      misses: { count: missed, byTask: missesAfter.byTask }
    };
    test.info().annotations.push(
      { type: "T0 to T1", description: String(report.t0ToT1) },
      {
        type: "X1 first run",
        description: `${fromFileChoice} from the file choice, ${gestures.total} from Cmd-N`
      }
    );
    expect(
      missed,
      `${defaultCassette} missed ${missed} calls (${JSON.stringify(missesAfter.byTask)}): record journeys-f5 (R4)`
    ).toBe(0);
  } finally {
    const evidence = join(run.evidenceDir, "j1");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "report.json"),
      `${JSON.stringify({ ...report, laps: mark }, null, 2)}\n`
    );
    await db?.close();
    await session.close();
  }
});
