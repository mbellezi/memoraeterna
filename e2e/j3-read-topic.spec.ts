// J3 read topic (F5 T154, spec 5.3 and bar X2): the person reads the tree and the path shows itself.
//
// Test 1, the walk: Explore -> a topic row of the navigator -> the Topic panel (overview, members) -> a
// member note pushed beside it; then back: Option-click on a crumb of the Note panel replaces the
// note in its own panel (history of two), Cmd-[ returns to the note within the panel, and Cmd-[ at the
// start of the panel closes it. The workspace state the app keeps (`memora.workspace.v1`) says what
// each key did; the DOM says what is on screen.
//
// Test 2, X2: one object of each of the five kinds (a source, a note below level 1 of the tree, a
// topic, an entity and a question) is opened by a deep link and then by Cmd-K; with 0 gestures after
// the panel is up, the ribbon's segment addresses (`[data-segment]` of `[data-path-ribbon]`) must equal
// the topics of `objects.locate(primary)` (a note below level 1 shows at least two segments). The
// Question is the one object BASE-J lacks: it is asked once, through `questions.ask`, with the DEV
// fake remote answering (no provider is called).
//
// Selectors are the surfaces' data attributes (`data-surface`, `data-state`, `data-panel-top`,
// `data-path-ribbon`, `data-segment`, `data-nav-key`, `data-palette-row`, `data-quick-look`). The
// Topic panel's member rows carry none: they are found by their kind glyph's token class.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { currentNoteSql } from "@app/db";
import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  captureStep,
  followSystemTheme,
  invokeApp,
  journeysWriterConfigId,
  openClone,
  setContentSize,
  stepFailures,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import { openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter, readGestures, resetGestures } from "./support/gestures.js";
import { pathMustShow, ribbonFailures } from "./support/path-ribbon.js";
import { journeysRun } from "./support/profile.js";
import { pressShortcut } from "./support/shortcuts.js";

const workspaceKey = "memora.workspace.v1";
const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

type Kind = "source" | "note" | "topic" | "entity" | "question";
const kinds: readonly Kind[] = ["source", "note", "topic", "entity", "question"];

interface Ref {
  kind: Kind;
  id: string;
  title: string;
}
interface Located {
  object: Ref;
  primaryPath: Ref[];
  alsoIn: Ref[];
  counts: Record<string, number>;
}

/** The topics of an object's primary path that the ribbon shows as crumbs (the rule of the design record 9). */
export function expectedSegments(located: Located): string[] {
  return located.primaryPath
    .filter(
      (ref, index) =>
        ref.kind === "topic" &&
        !(ref.kind === located.object.kind && ref.id === located.object.id) &&
        !(index === 0 && ref.title === "")
    )
    .map((ref) => `memora://topic/${ref.id}`);
}

const address = (kind: Kind, id: string) => `memora://${kind}/${id}`;

interface PersistedPanel {
  id: string;
  history: string[];
  index: number;
}
interface PersistedStack {
  root: string;
  panels: PersistedPanel[];
  focus: number;
}
interface Persisted {
  destination: string;
  stacks: Record<string, PersistedStack>;
}

/** The workspace state the app persisted (it saves within 500 ms of a change). */
async function readWorkspace(page: Page): Promise<Persisted | null> {
  return page.evaluate((key) => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Persisted) : null;
    } catch {
      return null;
    }
  }, workspaceKey);
}

async function exploreStack(page: Page): Promise<PersistedStack> {
  const state = await readWorkspace(page);
  const stack = state?.stacks.explore;
  if (!stack) throw new Error("The workspace state holds no Explore stack");
  return stack;
}

/** Waits until the persisted Explore stack satisfies `check` (the save is debounced). */
async function untilStack(page: Page, what: string, check: (stack: PersistedStack) => boolean) {
  await expect
    .poll(async () => check(await exploreStack(page)), { message: what, timeout: 15_000 })
    .toBe(true);
}

const topPanel = (page: Page, kind: Kind): Locator =>
  page.locator(`[data-surface="${kind}"][data-panel-top]`);

