// J7 Settings (F5 T174, spec 5.3 and 5.2: X9, X10, X11, X12; D17, D18, section 3.8): Settings v2 in
// the built app on a clone of BASE-J, with each claim read back from the store it touches.
//
// What it proves, in order:
//   1. The default theme is dark (stored, on the root, and the theme row's pressed segment). The theme
//      row changes the theme at once (the root's class, the remembered preference, the app
//      preferences row of the database) and "Restore default" puts it back through the setting's own
//      writer (read from `settings`/`app.preferences`). "System" then follows the OS appearance.
//   2. The search finds a setting by an English synonym and by a pt-BR word and lands on its row (the
//      row is visible, focused and lit); the live pt-BR held-out pass lists each entry for one of its
//      two queries (X9 as the screen shows it); a search with nothing for it says so.
//   3. A changed setting shows the changed marker (`data-changed`) and its default; "Restore default"
//      puts the stored value back (a switch of Advanced).
//   4. A restore that deletes something the person gave asks first and does nothing until confirmed: a
//      Google Books key, which this journey plants as a fixed dummy (it is never a real credential,
//      and the step stops if the profile already holds one), and a saved import plan, whose Delete
//      asks the same way; the plan has no restore at all (the registry's `reset: "none"`), which the
//      IPC call confirms by refusing it.
//   5. Deep links: the in-app requests a `memora://settings/<section>#<setting>` address parses to (the
//      row links of Settings; the OS refuses view addresses) open the section and light the row.
//   6. X10: for every registry entry, from another place: click Settings in the rail, type the entry's
//      first English held-out query (its label where that query does not list it, recorded), click its
//      result: the row is visible and focused in at most 2 gestures, counted by the gesture counter.
//      Non-advanced entries are also reached by rail -> section: visible without scrolling.
//   X12: every Settings section, the search states and the confirm states, both themes, scanned by
//      the harness's contrast tool through the step log (the app follows the OS from step 1's end on,
//      so the harness's light and dark captures are the app's own).
//
// Selectors are data attributes and roles (`data-surface`, `data-state`, `data-setting-id`,
// `data-section`, `data-result`, `data-changed`, `aria-pressed`, `role=switch`, `role=searchbox`).
// Three controls carry no data attribute of their own, and are found by what they are: the reset
// action (the row's button with the rotate icon), the ask's confirm and cancel (the first and last
// button of the row's `role=group`) and a plan's Delete (the second button of its list item). The
// words asserted are read from the message catalog, never typed here.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { messages } from "@app/i18n";
import { expect, test, type ElementHandle, type Locator, type Page } from "@playwright/test";

import {
  settingsRegistryV2,
  type SettingEntryV2
} from "../apps/desktop/src/shared/settings-registry";
import { invokeApp, launchMemora, setContentSize, waitForDatabase } from "./support/app.js";
import { openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter, readGestures, resetGestures } from "./support/gestures.js";
import { cloneProfile, journeysRun, profileDir } from "./support/profile.js";
import { pressShortcut } from "./support/shortcuts.js";
import { StepLog, surface } from "./support/workspace-steps.js";

// ---------------------------------------------------------------------------------------------
// The held-out queries (T109's fixture, committed by T161) and the ids it names differently.

type Locale = "en" | "pt-BR" | "es" | "fr" | "it";
type HeldOut = Record<string, Record<Locale, string[]>>;

/** The held-out fixture's ids that are not a registry id (the registry's final shape); null: no control. */
const heldOutEntry: Readonly<Record<string, string | null>> = {
  matchingPresets: "activeMatchingPresetId",
  metadataEnrichmentEnabled: "bookLookup",
  bookMetadataProvider: "bookLookup",
  obsidianSyncEnabled: "obsidianSync",
  obsidianSyncPaused: "obsidianSync",
  "obsidian.layout": "obsidian.layout.language",
  uploadCopiesEnabled: "uploadCopies",
  uploadCopiesFolderPath: "uploadCopies",
  "relations.decisions.state": null,
  "relations.decisions.dailySpend": null,
  "prompts.active": null,
  "page.models": "ai.models",
  "page.this-mac": "ai.thisMac",
  "page.prompts": "advanced.prompts",
  "page.gateway": "integrations.gateway",
  "page.backup": "library.backup",
  "page.reset": "privacy.reset",
  "page.diagnostics-log": "advanced.callLog",
  navigationCollapsed: null,
  updatedAt: null,
  "import.lastDirectory": null,
  "ai.classTests.v1": null,
  "ai.routes.classMap.v1": null,
  "relations.ai.dailyCalls": null,
  "catalogHeader.dailyRoots": null,
  "gardener.budget.subscriptionCalls.v1": null,
  "gardener.budget.continue.v1": null,
  "gardener.audit.cursors.v1": null,
  "topics.ai.daily.v1": null,
  "topics.corpus.v1": null,
  "local-models.first-run-ranker": null,
  "jobs.history.dismissed-through.v1": null,
  "obsidian.layout.presence": null,
  "obsidian.editorial.client": null,
  "relations.match.valuesHistory.v1": null,
  "onboarding.v1": null
};

