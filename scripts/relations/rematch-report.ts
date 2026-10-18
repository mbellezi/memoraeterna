/**
 * The report of a relation re-match run (F3 T52b, spec 3.17): the Markdown the orchestrator reads
 * from the `summary.json` the harness wrote (`apps/desktop/src/main/services/dev/relations-rematch.ts`).
 * It shows the run's identity, X3's clock (T0, T1 and W normalized to 200 notes), the timeline of the
 * roots (release, decide, link) with a bar per root, the AI calls by task, lane and class, the
 * cassette's served, live and missed entries, the relations and typings the run produced, and the
 * flags that make a run unusable (a miss, a failure, a digest that was not checked, link jobs left).
 *
 *   npm run relations:rematch-report -- .cache/f3/rematch/<run>/summary.json [--out report.md]
 *
 * Reads the summary only, never the database; the report names library titles, so it stays under
 * `.cache/` like the summary.
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  RematchSummarySchema,
  type RematchSummary,
  type RematchTimelineEntry
} from "../../apps/desktop/src/main/services/dev/relations-rematch-summary.ts";

export const rematchReportUsage = `Usage: npx tsx scripts/relations/rematch-report.ts <summary.json> [--out <file.md>]

  <summary.json>   The summary a re-match run wrote (.cache/f3/rematch/<run>/summary.json).
  --out <file.md>  Write the Markdown here instead of printing it.
  --help           Show this text.`;

export function parseRematchSummary(raw: unknown): RematchSummary {
  return RematchSummarySchema.parse(raw);
}

const seconds = (ms: number | null, digits = 1): string =>
  ms === null ? "-" : (ms / 1000).toFixed(digits);
const minutes = (ms: number | null): string => (ms === null ? "-" : (ms / 60_000).toFixed(2));
const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)]!;
};
const cell = (value: string | number | null): string =>
  String(value ?? "-")
    .replace(/\|/gu, "\\|")
    .replace(/\s+/gu, " ");

function table(
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number | null>>
) {
  if (rows.length === 0) return "_none_\n";
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ].join("\n");
}

/** The root's end: its link job's, else the commit of its decide step. */
const doneAt = (entry: RematchTimelineEntry): number | null =>
  entry.link?.finishedAtMs ?? entry.decideCommittedAtMs;

/** One bar per root: `.` before its release, `D` while it decides, `L` while its link job works. */
function timelineBar(entry: RematchTimelineEntry, totalMs: number, width = 48): string {
  if (totalMs <= 0) return "";
  const column = (ms: number | null) =>
    ms === null ? null : Math.min(width, Math.round((ms / totalMs) * width));
  const decideFrom = column(entry.decideStartedAtMs) ?? 0;
  const decideTo = column(entry.decideCommittedAtMs) ?? width;
  const linkFrom = column(entry.link?.startedAtMs ?? entry.linkEnqueuedAtMs) ?? decideTo;
  const linkTo = column(entry.link?.finishedAtMs ?? null) ?? width;
  return Array.from({ length: width }, (_, index) =>
    index >= decideFrom && index < Math.max(decideTo, decideFrom + 1)
      ? "D"
      : index >= linkFrom &&
          index < Math.max(linkTo, linkFrom + 1) &&
          entry.linkEnqueuedAtMs !== null
        ? "L"
        : index < decideFrom
          ? "."
          : "-"
  ).join("");
}

/** The things that make a run unusable or worth a second look. */
export function rematchFlags(summary: RematchSummary): string[] {
  const flags: string[] = [];
  if (summary.outcome !== "completed")
    flags.push(`The run ended ${summary.outcome}${summary.error ? `: ${summary.error}` : ""}.`);
  const cassette = summary.cassette;
  if (cassette && cassette.misses > 0)
    flags.push(`${cassette.misses} cassette misses (the first ones are listed below).`);
  if (
    cassette?.mode === "record" &&
    cassette.maxLiveTokens !== null &&
    cassette.liveTokens >= cassette.maxLiveTokens
  )
    flags.push("The live token cap was reached: later calls were refused.");
  const failed = summary.aiCalls.reduce((sum, call) => sum + call.failed, 0);
  if (failed > 0) flags.push(`${failed} AI calls failed.`);
  const linkFailures = summary.linkJobs.failures.length;
  if (linkFailures > 0) flags.push(`${linkFailures} link jobs failed or reported an error.`);
  if (summary.timeline.length < summary.plan.released)
    flags.push(
      `${summary.plan.released - summary.timeline.length} of ${summary.plan.released} roots were never released.`
    );
  if (summary.timeline.some((entry) => entry.decideCommittedAtMs === null))
    flags.push("A root's decide step did not commit.");
  if (summary.drainedAt === null && summary.outcome !== "failed")
    flags.push("The link jobs did not drain.");
  if (summary.digest.actual.sha256 !== summary.digest.expected.sha256)
    flags.push("The notes digest differs from the pinned one.");
  return flags;
}

