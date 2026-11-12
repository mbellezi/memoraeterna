// J4 follow a relation (F5 T155, spec 5.3): a note panel -> a relation card -> the target note pushed
// to its right -> the context panel's Connections tab shows the backlink (`via = relation`); a hover
// card shows on an object link in the note body (by hover and by keyboard focus) and none on the
// context panel's relation rows (A3, D31).
//
// The window is 1200 px wide: below 1280 px the context panel is the strip beside the stack, so the
// note panel lists its relations as cards (`[data-relation-button]`) and not as the stance summary
// that a docked context panel would show. The strip is opened with a click.
//
// One setup step comes before any gesture, as a harness step through `window.app` (the same call the
// note's own Save makes): BASE-J's notes have no object link in their body, so the origin note gets
// one line, `[<title>](memora://note/<target>)`, through `knowledge.reviewNote`. Nothing else is
// changed. Selectors are data attributes and roles (`data-surface`, `data-state`, `data-panel-top`,
// `data-relation-button`, `data-object-link`, `data-object`); the workspace state the app keeps
// (`memora.workspace.v1`) says which panels are on the stack.
import { appliedNoteRelationSql, shownNoteRelationSql } from "@app/db";
import { expect, test, type Locator, type Page } from "@playwright/test";

import { invokeApp, launchMemora, setContentSize, waitForDatabase } from "./support/app.js";
import { openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter } from "./support/gestures.js";
import { cloneProfile, journeysRun, profileDir } from "./support/profile.js";
import { inboxStoreReaders, seedInbox } from "./support/seed-inbox.js";
import {
  expectStack,
  noteAddress,
  openObject,
  showContextPanel,
  StepLog,
  surface
} from "./support/workspace-steps.js";

interface RelationPick {
  /** The note the journey opens. */
  originId: string;
  /** The note at the other end, which the relation card opens. */
  targetId: string;
  relationId: string;
  state: string;
}

interface RelationsPage {
  items: { id: string; state: string; other: { id: string } }[];
  total: number;
}

/**
 * A note whose first page of shown relations holds a relation to follow, found with the visibility
 * module's own predicates (applied first, then any shown one). Both ends are tried as the origin.
 */
async function pickRelation(page: Page, db: ProfileDb): Promise<RelationPick> {
  for (const predicate of [appliedNoteRelationSql, shownNoteRelationSql]) {
    const candidates = await db.query<{ id: string; lo: string; hi: string }>(
      `select r.id::text as id, r.source_atomic_note_id::text as lo, r.target_atomic_note_id::text as hi
         from atomic_note_relations r
         join atomic_notes lo on lo.id = r.source_atomic_note_id
         join atomic_notes hi on hi.id = r.target_atomic_note_id
        where ${predicate("r", ["lo", "hi"])}
        order by r.id limit 60`
    );
    for (const candidate of candidates)
      for (const originId of [candidate.lo, candidate.hi]) {
        const first = await invokeApp<RelationsPage>(page, "notes.relations", {
          noteId: originId,
          group: "shown",
          offset: 0,
          limit: 50
        });
        const found = first.items.find((item) => item.id === candidate.id);
        if (found && first.total <= first.items.length)
          return {
            originId,
            targetId: found.other.id,
            relationId: candidate.id,
            state: found.state
          };
      }
  }
  throw new Error("BASE-J has no shown relation between two notes to follow");
}

/** Every backlink of an address, through the pages `objects.backlinks` hands out. */
async function backlinksOf(page: Page, address: string) {
  const all: { from: string; via: string }[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const result = await invokeApp<{ items: { from: string; via: string }[]; next?: string }>(
      page,
      "objects.backlinks",
      { address, ...(cursor ? { cursor } : {}) }
    );
    all.push(...result.items);
    if (!result.next) break;
    cursor = result.next;
  }
  return all;
}

const noteTop = (page: Page): Locator => page.locator('[data-surface="note"][data-panel-top]');

