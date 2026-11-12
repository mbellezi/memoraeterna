// J-idle (F5 T154, spec 5.2 bar X4(b) and 5.3): the built app on a BASE-J clone holds still. For each of
// the five destinations and Settings, in rail order, the window is left alone for 60 s, and the IPC
// trace of main (`MEMORA_IPC_TRACE=1`, `support/ipc-trace.ts`) must hold no invocation that a bus event
// or a gesture did not cause: an invocation is caused when a bus event reached the renderer, or a
// gesture was made, within the 1,000 ms before it (`uncausedInvocations`). A poll, a timer that asks
// main for something, shows up here as an invocation nobody caused. The bar is 0.
//
// How a window is read:
//   - the place is reached by its key (Cmd-1..5, Cmd-,), a gesture, and the step is captured in both
//     themes with the contrast scan (X12, 0 failures: collected with soft expectations, so every place
//     is walked before the spec fails);
//   - the window then settles for `settleMs` (the surface's own reads, the theme switch's effects),
//     the trace is cleared and the 60 s start;
//   - the renderer listens to every bus event type from the start (a recorder installed with
//     `page.evaluate`, which stamps each event with `Date.now()`, the clock main's trace uses too);
//   - Knowledge controls are paused on a BASE-J clone: no background work starts by itself.
// A place whose surface never leaves `loading` is a failure of the journey, not an idle window.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { AppEventType } from "../apps/desktop/src/shared/app-events";
import {
  captureStep,
  openClone,
  setContentSize,
  setTheme,
  waitForDatabase
} from "./support/app.js";
import { installGestureCounter, readGestures } from "./support/gestures.js";
import { clearIpcTrace, readIpcTrace, uncausedInvocations } from "./support/ipc-trace.js";
import { journeysRun } from "./support/profile.js";
import { pressShortcut } from "./support/shortcuts.js";

/** How long each place is left alone (X4(b)). */
export const idleWindowMs = 60_000;
/** The invocation is caused when a cause came at most this long before it (X4(b)). */
export const causeWindowMs = 1_000;
/** After a place opens and is captured: its reads and the theme switch's effects finish. */
const settleMs = 4_000;

/** Every type on the bus (`S/app-events.ts`). A type added to the bus fails the typecheck here. */
const busTypes = Object.keys({
  "job.progress": true,
  "inbox.changed": true,
  "gardener.status": true,
  "model.download": true,
  "tree.changed": true,
  "relation.created": true,
  "budget.changed": true,
  "changes.changed": true,
  "overview.changed": true,
  "consultation.status": true,
  "consultation.delta": true,
  "object.changed": true,
  "view.changed": true,
  "settings.changed": true,
  "database.status": true,
  "model.loading": true,
  "obsidian.sync": true,
  "obsidian.projection": true,
  "monitoring.changed": true,
  "explanation.delta": true,
  "import.progress": true
} satisfies Record<AppEventType, true>);

interface Place {
  id: string;
  /** The key that reaches it (Cmd-1..5 in rail order, Cmd-, for Settings). */
  key: string;
  /** The root surface the frame reports, or null for Settings (the rail marks it current). */
  surface: string | null;
}

const places: readonly Place[] = [
  { id: "home", key: "Meta+1", surface: "destination-home" },
  { id: "explore", key: "Meta+2", surface: "destination-explore" },
  { id: "library", key: "Meta+3", surface: "destination-library" },
  { id: "inbox", key: "Meta+4", surface: "destination-inbox" },
  { id: "map", key: "Meta+5", surface: "destination-map" },
  { id: "settings", key: "Meta+,", surface: null }
];

/** The rail button of Settings carries Cmd-, as its key shortcut; it is the current place when open. */
const settingsCurrent = '[data-surface="rail"] [aria-keyshortcuts="Meta+,"][aria-current="page"]';

interface BusEvent {
  type: string;
  at: number;
}

/** Listens to every bus type in the renderer; each event is stamped with `Date.now()`. */
async function recordBus(page: Page): Promise<void> {
  await page.evaluate((types) => {
    const scope = window as unknown as {
      app: { onAppEvent(type: string, handler: () => void): () => void };
      __journeyBus?: { type: string; at: number }[];
    };
    const seen: { type: string; at: number }[] = [];
    scope.__journeyBus = seen;
    for (const type of types) scope.app.onAppEvent(type, () => seen.push({ type, at: Date.now() }));
  }, busTypes);
}

async function readBus(page: Page): Promise<BusEvent[]> {
  return page.evaluate(() => [
    ...((window as unknown as { __journeyBus?: BusEvent[] }).__journeyBus ?? [])
  ]);
}