/** A panel is up when its own frame says it succeeded (an error or an empty page is a failure here). */
async function expectPanelUp(page: Page, kind: Kind): Promise<Locator> {
  const panel = topPanel(page, kind);
  await expect(panel, `the ${kind} panel did not reach success`).toHaveAttribute(
    "data-state",
    "success",
    { timeout: 60_000 }
  );
  return panel;
}

/** The segment addresses the panel's ribbon shows, once the ribbon has left loading. */
async function ribbonOf(panel: Locator): Promise<{ state: string; segments: string[] }> {
  const ribbon = panel.locator("[data-path-ribbon]").first();
  await expect(ribbon).not.toHaveAttribute("data-ribbon-state", "loading", { timeout: 30_000 });
  const state = (await ribbon.getAttribute("data-ribbon-state")) ?? "";
  const segments = await ribbon
    .locator("[data-segment]")
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-segment") ?? ""));
  return { state, segments };
}

async function locate(page: Page, target: string): Promise<Located | null> {
  return invokeApp<Located | null>(page, "objects.locate", { address: target });
}

/** Soft contrast check of a step in both themes; the app is left in the dark theme (scanned last). */
async function captureAndCheck(session: MemoraSession, spec: string, index: number, step: string) {
  const record = await captureStep(session, spec, index, step);
  // X12: each scan drawn in the theme it was asked for, and no contrast failure in either.
  expect.soft(stepFailures(record), `${step} (X12)`).toEqual([]);
}

/**
 * A note of BASE-J below level 1 of the tree: its crumbs are at least two. The first such note in
 * the order of the store (a fixed pick on a fixed profile). When the tree has none, the note with
 * the longest path stands in and `belowLevelOne` is false: the journey then fails X2's clause
 * (soft), since the inference that BASE-J's tree is deeper than one level was wrong.
 */
async function noteBelowLevelOne(
  page: Page,
  db: ProfileDb
): Promise<{ note: Ref; located: Located; segments: string[]; belowLevelOne: boolean }> {
  const notes = await db.query<{ id: string; title: string }>(
    `select n.id::text as id, n.title from atomic_notes n
      where n.title is not null and ${currentNoteSql("n")} order by n.id limit 400`
  );
  let best: { note: Ref; located: Located; segments: string[] } | null = null;
  for (const note of notes) {
    const located = await locate(page, address("note", note.id));
    if (!located) continue;
    const segments = expectedSegments(located);
    const found = {
      note: { kind: "note" as const, id: note.id, title: note.title },
      located,
      segments
    };
    if (segments.length >= 2) return { ...found, belowLevelOne: true };
    if (!best || segments.length > best.segments.length) best = found;
  }
  if (!best || best.segments.length === 0)
    throw new Error(`BASE-J has no note with a place in the tree among ${notes.length}`);
  return { ...best, belowLevelOne: false };
}

async function openedByDeepLink(session: MemoraSession, target: string) {
  await session.electronApp.evaluate(({ app }, url) => {
    app.emit("open-url", { preventDefault: () => undefined }, url);
  }, target);
}

