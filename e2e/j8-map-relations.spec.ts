// J8 Map > Relations (F5 T155, spec 5.3, D19): a topic -> "Open in Map" -> Map > Relations scoped to
// it -> a choice on the canvas is the same choice in the table and the other way round; then the
// source scope from a Source panel.
//
// The topic's "Open in Map" is the button of the context panel's Graph tab (a topic has no Graph of
// its own; Option-5 opens the tab). The canvas is a WebGL view: it is driven with the keyboard it
// offers (`role="application"`; Home goes to the first item, the most connected note, End to the last,
// a relation) and the table beside it is read from the DOM (`tr[data-row-id]`, `aria-selected`): a
// note chosen on the canvas marks the rows of its relations, a relation chosen on the canvas is the
// selected row. The other way round, a click on a row must change what the canvas draws (the canvas
// element's pixels differ), since the canvas itself has no DOM to read.
//
// The branches are read with `window.app.relations.branch` (the lens's own read) to pick scopes with
// relations and to know what the table must hold. Selectors are data attributes and roles.
import { expect, test, type Locator, type Page } from "@playwright/test";

import { invokeApp, openClone, setContentSize, waitForDatabase } from "./support/app.js";
import { openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter } from "./support/gestures.js";
import { journeysRun } from "./support/profile.js";
import {
  expectStack,
  openObject,
  readWorkspace,
  showContextPanel,
  StepLog,
  surface
} from "./support/workspace-steps.js";

interface Branch {
  nodes: { id: string; degree: number }[];
  edges: { id: string; a: string; b: string }[];
}

/** The table's page: rows past it wait behind "Mostrar mais" (`tablePageSize` of the lens). */
const tablePage = 60;

const branchOf = (page: Page, scope: { topicId: string } | { sourceId: string }) =>
  invokeApp<Branch | null>(page, "relations.branch", { scope, colourDepth: 1 });

/** A topic of the tree whose branch holds at least three relations (the most populated first). */
async function pickTopic(page: Page): Promise<{ id: string; branch: Branch }> {
  const tree = await invokeApp<{ nodes: { id: string; items: number }[] } | null>(
    page,
    "topics.tree",
    { parentId: null, limit: 100 }
  );
  const areas = [...(tree?.nodes ?? [])].sort((a, b) => b.items - a.items);
  for (const area of areas) {
    const branch = await branchOf(page, { topicId: area.id });
    if (branch && branch.edges.length >= 3) return { id: area.id, branch };
  }
  throw new Error(`No topic of BASE-J has a branch with three relations (${areas.length} areas)`);
}

/** A source whose notes are linked: its branch holds at least one relation. */
async function pickSource(page: Page, db: ProfileDb): Promise<{ id: string; branch: Branch }> {
  const sources = await db.query<{ id: string }>(
    "select id::text as id from source_items order by created_at limit 60"
  );
  for (const source of sources) {
    const branch = await branchOf(page, { sourceId: source.id });
    if (branch && branch.edges.length >= 1) return { id: source.id, branch };
  }
  throw new Error(`No source of BASE-J has linked notes (${sources.length} sources)`);
}

const relationsLens = (page: Page): Locator => surface(page, "map-relations");
const rowsOf = (page: Page): Locator => relationsLens(page).locator("tr[data-row-id]");
const canvasOf = (page: Page): Locator => relationsLens(page).locator('[role="application"]');

/**
 * The relations the canvas lists after the notes, in the lens's own order: the read's edges once the
 * model has dropped a repeated id, a self-relation and a relation to a note it does not draw
 * (`buildBranchModel`). The last of them is where End puts the canvas cursor.
 */
function canvasEdgeOrder(branch: Branch): string[] {
  const nodeIds = new Set(branch.nodes.map((node) => node.id));
  const seen = new Set<string>();
  const order: string[] = [];
  for (const edge of branch.edges) {
    if (seen.has(edge.id) || edge.a === edge.b) continue;
    if (!nodeIds.has(edge.a) || !nodeIds.has(edge.b)) continue;
    seen.add(edge.id);
    order.push(edge.id);
  }
  return order;
}

/**
 * The canvas's pixels once the frame has stopped changing: two shots a beat apart are the same. The
 * canvas has no DOM to read, so a pixel comparison is only as good as the state it compares; a caller
 * takes this at a state that has no cursor and no card.
 */
async function stableShot(canvas: Locator): Promise<Buffer> {
  let last = await canvas.screenshot();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await canvas.page().waitForTimeout(250);
    const next = await canvas.screenshot();
    if (next.equals(last)) return next;
    last = next;
  }
  throw new Error("The canvas never settled on one frame (it kept changing for 5 s)");
}