/**
 * The entries whose first English held-out query does not list them in the app's search, as X9's
 * fixture and `searchSettings` have them today (found by running the fixture's first English query
 * of each entry through the search). X10 types the label for these only: a miss outside this list is
 * a regression of the English search and fails the journey, so a search that stops reading the
 * keywords cannot be absorbed by the label fallback. A listed entry that gets found is a note.
 */
const knownFirstQueryMisses: readonly string[] = [
  "ai.thisMac",
  "knowledge.controls.v1.onlyIdle",
  "sourceRelationSettings.minConfidence"
];

/**
 * The entries that have no held-out query at all (the list X9's test, `settings-search.test.ts`,
 * pins as "the entries that have no held-out query"): X10 types their label. The gap can only shrink.
 */
const entriesWithoutHeldOutQuery: readonly string[] = [
  "advanced.similarityRuns",
  "advanced.taskHistory",
  "ai.profiles",
  "ai.route.judge",
  "library.storage",
  "obsidian.layout.attachments",
  "obsidian.wiki.includeDescendants",
  "privacy.callLog",
  "privacy.clearQuestions",
  "privacy.clearViewHistory",
  "privacy.summary",
  "relationLabels"
];

/** The held-out queries of each registry entry, in the fixture's order, for one locale. */
function heldOutQueries(fixture: HeldOut, locale: Locale): Map<string, string[]> {
  const byEntry = new Map<string, string[]>();
  for (const [id, locales] of Object.entries(fixture)) {
    const entry = id in heldOutEntry ? heldOutEntry[id] : id;
    if (entry === null || entry === undefined) continue;
    byEntry.set(entry, [...(byEntry.get(entry) ?? []), ...(locales[locale] ?? [])]);
  }
  return byEntry;
}

async function loadHeldOut(repoRoot: string): Promise<HeldOut> {
  const path = join(repoRoot, "apps", "desktop", "src", "shared", "settings-search.heldout.json");
  return JSON.parse(await readFile(path, "utf8")) as HeldOut;
}

/** The copy at a dotted key of the catalog in one language (the journey never types copy). */
function copy(locale: Locale, key: string): string {
  let node: unknown = (messages as unknown as Record<string, unknown>)[locale];
  for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
  if (typeof node !== "string") throw new Error(`No ${locale} copy at ${key}`);
  return node;
}

// ---------------------------------------------------------------------------------------------
// The page

const settingsRoot = (page: Page): Locator => surface(page, "settings").first();
const railSettings = (page: Page): Locator =>
  page.locator('[data-surface="rail"] button[aria-keyshortcuts="Meta+,"]');
const searchField = (page: Page): Locator => settingsRoot(page).locator('input[role="searchbox"]');
const rowOf = (page: Page, id: string): Locator =>
  settingsRoot(page).locator(`[data-setting-id="${id}"]`);
const resultOf = (page: Page, id: string): Locator =>
  settingsRoot(page).locator(`[data-result="${id}"]`);
const sectionButton = (page: Page, section: string): Locator =>
  settingsRoot(page).locator(`button[data-section="${section}"]`);
/** The row's restore action: the button with the rotate icon (it has no data attribute). */
const resetButton = (row: Locator): Locator => row.locator("button:has(svg.lucide-rotate-ccw)");
/** The inline ask of a row: a group whose first button confirms and whose last cancels. */
const askOf = (row: Locator): Locator => row.locator('[role="group"]');

interface Description {
  id: string;
  value: unknown;
  default: unknown;
  changed: boolean;
}

async function describe(page: Page): Promise<Map<string, Description>> {
  const result = await invokeApp<{ entries: Description[] }>(page, "settings.describe");
  return new Map(result.entries.map((entry) => [entry.id, entry]));
}

/** The app preferences document as the database holds it (the store itself, not the screen). */
async function storedPreferences(db: ProfileDb): Promise<Record<string, unknown>> {
  const [row] = await db.query<{ value: Record<string, unknown> }>(
    "select value from settings where key = 'app.preferences'"
  );
  return row?.value ?? {};
}

/** The references the credential file holds: only the names, never a secret. */
async function storedCredentialRefs(userDataDir: string): Promise<string[]> {
  try {
    const file = JSON.parse(
      await readFile(join(userDataDir, "credentials", "ai-secrets.json"), "utf8")
    ) as { secrets?: Record<string, string> };
    return Object.keys(file.secrets ?? {});
  } catch {
    return [];
  }
}

const rootClass = (page: Page): Promise<string> =>
  page.evaluate(() => document.documentElement.className);