test("J3 read topic: a navigator topic, its member note beside it, back within the panel, back closes it", async () => {
  test.setTimeout(30 * 60_000);
  const run = journeysRun();
  const session = await openClone(run, "j3");
  const { page } = session;
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(page, 180_000);
    // Dark is the default (Q39): the app is made to follow the window's scheme, so every scan is drawn
    // in the theme setTheme asks for and none depends on the default or on what the profile stored.
    await followSystemTheme(session);
    await setContentSize(session, 1440, 900);
    await expect(page.locator('[data-surface="shell"]').first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(session.userDataDir);
    const { segments } = await noteBelowLevelOne(page, db);
    const topicId = segments[segments.length - 1]!.split("/").pop()!;
    const ancestors = segments.slice(0, -1).map((segment) => segment.split("/").pop()!);
    await installGestureCounter(page);

    // Explore, the navigator showing the tree.
    await pressShortcut(session, "Meta+2");
    await expect(
      page.locator('[data-surface="destination-explore"]:not([data-state="loading"])').first()
    ).toBeVisible({ timeout: 60_000 });
    const navigator = page.locator('[data-region="navigator"]');
    await expect(navigator.locator('[role="treeitem"]').first()).toBeVisible({ timeout: 60_000 });

    // The branch is opened with the keyboard (Right opens a branch without opening its page).
    for (const ancestor of ancestors) {
      const row = navigator.locator(`[role="treeitem"][data-nav-key="t:${ancestor}"]`);
      await expect(row).toBeVisible({ timeout: 30_000 });
      if ((await row.getAttribute("aria-expanded")) === "false") {
        await row.focus();
        await page.keyboard.press("ArrowRight");
        await expect(row).toHaveAttribute("aria-expanded", "true");
      }
    }
    const row = navigator.locator(`[role="treeitem"][data-nav-key="t:${topicId}"]`);
    await expect(row).toBeVisible({ timeout: 30_000 });
    const before = (await exploreStack(page)).panels.length;
    await row.click();

    // The Topic panel: its overview and its members.
    const topic = await expectPanelUp(page, "topic");
    await untilStack(
      page,
      "the Topic panel is on the stack",
      (s) => s.panels.length === before + 1
    );
    const topicPage = await invokeApp<{ overview?: { status?: string } } | null>(
      page,
      "topics.page",
      { id: topicId }
    ).catch(() => null);
    test
      .info()
      .annotations.push({ type: "overview", description: topicPage?.overview?.status ?? "unread" });
    // The overview region stands in the panel in whichever of its states (ready, absent, writing).
    await expect(
      topic.locator("section[aria-busy][aria-labelledby]").first(),
      "the Topic panel has no overview region"
    ).toBeVisible({ timeout: 30_000 });
    const members = topic.locator("button:has(svg.text-object-note)");
    await expect(members.first(), "the Topic panel lists no member note").toBeVisible({
      timeout: 30_000
    });
    await captureAndCheck(session, "j3", 1, "topic-panel");

    // A member note is pushed beside the topic.
    await members.first().click();
    const notePanel = await expectPanelUp(page, "note");
    await untilStack(page, "the Note panel is pushed", (s) => s.panels.length === before + 2);
    const pushed = await exploreStack(page);
    const noteAddress = pushed.panels[pushed.focus]?.history[pushed.panels[pushed.focus]!.index];
    expect(noteAddress).toMatch(new RegExp(`^memora://note/${uuid}$`));
    expect((await ribbonOf(notePanel)).state).toBe("placed");
    await captureAndCheck(session, "j3", 2, "note-panel");

    // The topic's own panel is closed first (an open address is focused, never opened twice), so the
    // crumb below is a link that replaces. A press on the compact panel focuses it; Cmd-W closes it.
    await page
      .locator('[data-surface="topic"] header')
      .first()
      .click({ position: { x: 6, y: 6 } });
    await pressShortcut(session, "Meta+W");
    await untilStack(page, "the topic panel closed", (s) => s.panels.length === before + 1);
    await expect(page.locator('[data-surface="topic"]')).toHaveCount(0);

    // Option-click on a crumb replaces the note in its own panel: its history holds two addresses.
    await page
      .locator('[data-surface="note"] header')
      .first()
      .click({ position: { x: 6, y: 6 } });
    const crumb = (await expectPanelUp(page, "note"))
      .locator("[data-path-ribbon] [data-segment]")
      .last();
    await crumb.click({ modifiers: ["Alt"] });
    await untilStack(page, "the crumb replaced the note", (s) => {
      const focused = s.panels[s.focus];
      return (
        s.panels.length === before + 1 &&
        focused !== undefined &&
        focused.history.length === 2 &&
        focused.index === 1
      );
    });
    await expectPanelUp(page, "topic");

    // Cmd-[ returns within the panel: the same panel, the note again.
    await page.keyboard.press("Meta+[");
    await untilStack(page, "back returned within the panel", (s) => {
      const focused = s.panels[s.focus];
      return s.panels.length === before + 1 && focused !== undefined && focused.index === 0;
    });
    await expectPanelUp(page, "note");
    await captureAndCheck(session, "j3", 3, "back-within-the-panel");

    // Cmd-[ at the start of the panel closes it: Explore is back to the stack it started with.
    await page.keyboard.press("Meta+[");
    await untilStack(page, "back at the start closed the panel", (s) => s.panels.length === before);
    await expect(page.locator('[data-surface="note"]')).toHaveCount(0);
    await captureAndCheck(session, "j3", 4, "back-closed-the-panel");
    test.info().annotations.push({
      type: "gestures",
      description: JSON.stringify((await readGestures(page)).log)
    });
  } finally {
    await db?.close();
    await session.close();
  }
});

