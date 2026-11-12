// J5 Inbox triage (F5 T155, spec 5.3, D33, D34): the Inbox of a clone seeded through the real
// writers, and each verdict read back from its own store.
//
// Before the app starts, `seedInbox` (support/seed-inbox.ts) writes, with the clone's server started
// by `scripts/lib/profile-server.ts` and no SQL insert: a withdrawn relation, a contradiction, a
// pending topic proposal (the engine's proposal path), a pending relation pass, a duplicate finding
// and three suggested relations, below the 0.85 band (0.64), with no probability and above it
// (0.92). The read model confirms what it lists before the profile is launched.
//
// D33: the two suggestions below the band are listed and counted, the one above it is not.
// D34: `a` keeps one suggestion, Backspace removes another (and `x` offers nothing on a suggestion),
// `x` dismisses a topic proposal, a relation pass and a finding. Each verdict is read through the
// repository readers F6's label export uses (relation events, the change-set view, findings): the
// relation's human state and its `relation_events` row, the change-sets' `dismissed` status, the
// finding's.
//
// `x` on a suggestion is proved by what the renderer sends, not by waiting for a write that did not
// come: the main process's IPC trace is cleared, `x` is pressed, a later key (`j`/`k`) moves the
// selection (the app has handled `x` by then), and the trace holds no `app:inbox:act`. The same
// read after Backspace holds one, so the read is not blind.
//
// Selectors are roles and data attributes (`data-surface`, `role=listbox` / `option` /
// `aria-selected`, `aria-keyshortcuts` on the verb buttons); the items are found by their keys from
// `inbox.list` (the list and the screen share one order), never by copy. The only words asserted are
// the two confidence phrases T176 pins ("confiança média (64%)", "confiança desconhecida").
import { expect, test, type Locator, type Page } from "@playwright/test";

import { invokeApp, launchMemora, setContentSize, waitForDatabase } from "./support/app.js";
import { installGestureCounter } from "./support/gestures.js";
import { clearIpcTrace, inboxActChannel, readIpcTrace } from "./support/ipc-trace.js";
import { cloneProfile, journeysRun, profileDir } from "./support/profile.js";
import { inboxStoreReaders, seedInbox, type InboxSeed } from "./support/seed-inbox.js";
import {
  expectStack,
  noteAddress,
  openObject,
  StepLog,
  surface
} from "./support/workspace-steps.js";
import { pressShortcut } from "./support/shortcuts.js";

interface ListedItem {
  key: string;
  kind: string;
  risk: string;
}

/** Every open item `inbox.list` hands out, in the order the screen lists them. */
async function listedItems(page: Page): Promise<ListedItem[]> {
  const all: ListedItem[] = [];
  let cursor: string | undefined;
  for (let pageNo = 0; pageNo < 40; pageNo += 1) {
    const answer = await invokeApp<{
      items: { kind: string; id: string; risk: string }[];
      nextCursor: string | null;
    }>(page, "inbox.list", { limit: 50, ...(cursor ? { cursor } : {}) });
    all.push(
      ...answer.items.map((item) => ({
        key: `${item.kind}:${item.id}`,
        kind: item.kind,
        risk: item.risk
      }))
    );
    if (!answer.nextCursor) return all;
    cursor = answer.nextCursor;
  }
  throw new Error("The Inbox listed more than 2,000 items");
}

const inboxRoot = (page: Page): Locator => surface(page, "destination-inbox");
const options = (page: Page): Locator =>
  inboxRoot(page).locator('[role="listbox"] [role="option"]');

/** Selects an item by clicking its row; loads more rows when the item is past the first page. */
async function selectItem(page: Page, key: string): Promise<Locator> {
  const index = (await listedItems(page)).findIndex((item) => item.key === key);
  if (index < 0) throw new Error(`${key} is not in the Inbox`);
  const rows = options(page);
  const more = inboxRoot(page).locator('[role="listbox"] + div button');
  while ((await rows.count()) <= index) {
    const held = await rows.count();
    await more.first().click();
    await expect
      .poll(() => rows.count(), { message: "more rows after Load more" })
      .toBeGreaterThan(held);
  }
  const row = rows.nth(index);
  await row.click();
  await expect(row, `${key} was not selected`).toHaveAttribute("aria-selected", "true");
  return row;
}

