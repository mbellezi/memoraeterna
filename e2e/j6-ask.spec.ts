// J6 ask and jump to citation (F5 T155, spec 5.3, section 3.6): Cmd-K -> `? <question>` -> the Ask
// panel streams its answer from the DEV fake remote (`class:answer`), the Question exists from the
// first delta, a citation chip opens the cited passage highlighted, and after a reload Library >
// Questions lists the Question and its page shows the stored answer.
//
// The clone starts with the DEV fake remote providers and no cassette (the app refuses the two
// together, and the fake answers `class:answer` itself): `MEMORA_FAKE_REMOTE` with the `journeys` plan,
// and `MEMORA_JOURNEYS_ADMIT_WRITER` naming BASE-J's signed-in Codex writer, which the fake remote's
// "no real provider is reachable" check would otherwise refuse (`fake-remote-journeys.ts`). The
// clone's automation is paused, so no job calls the writer; no remote AI provider is called. The
// retrieval runs on the local embedder and ranker (the harness holds the local-model slot).
//
// The stream is watched by a MutationObserver installed with `page.evaluate` before the question is
// sent: it records every distinct non-zero count of `[data-answer-paragraph]` until
// `[data-stage="done"]` appears. Selectors are data attributes and roles (`data-surface`,
// `data-palette-row`, `data-answer-paragraph`, `data-stage`, `data-citation`, `data-cited-passage`,
// `data-nav-key`); the panel stack is read from the workspace state the app keeps.
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { invokeApp, openClone, setContentSize, waitForDatabase } from "./support/app.js";
import { openProfileDb, type ProfileDb } from "./support/db.js";
import { installGestureCounter } from "./support/gestures.js";
import { journeysRun } from "./support/profile.js";
import { expectStack, pressMenuShortcut, StepLog, surface } from "./support/workspace-steps.js";

const question = "How does what we remember fade as time passes after learning something new?";

interface StreamRecord {
  counts: number[];
  done: boolean;
  doneCount: number | null;
}

/** BASE-J's Codex writer: the one real configuration the fake remote's check is told to admit. */
async function writerConfigId(scratchDir: string): Promise<string> {
  const record = JSON.parse(await readFile(join(scratchDir, "base-j.json"), "utf8")) as {
    writer?: { providerConfigId?: string };
  };
  const id = record.writer?.providerConfigId;
  if (!id) throw new Error("base-j.json names no writer configuration");
  return id;
}

/** Installs the observer of the answer's paragraphs; it stops recording at `[data-stage="done"]`. */
async function watchParagraphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scope = window as unknown as { __j6?: StreamRecord };
    const record: StreamRecord = { counts: [], done: false, doneCount: null };
    scope.__j6 = record;
    const read = () => {
      if (record.done) return;
      const count = document.querySelectorAll("[data-answer-paragraph]").length;
      if (document.querySelector('[data-stage="done"]')) {
        record.done = true;
        record.doneCount = count;
        return;
      }
      if (count > 0 && !record.counts.includes(count)) record.counts.push(count);
    };
    new MutationObserver(read).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-stage"]
    });
  });
}

const readStream = (page: Page) =>
  page.evaluate(() => (window as unknown as { __j6?: StreamRecord }).__j6 ?? null);

