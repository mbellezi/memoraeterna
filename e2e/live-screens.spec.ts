// Live screens, gate U2 (F5 T137, D1, spec 5.3): the surfaces a UI card lists, opened in the built
// app and captured in light and dark at 960 and 1440 px, each capture scanned for contrast. The list
// comes from the file named by MEMORA_LIVE_SCREENS (the orchestrator writes it from the cards'
// reports):
//
//   [{ "id": "destination-home", "keys": ["Meta+1"] },
//    { "id": "note", "address": "memora://note/<uuid>" },
//    { "id": "destination-library", "profile": "empty", "keys": ["Meta+3"] },
//    { "id": "onboarding", "profile": "first-run" }]
//
// `profile` (`support/live-screens.ts`): `base` a BASE-J clone, `empty` its empty-library twin,
// `first-run` a new, never-onboarded userData. Each surface runs in its own session, opened once and
// resized between widths. `address` opens an object address the way the system does (`open-url` in
// main); `keys` are pressed in order (a view address is reached through the keymap, never by an
// external deep link, D10); `ready` is a selector to wait for instead of the surface's own
// `[data-surface=<id>]` frame leaving `loading`. Captures go to
// `.cache/f5/journeys/<run>/live-screens/`.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { expect, test } from "@playwright/test";

import {
  captureStep,
  launchMemora,
  setContentSize,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import {
  liveScreenListSchema,
  liveScreenSessions,
  type LiveScreen
} from "./support/live-screens.js";
import { cloneProfile, emptyProfile, journeysRun, profileDir } from "./support/profile.js";

async function readScreens() {
  const path = process.env.MEMORA_LIVE_SCREENS?.trim();
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("MEMORA_LIVE_SCREENS must be an absolute path");
  return liveScreenListSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

function readyLocator(session: MemoraSession, screen: LiveScreen) {
  return screen.ready
    ? session.page.locator(screen.ready)
    : session.page.locator(`[data-surface="${screen.id}"]:not([data-state="loading"])`);
}

/** Opens the surface once: its address, then its keys. */
async function open(session: MemoraSession, screen: LiveScreen) {
  if (screen.address)
    await session.electronApp.evaluate(({ app }, url) => {
      app.emit("open-url", { preventDefault: () => undefined }, url);
    }, screen.address);
  for (const key of screen.keys) await session.page.keyboard.press(key);
  await expect(readyLocator(session, screen).first()).toBeVisible({ timeout: 60_000 });
}

test("live-screens: the listed surfaces in the built app, both themes, 960 and 1440 px", async () => {
  const screens = await readScreens();
  test.skip(screens === null, "MEMORA_LIVE_SCREENS names no list");
  const run = journeysRun();
  const failures: string[] = [];
  for (const plan of liveScreenSessions(screens!)) {
    const target = profileDir(run, plan.profileName);
    const userDataDir =
      plan.source === null
        ? await emptyProfile(target, run.repoRoot)
        : await cloneProfile(profileDir(run, plan.source), target, run.repoRoot);
    const session = await launchMemora({ run, userDataDir });
    try {
      await waitForDatabase(session.page, 180_000);
      for (const [position, capture] of plan.captures.entries()) {
        await setContentSize(session, capture.width);
        if (position === 0) await open(session, plan.screen);
        else await expect(readyLocator(session, plan.screen).first()).toBeVisible();
        const step = `${plan.screen.id}-${capture.width}`;
        const record = await captureStep(session, "live-screens", capture.index, step);
        for (const theme of ["light", "dark"] as const)
          for (const failure of record.contrast[theme].failures)
            failures.push(
              `${step} ${theme}: "${failure.text}" ${failure.ratio}:1 < ${failure.required}:1`
            );
      }
    } finally {
      await session.close();
    }
  }
  test.info().annotations.push({ type: "contrast failures", description: String(failures.length) });
  expect(failures).toEqual([]);
});