/** Waits until an item has left the list (its verdict was carried out). */
async function expectGone(page: Page, key: string) {
  await expect
    .poll(async () => (await listedItems(page)).some((item) => item.key === key), {
      message: `${key} is still in the Inbox`,
      timeout: 30_000
    })
    .toBe(false);
}

interface ShownRelation {
  id: string;
  state: string;
  probability: number | null;
}

/** A note's shown relations (`notes.relations`, group "shown"), paged until the list ends. */
async function shownRelations(page: Page, noteAddress: string): Promise<ShownRelation[]> {
  const noteId = noteAddress.split("/").pop()!;
  const all: ShownRelation[] = [];
  for (let pageNo = 0; pageNo < 20; pageNo += 1) {
    const answer = await invokeApp<{ items: ShownRelation[]; total: number }>(
      page,
      "notes.relations",
      { noteId, group: "shown", offset: all.length, limit: 50 }
    );
    all.push(...answer.items);
    if (answer.items.length === 0 || all.length >= answer.total) return all;
  }
  throw new Error("A note has more than 1,000 shown relations");
}

/** Moves the selection off the selected row with `j` (or `k` on the last row) and back. */
async function moveAndBack(page: Page, row: Locator) {
  const all = options(page);
  const index = await all.evaluateAll((rows) =>
    rows.findIndex((option) => option.getAttribute("aria-selected") === "true")
  );
  const last = (await all.count()) - 1;
  const [away, back] = index < last ? ["j", "k"] : ["k", "j"];
  await page.keyboard.press(away!);
  await expect(row, `${away} did not move the selection`).not.toHaveAttribute(
    "aria-selected",
    "true"
  );
  await page.keyboard.press(back!);
  await expect(row, `${back} did not bring the selection back`).toHaveAttribute(
    "aria-selected",
    "true"
  );
}

/** How many times the renderer asked main to carry out a verdict since the trace was cleared. */
async function actCalls(session: { electronApp: Parameters<typeof readIpcTrace>[0] }) {
  const trace = await readIpcTrace(session.electronApp);
  if (!trace) throw new Error("The IPC trace is off: MEMORA_IPC_TRACE did not reach main");
  return trace.entries.filter((entry) => entry.channel === inboxActChannel).length;
}

const verbButton = (page: Page, shortcut: string): Locator =>
  inboxRoot(page).locator(`button[aria-keyshortcuts="${shortcut}"]`);