interface WindowReport {
  place: string;
  /** Invocations main saw in the window. */
  invocations: number;
  /** The bus events the renderer heard in the window. */
  busEvents: number;
  /** Invocations no cause explains, by channel (the bar is none). */
  uncaused: { channel: string; atMs: number }[];
  /** Ring entries lost (a window of 60 s never fills 10,000). */
  dropped: number;
  contrast: { light: number; dark: number; unverifiable: number };
}

test("J-idle: 60 s idle in each destination and Settings, no invocation without a cause", async () => {
  test.setTimeout(30 * 60_000);
  const run = journeysRun();
  const session = await openClone(run, "j-idle");
  const { page, electronApp } = session;
  const reports: WindowReport[] = [];
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1280, 800);
    await expect(page.locator('[data-surface="shell"]').first()).toBeVisible({ timeout: 60_000 });
    // The trace must be on, or the journey proves nothing.
    expect(await readIpcTrace(electronApp), "MEMORA_IPC_TRACE is not recording").not.toBeNull();
    await recordBus(page);
    await installGestureCounter(page);

    const gestureTimes: number[] = [];
    let index = 0;
    for (const place of places) {
      index += 1;
      gestureTimes.push(Date.now());
      await pressShortcut(session, place.key);
      if (place.surface)
        await expect(
          page.locator(`[data-surface="${place.surface}"]:not([data-state="loading"])`).first(),
          `${place.id} never left loading`
        ).toBeVisible({ timeout: 60_000 });
      else await expect(page.locator(settingsCurrent)).toBeVisible({ timeout: 60_000 });

      const step = await captureStep(session, "j-idle", index, place.id);
      // Settings is J7's (T174): its contrast is recorded here, never asserted.
      if (place.surface !== null)
        for (const theme of ["light", "dark"] as const)
          expect
            .soft(
              step.contrast[theme].failures.map(
                (f) => `"${f.text}" ${f.ratio}:1 < ${f.required}:1`
              ),
              `${place.id} ${theme} contrast (X12)`
            )
            .toEqual([]);
      // Back to the system's own theme before the window: the capture left the app in dark.
      await setTheme(session, "light");
      await page.waitForTimeout(settleMs);

      const cleared = await clearIpcTrace(electronApp);
      expect(cleared, "the IPC trace cannot be cleared").toBe(true);
      const startedAt = Date.now();
      const gesturesBefore = (await readGestures(page)).total;
      await page.waitForTimeout(idleWindowMs);
      const after = await readGestures(page);
      const gesturesAfter = after.total;
      const trace = await readIpcTrace(electronApp);
      const bus = (await readBus(page)).filter((event) => event.at >= startedAt - causeWindowMs);
      expect(trace, "the trace went away").not.toBeNull();
      const entries = (trace?.entries ?? []).filter((entry) => entry.at >= startedAt);
      const causes = [...gestureTimes, ...bus.map((event) => event.at)];
      const uncaused = uncausedInvocations(entries, causes, causeWindowMs);
      reports.push({
        place: place.id,
        invocations: entries.length,
        busEvents: bus.filter((event) => event.at >= startedAt).length,
        uncaused: uncaused.map((entry) => ({
          channel: entry.channel,
          atMs: entry.at - startedAt
        })),
        dropped: trace?.dropped ?? 0,
        contrast: {
          light: step.contrast.light.failures.length,
          dark: step.contrast.dark.failures.length,
          unverifiable: step.contrast.light.unverifiable.length
        }
      });
      // No input in the window: the person did nothing, so no gesture can explain an invocation.
      expect
        .soft(
          gesturesAfter,
          `${place.id}: a gesture reached the window (${JSON.stringify(after.log.slice(-3))})`
        )
        .toBe(gesturesBefore);
    }
  } finally {
    const evidence = join(run.evidenceDir, "j-idle");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "report.json"),
      `${JSON.stringify({ bar: { uncaused: 0, windowMs: idleWindowMs, causeMs: causeWindowMs }, reports }, null, 2)}\n`
    );
    await session.close();
  }

  const total = reports.reduce((sum, report) => sum + report.uncaused.length, 0);
  test.info().annotations.push(
    {
      type: "invocations",
      description: reports
        .map((report) => `${report.place} ${report.invocations} (${report.busEvents} bus)`)
        .join(", ")
    },
    { type: "uncaused", description: String(total) }
  );
  for (const report of reports)
    expect
      .soft(
        report.uncaused,
        `${report.place}: invocations with no bus event or gesture in the ${causeWindowMs} ms before`
      )
      .toEqual([]);
  expect(reports).toHaveLength(places.length);
});