test("J4 follow a relation: the card opens the target beside it, Connections shows the backlink, hover cards only on links", async () => {
  test.setTimeout(30 * 60_000);
  const run = journeysRun();
  // The clone is seeded before it starts (the Inbox's writers, support/seed-inbox.ts): the suggested
  // connections of the last step of this journey are the seed's, with a known state and verdict.
  const userDataDir = await cloneProfile(
    profileDir(run, "base"),
    profileDir(run, "j4"),
    run.repoRoot
  );
  const seed = await seedInbox(run, userDataDir);
  const session = await launchMemora({ run, userDataDir });
  const { page } = session;
  let db: ProfileDb | null = null;
  let readers: Awaited<ReturnType<typeof inboxStoreReaders>> | null = null;
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1200, 900);
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(session.userDataDir);
    readers = await inboxStoreReaders(userDataDir);

    // Setup (a harness step): the origin note's body gets one object link, to the target note.
    const pick = await pickRelation(page, db);
    const origin = noteAddress(pick.originId);
    const target = noteAddress(pick.targetId);
    const [targetRow] = await db.query<{ title: string | null }>(
      "select title from atomic_notes where id = $1::uuid",
      [pick.targetId]
    );
    const targetTitle =
      (targetRow?.title ?? "Related note").replace(/[[\]()]/gu, " ").trim() || "Note";
    const [originRow] = await db.query<{ body: string; revision: string }>(
      `select body_markdown as body,
              to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as revision
         from atomic_notes where id = $1::uuid`,
      [pick.originId]
    );
    if (!originRow) throw new Error("The origin note is gone");
    await invokeApp(page, "knowledge.reviewNote", {
      id: pick.originId,
      action: "edit",
      expectedUpdatedAt: originRow.revision,
      bodyMarkdown: `${originRow.body.trimEnd()}\n\nSee also [${targetTitle}](${target}).`
    });
    test.info().annotations.push({
      type: "relation",
      description: `${pick.relationId} (${pick.state}) from ${origin} to ${target}`
    });
    await installGestureCounter(page);
    const steps = new StepLog(session, "j4");

    // 1. The origin note opens as a panel of Explore, with its relations as cards.
    await openObject(session, origin);
    const panel = noteTop(page);
    await expect(panel, "the note panel did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    const opened = await expectStack(
      page,
      "explore",
      (stack) => stack.panels.at(-1) === origin,
      "the origin note is the top panel"
    );
    const link = panel.locator(`a[data-object-link="${target}"]`);
    await expect(link, "the note body shows no object link to the target").toBeVisible({
      timeout: 30_000
    });
    const card = panel.locator(`[data-relation-button="${pick.relationId}"]`);
    await expect(card, "the note panel lists no card for the relation").toBeVisible({
      timeout: 30_000
    });
    await steps.step("origin-note");

    // 2. A hover card on the object link in the body: by hover, then by keyboard focus.
    const objectCard = page.locator('[data-surface="object-card"]');
    await link.hover();
    await expect(objectCard, "no hover card on the object link (pointer)").toBeVisible({
      timeout: 10_000
    });
    await expect(objectCard).not.toHaveAttribute("data-state", "loading", { timeout: 15_000 });
    await expect(objectCard).not.toHaveAttribute("data-state", "error");
    await steps.step("hover-card");
    await page.mouse.move(2, 2);
    await expect(objectCard, "the hover card stayed after the pointer left").toHaveCount(0, {
      timeout: 10_000
    });
    await link.focus();
    await expect(objectCard, "no hover card on the object link (keyboard focus)").toBeVisible({
      timeout: 10_000
    });
    await page.keyboard.press("Escape");
    await expect(objectCard, "Escape did not close the hover card").toHaveCount(0, {
      timeout: 10_000
    });
    await link.blur();

    // 3. The relation card opens the target note to the right of the origin.
    await card.click();
    const pushed = await expectStack(
      page,
      "explore",
      (stack) =>
        stack.panels.length === opened.panels.length + 1 &&
        stack.panels.at(-1) === target &&
        stack.panels.at(-2) === origin &&
        stack.focus === stack.panels.length - 1,
      "the target note is pushed to the right of the origin and is focused"
    );
    await expect(noteTop(page), "the target note panel did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    await steps.step("target-pushed");

    // 4. The context panel's Connections tab shows the other note of the relation, and the store
    // says the same: a backlink of the target `via = relation` from the origin.
    await showContextPanel(session, { open: true });
    const connections = page.locator('[data-surface="context-connections"]');
    await expect(connections, "the Connections tab did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 30_000 }
    );
    const backRow = connections.locator(`[data-object="${origin}"]`);
    await expect(backRow, "Connections does not show the origin note").toBeVisible();
    const backlinks = await backlinksOf(page, target);
    expect(
      backlinks.some((entry) => entry.from === origin && entry.via === "relation"),
      `objects.backlinks of the target holds no relation backlink from the origin (${JSON.stringify(backlinks)})`
    ).toBe(true);
    await steps.step("context-connections");

    // 5. No hover card on the context panel's relation rows (A3), by hover or by focus.
    await backRow.hover();
    await page.waitForTimeout(800);
    await expect(objectCard, "a hover card opened on a context-panel row (pointer)").toHaveCount(0);
    await backRow.focus();
    await page.waitForTimeout(800);
    await expect(objectCard, "a hover card opened on a context-panel row (focus)").toHaveCount(0);
    expect(pushed.panels.at(-1)).toBe(target);

    // 6. A suggested connection in the context panel is kept with `a` and removed with Backspace
    // (D34): the keys are on its buttons (`aria-keyshortcuts`), work while focus is in its box, and
    // each verdict is read back from the relation's events.
    for (const [name, key] of [
      ["suggestionLow", "a"],
      ["suggestionUnknown", "Backspace"]
    ] as const) {
      const suggested = seed.relations[name];
      await openObject(session, suggested.notes[0]);
      await expect(noteTop(page), `${name}: the note panel did not reach success`).toHaveAttribute(
        "data-state",
        "success",
        { timeout: 60_000 }
      );
      await expectStack(
        page,
        "explore",
        (stack) => stack.panels.at(-1) === suggested.notes[0],
        `${name}: the note of the suggestion is the top panel`
      );
      await showContextPanel(session, { open: true });
      const box = page.locator(`[data-suggestion="${suggested.id}"]`);
      await expect(box, `${name}: Connections shows no box for the suggestion`).toBeVisible({
        timeout: 30_000
      });
      const keep = box.locator('button[aria-keyshortcuts="a"]');
      const remove = box.locator('button[aria-keyshortcuts="Backspace"]');
      await expect(keep, `${name}: no Keep button with its key`).toBeVisible();
      await expect(remove, `${name}: no Remove button with its key`).toBeVisible();
      if (name === "suggestionLow") await steps.step("context-suggestion");
      await (key === "a" ? keep : remove).focus();
      await page.keyboard.press(key);
      await expect(box, `${name}: the box stayed after ${key}`).toHaveCount(0, {
        timeout: 30_000
      });
      const last = (await readers.relationEvents(suggested.id)).at(-1);
      expect(last?.kind, `${name}: the last relation event after ${key}`).toBe(
        key === "a" ? "kept" : "removed"
      );
      expect(last?.after?.status, `${name}: the relation's human state`).toBe(
        key === "a" ? "accepted" : "rejected"
      );
    }

    await steps.finish(test.info());
  } finally {
    await readers?.close();
    await db?.close();
    await session.close();
  }
});