export function renderRematchReport(summary: RematchSummary): string {
  const wallMs = Date.parse(summary.finishedAt) - Date.parse(summary.startedAt);
  const totalMs = Math.max(wallMs, ...summary.timeline.map((entry) => doneAt(entry) ?? 0));
  const order =
    summary.order === null
      ? "burst (every root visible from the start)"
      : summary.order.kind === "manifest"
        ? "arrival, manifest order (S0)"
        : `arrival, seed ${summary.order.seed}`;
  const lags = summary.timeline.flatMap((entry) =>
    entry.link?.finishedAtMs != null ? [entry.link.finishedAtMs - entry.releasedAtMs] : []
  );
  const decides = summary.timeline.flatMap((entry) =>
    entry.decideCommittedAtMs === null ? [] : [entry.decideCommittedAtMs - entry.decideStartedAtMs]
  );
  const flags = rematchFlags(summary);
  const cassette = summary.cassette;
  const lines: string[] = [
    `# Re-match run ${summary.runId}`,
    "",
    flags.length === 0
      ? "**Usable:** completed, no miss, no failure."
      : `**Check before use:**\n${flags.map((flag) => `- ${flag}`).join("\n")}`,
    "",
    "## Run",
    "",
    table(
      ["Item", "Value"],
      [
        ["Outcome", summary.outcome],
        ["Order", order],
        [
          "Profile",
          `${summary.profile.name}${summary.profile.kind ? ` (${summary.profile.kind})` : ""}`
        ],
        ["Lanes", summary.lanes.mode],
        [
          "Background",
          summary.background === "matched" ? `matched (${summary.backgroundSeeded} roots)` : "none"
        ],
        [
          "Roots released",
          `${summary.timeline.length} of ${summary.plan.released} (${summary.plan.notes} notes planned, ${summary.plan.withoutNotes} roots without notes)`
        ],
        [
          "Notes decided",
          `${summary.matching.decided} (${summary.matching.accepted} accepted pairs handed on)`
        ],
        [
          "Notes digest",
          `${summary.digest.actual.notes} notes, ${summary.digest.actual.sha256.slice(0, 16)}`
        ],
        [
          "Cleared",
          Object.entries(summary.cleared)
            .filter(([, value]) => value > 0)
            .map(([name, value]) => `${name} ${value}`)
            .join(", ") || "nothing"
        ],
        ["Wall time", `${minutes(wallMs)} min`]
      ]
    ),
    "",
    "## X3 clock",
    "",
    table(
      ["T0 (s)", "T1 (s)", "Span (min)", "Notes released", "W for 200 notes (min)"],
      [
        [
          seconds(summary.clock.t0Ms),
          seconds(summary.clock.t1Ms),
          minutes(summary.clock.rawMs),
          summary.clock.notesReleased,
          minutes(summary.clock.normalized200Ms)
        ]
      ]
    ),
    "",
    "T0 is the admission of the first decide call and T1 the commit of the last relation, typing, veto or source relation, both from the start of the run.",
    "",
    "## Timeline",
    "",
    `Per root, \`.\` before its release, \`D\` while its notes are decided, \`L\` while its link job works (${seconds(totalMs)} s in all), - elsewhere.`,
    "",
    table(
      [
        "#",
        "Root",
        "Part.",
        "Notes",
        "Released (s)",
        "Decide (s)",
        "Accepted",
        "Link jobs",
        "Link done (s)",
        "Lag (s)",
        ""
      ],
      summary.timeline.map((entry) => [
        entry.index + 1,
        entry.title,
        entry.partition,
        entry.decided,
        seconds(entry.releasedAtMs),
        seconds(
          entry.decideCommittedAtMs === null
            ? null
            : entry.decideCommittedAtMs - entry.decideStartedAtMs
        ),
        entry.accepted,
        entry.link?.jobs ?? 0,
        seconds(entry.link?.finishedAtMs ?? null),
        seconds(
          entry.link?.finishedAtMs == null ? null : entry.link.finishedAtMs - entry.releasedAtMs
        ),
        `\`${timelineBar(entry, totalMs)}\``
      ])
    ),
    "",
    `Decide per root p50 ${seconds(percentile(decides, 0.5))} s, p95 ${seconds(percentile(decides, 0.95))} s; release to link done (lag) p50 ${seconds(percentile(lags, 0.5))} s, p95 ${seconds(percentile(lags, 0.95))} s.`,
    "",
    "## AI calls",
    "",
    table(
      [
        "Task",
        "Class",
        "Lane",
        "Calls",
        "Replayed",
        "Failed",
        "Repairs",
        "In",
        "Out",
        "p50 ms",
        "p95 ms",
        "Wait p50",
        "Wait p95"
      ],
      summary.aiCalls.map((call) => [
        call.taskType,
        call.workloadClass,
        call.lane,
        call.calls,
        call.replayed,
        call.failed,
        call.repairs,
        call.inputTokens,
        call.outputTokens,
        call.durationMs.p50,
        call.durationMs.p95,
        call.requeueMs.p50,
        call.requeueMs.p95
      ])
    ),
    "",
    "## Cassette",
    ""
  ];
  if (!cassette) lines.push("_No cassette._", "");
  else {
    lines.push(
      table(
        [
          "Mode",
          "Timing",
          "Served",
          "Recorded",
          "Misses",
          "Live local",
          "Live tokens",
          "Cap",
          "Waited (s)"
        ],
        [
          [
            cassette.mode,
            cassette.timing ?? "off",
            cassette.served,
            cassette.recorded,
            cassette.misses,
            cassette.liveLocalMisses,
            cassette.liveTokens,
            cassette.maxLiveTokens,
            seconds(cassette.waitedMs)
          ]
        ]
      ),
      "",
      table(
        ["Task", "Served", "Recorded", "Misses", "Live local"],
        Object.entries(cassette.byTask).map(([task, value]) => [
          task,
          value.served,
          value.recorded,
          value.misses,
          value.liveLocalMisses ?? 0
        ])
      ),
      ""
    );
    if (cassette.missDetails.length > 0)
      lines.push(
        "Misses:",
        ...cassette.missDetails.map((miss) => `- ${miss.taskType} ${miss.key.slice(0, 16)}`),
        ""
      );
  }
  lines.push(
    "## Relations",
    "",
    table(
      ["Status", "Band", "Type", "Veto", "Count"],
      summary.noteRelations.map((row) => [
        row.status,
        row.band,
        row.relationType,
        row.vetoSource,
        row.count
      ])
    ),
    "",
    table(
      ["Typing", "Count"],
      summary.typings.map((row) => [row.relationType, row.count])
    ),
    "",
    table(
      ["Source relations", "Status", "Count"],
      summary.sourceRelations.map((row) => [row.origin, row.status, row.count])
    ),
    "",
    "## Link jobs",
    "",
    table(
      ["Total", ...Object.keys(summary.linkJobs.byStatus)],
      [[summary.linkJobs.total, ...Object.values(summary.linkJobs.byStatus)]]
    ),
    ""
  );
  if (summary.linkJobs.failures.length > 0)
    lines.push(
      "Failures:",
      ...summary.linkJobs.failures.map((failure) => `- ${failure.rootId ?? "?"}: ${failure.error}`),
      ""
    );
  return `${lines.join("\n")}\n`;
}

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { out: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
    strict: true
  });
  if (values.help || positionals.length !== 1) {
    console.info(rematchReportUsage);
    if (!values.help) process.exitCode = 2;
    return;
  }
  const summary = parseRematchSummary(JSON.parse(await readFile(resolve(positionals[0]!), "utf8")));
  const markdown = renderRematchReport(summary);
  if (values.out) {
    await writeFile(resolve(values.out), markdown);
    console.info(`Report written to ${resolve(values.out)}`);
  } else process.stdout.write(markdown);
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[rematch-report] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
