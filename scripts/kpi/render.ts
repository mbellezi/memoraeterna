import type { AiGroup, MatchingGroup, StageKpi } from "./aggregate.js";
import type { KpiReport, Section } from "./report.js";
import type { Distribution } from "./stats.js";

/** Renders the KPI report as Markdown. Numbers are formatted in en-US so output is stable. */

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

export const fmtInt = (value: number | null | undefined): string =>
  value === null || value === undefined ? "n/a" : integer.format(value);

export function fmtSeconds(value: number | null | undefined): string {
  if (value === null || value === undefined) return "n/a";
  const digits = Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0;
  return value.toFixed(digits);
}

/** `p50 / p95` of a distribution in seconds, or `n/a`. */
export function fmtPair(distribution: Distribution | null | undefined): string {
  return distribution ? `${fmtSeconds(distribution.p50)} / ${fmtSeconds(distribution.p95)}` : "n/a";
}

export const fmtPercent = (value: number | null | undefined): string =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;

/** Token or cost total with the number of calls that reported it, when that is not all of them. */
function reported(total: { sum: number; reportedCalls: number }, calls: number): string {
  if (total.reportedCalls === 0) return "n/a";
  return total.reportedCalls === calls
    ? fmtInt(total.sum)
    : `${fmtInt(total.sum)} (${fmtInt(total.reportedCalls)}/${fmtInt(calls)})`;
}

const cell = (value: string | number): string => String(value).replaceAll("|", "\\|");

