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
  StepLog,
  surface
} from "./support/workspace-steps.js";

interface Branch {
  nodes: { id: string; degree: number }[];
  edges: { id: string }[];
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
    await page.keyboard.press("Alt+5");
    const graphTab = page.locator('[data-surface="context-graph"]');
    await expect(graphTab, "Option-5 did not open the Graph tab").toHaveAttribute(
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
    // relations the table marks; End: a relation, which is the table's selected row.
    const edgeIds = new Set(topic.branch.edges.map((edge) => edge.id));
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
      .poll(async () => (await selectedRows(page)).length, {
        message: "the table has no selected row for the relation chosen on the canvas",
        timeout: 15_000
      })
      .toBe(1);
    const [fromCanvas] = await selectedRows(page);
    expect(edgeIds.has(fromCanvas!), "the selected row is a relation of the branch").toBe(true);
    await steps.step("canvas-selection");

    // 4. And the other way round: a click on another row moves the selection and the canvas shows it.
    const before = await canvasOf(page).screenshot();
    const ids = await rowsOf(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-row-id") ?? "")
    );
    const targetId = ids.find((id) => id !== fromCanvas);
    expect(targetId, "the table holds no other row to click").toBeTruthy();
    const target = relationsLens(page).locator(`tr[data-row-id="${targetId}"]`);
    await target.click();
    await expect
      .poll(() => selectedRows(page), { message: "the click did not select the row" })
      .toEqual([targetId]);
    await page.waitForTimeout(600);
    const after = await canvasOf(page).screenshot();
    expect(
      before.equals(after),
      "the canvas did not change when a table row was selected (it should emphasise the relation)"
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

    await steps.finish(test.info());
  } finally {
    await db?.close();
    await session.close();
  }
});
