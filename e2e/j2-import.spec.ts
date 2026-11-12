// J2 import to tree (F5 T154, spec 5.3, bar X1 and amendment A7): a person adds FR2's second source
// (`wikibooks-en-memory-and-language`) to a BASE-J clone through Add.
//
//   Cmd-N -> the stubbed picker answers the file (a native dialog cannot be driven; the renderer
//   still gets only an opaque token) -> the Source is pushed onto Explore's stack at once, with no
//   confirm step and no toast (A7) -> the panel lists the notes as they are made, each with its path
//   chip -> the Activity pill goes from running to done.
//
// X1 is counted by the gesture counter (`support/gestures.ts`) installed in the renderer: from the
// file choice (the picker returning is no gesture) until a note row whose `[data-path-chip]` is the
// path of `objects.locate(primary)` is on screen. The bar is 2 or fewer; the count from Cmd-N (which
// is one gesture more) is reported. Every AI call is served by the cassette `firstrun-hybrid-f4`; a
// miss fails the journey and names the task types (the orchestrator then records `journeys-f5`, R4).
//
// The path chip carries the titles of the crumbs (`data-path`), not their addresses, so the chip is
// compared with the titles of the topics of `objects.locate(primary)`; the ribbon of the Note panel
// (J3) carries the addresses.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  captureStep,
  cassetteMisses,
  defaultCassette,
  followSystemTheme,
  goldenSource,
  invokeApp,
  openClone,
  secondSourceKey,
  setContentSize,
  stepFailures,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import { stubOpenDialog } from "./support/dialog.js";
import {
  countRows,
  newestSourceSummary,
  openProfileDb,
  waitForSettled,
  type ProfileDb
} from "./support/db.js";
import { installGestureCounter, readGestures, resetGestures } from "./support/gestures.js";
import { journeysRun } from "./support/profile.js";
import { pressShortcut } from "./support/shortcuts.js";

/** The bar of X1: gestures from the file choice to the first note with its path. */
export const x1Bar = 2;

interface Ref {
  kind: string;
  id: string;
  title: string;
}
interface Located {
  object: Ref;
  primaryPath: Ref[];
}

/** The titles of the topics of a located note's primary path, as the chip shows them. */
export function chipTitles(located: Located): string[] {
  return located.primaryPath
    .filter(
      (ref, index) =>
        ref.kind === "topic" &&
        !(ref.kind === located.object.kind && ref.id === located.object.id) &&
        !(index === 0 && ref.title === "")
    )
    .map((ref) => ref.title);
}

/** The bus recorder: job progress (what the Activity pill reads) with the time of each event. */
async function recordJobs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as {
      app: { onAppEvent(type: string, handler: (event: unknown) => void): () => void };
      __journeyJobs?: { at: number; active: number }[];
    };
    const seen: { at: number; active: number }[] = [];
    scope.__journeyJobs = seen;
    scope.app.onAppEvent("job.progress", (event) => {
      const lanes = (event as { lanes?: Record<string, { running: number; queued: number }> })
        .lanes;
      const active = Object.values(lanes ?? {}).reduce(
        (sum, lane) => sum + lane.running + lane.queued,
        0
      );
      seen.push({ at: Date.now(), active });
    });
  });
}

async function jobs(page: Page): Promise<{ at: number; active: number }[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __journeyJobs?: { at: number; active: number }[] }).__journeyJobs ??
      [])
  ]);
}

/** The glyph the Activity pill draws, as it names it in `data-glyph`; null while there is no pill. */
async function pillGlyph(page: Page): Promise<string | null> {
  const pill = page.locator('[data-status] [data-fit="pill"]').first();
  if ((await pill.count()) === 0) return null;
  // The pill names the glyph it draws: working (the running ring), check, waiting, attention, error, loading.
  return pill.getAttribute("data-glyph");
}

/** One step in both themes, contrast scanned (X12, soft: every step is walked); leaves the dark theme. */
async function captureAndCheck(session: MemoraSession, index: number, step: string) {
  const record = await captureStep(session, "j2", index, step);
  // X12: each scan drawn in the theme it was asked for, and no contrast failure in either.
  expect.soft(stepFailures(record), `${step} (X12)`).toEqual([]);
}

/** The note rows of the top Source panel that already show their path. */
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

