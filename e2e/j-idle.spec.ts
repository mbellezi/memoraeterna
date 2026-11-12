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
// A place whose surface never leaves `loading`, or rests in `error` (or `empty`, but for the Inbox), is a
// failure of the journey, not an idle window: a poller lives in the success list, so only a loaded
// place proves anything. The report records the state each place measured.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import type { AppEventType } from "../apps/desktop/src/shared/app-events";
import {
  captureStep,
  followSystemTheme,
  openClone,
  setContentSize,
  setTheme,
  stepFailures,
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
  /** The root surface the frame reports. */
  surface: string;
  /** Another loaded state the place may rest in on BASE-J (an empty Inbox is a place at rest); success is the rule. */
  alsoLoaded?: "empty";
}

const places: readonly Place[] = [
  { id: "home", key: "Meta+1", surface: "destination-home" },
  { id: "explore", key: "Meta+2", surface: "destination-explore" },
  { id: "library", key: "Meta+3", surface: "destination-library" },
  { id: "inbox", key: "Meta+4", surface: "destination-inbox", alsoLoaded: "empty" },
  { id: "map", key: "Meta+5", surface: "destination-map" },
  { id: "settings", key: "Meta+,", surface: "settings" }
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
  /** The state the place rested in (the frame's `data-state`). */
  state: string;
  /** Invocations main saw from the place's own load (the positive control: the trace records). */
  loadInvocations: number;
  /** The bus events the renderer heard in the window. */
  busEvents: number;
  /** Invocations no cause explains, by channel (the bar is none). */
  uncaused: { channel: string; atMs: number }[];
  /** Ring entries lost (a window of 60 s never fills 10,000). */
  dropped: number;
  contrast: {
    light: number;
    dark: number;
    unverifiable: number;
    /** The theme each scan was drawn in (the guard fails a "light" scan drawn dark). */
    drawn: { light: string | undefined; dark: string | undefined };
  };
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
    // Dark is the default (Q39): the app is made to follow the window's scheme, so every scan is drawn
    // in the theme setTheme asks for and none depends on the default or on what the profile stored.
    // Asked once the shell is up: the app has loaded its settings and follows a change made outside it.
    await followSystemTheme(session);
    // The trace must be on, or the journey proves nothing.
    expect(await readIpcTrace(electronApp), "MEMORA_IPC_TRACE is not recording").not.toBeNull();
    await recordBus(page);
    await installGestureCounter(page);
    // The positive control below counts the first place's own load: the theme setup is not part of it.
    expect(await clearIpcTrace(electronApp), "the IPC trace cannot be cleared").toBe(true);

    const gestureTimes: number[] = [];
    let index = 0;
    for (const place of places) {
      index += 1;
      gestureTimes.push(Date.now());
      await pressShortcut(session, place.key);
      const surface = page.locator(`[data-surface="${place.surface}"]`).first();
      await expect(surface, `${place.id} never left loading`).not.toHaveAttribute(
        "data-state",
        "loading",
        { timeout: 60_000 }
      );
      // An error or empty place has no poller to catch: only a loaded place is an idle window.
      const state = (await surface.getAttribute("data-state")) ?? "";
      expect(
        ["success", place.alsoLoaded].includes(state as never),
        `${place.id} rested in "${state}", not a loaded state: its idle window would prove nothing`
      ).toBe(true);
      // The place is on screen (Settings' frame is mounted hidden while it is not the place).
      await expect(surface, `${place.id} is not on screen`).toBeVisible();
      if (place.id === "settings") await expect(page.locator(settingsCurrent)).toBeVisible();

      const step = await captureStep(session, "j-idle", index, place.id);
      // X12: each scan drawn in the theme it was asked for, and no contrast failure. Settings' contrast
      // is J7's (T174): recorded here, never asserted; its scans must still be drawn as asked.
      const failures = stepFailures(step);
      expect
        .soft(
          place.id === "settings"
            ? failures.filter((failure) => failure.includes(": the page was drawn in "))
            : failures,
          `${place.id} (X12)`
        )
        .toEqual([]);
      // The window rests in the product's default theme, dark (Q39), set explicitly, never left to
      // whatever the capture scanned last.
      await setTheme(session, "dark");
      await page.waitForTimeout(settleMs);

      // Positive control: the place's own load went through the trace, so a silent window is a real 0.
      const loadInvocations = ((await readIpcTrace(electronApp))?.entries ?? []).length;
      if (index === 1)
        expect(
          loadInvocations,
          "the trace saw nothing of the first place's own load"
        ).toBeGreaterThan(0);
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
        state,
        loadInvocations,
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
          unverifiable:
            step.contrast.light.unverifiable.length + step.contrast.dark.unverifiable.length,
          drawn: { light: step.contrast.light.drawnTheme, dark: step.contrast.dark.drawnTheme }
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
