// Command line and Markdown report of `npm run topics:audit` (F2 T17).
import { parseArgs } from "node:util";

import { z } from "zod";

import { fmtInt, renderTopicsKpi, table } from "../kpi/render.js";
import { defaultListLimit, defaultUndoWindowDays } from "./audit-core.js";
import type { Listed, TopicAuditReport } from "./audit-core.js";

export const auditUsage = `Usage: npx tsx scripts/topics/audit.ts --db <connection.json | postgres url> [options]

  --db <value>        Scratch connection file (.cache/f0/scratch-<name>.json) or a postgres:// URL. Read-only.
  --tree <uuid>       Tree to audit (default: the active tree).
  --areas <mode>      auto | on | off. Whether the root's fan-out band is the Areas band (default: auto, on
                      once an Areas change-set is applied).
  --as-of <iso|now>   End of the undo-rate window (default: now).
  --undo-days <n>     Length of the undo-rate window in days (default: ${defaultUndoWindowDays}).
  --limit <n>         Entries listed per detail table (default: ${defaultListLimit}); totals are always exact.
  --out <file.md>     Write the Markdown report here (default: print to stdout).
  --json <file.json>  Also write the full report as JSON.
  --help              Show this text.

Exit code: 0 when E1 holds (reachability 100%, 0 orphans, 0 hard violations), 1 when it does not,
2 when the audit could not run. Statistics and vectors are not read, so the coherence invariant (I8)
and the statistics recompute are left to the service's own audit. The report lists topic and item
identifiers, never titles or note text.`;

export interface AuditArgs {
  readonly db: string;
  readonly treeId: string | null;
  readonly areas: "auto" | "on" | "off";
  readonly asOf: Date | null;
  readonly undoWindowDays: number;
  readonly limit: number;
  readonly out: string | null;
  readonly json: string | null;
}

export type AuditCommand = { readonly kind: "help" } | ({ readonly kind: "run" } & AuditArgs);

const boundedInteger = (name: string, text: string, min: number, max: number): number => {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max)
    throw new Error(`--${name} must be an integer between ${min} and ${max}, got "${text}".`);
  return value;
};

export function parseAuditArgs(argv: readonly string[]): AuditCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      tree: { type: "string" },
      areas: { type: "string" },
      "as-of": { type: "string" },
      "undo-days": { type: "string" },
      limit: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");

  const tree = values.tree === undefined ? null : z.string().uuid().safeParse(values.tree);
  if (tree !== null && !tree.success) throw new Error("--tree must be a UUID.");
  const areas = values.areas ?? "auto";
  if (areas !== "auto" && areas !== "on" && areas !== "off")
    throw new Error(`--areas must be auto, on or off, got "${areas}".`);

  let asOf: Date | null = null;
  if (values["as-of"] !== undefined && values["as-of"] !== "now") {
    asOf = new Date(values["as-of"]);
    if (Number.isNaN(asOf.getTime()))
      throw new Error(`--as-of must be "now" or an ISO timestamp, got "${values["as-of"]}".`);
  }

  return {
    kind: "run",
    db: values.db,
    treeId: tree?.data ?? null,
    areas,
    asOf,
    undoWindowDays: boundedInteger(
      "undo-days",
      values["undo-days"] ?? String(defaultUndoWindowDays),
      1,
      365
    ),
    limit: boundedInteger("limit", values.limit ?? String(defaultListLimit), 1, 10_000),
    out: values.out ?? null,
    json: values.json ?? null
  };
}

function listing<T>(
  title: string,
  list: Listed<T>,
  headers: readonly string[],
  row: (entry: T) => Array<string | number>
): string[] {
  if (list.total === 0) return [];
  const shown = list.shown.length < list.total ? `, first ${fmtInt(list.shown.length)}` : "";
  return [`${title} (${fmtInt(list.total)}${shown}):`, "", table(headers, list.shown.map(row))];
}

export function renderAuditMarkdown(report: TopicAuditReport): string {
  const { summary, details } = report;
  const out: string[] = [
    "# Topic tree audit",
    "",
    table(
      ["Field", "Value"],
      [
        ["Tree", details.treeId],
        ["Generated", report.generatedAt],
        [
          "E1 (reachability 100%, 0 orphans, 0 hard violations)",
          summary.e1.passes ? "PASS" : `FAIL: ${summary.e1.failures.join(", ")}`
        ]
      ]
    ),
    "## Summary",
    "",
    renderTopicsKpi(summary)
  ];
  const detailBlocks = [
    ...listing(
      "Violations",
      details.violations,
      ["Invariant", "Severity", "Reason", "Topic", "Item", "Value", "Awaiting approval"],
      (v) => [
        v.code,
        v.severity,
        v.reason,
        v.topicId ?? "",
        v.item ?? "",
        v.value ?? "",
        v.awaitingApproval ? "yes" : "no"
      ]
    ),
    ...listing(
      "Live topics the root does not reach",
      details.unreachableTopics,
      ["Topic"],
      (id) => [id]
    ),
    ...listing(
      "Placements on retired topics",
      details.placementsOnRetiredTopics,
      ["Item", "Topic", "Rank"],
      (p) => [p.item, p.topicId, p.rank]
    ),
    ...listing(
      "Placements on unreachable topics",
      details.placementsOnUnreachableTopics,
      ["Item", "Topic", "Rank"],
      (p) => [p.item, p.topicId, p.rank]
    ),
    ...listing(
      "Expected items without a primary placement",
      details.itemsWithoutPrimary,
      ["Item"],
      (item) => [item]
    ),
    ...listing(
      "Placed items that are no longer current",
      details.placedNotCurrent,
      ["Item"],
      (item) => [item]
    )
  ];
  out.push("## Details", "");
  out.push(detailBlocks.length > 0 ? detailBlocks.join("\n") : "_Nothing to list._\n");
  return out.join("\n");
}