test("J2 import to tree: Add through Cmd-N pushes the Source at once and its notes show their path (X1)", async () => {
  test.setTimeout(75 * 60_000);
  const run = journeysRun();
  const cassetteDir = join(run.scratchDir, "cassettes", defaultCassette);
  const missesBefore = await cassetteMisses(cassetteDir);
  const session = await openClone(run, "j2");
  const { page } = session;
  let db: ProfileDb | null = null;
  let report: Record<string, unknown> = {};
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1440, 900);
    await expect(page.locator('[data-surface="shell"]').first()).toBeVisible({ timeout: 60_000 });
    // Dark is the default (Q39): the app is made to follow the window's scheme, so every scan is drawn
    // in the theme setTheme asks for and none depends on the default or on what the profile stored.
    // Asked once the shell is up: the app has loaded its settings and follows a change made outside it.
    await followSystemTheme(session);
    db = await openProfileDb(session.userDataDir);
    const sourcesBefore = await db.query<{ id: string }>("select id::text as id from source_items");
    const [failedRow] = await db.query<{ failed: number }>(
      "select count(*)::int as failed from jobs where status::text = 'failed'"
    );
    const failedBefore = failedRow?.failed ?? 0;
    // A clone starts paused: the knowledge work that follows the import runs, and only this one.
    await invokeApp(page, "knowledgeControls.update", { paused: false, autonomy: "auto" });
    await recordJobs(page);
    await installGestureCounter(page);

    // The file picker answers the second source with no window.
    const file = await goldenSource(run.repoRoot, secondSourceKey);
    await stubOpenDialog(session.electronApp, [file.path]);

    // Home, where a person starts each day: Add pushes the Source onto Explore from here.
    await pressShortcut(session, "Meta+1");
    await expect(
      page.locator('[data-surface="destination-home"]:not([data-state="loading"])').first()
    ).toBeVisible({ timeout: 60_000 });
    await resetGestures(page);
    const importedAt = Date.now();
    await pressShortcut(session, "Meta+N");

    // The Source is on screen at once, on Explore, with no confirm step and no toast.
    const sourcePanel = page.locator('[data-surface="source"][data-panel-top]');
    await expect(sourcePanel).toBeVisible({ timeout: 120_000 });
    const pushedAfterMs = Date.now() - importedAt;
    await expect(
      page.locator('[data-surface="rail"] [aria-keyshortcuts="Meta+2"][aria-current="page"]'),
      "Add did not take the person to Explore"
    ).toBeVisible();
    const gesturesAtPush = (await readGestures(page)).total;
    expect(gesturesAtPush, "the Source needed more than Cmd-N").toBe(1);
    // A7: the toast viewport renders only while a toast is up; look again a moment later for a late one.
    await expect(page.locator("[data-toast-viewport]")).toHaveCount(0);
    await page.waitForTimeout(1_500);
    await expect(
      page.locator("[data-toast-viewport]"),
      "a toast arrived after the push"
    ).toHaveCount(0);
    const afterImport = await db.query<{ id: string }>("select id::text as id from source_items");
    const known = new Set(sourcesBefore.map((row) => row.id));
    const added = afterImport.filter((row) => !known.has(row.id));
    expect(added, "the import stored no new source").not.toHaveLength(0);
    // While the import's jobs are active the pill draws the running ring.
    await expect
      .poll(() => pillGlyph(page), {
        message: "the Activity pill never drew the running ring while the import worked",
        timeout: 60_000
      })
      .toBe("working");
    await captureAndCheck(session, 1, "source-pushed");

    // The first note with its path: X1's end. The chip equals objects.locate(primary).
    const firstRow = await waitForPlacedRow(
      page,
      db,
      cassetteDir,
      { failed: failedBefore, misses: missesBefore.total },
      30 * 60_000
    );
    const gestures = await readGestures(page);
    const noteAddress = await firstRow.locator("button[data-address]").getAttribute("data-address");
    expect(noteAddress).toMatch(/^memora:\/\/note\//u);
    const chip = (await firstRow.locator("[data-path-chip]").getAttribute("data-path")) ?? "";
    const located = await invokeApp<Located | null>(page, "objects.locate", {
      address: noteAddress
    });
    expect(located, "objects.locate found no note for the row").not.toBeNull();
    const expected = chipTitles(located!);
    expect(expected.length, "the located note has no topic path").toBeGreaterThan(0);
    expect(chip, "the chip differs from objects.locate (primary)").toBe(expected.join(" › "));
    const fromFileChoice = gestures.total - 1;
    test.info().annotations.push(
      {
        type: "X1",
        description: `${fromFileChoice} gestures from the file choice (bar ${x1Bar})`
      },
      { type: "from Cmd-N", description: `${gestures.total}: ${JSON.stringify(gestures.log)}` },
      { type: "source pushed", description: `${pushedAfterMs} ms after Cmd-N` }
    );
    expect(fromFileChoice, "X1: gestures from the file choice").toBeLessThanOrEqual(x1Bar);
    await captureAndCheck(session, 2, "first-note-with-path");

    // The work behind it settles; the pill went from running to done.
    const settled = await waitForSettled(db, { timeoutMs: 60 * 60_000 });
    await expect
      .poll(async () => (await jobs(page)).at(-1)?.active ?? -1, { timeout: 60_000 })
      .toBe(0);
    await expect
      .poll(() => pillGlyph(page), {
        message: "the Activity pill did not draw the check once the work settled",
        timeout: 60_000
      })
      .toBe("check");
    const events = await jobs(page);
    const sawRunning = events.some((event) => event.active > 0);
    expect(sawRunning, "the bus never reported work in the import").toBe(true);
    const notes = await countRows(db, "atomic_notes");
    await invokeApp(page, "knowledgeControls.update", { paused: true, autonomy: "off" });

    // Every AI call came from the cassette.
    const missesAfter = await cassetteMisses(cassetteDir);
    const missed = missesAfter.total - missesBefore.total;
    report = {
      x1: { fromFileChoice, fromCmdN: gestures.total, bar: x1Bar, log: gestures.log },
      pushedAfterMs,
      chip,
      notes,
      pill: { running: "working", done: "check" },
      jobEvents: events.length,
      setAside: settled.setAside,
      misses: { count: missed, byTask: missesAfter.byTask }
    };
    expect(
      missed,
      `${defaultCassette} missed ${missed} calls for ${secondSourceKey} ` +
        `(${JSON.stringify(missesAfter.byTask)}): record journeys-f5 (R4)`
    ).toBe(0);
    await captureAndCheck(session, 3, "import-done");
  } finally {
    const evidence = join(run.evidenceDir, "j2");
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    await db?.close();
    await session.close();
  }
});
