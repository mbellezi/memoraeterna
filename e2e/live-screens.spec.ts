// Live screens, gate U2 (F5 T137, D1, spec 5.3): the surfaces a UI card lists, opened in the built
// app on a BASE-J clone (or on its empty-library twin) and captured in light and dark at 960 and
// 1440 px, each capture scanned for contrast. The list comes from the file named by
// MEMORA_LIVE_SCREENS (the orchestrator writes it from the cards' reports):
//
//   [{ "id": "destination-home", "keys": ["Meta+1"] },
//    { "id": "note", "address": "memora://note/<uuid>" },
//    { "id": "destination-library", "profile": "empty", "keys": ["Meta+3"] }]
//
// `address` opens an object address the way the system does (`open-url` in main); `keys` are
// pressed in order (a view address is reached through the keymap, never by an external deep link,
// D10); `ready` is a selector to wait for instead of the surface's own `[data-surface=<id>]` frame
// leaving `loading`. Captures go to `.cache/f5/journeys/<run>/live-screens/`.
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { expect, test } from "@playwright/test";
import { z } from "zod";

import {
  captureStep,
  launchMemora,
  setContentSize,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import { cloneProfile, journeysRun, profileDir } from "./support/profile.js";

const screenSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    profile: z.enum(["base", "empty"]).default("base"),
    address: z
      .string()
      .regex(/^memora:\/\/[a-z]+\/[0-9a-f-]{36}/u)
      .optional(),
    keys: z.array(z.string().min(1)).default([]),
    ready: z.string().min(1).optional()
  })
  .strict();
const widths = [960, 1440] as const;

async function readScreens() {
  const path = process.env.MEMORA_LIVE_SCREENS?.trim();
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("MEMORA_LIVE_SCREENS must be an absolute path");
  return z
    .array(screenSchema)
    .min(1)
    .parse(JSON.parse(await readFile(path, "utf8")));
}

async function open(session: MemoraSession, screen: z.infer<typeof screenSchema>) {
  if (screen.address)
    await session.electronApp.evaluate(({ app }, url) => {
      app.emit("open-url", { preventDefault: () => undefined }, url);
    }, screen.address);
  for (const key of screen.keys) await session.page.keyboard.press(key);
  const ready = screen.ready
    ? session.page.locator(screen.ready)
    : session.page.locator(`[data-surface="${screen.id}"]:not([data-state="loading"])`);
  await expect(ready.first()).toBeVisible({ timeout: 60_000 });
}

test("live-screens: the listed surfaces in the built app, both themes, 960 and 1440 px", async () => {
  const screens = await readScreens();
  test.skip(screens === null, "MEMORA_LIVE_SCREENS names no list");
  const run = journeysRun();
  const failures: string[] = [];
  for (const profile of ["base", "empty"] as const) {
    const list = screens!.filter((screen) => screen.profile === profile);
    if (list.length === 0) continue;
    const source = profileDir(run, profile === "base" ? "base" : "base-empty");
    const userDataDir = await cloneProfile(
      source,
      profileDir(run, `live-${profile}`),
      run.repoRoot
    );
    const session = await launchMemora({ run, userDataDir });
    try {
      await waitForDatabase(session.page, 180_000);
      let index = 0;
      for (const screen of list)
        for (const width of widths) {
          index += 1;
          await setContentSize(session, width);
          await open(session, screen);
          const record = await captureStep(session, "live-screens", index, `${screen.id}-${width}`);
          for (const theme of ["light", "dark"] as const)
            for (const failure of record.contrast[theme].failures)
              failures.push(
                `${screen.id} ${width} ${theme}: "${failure.text}" ${failure.ratio}:1 < ${failure.required}:1`
              );
        }
    } finally {
      await session.close();
    }
  }
  test.info().annotations.push({ type: "contrast failures", description: String(failures.length) });
  expect(failures).toEqual([]);
});