test("J6 ask and jump to citation: the answer streams, the Question is stored from the first delta, a citation opens its passage, the Library lists it", async () => {
  test.setTimeout(45 * 60_000);
  const run = journeysRun();
  const writerId = await writerConfigId(run.scratchDir);
  const session = await openClone(run, "j6", {
    cassette: false,
    fakeRemote: true,
    env: { MEMORA_JOURNEYS_ADMIT_WRITER: writerId }
  });
  const { page } = session;
  let db: ProfileDb | null = null;
  try {
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1440, 900);
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    db = await openProfileDb(session.userDataDir);
    const steps = new StepLog(session, "j6");

    // The question is asked from Explore, where its panels stand.
    await pressMenuShortcut(session, "2");
    await expect(
      page.locator('[data-surface="destination-explore"]:not([data-state="loading"])').first()
    ).toBeVisible({ timeout: 60_000 });
    await installGestureCounter(page);
    await watchParagraphs(page);

    // 1. Cmd-K, `? <question>`: the palette offers to ask it.
    await pressMenuShortcut(session, "k");
    const palette = surface(page, "palette");
    await expect(palette, "Cmd-K opened no palette").toBeVisible({ timeout: 15_000 });
    await page.keyboard.type(`? ${question}`);
    await expect(palette.locator('[data-palette-row="ask"]')).toBeVisible({ timeout: 15_000 });
    await steps.step("palette-ask");
    await page.keyboard.press("Enter");

    // 2. The Question exists from the first delta, and the paragraphs arrive one after another.
    await page.waitForFunction(
      () => ((window as unknown as { __j6?: StreamRecord }).__j6?.counts.length ?? 0) >= 1,
      null,
      { timeout: 240_000 }
    );
    const [first] = await db.query<{ id: string; status: string }>(
      "select id::text as id, status from questions where text = $1 order by created_at desc limit 1",
      [question]
    );
    expect(first, "no `questions` row at the first delta").toBeTruthy();
    expect(first!.status, "the Question's status while it streams").toBe("running");
    await expect(
      page.locator('[data-stage="done"]').first(),
      "the answer never finished"
    ).toBeVisible({ timeout: 120_000 });
    const stream = (await readStream(page))!;
    expect(
      stream.counts.length,
      `distinct paragraph counts before done: ${JSON.stringify(stream.counts)}`
    ).toBeGreaterThanOrEqual(2);
    expect(stream.counts.every((count) => count > 0)).toBe(true);
    test.info().annotations.push({
      type: "stream",
      description: `paragraph counts ${JSON.stringify(stream.counts)} then done at ${stream.doneCount}`
    });
    await expect
      .poll(
        async () =>
          (
            await db!.query<{ status: string }>(
              "select status from questions where id = $1::uuid",
              [first!.id]
            )
          )[0]?.status,
        { message: "the Question never completed", timeout: 60_000 }
      )
      .toBe("complete");
    const [citations] = await db.query<{ n: string }>(
      `select count(*)::text as n from question_citations c
         join question_answers a on a.id = c.answer_id where a.question_id = $1::uuid`,
      [first!.id]
    );
    expect(Number(citations?.n ?? 0), "the stored answer cites nothing").toBeGreaterThan(0);
    await steps.step("answer-done");

    // The Ask panel replaced itself with the Question: a reload would restore it.
    const asked = await expectStack(
      page,
      "explore",
      (stack) => stack.panels.at(-1) === `memora://question/${first!.id}`,
      "the Question is the top panel of Explore"
    );

    // 3. Citation 1 opens the cited object beside the answer, its anchor highlighted.
    await page.locator('[data-surface="question"] [data-citation="1"]').first().click();
    const cited = await expectStack(
      page,
      "explore",
      (stack) =>
        stack.panels.length === asked.panels.length + 1 &&
        /^memora:\/\/source\/[0-9a-f-]{36}#.*passage=/u.test(stack.panels.at(-1) ?? ""),
      "citation 1 pushed a source with a passage anchor"
    );
    await expect(
      page.locator('[data-surface="source"][data-panel-top]'),
      "the cited source panel did not reach success"
    ).toHaveAttribute("data-state", "success", { timeout: 60_000 });
    await expect(
      page.locator('[data-surface="source"][data-panel-top] [data-cited-passage="true"]').first(),
      `the cited passage is not highlighted (${cited.panels.at(-1)})`
    ).toBeVisible({ timeout: 30_000 });
    await steps.step("citation-passage");

    // 4. After a reload, Library > Questions lists the Question and its page shows the stored answer.
    await page.reload();
    await expect(surface(page, "shell").first()).toBeVisible({ timeout: 60_000 });
    await pressMenuShortcut(session, "3");
    const library = surface(page, "destination-library");
    await expect(library, "the Library did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    await library.locator('[role="tablist"] [role="tab"]').nth(1).click();
    const row = library.locator(`[data-nav-key="${first!.id}"]`);
    await expect(row, "Library > Questions does not list the Question").toBeVisible({
      timeout: 30_000
    });
    await steps.step("library-questions");
    await row.click();
    const stored = page.locator('[data-surface="question"][data-panel-top]');
    await expect(stored, "the stored Question page did not reach success").toHaveAttribute(
      "data-state",
      "success",
      { timeout: 60_000 }
    );
    await expect(stored.locator('[data-stage="done"]').first()).toBeVisible({ timeout: 30_000 });
    const shown = await stored.locator("[data-answer-paragraph]").count();
    const [answer] = await db.query<{ n: string }>(
      `select jsonb_array_length(paragraphs)::text as n from question_answers
        where question_id = $1::uuid and status = 'complete' order by version desc limit 1`,
      [first!.id]
    );
    expect(shown, "the stored answer's paragraphs on the page").toBe(Number(answer?.n ?? -1));
    await steps.step("stored-answer");

    // The app's own read of the Question agrees with the store.
    expect(
      await invokeApp<{ id: string } | null>(page, "questions.get", { id: first!.id })
    ).toMatchObject({ id: first!.id });
    await steps.finish(test.info());
  } finally {
    await db?.close();
    await session.close();
  }
});