export function table(
  headers: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>
): string {
  if (rows.length === 0) return "_none_\n";
  const lines = [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`)
  ];
  return `${lines.join("\n")}\n`;
}

const counts = (record: Record<string, number>): string =>
  Object.entries(record)
    .sort(([, a], [, b]) => b - a)
    .map(([name, count]) => `${name} ${fmtInt(count)}`)
    .join(", ") || "none";

function unavailable(section: Extract<Section<unknown>, { available: false }>): string {
  return `_Not available: ${section.reason}._\n`;
}

function when<T>(section: Section<T>, render: (data: T) => string): string {
  return section.available ? render(section.data) : unavailable(section);
}

function aiRow(label: ReadonlyArray<string>, group: AiGroup): Array<string | number> {
  return [
    ...label,
    fmtInt(group.calls),
    fmtInt(group.failed + group.canceled),
    reported(group.inputTokens, group.calls),
    reported(group.outputTokens, group.calls),
    reported(group.reasoningTokens, group.calls),
    fmtPair(group.durationSeconds),
    group.queueSeconds ? `${fmtPair(group.queueSeconds)} (${fmtInt(group.queueSeconds.n)})` : "n/a",
    group.retries.reportedCalls
      ? `${fmtInt(group.retries.retryCalls)}/${fmtInt(group.retries.reportedCalls)}`
      : "n/a",
    group.cost.knownCalls
      ? `${group.cost.sum.toFixed(4)} (${fmtInt(group.cost.knownCalls)}/${fmtInt(group.calls)})`
      : "unknown"
  ];
}

const aiColumns = [
  "Calls",
  "Failed or canceled",
  "Input tokens",
  "Output tokens",
  "Reasoning tokens",
  "Duration p50 / p95 (s)",
  "Queue p50 / p95 (s) (calls)",
  "Retries (reported)",
  "Cost (calls with cost)"
];

function stageRow(stage: StageKpi): Array<string | number> {
  return [
    stage.stage,
    fmtInt(stage.executed),
    fmtInt(stage.reused),
    fmtInt(stage.skipped),
    fmtInt(stage.failed + stage.canceled),
    fmtInt(stage.retried),
    fmtPair(stage.wallSeconds),
    fmtPair(stage.attemptSeconds),
    fmtInt(stage.durationUnknown)
  ];
}

function matchingRows(group: MatchingGroup | null, target: string): string {
  if (!group) return "_No calls recorded._\n";
  return table(
    [
      "Calls",
      "Failed",
      `Distinct ${target}s`,
      `Calls per ${target}`,
      `Seconds per ${target}`,
      "Call p50 / p95 (s)",
      "Queue p50 / p95 (s)",
      "Retries (reported)"
    ],
    [
      [
        fmtInt(group.calls),
        fmtInt(group.failed),
        fmtInt(group.distinctTargets),
        group.callsPerTarget === null ? "n/a" : group.callsPerTarget.toFixed(2),
        fmtSeconds(group.secondsPerTarget),
        fmtPair(group.callSeconds),
        fmtPair(group.queueSeconds),
        group.retries.reportedCalls
          ? `${fmtInt(group.retries.retryCalls)}/${fmtInt(group.retries.reportedCalls)}`
          : "n/a"
      ]
    ]
  );
}

export function renderMarkdown(report: KpiReport): string {
  const out: string[] = [];
  const { database } = report;
  out.push("# KPI report", "");
  out.push(
    table(
      ["Field", "Value"],
      [
        [
          "Database",
          `${database.label ?? database.name} (${database.host}:${database.port ?? "?"}/${database.name})`
        ],
        ...(database.provenance
          ? [
              [
                "Restored from",
                `${database.provenance.sourceName} (sha256 ${database.provenance.sha256.slice(0, 12)}, dump ${database.provenance.dumpCreatedAt ?? "unknown"})`
              ]
            ]
          : []),
        [
          "Migrations applied",
          `${fmtInt(database.migrations.applied)} (latest ${database.migrations.latestAt ?? "n/a"})`
        ],
        [
          "Wall-clock columns",
          `stage attempts ${database.instrumentation.stageAttempts ? "yes" : "no"}, AI queue_ms ${database.instrumentation.aiQueueMs ? "yes" : "no"}, AI attempt ${database.instrumentation.aiAttempt ? "yes" : "no"}, monitoring ${database.instrumentation.monitoring ? "yes" : "no"}`
        ],
        ["Generated", report.generatedAt],
        ["As of", `${report.asOf.value ?? "unknown"} (${report.asOf.basis})`]
      ]
    )
  );

  out.push("## Library", "");
  out.push(
    when(report.library, (library) => {
      const parts: string[] = [];
      parts.push(
        table(
          ["Measure", "Value"],
          [
            ...(library.sources
              ? [
                  [
                    "Sources (roots)",
                    `${fmtInt(library.sources.total)} (${fmtInt(library.sources.roots)})`
                  ],
                  ["Sources by type", counts(library.sources.byType)],
                  ...(library.sources.byOrigin
                    ? [["Sources by origin", counts(library.sources.byOrigin)]]
                    : [])
                ]
              : [["Sources", "n/a"]]),
            ["Documents", fmtInt(library.documents)],
            ["Chunks", fmtInt(library.chunks)],
            [
              "Notes (current)",
              library.notes
                ? `${fmtInt(library.notes.total)} (${fmtInt(library.notes.current)})`
                : "n/a"
            ],
            ["Notes by status", library.notes ? counts(library.notes.byStatus) : "n/a"],
            [
              "Note relations",
              library.noteRelations
                ? `${fmtInt(library.noteRelations.total)}: ${counts(library.noteRelations.byStatus)}`
                : "n/a"
            ],
            [
              "Source relations",
              library.sourceRelations
                ? `${fmtInt(library.sourceRelations.total)}: ${counts(library.sourceRelations.byStatus)}`
                : "n/a"
            ],
            ["Entities", fmtInt(library.entities)],
            [
              "Embeddings",
              Object.keys(library.embeddings).length ? counts(library.embeddings) : "n/a"
            ]
          ]
        )
      );
      return parts.join("\n");
    })
  );

  out.push("## Processing", "");
  out.push(
    when(report.processing, (processing) =>
      [
        `Ingestion runs: ${fmtInt(processing.runs.total)} (${counts(processing.runs.byStatus)}). ` +
          `Queue wait p50 / p95: ${fmtPair(processing.runs.queueSeconds)} s. ` +
          `Succeeded run wall time p50 / p95: ${fmtPair(processing.runs.wallSeconds)} s.`,
        "",
        "Stage durations cover stages that executed (reused artifacts excluded). Wall time runs from the first start to completion; attempt time covers the latest attempt only and exists only for stages recorded after the instrumentation migration.",
        "",
        table(
          [
            "Stage",
            "Executed",
            "Reused",
            "Skipped",
            "Failed or canceled",
            "Retried",
            "Wall p50 / p95 (s)",
            "Attempt p50 / p95 (s)",
            "Duration unknown"
          ],
          processing.stages.map(stageRow)
        )
      ].join("\n")
    )
  );

  out.push("## AI usage", "");
  out.push(
    when(report.ai, (ai) =>
      [
        "Durations cover succeeded calls. Unknown token counts, queue waits, retry indexes and costs are left out of the totals, not counted as zero; the bracket shows how many calls reported them. Reasoning tokens are normally a subset of the output tokens that the provider reports.",
        "",
        table(["Scope", ...aiColumns], [aiRow(["All calls"], ai.total)]),
        "By task:",
        "",
        table(
          ["Task", ...aiColumns],
          ai.byTask.map((group) => aiRow([group.task], group))
        ),
        "By route:",
        "",
        table(
          ["Task", "Route", ...aiColumns],
          ai.byRoute.map((group) =>
            aiRow([group.task, `${group.provider} / ${group.model} / ${group.runtime}`], group)
          )
        )
      ].join("\n")
    )
  );

  out.push("## Matching", "");
  out.push(
    when(report.matching, (matching) =>
      [
        "Note matching (one reranking call per note):",
        "",
        matchingRows(matching.noteMatching, "note"),
        "Source matching (one reranking call per source pair attempt):",
        "",
        matchingRows(matching.sourceMatching, "root"),
        ...(matching.unclassifiedReranking
          ? [
              "Reranking calls without a monitoring record (purpose unknown):",
              "",
              matchingRows(matching.unclassifiedReranking, "target")
            ]
          : []),
        "Wall-clock operation spans (recorded only in diagnostic mode), p50 / p95 seconds:",
        "",
        table(
          ["Operation", "Spans", "p50 / p95 (s)"],
          Object.entries(matching.operationSeconds).map(([operation, span]) => [
            operation,
            fmtInt(span?.n ?? 0),
            fmtPair(span)
          ])
        )
      ].join("\n")
    )
  );

  out.push("## Wiki structure", "");
  out.push(
    when(report.wiki, (wiki) =>
      [
        table(
          ["Measure", "Value"],
          [
            ["Pages (archived)", `${fmtInt(wiki.pages)} (${fmtInt(wiki.archivedPages)})`],
            ["AI-managed pages without a parent (orphan roots)", fmtInt(wiki.aiOrphanRoots)],
            ["Human-managed roots", fmtInt(wiki.humanRoots)],
            ["Pages whose parent is outside the live set", fmtInt(wiki.shape.danglingParents)],
            ["Pages unreachable from a root (parent loops)", fmtInt(wiki.shape.unreachable)],
            [
              "Depth (0 = root)",
              wiki.shape.depth
                ? `max ${wiki.shape.maxDepth}, p50 ${wiki.shape.depth.p50.toFixed(1)}, p95 ${wiki.shape.depth.p95.toFixed(1)}; pages per depth: ${Object.entries(
                    wiki.shape.byDepth
                  )
                    .map(([depth, count]) => `${depth}:${count}`)
                    .join(" ")}`
                : "n/a"
            ],
            [
              "Fan-out (children per internal page)",
              wiki.shape.fanOut
                ? `${fmtInt(wiki.shape.internalNodes)} internal, ${fmtInt(wiki.shape.leaves)} leaves; p50 ${wiki.shape.fanOut.p50.toFixed(1)}, p95 ${wiki.shape.fanOut.p95.toFixed(1)}, max ${fmtInt(wiki.shape.fanOut.max)}`
                : "no internal pages"
            ],
            [
              "Current notes in a membership of a live page",
              wiki.notes
                ? `${fmtInt(wiki.notes.inMembership)} of ${fmtInt(wiki.notes.current)} (${fmtPercent(wiki.notes.share)})`
                : "n/a"
            ],
            [
              "Sources with a source TOC page",
              wiki.sources
                ? `${fmtInt(wiki.sources.withToc)} of ${fmtInt(wiki.sources.total)} (${fmtPercent(wiki.sources.share)})`
                : "n/a"
            ]
          ]
        ),
        "Live pages by management and role (kind when the role is empty):",
        "",
        table(
          ["Management", "Role", "Pages"],
          wiki.byRole.map((entry) => [entry.management, entry.role, fmtInt(entry.count)])
        )
      ].join("\n")
    )
  );

  for (const [title, section] of [
    ["Organization runs", report.organization],
    ["Maintenance runs", report.maintenance]
  ] as const) {
    out.push(`## ${title}`, "");
    out.push(
      when(section, (runs) =>
        [
          `Runs: ${fmtInt(runs.total)} (${counts(runs.byStatus)}). Waiting for review: ${fmtInt(runs.awaitingReview)}.`,
          "",
          "Reasons of failed or canceled runs:",
          "",
          table(
            ["Reason", "Runs"],
            Object.entries(runs.blockedReasons)
              .sort(([, a], [, b]) => b - a)
              .map(([reason, count]) => [reason, fmtInt(count)])
          )
        ].join("\n")
      )
    );
  }

  out.push("## Jobs", "");
  out.push(
    when(report.jobs, (jobs) =>
      [
        table(
          ["Type", "Status", "Jobs", "Created to finished p50 / p95 (s)"],
          jobs.byTypeStatus.map((row) => [
            row.type,
            row.status,
            fmtInt(row.count),
            fmtPair(row.latencySeconds)
          ])
        ),
        "Failed jobs by reason:",
        "",
        table(
          ["Type", "Reason", "Jobs"],
          jobs.failures.map((row) => [row.type, row.reason, fmtInt(row.count)])
        ),
        jobs.stuck
          ? [
              `Stuck jobs (threshold ${jobs.stuck.thresholdMinutes} minutes before the as-of time): ` +
                `${fmtInt(jobs.stuck.stuckRunning)} of ${fmtInt(jobs.stuck.running)} running jobs, ` +
                `${fmtInt(jobs.stuck.queuedOverdue)} queued jobs overdue, ` +
                `${fmtInt(jobs.stuck.orphanedRunningIngestionRuns)} ingestion runs marked running without a running job.`,
              "",
              table(
                ["Type", "Running", "Stuck running", "Queued overdue"],
                jobs.stuck.byType.map((row) => [
                  row.type,
                  fmtInt(row.running),
                  fmtInt(row.stuckRunning),
                  fmtInt(row.queuedOverdue)
                ])
              )
            ].join("\n")
          : "_Stuck-job detection not available._\n"
      ].join("\n")
    )
  );

  out.push("## Not measurable on this database", "");
  out.push(
    report.gaps.length > 0
      ? `${report.gaps.map((gap) => `- ${gap}`).join("\n")}\n`
      : "_Nothing missing._\n"
  );
  return out.join("\n");
}
