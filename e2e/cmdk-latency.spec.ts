// cmdk-latency (F5 T145, spec 5.2 bar X3(b) and 3.5): Cmd-K on a clone of ENV-C with no import. The
// same query set as `npm run bench:omni` (seed 20261111, 50 titles per kind, prefixes of 2-12
// characters, `typedPrefixes`) is typed key by key at 80 ms per key into the palette of the built
// app. The app writes `omni:key`, `omni:send` and `omni:paint` marks (`lib/omni-marks.ts`); this
// spec reads them with `page.evaluate` after each query, clears them (the app bounds them at 2,000),
// and hands them to `analyzeOmniLatency`: a key's latency is the first paint of its own query or a
// later one, minus the key's time stamp. The bar is p95 <= 100 ms; the queue wait, the share of keys
// whose query was never sent and the service's own time (`tookMs`, the "SQL" half of the split the
// X3(a) note asks for) are reported, and the whole report is written beside the run's evidence.
//
// Profile: `MEMORA_CMDK_PROFILE` (an absolute ENV-C clone under `.cache/f5/scratch/`, closed, no
// `postmaster.pid`) is cloned into the run. It is required: the bar is stated on ENV-C's library, so a
// run on a smaller one (BASE-J) would meet it and prove nothing. The source's name is written into
// the report and the annotations. Run from the proof worktree, in a slot window, with
// `MEMORA_CMDK_PROFILE=<abs path> npm run journeys -- --grep cmdk-latency`.
import { mkdir, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import { currentNoteSql } from "@app/db";
import { expect, test } from "@playwright/test";

import {
  analyzeOmniLatency,
  type OmniLatencyReport
} from "../apps/desktop/src/renderer/workspace/palette/omni-latency";
import {
  buildQuerySet,
  omniQueriesPerKind,
  omniQuerySeed,
  typedPrefixes,
  type OmniQueryKind,
  type TitleSample
} from "../scripts/bench/omni-queries";
import {
  captureStep,
  launchMemora,
  setContentSize,
  waitForDatabase,
  type MemoraSession
} from "./support/app.js";
import { openProfileDb } from "./support/db.js";
import { clearMarks, readMarks, type MarkEntry } from "./support/perf.js";
import { cloneProfile, journeysRun, profileDir } from "./support/profile.js";

/** The bar (X3(b)): p95 from a key to the paint of its results, in milliseconds. */
export const p95BarMs = 100;
const keyDelayMs = 80;

/** The titles each kind's query set draws from: what omni's statement makes visible (as the bench). */
const titleSql: Record<OmniQueryKind, string> = {
  source: "select id::text as id, title from source_items where title is not null",
  topic: `select t.id::text as id, t.title from topics t
    where t.title is not null and t.retired_at is null
      and coalesce((select tt.status = 'active' from topic_trees tt where tt.id = t.tree_id), false)`,
  note: `select n.id::text as id, n.title from atomic_notes n
    where n.title is not null and ${currentNoteSql("n")}`,
  entity: "select id::text as id, canonical_name as title from entities",
  question: "select id::text as id, left(text, 200) as title from questions"
};

/** The ENV-C clone this run measures; the spec refuses to run without one. */
function profileSource(): string {
  const source = process.env.MEMORA_CMDK_PROFILE?.trim();
  if (!source)
    throw new Error(
      "MEMORA_CMDK_PROFILE is required: bar X3(b) is measured on an ENV-C clone, never on BASE-J"
    );
  if (!isAbsolute(source)) throw new Error("MEMORA_CMDK_PROFILE must be an absolute path");
  return source;
}

async function openSession(source: string): Promise<MemoraSession> {
  const run = journeysRun();
  const userDataDir = await cloneProfile(source, profileDir(run, "cmdk-latency"), run.repoRoot);
  return launchMemora({ run, userDataDir });
}

test("cmdk-latency: Cmd-K p95 from a key to its paint stays within 100 ms", async () => {
  test.setTimeout(90 * 60_000);
  const run = journeysRun();
  const source = profileSource();
  const profile = basename(source);
  const session = await openSession(source);
  let db: Awaited<ReturnType<typeof openProfileDb>> | null = null;
  try {
    const { page } = session;
    await waitForDatabase(page, 180_000);
    await setContentSize(session, 1280, 800);
    db = await openProfileDb(session.userDataDir);
    const titles: Partial<Record<OmniQueryKind, TitleSample[]>> = {};
    for (const [kind, sql] of Object.entries(titleSql) as [OmniQueryKind, string][])
      titles[kind] = await db.query<TitleSample & Record<string, unknown>>(sql);
    const queries = buildQuerySet(titles, { seed: omniQuerySeed, perKind: omniQueriesPerKind });
    expect(queries.length, "the clone has no titles to type").toBeGreaterThan(0);

    const palette = page.locator('[data-surface="palette"]');
    const marks: MarkEntry[] = [];
    await clearMarks(page, "omni:");
    for (const query of queries) {
      await page.keyboard.press("Meta+K");
      await expect(palette).toBeVisible();
      let typed = "";
      for (const prefix of typedPrefixes(query)) {
        const next = [...prefix].slice([...typed].length).join("");
        await page.keyboard.type(next);
        typed = prefix;
        await page.waitForTimeout(keyDelayMs);
      }
      // The last answer reaches the screen: a paint of a request sent at or after the last key. (The
      // palette's `data-state` is no signal: while the last query is on its way it still shows the
      // answer before it.)
      await page.waitForFunction(
        () => {
          const detail = (entry: PerformanceEntry) =>
            (entry as PerformanceMark).detail as { seq: number };
          const keys = performance.getEntriesByName("omni:key", "mark").map(detail);
          if (keys.length === 0) return false;
          const last = Math.max(...keys.map((key) => key.seq));
          return performance
            .getEntriesByName("omni:paint", "mark")
            .some((entry) => detail(entry).seq >= last);
        },
        undefined,
        { timeout: 15_000 }
      );
      marks.push(...(await readMarks(page, "omni:")));
      await clearMarks(page, "omni:");
      // Escape is not an edit key: the next query starts from an empty box and no mark.
      await page.keyboard.press("Escape");
      await expect(palette).toHaveCount(0);
    }

    const report: OmniLatencyReport = analyzeOmniLatency(marks);
    const evidence = join(run.evidenceDir, "cmdk-latency");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "report.json"),
      `${JSON.stringify({ bar: { p95Ms: p95BarMs }, profile, queries: queries.length, report }, null, 2)}\n`
    );
    // One look at the palette with results, in both themes, for the record.
    await page.keyboard.press("Meta+K");
    await page.keyboard.type(queries[0]?.query ?? "a");
    await page.waitForTimeout(400);
    await captureStep(session, "cmdk-latency", 1, "palette");
    await page.keyboard.press("Escape");

    test.info().annotations.push(
      { type: "profile", description: profile },
      {
        type: "latency",
        description: `p50 ${report.latency.p50} ms, p95 ${report.latency.p95} ms, max ${report.latency.max} ms over ${report.keys} keys`
      },
      {
        type: "queue wait",
        description: `p95 ${report.queueWait.p95} ms; ${(report.neverSentShare * 100).toFixed(1)}% of keys never sent`
      },
      {
        type: "service",
        description: `tookMs p50 ${report.service.p50} ms, p95 ${report.service.p95} ms`
      }
    );
    expect(report.keys, "the app wrote no omni:key marks").toBeGreaterThan(0);
    expect(report.unresolved, "keys with no paint after them").toBe(0);
    expect(report.latency.p95 ?? Infinity).toBeLessThanOrEqual(p95BarMs);
  } finally {
    await db?.close();
    await session.close();
  }
});