test("J3 path with 0 clicks (X2): each of the five kinds shows the path of objects.locate, by deep link and by Cmd-K", async () => {
  test.setTimeout(45 * 60_000);
  const run = journeysRun();
  // The Question is answered by the DEV fake remote, set up as J6 does: no cassette (the app refuses the
  // two together) and BASE-J's Codex writer admitted. The fake remote refuses a data root inside
  // `.claude/worktrees/` (agents prune those folders), so this test runs from a worktree outside it;
  // MEMORA_JOURNEYS_NO_FAKE_REMOTE=1 runs without the fake (the Question is then stored, its answer
  // fails, and the question kind is not verified).
  const fakeRemote = process.env.MEMORA_JOURNEYS_NO_FAKE_REMOTE?.trim() !== "1";
  const session = await openClone(
    run,
    "j3-x2",
    fakeRemote
      ? {
          cassette: false,
          fakeRemote: true,
          env: { MEMORA_JOURNEYS_ADMIT_WRITER: await journeysWriterConfigId(run.scratchDir) }
        }
      : {}
  );
  const { page } = session;
  let db: ProfileDb | null = null;
  const report: Record<string, unknown>[] = [];
  try {
    await waitForDatabase(page, 180_000);
    // Dark is the default (Q39): the app is made to follow the window's scheme, so every scan is drawn
    // in the theme setTheme asks for and none depends on the default or on what the profile stored.
    await followSystemTheme(session);
    await setContentSize(session, 1440, 900);
    await expect(page.locator('[data-surface="shell"]').first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(session.userDataDir);

    // One object of each kind. The note below level 1 comes first; its topic is the topic.
    const below = await noteBelowLevelOne(page, db);
    const topicId = below.segments[below.segments.length - 1]!.split("/").pop()!;
    const [source] = await db.query<{ id: string; title: string }>(
      "select id::text as id, title from source_items where title is not null order by id limit 1"
    );
    const [entity] = await db.query<{ id: string; title: string }>(
      "select id::text as id, canonical_name as title from entities order by id limit 1"
    );
    expect(source, "BASE-J holds no source").toBeDefined();
    expect(entity, "BASE-J holds no entity").toBeDefined();
    const topicTitle = (await locate(page, address("topic", topicId)))?.object.title ?? "";

    // The Question: asked once, answered by the fake remote.
    const questionText = "How do murre eggs differ in shape from other seabird eggs";
    const asked = await invokeApp<{ questionId: string }>(page, "questions.ask", {
      text: questionText,
      scope: { kind: "library" }
    });
    await expect
      .poll(
        async () => {
          const list = await invokeApp<{ items: { id: string; status: string }[] }>(
            page,
            "questions.list",
            { limit: 5 }
          );
          return list.items.find((item) => item.id === asked.questionId)?.status ?? "missing";
        },
        { message: "the Question did not complete", timeout: 120_000 }
      )
      .toBe("complete");

    const targets: { kind: Kind; id: string; query: string }[] = [
      { kind: "source", id: source!.id, query: source!.title },
      { kind: "note", id: below.note.id, query: below.note.title },
      { kind: "topic", id: topicId, query: topicTitle },
      { kind: "entity", id: entity!.id, query: entity!.title },
      { kind: "question", id: asked.questionId, query: questionText }
    ];
    expect(targets.map((target) => target.kind)).toEqual([...kinds]);

    await pressShortcut(session, "Meta+2");
    await expect(
      page.locator('[data-surface="destination-explore"]:not([data-state="loading"])').first()
    ).toBeVisible({ timeout: 60_000 });
    await installGestureCounter(page);

    let step = 0;
    let passed = 0;
    for (const target of targets) {
      const want = address(target.kind, target.id);
      const located = await locate(page, want);
      // Every kind has a place: the answer of the Question cites a placed note, so locate must answer for it.
      if (!located) throw new Error(`objects.locate found nothing for ${want}`);
      const expected = expectedSegments(located);
      // A path that must show is not empty: an empty locate and an "unsorted" ribbon would agree.
      const mustShow = pathMustShow(target.kind, below.belowLevelOne);
      if (mustShow)
        expect(
          expected.length,
          target.kind === "question"
            ? "the Question's path is empty: its answer cites no placed note"
            : `objects.locate gives the ${target.kind} no topic on its primary path`
        ).toBeGreaterThan(0);
      if (target.kind === "note")
        expect
          .soft(below.belowLevelOne, "BASE-J's tree has no note below level 1 (X2's [I])")
          .toBe(true);

      let kindFailed = false;
      for (const route of ["deep link", "Cmd-K"] as const) {
        // Each route opens the object afresh: the stack starts without it.
        await resetGestures(page);
        if (route === "deep link") {
          await openedByDeepLink(session, want);
        } else {
          await pressShortcut(session, "Meta+K");
          await expect(page.locator('[data-surface="palette"]')).toBeVisible();
          await page.keyboard.type(target.query.slice(0, 60));
          const choice = page.locator(`[data-palette-row][data-quick-look="${want}"]`);
          await expect(choice, `Cmd-K did not list the ${target.kind}`).toBeVisible({
            timeout: 30_000
          });
          // X12: the open palette, with its results, is a step of its own.
          if (route === "Cmd-K") {
            step += 1;
            await captureAndCheck(session, "j3-x2", step, `${target.kind}-palette`);
          }
          await choice.click();
        }
        const panel = await expectPanelUp(page, target.kind);
        const gesturesBefore = (await readGestures(page)).total;
        const { state, segments } = await ribbonOf(panel);
        const gesturesAfter = (await readGestures(page)).total;
        report.push({
          kind: target.kind,
          route,
          state,
          segments: segments.length,
          expected: expected.length,
          gesturesToRibbon: gesturesAfter - gesturesBefore,
          gesturesToOpen: gesturesBefore
        });
        // The path is there with no gesture beyond the opening, and it is the path of locate.
        expect
          .soft(gesturesAfter, `${target.kind} by ${route}: a gesture was needed`)
          .toBe(gesturesBefore);
        if (route === "deep link")
          expect.soft(gesturesBefore, `${target.kind}: a deep link needs no gesture`).toBe(0);
        // The ribbon shows a path where one must show (placed or tentative, with segments), and it is
        // the path of locate.
        const failures = ribbonFailures({
          kind: target.kind,
          route,
          state,
          segments,
          expected,
          mustShow
        });
        expect
          .soft(failures, `${target.kind} by ${route}: the ribbon against objects.locate`)
          .toEqual([]);
        if (failures.length > 0) kindFailed = true;
        if (route === "deep link") {
          step += 1;
          await captureAndCheck(session, "j3-x2", step, `${target.kind}-ribbon`);
        }
        // Close it: the next route opens it again.
        await pressShortcut(session, "Meta+W");
        await expect(page.locator(`[data-surface="${target.kind}"]`)).toHaveCount(0);
      }
      // A kind counts as read only when both routes showed its path.
      if (!kindFailed) passed += 1;
    }
    expect(passed, "kinds whose ribbon held by both routes").toBe(kinds.length);
  } finally {
    const evidence = join(run.evidenceDir, "j3-x2");
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, "report.json"), `${JSON.stringify({ report }, null, 2)}\n`);
    test.info().annotations.push({
      type: "X2",
      description: `${report.length / 2} kinds read by both routes; ${JSON.stringify(
        report.map((row) => [row.kind, row.route, row.segments, row.expected])
      )}`
    });
    await db?.close();
    await session.close();
  }
});
