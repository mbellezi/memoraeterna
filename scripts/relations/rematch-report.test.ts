import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  noCompositeBackfill,
  rematchSummaryFormat,
  type RematchSummary,
  type RematchTimelineEntry
} from "../../apps/desktop/src/main/services/dev/relations-rematch-summary.ts";
import { main, parseRematchSummary, rematchFlags, renderRematchReport } from "./rematch-report.ts";

const entry = (
  index: number,
  title: string,
  extra: Partial<RematchTimelineEntry> = {}
): RematchTimelineEntry => ({
  index,
  rootId: `root-${index}`,
  title,
  partition: index < 2 ? "tuning" : "holdout",
  records: 1,
  notes: 3,
  releasedAtMs: index * 10_000,
  decideStartedAtMs: index * 10_000,
  decideCommittedAtMs: index * 10_000 + 8_000,
  decided: 3,
  accepted: 2,
  linkEnqueuedAtMs: index * 10_000 + 8_000,
  link: {
    jobs: 1,
    status: "succeeded",
    startedAtMs: index * 10_000 + 9_000,
    finishedAtMs: index * 10_000 + 20_000,
    error: null
  },
  ...extra
});

const summary = (extra: Partial<RematchSummary> = {}): RematchSummary => ({
  format: rematchSummaryFormat,
  version: 1,
  runId: "2026-10-17T10-00-00-000Z",
  outcome: "completed",
  error: null,
  mode: "arrival",
  order: { kind: "seeded", seed: 20261031 },
  background: "none",
  discovery: "on",
  candidates: "off",
  lanes: { mode: "serial" },
  profile: { name: "env-f-s1", kind: "env-f" },
  startedAt: "2026-10-17T10:00:00.000Z",
  finishedAt: "2026-10-17T10:01:00.000Z",
  drainedAt: "2026-10-17T10:01:00.000Z",
  digest: {
    expected: { notes: 138, sha256: "a".repeat(64) },
    actual: { notes: 138, sha256: "a".repeat(64) }
  },
  deciderKey: "key",
  cleared: {
    noteRelations: 137,
    decisions: 0,
    typings: 0,
    noteMatchState: 0,
    sourceRelations: 1,
    sourceDecisions: 0,
    sourceMatchState: 0,
    runs: 0,
    events: 0
  },
  backgroundSeeded: 0,
  backgroundNotesSeeded: 0,
  compositeBackfill: noCompositeBackfill,
  plan: { released: 4, background: 0, withoutNotes: 1, notes: 12 },
  timeline: [
    entry(0, "Aprendizagem"),
    entry(1, "Memória"),
    entry(2, "Sono"),
    entry(3, "Pipe | root")
  ],
  clock: {
    t0Ms: 1_000,
    t1Ms: 61_000,
    rawMs: 60_000,
    notesReleased: 12,
    normalized200Ms: 1_000_000
  },
  matching: { decided: 12, accepted: 8 },
  cassette: {
    mode: "record",
    directory: "/repo/.cache/golden/cassettes/x",
    timing: null,
    served: 30,
    recorded: 6,
    misses: 0,
    liveLocalMisses: 0,
    liveTokens: 9_000,
    maxLiveTokens: 40_000,
    waitedMs: 0,
    byTask: { reranking: { served: 30, recorded: 0, misses: 0 } },
    missDetails: []
  },
  aiCalls: [
    {
      taskType: "reranking",
      workloadClass: "decide",
      lane: "local",
      calls: 30,
      replayed: 30,
      failed: 0,
      repairs: 0,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: { total: 3000, p50: 90, p95: 140 },
      requeueMs: { p50: 0, p95: 4 }
    }
  ],
  noteRelations: [
    { status: "accepted", band: "apply", relationType: "supports", vetoSource: null, count: 5 }
  ],
  typings: [{ relationType: "supports", count: 5 }],
  sourceRelations: [{ origin: "promoted", status: "accepted", count: 2 }],
  linkJobs: { total: 4, byStatus: { succeeded: 4 }, failures: [] },
  ...extra
});