test("J5 Inbox triage: seeded through the real writers, D33 routing, D34 keys, each verdict in its store", async () => {
  test.setTimeout(30 * 60_000);
  const run = journeysRun();

  // The headless step: clone BASE-J, seed the clone, start the app on it.
  const userDataDir = await cloneProfile(
    profileDir(run, "base"),
    profileDir(run, "j5"),
    run.repoRoot
  );
  const seed: InboxSeed = await seedInbox(run, userDataDir);
  test.info().annotations.push({
    type: "seeded",
    description: `before ${JSON.stringify(seed.counts.before.byKind)}, after ${JSON.stringify(seed.counts.after.byKind)}`
  });

  const session = await launchMemora({ run, userDataDir });
  const { page } = session;
  let readers: Awaited<ReturnType<typeof inboxStoreReaders>> | null = null;
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1440, 900);
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    readers = await inboxStoreReaders(userDataDir);
    await installGestureCounter(page);
    const steps = new StepLog(session, "j5");

    // 1. The Inbox (Cmd-4) lists what the seed wrote and counts it.
    await pressShortcut(session, "Meta+4");
    await expect(inboxRoot(page), "the Inbox did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    const listed = await listedItems(page);
    const keysListed = new Set(listed.map((item) => item.key));
    for (const name of [
      "withdrawn",
      "contradiction",
      "suggestionLow",
      "suggestionUnknown",
      "pass",
      "proposal",
      "duplicate"
    ] as const)
      expect(keysListed.has(seed.keys[name]), `the Inbox does not list the seeded ${name}`).toBe(
        true
      );
    // D33: the suggestion above the band is inline only.
    expect(
      keysListed.has(seed.keys.suggestionHigh),
      "the suggestion above the 0.85 band is listed in the Inbox"
    ).toBe(false);
    // ... and it is not dropped: it is a live suggestion, shown inline on its note (state
    // suggested, the probability the seed wrote), so "not in the Inbox" is not vacuous.
    const inline = (await shownRelations(page, seed.relations.suggestionHigh.notes[0])).find(
      (relation) => relation.id === seed.relations.suggestionHigh.id
    );
    expect(inline, "the suggestion above the band is not shown inline on its note").toBeTruthy();
    expect(inline?.state, "the inline suggestion's state").toBe("suggested");
    expect(inline?.probability, "the inline suggestion's probability").toBeCloseTo(0.92, 2);
    // Both suggestions that are listed are medium risk (an unknown probability is not "high").
    for (const name of ["suggestionLow", "suggestionUnknown"] as const)
      expect(listed.find((item) => item.key === seed.keys[name])?.risk, `${name} risk`).toBe(
        "medium"
      );
    // And they are counted in "needs you": the app's counts equal the read model's after the seed.
    const counts = await invokeApp<{ total: number; byKind: Record<string, number> }>(
      page,
      "inbox.counts"
    );
    for (const kind of ["suggestion", "contradiction", "withdrawn", "review", "duplicate"] as const)
      expect(counts.byKind[kind] ?? 0, `the Inbox counts ${kind} items`).toBe(
        seed.counts.after.byKind[kind] ?? 0
      );
    expect(
      (counts.byKind.suggestion ?? 0) - (seed.counts.before.byKind.suggestion ?? 0),
      "the two suggestions below the band are counted, the one above it is not"
    ).toBe(2);
    await steps.step("inbox-seeded");

    // 2. The suggestion at 0.64: its confidence is worded with its number; `a` keeps it.
    await selectItem(page, seed.keys.suggestionLow);
    await expect(inboxRoot(page)).toContainText(/confiança média \(64%\)/u);
    await expect(verbButton(page, "A"), "A is not offered on a suggestion").toBeVisible();
    await expect(verbButton(page, "Backspace")).toBeVisible();
    await expect(verbButton(page, "X"), "X is offered on a suggestion").toHaveCount(0);
    await steps.step("suggestion-selected");
    await page.keyboard.press("a");
    await expectGone(page, seed.keys.suggestionLow);
    const kept = (await readers.relationEvents(seed.relations.suggestionLow.id)).at(-1);
    expect(kept?.kind, "the last relation event of the kept suggestion").toBe("kept");
    expect(kept?.after?.status, "the kept relation's human state").toBe("accepted");

    // 3. The suggestion with no probability: no number; `x` offers nothing; Backspace removes it.
    const unknownRow = await selectItem(page, seed.keys.suggestionUnknown);
    const detail = inboxRoot(page);
    await expect(detail).toContainText(/confiança desconhecida/u);
    await expect(detail.getByText(/confiança desconhecida[^\n]*\d/u)).toHaveCount(0);
    await expect(verbButton(page, "Backspace")).toBeVisible();
    expect(await clearIpcTrace(session.electronApp), "the IPC trace is off").toBe(true);
    await page.keyboard.press("x");
    await moveAndBack(page, unknownRow);
    expect(await actCalls(session), "x asked main to carry out a verdict on a suggestion").toBe(0);
    expect(
      (await listedItems(page)).some((item) => item.key === seed.keys.suggestionUnknown),
      "x dismissed a suggestion (D34: x only dismisses where nothing changes)"
    ).toBe(true);
    const untouched = (await readers.relationEvents(seed.relations.suggestionUnknown.id)).at(-1);
    expect(untouched?.kind, "x wrote a relation event").not.toMatch(/^(kept|removed)$/u);
    await clearIpcTrace(session.electronApp);
    await page.keyboard.press("Backspace");
    await expectGone(page, seed.keys.suggestionUnknown);
    expect(
      await actCalls(session),
      "Backspace did not reach main as a verdict"
    ).toBeGreaterThanOrEqual(1);
    const removed = (await readers.relationEvents(seed.relations.suggestionUnknown.id)).at(-1);
    expect(removed?.kind, "the last relation event of the removed suggestion").toBe("removed");
    expect(removed?.after?.status, "the removed relation's human state").toBe("rejected");
    // D34: Backspace never sets `vetoed_at`, the withdrawn state.
    expect(removed?.after?.vetoed_at ?? null, "Backspace set vetoed_at").toBeNull();

    // 4. `x` dismisses a topic proposal and a relation pass; nothing the proposal named changes.
    await selectItem(page, seed.keys.proposal);
    await expect(verbButton(page, "X")).toBeVisible();
    await page.keyboard.press("x");
    await expectGone(page, seed.keys.proposal);
    expect(await readers.changeSetStatus("topic", seed.proposal.id), "the topic proposal").toBe(
      "dismissed"
    );
    const topicAddress = `memora://topic/${seed.proposal.topicId}`;
    const resolved = await invokeApp<{ items: Record<string, { title: string | null }> }>(
      page,
      "objects.resolveMany",
      { addresses: [topicAddress] }
    );
    expect(resolved.items[topicAddress]?.title, "the dismissed proposal renamed the topic").toBe(
      seed.proposal.topicTitle
    );
    await selectItem(page, seed.keys.pass);
    await page.keyboard.press("x");
    await expectGone(page, seed.keys.pass);
    expect(await readers.changeSetStatus("relation", seed.pass.id), "the relation pass").toBe(
      "dismissed"
    );

    // 5. `x` dismisses the duplicate finding.
    await selectItem(page, seed.keys.duplicate);
    await page.keyboard.press("x");
    await expectGone(page, seed.keys.duplicate);
    expect(await readers.findingStatus(seed.finding.id), "the duplicate finding").toBe("dismissed");

    // 6. What was not decided stands: the contradiction and the withdrawn relation, and the counts
    // moved by exactly the verdicts.
    const after = await listedItems(page);
    for (const name of ["contradiction", "withdrawn"] as const)
      expect(
        after.some((item) => item.key === seed.keys[name]),
        `the untouched ${name} left the Inbox`
      ).toBe(true);
    const finalCounts = await readers.counts();
    const moved = (kind: string, wanted: number) =>
      expect(
        (seed.counts.after.byKind[kind as "review"] ?? 0) -
          (finalCounts.byKind[kind as "review"] ?? 0),
        `${kind} items closed by the verdicts`
      ).toBe(wanted);
    moved("suggestion", 2);
    moved("review", 2);
    moved("duplicate", 1);
    moved("contradiction", 0);
    moved("withdrawn", 0);
    await steps.step("inbox-after-verdicts");

    // 7. An object opened beside the Inbox leaves the root as the previous panel (its list alone).
    await openObject(session, noteAddress(seed.relations.contradiction.notes[0].split("/").pop()!));
    await expectStack(
      page,
      "inbox",
      (stack) => stack.panels.length === 1 && stack.panels[0]!.startsWith("memora://note/"),
      "the note opens beside the Inbox, which stays the destination"
    );
    await expect(
      surface(page, "destination-inbox-compact"),
      "the Inbox root is not reported as the previous panel"
    ).toBeVisible({ timeout: 30_000 });
    await steps.step("inbox-previous-panel");

    await steps.finish(test.info());
  } finally {
    await readers?.close();
    await session.close();
  }
});