/** Whether the row is lit: the highlight is a fill; an idle row has none. */
const rowFill = (row: Locator): Promise<string> =>
  row.evaluate((node) => getComputedStyle(node).backgroundColor);
const noFill = "rgba(0, 0, 0, 0)";

async function isFocused(row: Locator): Promise<boolean> {
  return row.evaluate((node) => document.activeElement === node);
}

/** Whether the row sits wholly inside the visible part of the Settings column (no scrolling needed). */
async function visibleWithoutScrolling(row: Locator): Promise<boolean> {
  return row.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    let scroller: HTMLElement | null = node.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto")
      scroller = scroller.parentElement;
    const box = scroller?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight
    };
    return rect.height > 0 && rect.top >= box.top - 1 && rect.bottom <= box.bottom + 1;
  });
}

/** The Settings column that scrolls: the nearest scrolling ancestor of the open section's title. */
async function sectionScroller(page: Page): Promise<ElementHandle<HTMLElement>> {
  const title = settingsRoot(page).locator('h2[tabindex="-1"]').first();
  await expect(title, "the section's title is not on screen").toBeVisible();
  const handle = await title.evaluateHandle((node) => {
    let scroller: HTMLElement | null = node.parentElement;
    while (scroller && getComputedStyle(scroller).overflowY !== "auto")
      scroller = scroller.parentElement;
    return scroller ?? document.scrollingElement;
  });
  return handle as ElementHandle<HTMLElement>;
}

/**
 * Takes a step (both themes) for each screen of the open section: the scan sees only what is inside
 * the window, so the section's column is scrolled by a page (less a margin that keeps one row in
 * two screens) until its end. Returns how many screens it took.
 */
async function stepEveryScreen(page: Page, steps: StepLog, name: string): Promise<number> {
  const scroller = await sectionScroller(page);
  const frame = () =>
    page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))
    );
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  let screens = 0;
  for (;;) {
    await frame();
    screens += 1;
    await steps.step(screens === 1 ? name : `${name}-screen-${screens}`);
    const moved = await scroller.evaluate((node) => {
      const before = node.scrollTop;
      node.scrollTop = before + Math.max(node.clientHeight - 96, 96);
      return node.scrollTop > before;
    });
    if (!moved || screens >= 40) break;
  }
  await scroller.evaluate((node) => {
    node.scrollTop = 0;
  });
  await scroller.dispose();
  return screens;
}

/** The changed count the section's navigation button shows (the badge is absent at 0). */
async function navChangedCount(page: Page, section: string): Promise<number> {
  const badge = sectionButton(page, section).locator("span[aria-label]");
  if ((await badge.count()) === 0) return 0;
  return Number.parseInt((await badge.first().innerText()).trim(), 10) || 0;
}

async function openSettings(page: Page): Promise<void> {
  await railSettings(page).click();
  await expect(settingsRoot(page), "Settings did not show").toBeVisible();
  await expect(settingsRoot(page), "Settings did not reach success").toHaveAttribute(
    "data-state",
    "success",
    { timeout: 30_000 }
  );
}

type Session = Parameters<typeof pressShortcut>[0];

/** Leaves Settings for Home (Cmd-1), the way a person goes elsewhere; the Settings frame hides. */
async function leaveSettings(session: Session): Promise<void> {
  await pressShortcut(session, "Meta+1");
  await expect(settingsRoot(session.page), "Settings stayed on screen").toBeHidden();
}

/** Whether the row takes focus within `timeout` ms (no throw). */
async function takesFocus(row: Locator, timeout: number): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await isFocused(row)) return true;
    await new Promise((done) => setTimeout(done, 100));
  }
  return isFocused(row);
}

/** Waits until the row is on screen, focused and (when `lit`) filled. */
async function expectLanded(page: Page, id: string, what: string, lit = true): Promise<void> {
  const row = rowOf(page, id);
  await expect(row, `${what}: the row is not on screen`).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() => isFocused(row), { message: `${what}: the row is not focused` })
    .toBe(true);
  if (lit)
    await expect
      .poll(() => rowFill(row), { message: `${what}: the row is not lit` })
      .not.toBe(noFill);
}

/** The ids listed by the results of the current search, in the order of the page. */
async function listedResults(page: Page): Promise<string[]> {
  return settingsRoot(page)
    .locator("[data-result]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-result") ?? ""));
}

/** Types a query and waits until the screen answers it: results, or the "nothing found" state. */
async function search(page: Page, query: string): Promise<void> {
  await searchField(page).fill(query);
  await expect
    .poll(
      async () => {
        const state = await settingsRoot(page).getAttribute("data-state");
        return state === "success" || state === "empty";
      },
      { message: `the search for "${query}" gave no answer` }
    )
    .toBe(true);
}

async function clearSearch(page: Page): Promise<void> {
  await searchField(page).fill("");
  await expect(settingsRoot(page)).toHaveAttribute("data-state", "success");
}