describe("the re-match report", () => {
  it("reads a summary and refuses anything else", () => {
    expect(parseRematchSummary(JSON.parse(JSON.stringify(summary())))).toEqual(summary());
    expect(() => parseRematchSummary({ ...summary(), version: 2 })).toThrow();
    expect(() => parseRematchSummary({ ...summary(), extra: true })).toThrow();
  });

  it("says a clean run is usable and shows its identity and X3's clock", () => {
    const markdown = renderRematchReport(summary());
    expect(markdown).toContain("# Re-match run 2026-10-17T10-00-00-000Z");
    expect(markdown).toContain("**Usable:** completed, no miss, no failure.");
    expect(markdown).toContain("arrival, seed 20261031");
    expect(markdown).toContain("env-f-s1 (env-f)");
    expect(markdown).toContain("| Lanes | serial |");
    expect(markdown).toContain("| Source discovery | on |");
    expect(markdown).toContain("| Candidate lists | not kept |");
    expect(markdown).toContain("4 of 4 (12 notes planned, 1 roots without notes)");
    expect(markdown).toContain("noteRelations 137, sourceRelations 1");
    // T0 1 s, T1 61 s, a 1-minute span, 12 notes, and 1,000 s for 200 notes (16.67 min).
    expect(markdown).toContain("| 1.0 | 61.0 | 1.00 | 12 | 16.67 |");
  });

  it("draws one row and one bar per root, with the lag from release to the end of its link job", () => {
    const markdown = renderRematchReport(summary());
    const rows = markdown.split("\n").filter((line) => /^\| [1-4] \|.*`[-.DL]+`/u.test(line));
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain(
      "| 1 | Aprendizagem | tuning | 3 | 0.0 | 8.0 | 2 | 1 | 20.0 | 20.0 |"
    );
    expect(rows[3]).toContain("Pipe \\| root");
    const bars = rows.map((row) => /`([-.DL]+)`/u.exec(row)?.[1] ?? "");
    for (const bar of bars) {
      expect(bar).toHaveLength(48);
      expect(bar).toContain("D");
      expect(bar).toContain("L");
    }
    // A later root starts its decide step further right.
    expect(bars[3]!.indexOf("D")).toBeGreaterThan(bars[0]!.indexOf("D"));
    expect(markdown).toContain("lag) p50 20.0 s, p95 20.0 s");
  });

  it("lists the calls, the cassette and the relations", () => {
    const markdown = renderRematchReport(summary());
    expect(markdown).toContain(
      "| reranking | decide | local | 30 | 30 | 0 | 0 | 0 | 0 | 90 | 140 | 0 | 4 |"
    );
    expect(markdown).toContain("| record | off | 30 | 6 | 0 | 0 | 9000 | 40000 | 0.0 |");
    expect(markdown).toContain("| accepted | apply | supports | - | 5 |");
    expect(markdown).toContain("| promoted | accepted | 2 |");
  });

  it("flags a miss, a failure, a cap that was reached, an undrained run and another digest", () => {
    expect(rematchFlags(summary())).toEqual([]);
    const bad = summary({
      outcome: "drainTimeout",
      drainedAt: null,
      digest: {
        expected: { notes: 138, sha256: "a".repeat(64) },
        actual: { notes: 137, sha256: "b".repeat(64) }
      },
      cassette: {
        ...summary().cassette!,
        misses: 2,
        liveTokens: 40_000,
        missDetails: [{ taskType: "atomic-note-generation", key: "k".repeat(64) }]
      },
      aiCalls: [{ ...summary().aiCalls[0]!, failed: 3 }],
      linkJobs: {
        total: 4,
        byStatus: { succeeded: 3, failed: 1 },
        failures: [{ rootId: "root-2", error: "errors.ai.providerUnavailable" }]
      },
      timeline: [entry(0, "Aprendizagem", { decideCommittedAtMs: null })]
    });
    const flags = rematchFlags(bad);
    expect(flags).toEqual(
      expect.arrayContaining([
        "The run ended drainTimeout.",
        "2 cassette misses (the first ones are listed below).",
        "The live token cap was reached: later calls were refused.",
        "3 AI calls failed.",
        "1 link jobs failed or reported an error.",
        "3 of 4 roots were never released.",
        "A root's decide step did not commit.",
        "The link jobs did not drain.",
        "The notes digest differs from the pinned one."
      ])
    );
    const markdown = renderRematchReport(bad);
    expect(markdown).toContain("**Check before use:**");
    expect(markdown).toContain("- root-2: errors.ai.providerUnavailable");
    expect(markdown).toContain("- atomic-note-generation kkkkkkkkkkkkkkkk");
  });

  it("says how many composites the run backfilled and which topic re-placements they caused", () => {
    const backfilled = summary({
      compositeBackfill: {
        jobs: 1,
        examined: 11,
        written: 11,
        rebuilt: 0,
        current: 0,
        incomplete: 0,
        failed: 0,
        skipped: [],
        remaining: 0,
        waitedMs: 4_200,
        placements: {
          backfilledRoots: 11,
          withCurrentNotes: 10,
          moved: 1,
          movedWithCurrentNotes: 0,
          topicJobsOpen: 0,
          moves: [
            {
              rootId: "root-9",
              title: "Livro | sem notas",
              hasCurrentNotes: false,
              before: { topicId: "11111111-aaaa", needsVector: true },
              after: { topicId: "22222222-bbbb", needsVector: false }
            }
          ]
        }
      }
    });
    expect(rematchFlags(backfilled)).toEqual([]);
    const markdown = renderRematchReport(backfilled);
    expect(markdown).toContain("## Composite backfill");
    expect(markdown).toContain("| 1 | 11 | 11 | 0 | 0 | 0 | 0 | 0 | 4.2 |");
    expect(markdown).toContain(
      "11 roots had a composite written, 10 of them with current notes (their vector comes from their notes); 1 moved once PLACE ran, 0 of them with current notes."
    );
    expect(markdown).toContain("| Livro \\| sem notas | no | 11111111 (needs vector) | 22222222 |");
    // A run that backfilled nothing says so with zeros, and is usable.
    expect(renderRematchReport(summary())).toContain("| 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0.0 |");
  });

  it("flags a hierarchy root left without a composite and a root with notes that moved", () => {
    const bad = summary({
      compositeBackfill: {
        ...summary().compositeBackfill,
        failed: 1,
        remaining: 2,
        placements: {
          ...summary().compositeBackfill.placements,
          moved: 1,
          movedWithCurrentNotes: 1,
          topicJobsOpen: 3
        }
      }
    });
    expect(rematchFlags(bad)).toEqual(
      expect.arrayContaining([
        "2 hierarchy roots still have no composite vector: discovery skips them.",
        "1 composite backfill nodes or jobs failed.",
        "3 topic placement jobs caused by the composite backfill were still open when the run started.",
        "1 roots with current notes moved in the topic tree after the composite backfill (3.20 expects none)."
      ])
    );
  });

  it("renders a burst with no order and a run without a cassette", () => {
    const markdown = renderRematchReport(summary({ mode: "burst", order: null, cassette: null }));
    expect(markdown).toContain("burst (every root visible from the start)");
    expect(markdown).toContain("_No cassette._");
  });
});

describe("the report command", () => {
  let directory = "";
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "memora-rematch-report-"));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it("writes the Markdown of a summary file", async () => {
    const input = join(directory, "summary.json");
    const output = join(directory, "report.md");
    await writeFile(input, JSON.stringify(summary()));
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    await main([input, "--out", output]);
    expect(await readFile(output, "utf8")).toContain("# Re-match run 2026-10-17T10-00-00-000Z");
  });

  it("prints its usage for --help and for a missing file name", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    await main(["--help"]);
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Usage: npx tsx scripts/relations/rematch-report.ts")
    );
    const code = process.exitCode;
    await main([]);
    expect(process.exitCode).toBe(2);
    process.exitCode = code;
  });
});
