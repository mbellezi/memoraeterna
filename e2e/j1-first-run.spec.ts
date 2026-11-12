// J1 first run (F5 T154, spec 5.3, amendments A6 and A7, bar X7): an empty profile starts in the
// first-run view and the person walks its three steps there: the languages, the AI setup in Hybrid
// (the ChatGPT / Codex sign-in included) and the first source, chosen in onboarding's own import
// step. Choosing it is A6/D9's path (`use-first-run.tsx` onFirstSource -> `App.tsx` openFirstSource
// -> the `firstSource` case of `workspace/state.ts`): the app lands in Explore with that Source
// pushed, the navigator showing the tree being born and then a note row with its path chip. T0 (the
// launch) to T1 (that note row) is recorded: F4 E6's replay bar is 10 minutes for the whole first run.
//
// The one thing a journey cannot play is the browser sign-in: `stubCodexSignIn` swaps the connect
// handler in main for a stand-in that runs the product's own handler with the sign-in's outside world
// answered on this machine (the DEV Codex credential stub, the cassette's writer model), so the
// first-run view's own button signs in and the setup saves the stub in this scratch profile. No model
// is downloaded (the seed folder is checked first; the ranker comes from it through the DEV install
// knob) and every AI call is served by the cassette `firstrun-hybrid-f4`; a miss fails the journey.
// The app is made to follow the window's colour scheme before the first scan (dark is the default).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTranslator, normalizeLanguageCode, type MessageKey } from "@app/i18n";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  assertModelsSeeded,
  captureStep,
  cassetteMisses,
  defaultCassette,
  followSystemTheme,
  firstRunRankerEnv,
  firstRunRankerState,
  goldenSource,
  invokeApp,
  launchMemora,
  modelSeedDir,
  setContentSize,
  stepFailures,
  waitForDatabase,
  type ListedLocalModel,
  type MemoraSession
} from "./support/app.js";
import { stubCodexSignIn } from "./support/codex-sign-in.js";
import { stubOpenDialog } from "./support/dialog.js";
import { newestSourceSummary, openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter, readGestures, resetGestures } from "./support/gestures.js";
import { emptyProfile, journeysRun, profileDir, type JourneysRun } from "./support/profile.js";

/** The first source of FR2 (as `global-setup.ts`). */
const firstSourceKey = "plos-one-murre-dros-2015";
const contentLanguage = "pt-BR";
/** The bar of X1 for the first source: 2 gestures from the file choice (design 9.1, row 1). */
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

/** The first-run view's own copy, in the language it marks on its root (`lang`). */
function translatorOf(lang: string | null) {
  const translator = createTranslator(normalizeLanguageCode(lang));
  return (key: MessageKey) => translator(key);
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
          `${JSON.stringify(misses.byTask)} (the newest source as the app stored it: ` +
          `${await newestSourceSummary(db)}): if they are misses, record journeys-f5 (R4)`
      );
    }
    if (Date.now() >= deadline) throw new Error("no note row with a path chip appeared in time");
    await page.waitForTimeout(5_000);
  }
}

async function captureAndCheck(session: MemoraSession, index: number, step: string) {
  const record = await captureStep(session, "j1", index, step);
  // X12: each scan drawn in the theme it was asked for, and no contrast failure in either.
  expect.soft(stepFailures(record), `${step} (X12)`).toEqual([]);
}