test("J7 Settings: search, the changed marker and restore, asks before deleting, theme, deep links, X10 and X12", async () => {
  test.setTimeout(45 * 60_000);
  const run = journeysRun();
  const info = test.info();
  const userDataDir = await cloneProfile(
    profileDir(run, "base"),
    profileDir(run, "j7"),
    run.repoRoot
  );
  const heldOut = await loadHeldOut(run.repoRoot);
  const registry: readonly SettingEntryV2[] = settingsRegistryV2;
  const byId = new Map(registry.map((entry) => [entry.id, entry]));

  const session = await launchMemora({ run, userDataDir });
  const { page } = session;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1440, 900);
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(userDataDir);
    await installGestureCounter(page);
    const steps = new StepLog(session, "j7");

    // The window speaks pt-BR (the harness's `--lang`), which the pt-BR parts rely on.
    expect((await invokeApp<{ language: string }>(page, "settings.getApp")).language).toBe("pt-BR");

    // -----------------------------------------------------------------------------------------
    // 1. The default theme is dark; the theme row changes it at once; restore puts it back.
    await openSettings(page);
    const themeRow = rowOf(page, "themeMode");
    const themeSegments = themeRow.locator("button[aria-pressed]");
    const pressed = async () =>
      themeSegments.evaluateAll((nodes) =>
        nodes.findIndex((node) => node.getAttribute("aria-pressed") === "true")
      );
    // The segments are the theme modes in the schema's order: system, light, dark.
    const [systemAt, lightAt, darkAt] = [0, 1, 2];
    await expect(themeSegments).toHaveCount(3);

    const first = (await describe(page)).get("themeMode");
    expect(first?.default, "the registry's default theme").toBe("dark");
    if (first?.value !== "dark") {
      // A BASE-J built before the dark default holds the old default as a stored choice ("system"),
      // which is kept and now differs from the default: the row says so and restore moves it to dark.
      info.annotations.push({
        type: "note",
        description: `the profile stores the theme "${String(first?.value)}" (BASE-J predates the dark default); the journey restores it first`
      });
      expect(first?.changed, "a stored non-default theme is not marked as changed").toBe(true);
      await expect(themeRow).toHaveAttribute("data-changed");
      await resetButton(themeRow).click();
      await expect
        .poll(async () => (await storedPreferences(db!)).themeMode, {
          message: "restore did not store the dark default"
        })
        .toBe("dark");
    }
    expect((await describe(page)).get("themeMode")?.value, "the theme at the start").toBe("dark");
    expect((await describe(page)).get("themeMode")?.changed, "dark is marked as changed").toBe(
      false
    );
    await expect
      .poll(() => rootClass(page), { message: "the root's theme at the start" })
      .toContain("dark");
    expect(await pressed(), "the pressed theme segment at the start").toBe(darkAt);
    await expect(themeRow, "the default theme shows a changed marker").not.toHaveAttribute(
      "data-changed"
    );

    await themeSegments.nth(lightAt).click();
    await expect
      .poll(() => rootClass(page), { message: "the theme did not change at once", timeout: 3_000 })
      .toContain("light");
    expect(await rootClass(page), "light left the dark class on the root").not.toContain("dark");
    await expect(themeRow, "a changed theme shows no changed marker").toHaveAttribute(
      "data-changed"
    );
    // The default line ("Padrão: Escuro"), not the row's own Dark segment, which is always there.
    await expect(
      themeRow.locator("p", { hasText: copy("pt-BR", "settingsShell.row.default") }),
      "the row does not name the default on its default line"
    ).toContainText(copy("pt-BR", "settingsGeneral.theme.dark"));
    await expect
      .poll(async () => (await storedPreferences(db!)).themeMode, {
        message: "the light theme was not stored"
      })
      .toBe("light");
    expect(
      await page.evaluate(() => localStorage.getItem("memora.themeMode")),
      "the remembered preference"
    ).toBe("light");
    expect((await describe(page)).get("themeMode")?.changed).toBe(true);

    await resetButton(themeRow).click();
    await expect
      .poll(() => rootClass(page), { message: "restore did not bring the dark theme back" })
      .toContain("dark");
    await expect
      .poll(async () => (await storedPreferences(db!)).themeMode, {
        message: "restore did not write the default theme through its writer"
      })
      .toBe("dark");
    await expect(themeRow, "the marker stayed after the restore").not.toHaveAttribute(
      "data-changed"
    );
    expect(await pressed()).toBe(darkAt);
    expect((await describe(page)).get("themeMode")?.changed).toBe(false);

    // "System" follows the OS appearance live; the rest of the journey leans on it (the harness's
    // light and dark captures set the window's appearance and the app follows).
    await themeSegments.nth(systemAt).click();
    await expect
      .poll(async () => (await storedPreferences(db!)).themeMode, {
        message: "the system theme was not stored"
      })
      .toBe("system");
    for (const theme of ["light", "dark"] as const) {
      await session.electronApp.evaluate(({ nativeTheme }, source) => {
        nativeTheme.themeSource = source;
      }, theme);
      await page.emulateMedia({ colorScheme: theme });
      await expect
        .poll(() => rootClass(page), { message: `system did not follow the OS to ${theme}` })
        .toContain(theme);
    }
    await steps.step("general-theme-system");

    // -----------------------------------------------------------------------------------------
    // 2. The search: a synonym, a pt-BR word, a live pass of the held-out queries, nothing found.
    await leaveSettings(session);
    await openSettings(page);
    await search(page, "night mode");
    expect(await listedResults(page), "the synonym 'night mode' does not list the theme").toContain(
      "themeMode"
    );
    await steps.step("search-synonym-results");
    await resultOf(page, "themeMode").click();
    await expectLanded(page, "themeMode", "the synonym's result");
    await expect(sectionButton(page, "general")).toHaveAttribute("aria-current", "true");

    await leaveSettings(session);
    await openSettings(page);
    await search(page, "aparência");
    expect(
      await listedResults(page),
      "the pt-BR word 'aparência' does not list the theme"
    ).toContain("themeMode");
    await resultOf(page, "themeMode").click();
    await expectLanded(page, "themeMode", "the pt-BR word's result");

    await leaveSettings(session);
    await openSettings(page);
    await search(page, "zzqxjvw");
    await expect(settingsRoot(page), "a search for nothing is not the empty state").toHaveAttribute(
      "data-state",
      "empty"
    );
    expect(await listedResults(page)).toEqual([]);
    await steps.step("search-nothing-found");
    await clearSearch(page);

    // X9 as the screen shows it, in pt-BR: each entry is listed for at least one of its two
    // held-out queries, and at least 90% of all the queries list their entry.
    const ptQueries = heldOutQueries(heldOut, "pt-BR");
    let asked = 0;
    let listed = 0;
    const ptMisses: string[] = [];
    for (const [entryId, queries] of ptQueries) {
      if (!byId.has(entryId)) continue;
      let any = false;
      for (const query of queries) {
        await search(page, query);
        asked += 1;
        if ((await listedResults(page)).includes(entryId)) {
          listed += 1;
          any = true;
        }
      }
      if (!any) ptMisses.push(`${entryId} (${queries.join(" | ")})`);
    }
    await clearSearch(page);
    const ptRate = asked === 0 ? 0 : listed / asked;
    info.annotations.push({
      type: "X9 live pt-BR",
      description: `${listed}/${asked} queries list their entry (${(ptRate * 100).toFixed(1)}%); entries with no query listed: ${ptMisses.length}${ptMisses.length ? ` (${ptMisses.join("; ")})` : ""}`
    });
    expect(ptMisses, "an entry no pt-BR held-out query lists").toEqual([]);
    expect(
      ptRate,
      "the share of pt-BR held-out queries that list their entry"
    ).toBeGreaterThanOrEqual(0.9);

    // -----------------------------------------------------------------------------------------
    // 3. A changed setting: the marker, its default, restore through its writer (a switch).
    const keepId = "keepLocalEmbeddingModelsLoaded";
    await leaveSettings(session);
    await openSettings(page);
    await search(page, (heldOut[keepId]?.["pt-BR"] ?? [])[0] ?? "manter modelo na memória");
    await resultOf(page, keepId).click();
    await expectLanded(page, keepId, "the switch's pt-BR query");
    await expect(sectionButton(page, "advanced")).toHaveAttribute("aria-current", "true");
    const keepRow = rowOf(page, keepId);
    const keepSwitch = keepRow.locator('[role="switch"]');
    const keepStored = async () => (await storedPreferences(db!)).keepLocalEmbeddingModelsLoaded;
    expect(
      (await describe(page)).get(keepId)?.default,
      "the registry's default of the switch"
    ).toBe(true);
    expect((await keepStored()) ?? true, "the stored switch").toBe(true);
    await expect(keepRow).not.toHaveAttribute("data-changed");
    const advancedChangedBefore = await navChangedCount(page, "advanced");
    await keepSwitch.click();
    await expect.poll(keepStored, { message: "the switch was not stored" }).toBe(false);
    await expect(keepRow, "a changed switch shows no marker").toHaveAttribute("data-changed");
    await expect(keepRow, "a changed switch does not name its default").toContainText(
      copy("pt-BR", "settingsShell.row.valueOn")
    );
    await expect(keepRow).toContainText(copy("pt-BR", "settingsShell.row.default"));
    await expect(resetButton(keepRow), "a changed row offers no restore").toBeVisible();
    expect((await describe(page)).get(keepId)?.changed).toBe(true);
    await expect
      .poll(() => navChangedCount(page, "advanced"), {
        message: "the section's changed count did not go up by exactly 1"
      })
      .toBe(advancedChangedBefore + 1);
    await steps.step("advanced-changed-switch");
    await resetButton(keepRow).click();
    await expect
      .poll(keepStored, { message: "restore did not write the default through its writer" })
      .toBe(true);
    await expect(keepRow, "the marker stayed after the restore").not.toHaveAttribute(
      "data-changed"
    );
    await expect(keepSwitch).toHaveAttribute("aria-checked", "true");
    expect((await describe(page)).get(keepId)?.changed).toBe(false);
    await expect
      .poll(() => navChangedCount(page, "advanced"), {
        message: "the section's changed count did not come back after the restore"
      })
      .toBe(advancedChangedBefore);

    // -----------------------------------------------------------------------------------------
    // 4. A restore that deletes asks first and does nothing until confirmed.
    // 4a. A stored key. The profile's own Codex sign-in is the harness's stub; the Google Books key
    // has no restore of its own before one is saved, so the journey plants a fixed dummy through the
    // app's writer, only on a profile that holds none, and removes only that.
    const booksId = "metadata:google-books";
    const refsBefore = await storedCredentialRefs(userDataDir);
    expect(
      await invokeApp(page, "settings.getGoogleBooksKeyStatus"),
      "the profile already holds a Google Books key: the journey will not touch it"
    ).toEqual({ configured: false });
    expect(refsBefore.includes(booksId)).toBe(false);
    await invokeApp(page, "settings.updateGoogleBooksKey", { apiKey: "journeys-dummy-not-a-key" });
    expect(await invokeApp(page, "settings.getGoogleBooksKeyStatus")).toEqual({ configured: true });
    expect(
      await storedCredentialRefs(userDataDir),
      "the dummy key is not in the credential file"
    ).toContain(booksId);

    await leaveSettings(session);
    await openSettings(page);
    await sectionButton(page, "integrations").click();
    const booksRow = rowOf(page, booksId);
    await expect(booksRow).toBeVisible();
    await expect.poll(async () => (await describe(page)).get(booksId)?.changed).toBe(true);
    await resetButton(booksRow).click();
    await expect(askOf(booksRow), "the restore of a stored key did not ask").toBeVisible();
    await steps.step("integrations-restore-key-ask");
    // Nothing is deleted while the question stands, nor after it is cancelled.
    expect(await invokeApp(page, "settings.getGoogleBooksKeyStatus")).toEqual({ configured: true });
    expect(await storedCredentialRefs(userDataDir)).toContain(booksId);
    await askOf(booksRow).locator("button").last().click();
    await expect(askOf(booksRow), "cancel left the question open").toHaveCount(0);
    expect(await invokeApp(page, "settings.getGoogleBooksKeyStatus")).toEqual({ configured: true });
    expect(await storedCredentialRefs(userDataDir)).toContain(booksId);
    // Confirmed: only now the key goes, and only that one.
    await resetButton(booksRow).click();
    await expect(askOf(booksRow)).toBeVisible();
    await askOf(booksRow).locator("button").first().click();
    await expect
      .poll(
        async () => invokeApp<{ configured: boolean }>(page, "settings.getGoogleBooksKeyStatus"),
        {
          message: "the confirmed restore did not remove the key"
        }
      )
      .toEqual({ configured: false });
    const refsAfter = await storedCredentialRefs(userDataDir);
    expect(refsAfter.includes(booksId), "the key is still in the credential file").toBe(false);
    expect(
      refsAfter.filter((ref) => ref !== booksId).sort(),
      "the restore removed another credential"
    ).toEqual(refsBefore.sort());

    // 4b. A saved import plan: Delete asks, nothing moves until confirmed; there is no restore.
    const plan = {
      id: randomUUID(),
      name: "J7 plan",
      requestedStages: ["conversion", "chunking"]
    };
    const plansBefore = ((await storedPreferences(db)).processingPresets ?? []) as { id: string }[];
    await invokeApp(page, "settings.updateApp", {
      processingPresets: [...plansBefore, plan]
    });
    const planIds = async () =>
      (((await storedPreferences(db!)).processingPresets ?? []) as { id: string }[]).map(
        (item) => item.id
      );
    expect(await planIds(), "the plan was not stored").toContain(plan.id);
    await sectionButton(page, "library").click();
    const plansRow = rowOf(page, "processingPresets");
    await expect(plansRow).toBeVisible();
    const planItem = plansRow.locator("li", { hasText: plan.name });
    await expect(planItem).toBeVisible();
    await expect(
      resetButton(plansRow),
      "the saved import plans offer a restore, which the registry says they do not"
    ).toHaveCount(0);
    // The IPC refuses to reset them, so no path restores them behind a person's back.
    await expect(
      invokeApp(page, "settings.reset", { id: "processingPresets" }),
      "settings.reset accepted the saved import plans"
    ).rejects.toThrow();
    expect(await planIds()).toContain(plan.id);
    await planItem.locator("button").nth(1).click();
    await expect(askOf(planItem), "Delete did not ask").toBeVisible();
    await steps.step("library-delete-plan-ask");
    expect(await planIds(), "the plan went before the question was answered").toContain(plan.id);
    await askOf(planItem).locator("button").last().click();
    await expect(askOf(planItem)).toHaveCount(0);
    expect(await planIds(), "cancel deleted the plan").toContain(plan.id);
    await planItem.locator("button").nth(1).click();
    await askOf(planItem).locator("button").first().click();
    await expect
      .poll(planIds, { message: "the confirmed Delete did not remove the plan" })
      .not.toContain(plan.id);
    expect(await planIds(), "Delete removed the other plans").toEqual(
      plansBefore.map((item) => item.id)
    );

    // -----------------------------------------------------------------------------------------
    // 5. Deep links. The system's `open-url` takes object addresses only (a view address is refused
    // in main, D10), so a `memora://settings/<section>#<setting>` address is the in-app one: the row
    // links of Settings send exactly the request the address parses to (`settings-target`), and
    // each is followed here. Each opens the section, scrolls to the row, focuses it and lights it.
    const linkIn = (scope: Locator, key: string): Locator =>
      scope.getByRole("button", { name: copy("pt-BR", key), exact: true });
    // Privacy's call-log row -> Advanced, the call log's row (by registry id).
    await sectionButton(page, "privacy").click();
    await linkIn(rowOf(page, "privacy.callLog"), "settingsPrivacy.callLog.open").click();
    await expectLanded(page, "advanced.callLog", "the link to the call log");
    await expect(sectionButton(page, "advanced")).toHaveAttribute("aria-current", "true");
    // The light goes out by itself (2 s), and the row keeps its focus.
    await expect
      .poll(() => rowFill(rowOf(page, "advanced.callLog")), {
        message: "the row stayed lit",
        timeout: 10_000
      })
      .toBe(noFill);
    expect(await isFocused(rowOf(page, "advanced.callLog"))).toBe(true);
    // Integrations -> Advanced, the managed folder.
    await sectionButton(page, "integrations").click();
    await linkIn(settingsRoot(page), "settingsIntegrations.openAdvanced").click();
    await expectLanded(page, "managedRoot", "the link to the managed folder");
    await expect(sectionButton(page, "advanced")).toHaveAttribute("aria-current", "true");
    // A link that names only a section (Advanced's layout row -> Integrations).
    await linkIn(settingsRoot(page), "settingsAdvanced.layout.openIntegrations").click();
    await expect(sectionButton(page, "integrations")).toHaveAttribute("aria-current", "true");
    await expect(settingsRoot(page)).toHaveAttribute("data-state", "success");

    // -----------------------------------------------------------------------------------------
    // X12: every section of Settings, every screen of it (the scan sees the window only, so the
    // section's column is scrolled a page at a time), both themes.
    const screensOf: string[] = [];
    for (const section of [
      "general",
      "ai",
      "knowledge",
      "library",
      "integrations",
      "privacy",
      "advanced"
    ]) {
      await sectionButton(page, section).click();
      await expect(sectionButton(page, section)).toHaveAttribute("aria-current", "true");
      await expect(settingsRoot(page)).toHaveAttribute("data-state", "success", {
        timeout: 30_000
      });
      screensOf.push(`${section} ${await stepEveryScreen(page, steps, `section-${section}`)}`);
    }
    info.annotations.push({
      type: "X12 screens scanned per section",
      description: screensOf.join(", ")
    });

    // -----------------------------------------------------------------------------------------
    // 6. X10, in English (the held-out queries are English). The app's language is changed by the
    // writer, as a setup step.
    await invokeApp(page, "settings.updateApp", { language: "en" });
    await expect
      .poll(async () => (await invokeApp<{ language: string }>(page, "settings.getApp")).language)
      .toBe("en");
    const enQueries = heldOutQueries(heldOut, "en");
    const labelOf = (entry: SettingEntryV2) => copy("en", entry.labelKey);

    interface Outcome {
      id: string;
      how: "query" | "label";
      query: string;
      gestures: number;
      problem: string | null;
    }
    const outcomes: Outcome[] = [];
    const sectionProblems: string[] = [];
    const noQuery: string[] = [];
    const queryMisses: string[] = [];
    const unpinnedMisses: string[] = [];

    for (const entry of registry) {
      // From another place: Home.
      await pressShortcut(session, "Meta+1");
      await expect(settingsRoot(page)).toBeHidden({ timeout: 10_000 });
      const queries = enQueries.get(entry.id) ?? [];
      if (queries.length === 0) noQuery.push(entry.id);
      let how: Outcome["how"] = queries.length > 0 ? "query" : "label";
      let query = queries[0] ?? labelOf(entry);

      await resetGestures(page);
      await railSettings(page).click();
      const outcome: Outcome = { id: entry.id, how, query, gestures: 0, problem: null };
      try {
        await expect(settingsRoot(page)).toBeVisible({ timeout: 10_000 });
        await expect(searchField(page)).toBeEnabled({ timeout: 10_000 });
        await searchField(page).fill(query);
        const result = resultOf(page, entry.id);
        let found = await result.waitFor({ timeout: 4_000 }).then(
          () => true,
          () => false
        );
        if (!found && how === "query") {
          // The held-out query does not list the entry: its label is typed instead, and recorded.
          queryMisses.push(`${entry.id} ("${query}")`);
          if (!knownFirstQueryMisses.includes(entry.id))
            unpinnedMisses.push(`${entry.id} ("${query}")`);
          how = "label";
          query = labelOf(entry);
          await searchField(page).fill(query);
          found = await result.waitFor({ timeout: 4_000 }).then(
            () => true,
            () => false
          );
        }
        outcome.how = how;
        outcome.query = query;
        if (!found) {
          outcome.problem = `no result for "${query}"`;
        } else {
          await result.click();
          const row = rowOf(page, entry.id);
          const shown = await row.waitFor({ state: "visible", timeout: 6_000 }).then(
            () => true,
            () => false
          );
          if (!shown) outcome.problem = "the row is not on screen";
          else if (!(await takesFocus(row, 3_000))) outcome.problem = "the row is not focused";
        }
      } catch (error) {
        outcome.problem = `${error instanceof Error ? error.message.split("\n")[0] : String(error)}`;
      }
      outcome.gestures = (await readGestures(page)).total;
      if (outcome.problem === null && outcome.gestures > 2)
        outcome.problem = `${outcome.gestures} gestures`;
      outcomes.push(outcome);

      // The same entry by rail -> section, for the entries outside Advanced's disclosure.
      if (!entry.advanced && entry.section !== "advanced") {
        await pressShortcut(session, "Meta+1");
        await expect(settingsRoot(page)).toBeHidden({ timeout: 10_000 });
        await resetGestures(page);
        await railSettings(page).click();
        await expect(settingsRoot(page)).toBeVisible({ timeout: 10_000 });
        await sectionButton(page, entry.section).click();
        const row = rowOf(page, entry.id);
        const shown = await row.waitFor({ state: "visible", timeout: 6_000 }).then(
          () => true,
          () => false
        );
        const gestures = (await readGestures(page)).total;
        if (!shown) sectionProblems.push(`${entry.id}: not on screen after rail and section`);
        else if (!(await visibleWithoutScrolling(row)))
          sectionProblems.push(`${entry.id}: below the fold of ${entry.section}`);
        else if (gestures > 2) sectionProblems.push(`${entry.id}: ${gestures} gestures`);
      }
    }

    const byQuery = outcomes.filter((outcome) => outcome.how === "query").length;
    info.annotations.push(
      {
        type: "X10 search",
        description: `${outcomes.length} entries; ${outcomes.length - outcomes.filter((o) => o.problem).length} landed focused in at most 2 gestures; ${byQuery} by the first held-out query, ${outcomes.length - byQuery} by the label`
      },
      {
        type: "X10 entries without a held-out query (label typed)",
        description: noQuery.join(", ") || "none"
      },
      {
        type: "X10 held-out misses (label typed instead)",
        description: `${queryMisses.join("; ") || "none"}${unpinnedMisses.length ? ` (NOT PINNED: ${unpinnedMisses.length})` : ""}`
      },
      {
        type: "X10 rail and section",
        description:
          sectionProblems.length === 0
            ? "every non-advanced entry is visible without scrolling in 2 gestures"
            : sectionProblems.join("; ")
      },
      { type: "page errors", description: pageErrors.join(" | ") || "none" }
    );
    expect
      .soft(
        outcomes.filter((outcome) => outcome.problem !== null).map((o) => `${o.id}: ${o.problem}`),
        "X10: every entry by search in at most 2 gestures, focused"
      )
      .toEqual([]);
    expect
      .soft(
        sectionProblems,
        "X10: every non-advanced entry by rail and section, visible without scrolling"
      )
      .toEqual([]);
    expect
      .soft(
        unpinnedMisses,
        "X10: a first held-out query that does not list its entry, outside the pinned misses of X9 (the English search regressed)"
      )
      .toEqual([]);
    expect
      .soft(
        noQuery.filter((id) => !entriesWithoutHeldOutQuery.includes(id)),
        "X10: an entry with no held-out query that X9's test does not name"
      )
      .toEqual([]);
    expect.soft(pageErrors, "uncaught errors in the page").toEqual([]);

    await invokeApp(page, "settings.updateApp", { language: "pt-BR", themeMode: "dark" });
    await steps.finish(info);
  } finally {
    await db?.close();
    await session.close();
  }
});