/** The ids of the rows the table marks as the selected relation. */
const selectedRows = (page: Page) =>
  rowsOf(page).evaluateAll((rows) =>
    rows
      .filter((row) => row.getAttribute("aria-selected") === "true")
      .map((row) => row.getAttribute("data-row-id") ?? "")
  );

/** How many rows are marked as relations of the selected note (an inset bar; idle rows have none). */
const connectedRows = (page: Page) =>
  rowsOf(page).evaluateAll(
    (rows) =>
      rows.filter(
        (row) =>
          row.getAttribute("aria-selected") !== "true" && getComputedStyle(row).boxShadow !== "none"
      ).length
  );

async function expectBranchOnScreen(page: Page, branch: Branch, what: string) {
  await expect(
    relationsLens(page),
    `${what}: Map > Relations did not reach success`
  ).toHaveAttribute("data-state", "success", { timeout: 90_000 });
  await expect(rowsOf(page).first(), `${what}: the table lists no relation`).toBeVisible({
    timeout: 30_000
  });
  expect(await rowsOf(page).count(), `${what}: the table's rows against the read`).toBe(
    Math.min(branch.edges.length, tablePage)
  );
}

test("J8 Map > Relations: a topic opens in the Map, canvas and table select each other, the source scope from a Source panel", async () => {
  test.setTimeout(30 * 60_000);
  const run = journeysRun();
  const session = await openClone(run, "j8");
  const { page } = session;
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1440, 900);
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(session.userDataDir);
    const topic = await pickTopic(page);
    const source = await pickSource(page, db);
    test.info().annotations.push(
      {
        type: "topic",
        description: `${topic.id}: ${topic.branch.nodes.length} notes, ${topic.branch.edges.length} relations`
      },
      {
        type: "source",
        description: `${source.id}: ${source.branch.nodes.length} notes, ${source.branch.edges.length} relations`
      }
    );
    await installGestureCounter(page);
    const steps = new StepLog(session, "j8");

    // 1. The topic opens as a panel; its context panel's Graph tab offers "Open in Map".
    await openObject(session, `memora://topic/${topic.id}`);
    await expect(
      page.locator('[data-surface="topic"][data-panel-top]'),
      "the topic panel did not reach success"
    ).toHaveAttribute("data-state", "success", { timeout: 60_000 });
    await showContextPanel(session);
    const graphTab = page.locator('[data-surface="context-graph"]');
    await page.keyboard.press("Alt+5");
    const viaKey = await graphTab.waitFor({ timeout: 3_000 }).then(
      () => true,
      () => false
    );
    if (!viaKey) {
      // Option-5 did not switch the tab: the tab's own button does, and the miss is recorded.
      test.info().annotations.push({
        type: "note",
        description: "Option-5 did not open the Graph tab"
      });
      const seen = await page.evaluate(() => ({
        tabs: [...document.querySelectorAll('[data-surface="context-panel"] [role="tab"]')].map(
          (tab) => `${tab.id.replace(/^.*-tab-/u, "")}:${tab.getAttribute("aria-selected")}`
        ),
        surfaces: [...document.querySelectorAll("[data-surface]")].map(
          (node) => `${node.getAttribute("data-surface")}:${node.getAttribute("data-state")}`
        )
      }));
      const tabButton = page.locator(
        '[data-surface="context-panel"] [role="tab"][id$="-tab-graph"]'
      );
      if ((await tabButton.count()) > 0) await tabButton.click();
      else {
        // The tab is in the "more" menu; its item carries the Option-5 shortcut.
        await page.locator('[data-surface="context-panel"] button[aria-haspopup="menu"]').click();
        await page
          .locator('[role="menuitem"]')
          .filter({ hasText: "5" })
          .first()
          .click()
          .catch(() => {
            throw new Error(`The Graph tab is nowhere (${JSON.stringify(seen)})`);
          });
      }
    }
    await expect(graphTab, "the Graph tab did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 30_000 }
    );
    await steps.step("topic-graph-tab");
    await graphTab.locator("button").first().click();

    // 2. Map > Relations, scoped to the topic.
    await expect
      .poll(async () => (await readWorkspace(page)).destination, {
        message: "the workspace did not go to the Map"
      })
      .toBe("map");
    const mapStack = await expectStack(
      page,
      "map",
      (stack) =>
        decodeURIComponent(stack.root).includes(`/relations`) &&
        decodeURIComponent(stack.root).includes(`scope=memora://topic/${topic.id}`),
      "the Map's root is Relations scoped to the topic"
    );
    await expectBranchOnScreen(page, topic.branch, "topic scope");
    await expect(
      canvasOf(page),
      "the canvas is not drawn (no WebGL in this window?): J8 needs both views"
    ).toBeVisible();
    await steps.step("map-relations-topic");

    // 3. A choice on the canvas is the same choice in the table. Home: the most connected note, whose
    // relations the table marks; End: the last item, a relation: the table's selected row, and the one
    // the lens's own order ends on (a canvas that reported another edge would select another row).
    const edgeOrder = canvasEdgeOrder(topic.branch);
    const lastEdge = edgeOrder.at(-1);
    expect(lastEdge, "the lens draws no relation of the topic's branch").toBeTruthy();
    const maxDegree = Math.max(...topic.branch.nodes.map((node) => node.degree));
    await canvasOf(page).focus();
    await page.keyboard.press("Home");
    await expect
      .poll(() => connectedRows(page), {
        message: "the table does not mark the relations of the note chosen on the canvas",
        timeout: 15_000
      })
      .toBe(maxDegree);
    expect(await selectedRows(page), "a note is chosen, not a relation").toEqual([]);
    await page.keyboard.press("End");
    await expect
      .poll(() => selectedRows(page), {
        message: "the table's selected row is not the relation the canvas chose (the last one)",
        timeout: 15_000
      })
      .toEqual([lastEdge]);
    await steps.step("canvas-selection");

    // 4. And the other way round: a click on a row must make the canvas draw that relation. The
    // reference frame is a canvas with no cursor, no card and no focus: Escape clears the cursor and
    // the card (and the table's selection with them), and the blur takes the focus ring off, since a
    // row taking focus would remove it too and that alone would change the pixels. A frame that still
    // held the cursor would also change when the canvas blurred.
    await page.keyboard.press("Escape");
    await expect
      .poll(() => selectedRows(page), { message: "Escape on the canvas did not clear the choice" })
      .toEqual([]);
    await canvasOf(page).evaluate((node) => (node as HTMLElement).blur());
    const blank = await stableShot(canvasOf(page));
    const ids = await rowsOf(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-row-id") ?? "")
    );
    const [targetId, otherId] = ids.filter((id) => id !== lastEdge);
    expect(targetId && otherId, "the table holds fewer than two other rows to click").toBeTruthy();
    const target = relationsLens(page).locator(`tr[data-row-id="${targetId}"]`);
    await target.click();
    await expect
      .poll(() => selectedRows(page), { message: "the click did not select the row" })
      .toEqual([targetId]);
    const emphasised = await stableShot(canvasOf(page));
    expect(
      blank.equals(emphasised),
      "the canvas did not change when a table row was selected (it should emphasise the relation)"
    ).toBe(false);
    // Another row: another relation emphasised.
    await relationsLens(page).locator(`tr[data-row-id="${otherId}"]`).click();
    await expect
      .poll(() => selectedRows(page), { message: "the second click did not select its row" })
      .toEqual([otherId]);
    const moved = await stableShot(canvasOf(page));
    expect(
      emphasised.equals(moved),
      "the canvas draws the same for two different selected relations"
    ).toBe(false);
    // Escape in the table clears the choice on both sides.
    await target.focus();
    await page.keyboard.press("Escape");
    await expect
      .poll(() => selectedRows(page), { message: "Escape did not clear the selection" })
      .toEqual([]);

    // 5. The source scope, from a Source panel.
    await openObject(session, `memora://source/${source.id}`);
    const sourcePanel = page.locator('[data-surface="source"][data-panel-top]');
    await expect(sourcePanel, "the source panel did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    await sourcePanel.locator("button:has(svg.lucide-network)").first().click();
    await expect
      .poll(async () => (await readWorkspace(page)).destination, {
        message: "the workspace did not go to the Map again"
      })
      .toBe("map");
    await expectStack(
      page,
      "map",
      (stack) => decodeURIComponent(stack.root).includes(`scope=memora://source/${source.id}`),
      "the Map's root is Relations scoped to the source"
    );
    await expectBranchOnScreen(page, source.branch, "source scope");
    expect(mapStack.root).toContain("relations");
    await steps.step("map-relations-source");

    // 6. A note opened from the table (a double click on its cell) stands beside the Map, which
    // becomes the previous panel and reports its compact form.
    await rowsOf(page).first().locator("td").first().dblclick();
    await expectStack(
      page,
      "map",
      (stack) => stack.panels.length === 1 && stack.panels[0]!.startsWith("memora://note/"),
      "a note opens beside the Map"
    );
    await expect(
      surface(page, "destination-map-compact"),
      "the Map root is not reported as the previous panel"
    ).toBeVisible({ timeout: 30_000 });
    await steps.step("map-previous-panel");

    await steps.finish(test.info());
  } finally {
    await db?.close();
    await session.close();
  }
});