test("J1 first run: the three onboarding steps in the first-run view, the first source opens Explore with its Source", async () => {
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
    env: firstRunRankerEnv()
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
    // Dark is the default (Q39): the app is made to follow the window's scheme, so every scan is drawn
    // in the theme setTheme asks for and none depends on the default or on what the profile stored.
    // Asked once the first-run view is up: the app has loaded its settings and follows a change.
    await followSystemTheme(session);
    // X12 scans the first-run view too: the languages step stands in both themes.
    await captureAndCheck(session, 0, "first-run-languages");
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

    // Step 2 in the first-run view: Hybrid, the ChatGPT / Codex sign-in (the stand-in: no browser,
    // no request leaves the machine), the writer model the cassette was recorded with, then the setup.
    const t = translatorOf(
      await page
        .locator("div[lang]")
        .filter({ has: page.locator("main") })
        .first()
        .getAttribute("lang")
    );
    // The last match: the import form's footer holds its primary button after the form's own ones.
    const named = (key: MessageKey) =>
      page.getByRole("button", { name: t(key), exact: true }).last();
    await expect(page.locator('main input[name="onboarding-setup"]')).toHaveCount(3, {
      timeout: 60_000
    });
    await setContentSize(session, 1440, 900);
    // The setups in `presetOrder` (local, hybrid, cloud): the second is Hybrid.
    const hybrid = page
      .locator("main label")
      .filter({ has: page.locator('input[name="onboarding-setup"]') })
      .nth(1);
    await expect(hybrid).toContainText(t("settings.ai.classes.setup.hybrid"));
    await hybrid.locator("input").check();
    await page.locator('main input[name="onboarding-writer-method"]').first().check();
    await stubCodexSignIn(session.electronApp, [writerModel]);
    await named("onboarding.mode.writer.signIn").click();
    await expect(page.getByText(t("onboarding.mode.writer.signedIn"), { exact: true })).toBeVisible(
      {
        timeout: 60_000
      }
    );
    // The model list is the sign-in's answer, and the recorded writer is the one chosen.
    await expect(page.locator("main form select")).toHaveValue(writerModel);
    lap("signedIn");
    await captureAndCheck(session, 1, "first-run-signed-in");
    await page.locator("main form button[type=submit]").click();
    // The setup runs in the view: the writer, the embedder from the seed folder, the preset, the tests.
    const done = named("onboarding.continue");
    const doneWithProblems = named("onboarding.setup.continueAnyway");
    await expect(done.or(doneWithProblems)).toBeVisible({ timeout: minutes(30) });
    lap("setupDone");
    const setupHadProblems = await doneWithProblems.isVisible();
    expect
      .soft(setupHadProblems, "the first-run setup ended with a part failed or a test not passed")
      .toBe(false);
    // The writer the sign-in left is stored: one Codex configuration, holding a credential.
    const [writer] = await db.query<{ count: number; held: number }>(
      "select count(*)::int as count, count(credential_ref)::int as held from ai_provider_configs " +
        "where provider = 'openai-codex'"
    );
    expect(writer, "the sign-in's writer was not saved with its credential").toEqual({
      count: 1,
      held: 1
    });
    await captureAndCheck(session, 2, "first-run-setup-done");
    // With a cassette on the app never asks for the ranker; the DEV install knob puts it in from the
    // seed folder at start, and the import must not begin before it is validated for reranking.
    await until("the first-run ranker", minutes(30), 3_000, async () =>
      firstRunRankerState(await invokeApp<ListedLocalModel[]>(page, "localModels.list"))
    );
    await invokeApp(page, "knowledgeControls.update", { paused: false, autonomy: "auto" });
    await (setupHadProblems ? doneWithProblems : done).click();

    // Step 3, onboarding's own import step: the file origin, the file (the stubbed picker answers
    // it), then on to the import. Choosing it is A6/D9's first source.
    await expect(page.locator("main button[aria-pressed]")).toHaveCount(2, { timeout: 60_000 });
    lap("sourceStep");
    await captureAndCheck(session, 3, "first-run-source");
    const file = await goldenSource(run.repoRoot, firstSourceKey);
    await stubOpenDialog(session.electronApp, [file.path]);
    await installGestureCounter(page);
    await page.locator("main button[aria-pressed]").nth(1).click();
    await named("import.actions.continue").click();
    const [failedRow] = await db.query<{ failed: number }>(
      "select count(*)::int as failed from jobs where status::text = 'failed'"
    );
    const failedBefore = failedRow?.failed ?? 0;
    await resetGestures(page);
    lap("beforeImport");
    // The form's own "Escolher arquivo" (the first of the two the content step shows).
    await page
      .getByRole("button", { name: t("import.actions.chooseFile"), exact: true })
      .first()
      .click();
    // On through the form with its primary button until the import is the button left.
    const importButton = named("import.actions.import");
    for (let step = 0; step < 6 && !(await importButton.isVisible()); step += 1) {
      await expect(named("import.actions.continue")).toBeEnabled({ timeout: minutes(2) });
      await named("import.actions.continue").click();
    }
    await expect(importButton).toBeEnabled({ timeout: minutes(2) });
    await importButton.click();

    // A6/D9: the first-run view goes, Explore opens with the Source pushed and the navigator beside it.
    const sourcePanel = page.locator('[data-surface="source"][data-panel-top]');
    await expect(sourcePanel).toBeVisible({ timeout: minutes(5) });
    lap("sourcePushed");
    await expect(page.locator('[data-surface="shell"]')).toHaveCount(1);
    await expect(
      page.locator('[data-surface="rail"] [aria-keyshortcuts="Meta+2"][aria-current="page"]'),
      "the first source did not open Explore"
    ).toBeVisible();
    await expect(page.locator('[data-region="navigator"]')).toBeVisible();
    expect(await invokeApp<{ show: boolean }>(page, "onboarding.state")).toMatchObject({
      show: false
    });
    const destinations = await page
      .locator('[data-surface="rail"] button[aria-keyshortcuts]')
      .evaluateAll(
        (buttons) =>
          buttons
            .map((button) => button.getAttribute("aria-keyshortcuts") ?? "")
            .filter((keys) => /^Meta\+\d+$/u.test(keys)).length
      );
    expect(destinations, "X7: the rail's destinations").toBe(5);
    // X1 from the file choice: the gestures counted since it, plus the picker's Abrir the stub plays.
    const atLanding = await readGestures(page);
    const fromFileChoice = atLanding.total + 1;
    expect
      .soft(fromFileChoice, `X1 for the first source (${JSON.stringify(atLanding.log)})`)
      .toBeLessThanOrEqual(x1Bar);
    // A7: no toast over the content at the landing; look again a moment later for a late one.
    await page.waitForTimeout(1_500);
    expect
      .soft(await page.locator("[data-toast-viewport]").count(), "A7: a toast at the landing")
      .toBe(0);
    await captureAndCheck(session, 4, "source-pushed");

    // The first note with its path: T1. The navigator shows the topic the chip names.
    const firstRow = await waitForPlacedRow(
      page,
      db,
      cassetteDir,
      { failed: failedBefore, misses: missesBefore.total },
      minutes(30)
    );
    lap("firstNoteWithPath");
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
    await captureAndCheck(session, 5, "first-note-with-path");

    const t1 = mark.firstNoteWithPath!;
    const missesAfter = await cassetteMisses(cassetteDir);
    const missed = missesAfter.total - missesBefore.total;
    await invokeApp(page, "knowledgeControls.update", { paused: true, autonomy: "off" });
    report = {
      t0ToT1Ms: t1,
      t0ToT1: `${Math.floor(t1 / 60_000)}:${String(Math.floor((t1 % 60_000) / 1000)).padStart(2, "0")}`,
      f4E6BarMs: 10 * 60_000,
      laps: mark,
      x1FirstRun: { fromFileChoice, log: atLanding.log },
      chip,
      railDestinations: destinations,
      misses: { count: missed, byTask: missesAfter.byTask }
    };
    test.info().annotations.push(
      { type: "T0 to T1", description: String(report.t0ToT1) },
      {
        type: "X1 first run",
        description: `${fromFileChoice} from the file choice (the picker's Abrir included)`
      }
    );
    expect(
      missed,
      `${defaultCassette} missed ${missed} calls (${JSON.stringify(missesAfter.byTask)}; the first source as the app stored it: ${await newestSourceSummary(db)}): record journeys-f5 (R4)`
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
