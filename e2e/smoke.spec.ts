// J0 smoke (F5 T137, spec 5.3): a clone of BASE-J opens in the built app and shows the shell (the
// workspace shell once T135 merges, the legacy App's navigation before). It also exercises every
// harness part a later journey leans on: the step capture in both themes with its contrast scan,
// the gesture counter, the performance marks and the IPC trace.
import { expect, test } from "@playwright/test";

import { captureStep, openClone, waitForDatabase } from "./support/app.js";
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
