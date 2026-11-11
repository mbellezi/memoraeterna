// J0 smoke (F5 T137, spec 5.3): a clone of BASE-J opens in the built app and shows the shell (the
// workspace shell once T135 merges, the legacy App's navigation before). It also exercises every
// harness part a later journey leans on: the step capture in both themes with its contrast scan,
// the gesture counter, the performance marks and the IPC trace.
//
// J0's second test is the card's [I] check: on another clone, FR2's second source is imported with
// the default plan and every AI call must come from `firstrun-hybrid-f4`. A miss fails it, names the
// task types that missed and means the orchestrator records `journeys-f5` (R4).
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  captureStep,
  cassetteMisses,
  defaultCassette,
  importGoldenSource,
  invokeApp,
  openClone,
  secondSourceKey,
  waitForDatabase
} from "./support/app.js";
import { countRows, openProfileDb, waitForSettled, type ProfileDb } from "./support/db.js";
import { installGestureCounter, readGestures } from "./support/gestures.js";
import { readIpcTrace } from "./support/ipc-trace.js";
import { readMarks } from "./support/perf.js";
import { journeysRun } from "./support/profile.js";

/** The workspace shell's frame (T135) or, before it merges, the legacy App's navigation. */
const shell = '[data-surface="shell"], #app-navigation';

test("J0 smoke: a clone of BASE-J opens and shows the shell", async () => {
  const run = journeysRun();
  const session = await openClone(run, "j0");
  try {
    await waitForDatabase(session.page, 180_000);
    await expect(session.page.locator(shell).first()).toBeVisible({ timeout: 60_000 });
    await installGestureCounter(session.page);

    const step = await captureStep(session, "j0", 1, "shell");
    expect(step.screenshots).toHaveLength(2);
    for (const theme of ["light", "dark"] as const)
      expect(step.contrast[theme].checked).toBeGreaterThan(0);

    // Nothing was clicked or typed: the counter reads zero, whatever the app did on its own.
    expect((await readGestures(session.page)).total).toBe(0);
    expect(Array.isArray(await readMarks(session.page))).toBe(true);
    const trace = await readIpcTrace(session.electronApp);

    // Sticky replay (D16; triage item 14): a window that loads hears the sticky states once. A
    // subscription made before the page's own scripts counts them across a reload; recorded here,
    // asserted by the journey the orchestrator names after T125's dispatcher fix.
    await session.page.addInitScript(() => {
      const scope = window as unknown as Record<string, unknown>;
      const app = scope.app as
        { onAppEvent?: (type: string, handler: () => void) => () => void } | undefined;
      const seen = { database: 0, model: 0 };
      scope.__journeySticky = seen;
      app?.onAppEvent?.("database.status", () => (seen.database += 1));
      app?.onAppEvent?.("model.loading", () => (seen.model += 1));
    });
    await session.page.reload();
    await expect(session.page.locator(shell).first()).toBeVisible({ timeout: 60_000 });
    const sticky = await session.page.evaluate(
      () => (window as unknown as Record<string, unknown>).__journeySticky ?? null
    );

    test.info().annotations.push(
      { type: "sticky replay", description: JSON.stringify(sticky) },
      {
        type: "contrast",
        description: `light ${step.contrast.light.failures.length} and dark ${step.contrast.dark.failures.length} failures (recorded; X12 gates J1-J8)`
      },
      {
        type: "ipc-trace",
        description: trace
          ? `${trace.entries.length} invocations recorded`
          : "off (installed by T171)"
      }
    );
  } finally {
    await session.close();
  }
});

test("J0 second source: firstrun-hybrid-f4 serves FR2's second source on a BASE-J clone", async () => {
  test.setTimeout(75 * 60_000);
  const run = journeysRun();
  // The run's copy of the cassette: BASE-J left no miss there (the setup fails otherwise), and J0's
  // first test calls no AI, so what this test adds is the second source's.
  const cassetteDir = join(run.scratchDir, "cassettes", defaultCassette);
  const before = await cassetteMisses(cassetteDir);
  const session = await openClone(run, "j0-second-source");
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(session.page, 180_000);
    db = await openProfileDb(session.userDataDir);
    const sourcesBefore = await countRows(db, "source_items");
    await invokeApp(session.page, "knowledgeControls.update", { paused: false, autonomy: "auto" });
    await importGoldenSource(session, secondSourceKey);
    const settled = await waitForSettled(db, { timeoutMs: 60 * 60_000 });
    const sourcesAfter = await countRows(db, "source_items");
    await invokeApp(session.page, "knowledgeControls.update", { paused: true, autonomy: "off" });
    const after = await cassetteMisses(cassetteDir);
    const byTask = Object.fromEntries(
      Object.entries(after.byTask)
        .map(([task, count]) => [task, count - (before.byTask[task] ?? 0)] as const)
        .filter(([, count]) => count > 0)
    );
    const missed = after.total - before.total;
    test
      .info()
      .annotations.push(
        { type: "second source misses", description: `${missed} ${JSON.stringify(byTask)}` },
        { type: "left aside", description: JSON.stringify(settled.setAside) }
      );
    expect(sourcesAfter, "the second source was not stored").toBeGreaterThan(sourcesBefore);
    expect(
      missed,
      `${defaultCassette} missed ${missed} calls for ${secondSourceKey} (${JSON.stringify(byTask)}): ` +
        "record journeys-f5 (R4)"
    ).toBe(0);
  } finally {
    await db?.close();
    await session.close();
  }
});
