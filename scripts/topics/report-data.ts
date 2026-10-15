// The data layer of the replay reports (`.cache/topics/reports/`): strict Zod schemas for what
// the harness measures, a writer (JSON for tools, Markdown for people) and a reader. The
// developer comparison report (`npm run topics:report`, T22b, D21) reads these files; gate A and
// the calibration tasks (T29a, T29b) cite them. Reports hold aggregates and the dataset's name,
// never note text.
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  canonicalPartition,
  canonicalTopicTreeConfig,
  compareStrings,
  rowItemKey
} from "@app/domain/topic-tree";
import type {
  PartitionNode,
  ShapeReport,
  TopicTreeConfig,
  TopicTreeState
} from "@app/domain/topic-tree";

export const reportSchemaVersion = "topics-report/v1";

const count = z.number().int().min(0);
const share = z.number().min(0).max(1);
const ms = z.number().min(0);

export const DatasetRefSchema = z
  .object({
    name: z.string().min(1),
    rows: count,
    dim: z.number().int().positive(),
    model: z.string(),
    runtime: z.string(),
    /** The app embedding space of an export; null for the MLX Spike B stores. */
    spaceKey: z.string().nullable()
  })
  .strict();
export type DatasetRef = z.infer<typeof DatasetRefSchema>;

/** The shape numbers of one tree (a trimmed `ShapeReport`). */
export const ShapeSummarySchema = z
  .object({
    items: count,
    topics: count,
    leaves: count,
    internalTopics: count,
    /** Children of the root (the Areas). */
    rootChildren: count,
    depthMean: z.number().min(0),
    depthP95: z.number().min(0),
    fanOutInTarget: share,
    fanOutInRange: share,
    leafInRange: share,
    singleChildTopics: count,
    reachability: share,
    unsortedShare: share,
    hardViolations: count,
    softViolations: z.record(z.string(), count),
    coherenceLeafWeighted: z.number(),
    coherenceLeafP10: z.number()
  })
  .strict();
export type ShapeSummary = z.infer<typeof ShapeSummarySchema>;

/** Agreement with the ground-truth labels (Wikipedia domain, article); null without labels. */
export const TruthSummarySchema = z
  .object({
    leafDomainPurity: share,
    depth1NmiDomain: z.number(),
    depth2NmiDomain: z.number(),
    leafNmiGroup: z.number()
  })
  .strict();
export type TruthSummary = z.infer<typeof TruthSummarySchema>;

export const OperationCountsSchema = z.record(z.string(), count);

export const CheckSchema = z
  .object({
    name: z.string(),
    value: z.number(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    pass: z.boolean()
  })
  .strict();
export type Check = z.infer<typeof CheckSchema>;

const baseFields = {
  schema: z.literal(reportSchemaVersion),
  createdAt: z.string(),
  dataset: DatasetRefSchema,
  seed: z.number().int(),
  seedRole: z.enum(["evaluation", "calibration", "other"]),
  /** SHA-256 of the canonical configuration the run used. */
  configHash: z.string().length(64),
  engine: z.string()
};

export const BuildTimingsSchema = z
  .object({ knnMs: ms, communitiesMs: ms, repairMs: ms, totalMs: ms })
  .strict();

export const ParityReportSchema = z
  .object({
    ...baseFields,
    kind: z.literal("parity"),
    shape: ShapeSummarySchema,
    truth: TruthSummarySchema.nullable(),
    timings: BuildTimingsSchema,
    knnExact: z.boolean(),
    /** SHA-256 of the canonical (ID-free) partition: T13's worker must reproduce it. */
    partitionHash: z.string().length(64),
    /** A second build with the same seed gives the same partition (null: not checked). */
    deterministic: z.boolean().nullable(),
    /** Louvain's top-level behaviour (root communities, super-grouping). */
    root: z
      .object({
        communities: count,
        children: count,
        superGrouped: z.boolean(),
        kmeansFallback: z.boolean()
      })
      .strict(),
    /** The Spike B bounds the run was held to; empty when the dataset has none. */
    checks: z.array(CheckSchema),
    passes: z.boolean()
  })
  .strict();
export type ParityReport = z.infer<typeof ParityReportSchema>;

export const GrowthReportSchema = z
  .object({
    ...baseFields,
    kind: z.literal("growth"),
    arrival: z.string(),
    base: count,
    inserted: count,
    buildMs: ms,
    insertMsPerItem: ms,
    /** Share of base items whose primary path changed while the rest was inserted. */
    churn: share,
    ambiguousRate: share,
    unadmittedRate: share,
    gatedAtMargin: z.record(z.string(), share),
    operations: OperationCountsSchema,
    before: z.object({ shape: ShapeSummarySchema, truth: TruthSummarySchema.nullable() }).strict(),
    after: z.object({ shape: ShapeSummarySchema, truth: TruthSummarySchema.nullable() }).strict(),
    settled: z
      .object({
        shape: ShapeSummarySchema,
        truth: TruthSummarySchema.nullable(),
        operations: OperationCountsSchema
      })
      .strict(),
    /** E1 and E2 on the settled tree. */
    checks: z.array(CheckSchema),
    passes: z.boolean()
  })
  .strict();
export type GrowthReport = z.infer<typeof GrowthReportSchema>;

/** Audits and undo checks of the real engine over a run (real-engine.ts). */
export const EngineChecksSchema = z
  .object({
    audits: count,
    reparentCandidates: count,
    driftedTopics: count,
    undoChecked: count,
    undoExact: count
  })
  .strict();

export const WeekRowSchema = z
  .object({
    week: z.number().int().min(1),
    arrivals: count,
    itemsAtStart: count,
    itemsAtEnd: count,
    /** Arrivals as a share of the items at the start of the week. */
    growth: z.number().min(0),
    /** E3: items present at the start whose primary path (redirects resolved) changed by its end. */
    churn: share,
    changedItems: count,
    operations: OperationCountsSchema,
    skippedFrozen: count,
    skippedBudget: count,
    /** Topics whose soft checks waited for their cooldown (the real engine reports it). */
    skippedCooldown: count.optional(),
    /** Operations returned for review instead of applied (protected or Area-level, D12). */
    proposals: count.optional(),
    ambiguous: count,
    unadmitted: count,
    rebuild: z.object({ trigger: z.string(), movedItems: count }).strict().nullable(),
    topics: count,
    rootChildren: count,
    depthMean: z.number().min(0),
    fanOutInTarget: share,
    hardViolations: count,
    ms
  })
  .strict();
export type WeekRow = z.infer<typeof WeekRowSchema>;

export const WeeklyReportSchema = z
  .object({
    ...baseFields,
    kind: z.literal("weekly-replay"),
    arrival: z.string(),
    /**
     * How gated items were resolved: `baseline` takes the best-scoring candidate (the margin-only
     * baseline, D19; the reference engine's behaviour), `off` leaves them at the fallback ancestor
     * (the fallback sensitivity run of E3). Serving the gate from the score cache joins the loop
     * with the T07 gate rule and the T23 descriptors.
     */
    gate: z.enum(["baseline", "off"]),
    schedule: z
      .object({
        baseRows: count,
        weeks: z.number().int().min(1),
        weeklyShare: share,
        daysPerWeek: z.number().int().min(1),
        frozenTopics: count
      })
      .strict(),
    base: z.object({ shape: ShapeSummarySchema, timings: BuildTimingsSchema }).strict(),
    weeks: z.array(WeekRowSchema),
    maxChurn: share,
    medianChurn: share,
    final: z.object({ shape: ShapeSummarySchema, truth: TruthSummarySchema.nullable() }).strict(),
    /** The engine's own audit and undo checks over the run (engines that have them). */
    engineChecks: EngineChecksSchema.nullable().optional(),
    checks: z.array(CheckSchema),
    /** E3 on this run: the largest weekly churn is within the bar. */
    passes: z.boolean()
  })
  .strict();
export type WeeklyReport = z.infer<typeof WeeklyReportSchema>;

export const AuditReportSchema = z
  .object({
    ...baseFields,
    kind: z.literal("audit"),
    expectedItems: count,
    reachable: count,
    reachability: share,
    orphans: z
      .object({
        unreachableTopics: count,
        placementsOnRetiredTopics: count,
        itemsWithoutPrimary: count
      })
      .strict(),
    hardViolations: z.array(z.string()).max(100),
    hardViolationCount: count,
    awaitingApproval: count,
    /** E1: reachability 100%, 0 orphans, 0 hard violations. */
    passes: z.boolean()
  })
  .strict();
export type AuditReport = z.infer<typeof AuditReportSchema>;

const KnnPointSchema = z
  .object({ nprobe: z.number().int().min(1), recall: share, lists: count, ivfMs: ms })
  .strict();

export const KnnRecallReportSchema = z
  .object({
    ...baseFields,
    kind: z.literal("knn-recall"),
    k: z.number().int().min(1),
    target: share,
    /** The IVF probes configured now (`knn.nprobe`). */
    configuredNprobe: z.number().int().min(1),
    subsets: z.array(
      z
        .object({
          sample: count,
          exactMs: ms,
          points: z.array(KnnPointSchema),
          /** Smallest probed nprobe reaching the target on this sample, or null. */
          smallestPassing: z.number().int().nullable()
        })
        .strict()
    ),
    queries: z.array(
      z
        .object({
          rows: count,
          queries: count,
          minRecall: share,
          point: KnnPointSchema,
          exactMs: ms
        })
        .strict()
    ),
    /** nprobe to adopt: the configured one when it passes everywhere, else the smallest that does. */
    recommendedNprobe: z.number().int().nullable(),
    passes: z.boolean()
  })
  .strict();
export type KnnRecallReport = z.infer<typeof KnnRecallReportSchema>;

export const ReplayReportSchema = z.discriminatedUnion("kind", [
  ParityReportSchema,
  GrowthReportSchema,
  WeeklyReportSchema,
  AuditReportSchema,
  KnnRecallReportSchema
]);
export type ReplayReport = z.infer<typeof ReplayReportSchema>;

// ---------------------------------------------------------------------------
// Builders

export function configHash(config: TopicTreeConfig): string {
  return createHash("sha256").update(canonicalTopicTreeConfig(config)).digest("hex");
}

export function partitionHash(state: TopicTreeState): string {
  return createHash("sha256").update(canonicalPartition(state)).digest("hex");
}

/**
 * The same hash from a worker's result (`partitionOf`: topics as integer keys, items as matrix
 * rows): T13 compares the clustering worker's partition with the in-memory one through it.
 */
export function partitionHashOfNodes(nodes: readonly PartitionNode[]): string {
  const children = new Map<number, number[]>();
  const byKey = new Map<number, PartitionNode>();
  let root: PartitionNode | undefined;
  for (const node of nodes) {
    byKey.set(node.key, node);
    if (node.parent === null) root = node;
    else children.set(node.parent, [...(children.get(node.parent) ?? []), node.key]);
  }
  if (!root) throw new RangeError("A partition needs a root (a node without a parent)");
  const encode = (key: number): string => {
    const node = byKey.get(key) as PartitionNode;
    const items = node.items.map(rowItemKey).sort(compareStrings);
    const below = (children.get(key) ?? []).map(encode).sort(compareStrings);
    return `(${items.join(",")}|${below.join("")})`;
  };
  return createHash("sha256").update(encode(root.key)).digest("hex");
}

const round = (value: number, digits = 4): number => Number(value.toFixed(digits));

export function summarizeShape(report: ShapeReport, rootChildren: number): ShapeSummary {
  return {
    items: report.items,
    topics: report.topics,
    leaves: report.leaves,
    internalTopics: report.internalTopics,
    rootChildren,
    depthMean: round(report.itemDepth.mean),
    depthP95: report.itemDepth.p95,
    fanOutInTarget: round(report.fanOut.inTarget),
    fanOutInRange: round(report.fanOut.inRange),
    leafInRange: round(report.leafSize.inRange),
    singleChildTopics: report.singleChildTopics,
    reachability: round(report.reachability),
    unsortedShare: round(report.unsortedShare),
    hardViolations: report.violations.hardCount,
    softViolations: report.violations.soft,
    coherenceLeafWeighted: round(report.coherence.leafWeightedMean),
    coherenceLeafP10: round(report.coherence.leafP10)
  };
}

/** A check that `value` lies within [min, max] (either bound may be absent). */
export function check(name: string, value: number, bounds: { min?: number; max?: number }): Check {
  const min = bounds.min === undefined ? null : round(bounds.min, 6);
  const max = bounds.max === undefined ? null : round(bounds.max, 6);
  return {
    name,
    value: round(value, 6),
    min,
    max,
    pass: (min === null || value >= min - 1e-9) && (max === null || value <= max + 1e-9)
  };
}

// ---------------------------------------------------------------------------
// Files

const slug = (text: string): string => text.replace(/[^A-Za-z0-9._-]+/gu, "_");

/** `<kind>-<dataset>-<seed>[-<suffix>]`: a re-run overwrites its own report. */
export function reportName(report: ReplayReport, suffix?: string): string {
  const parts = [report.kind, report.dataset.name, String(report.seed)];
  if (suffix) parts.push(suffix);
  return parts.map(slug).join("-");
}

async function writeAtomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content);
  await rename(temporary, path);
}

/** Validates and writes `<name>.json` and `<name>.md` under `dir`; returns the JSON path. */
export async function writeReport(
  dir: string,
  report: ReplayReport,
  suffix?: string
): Promise<string> {
  const parsed = ReplayReportSchema.parse(report);
  await mkdir(dir, { recursive: true });
  const base = join(dir, reportName(parsed, suffix));
  await writeAtomic(`${base}.json`, `${JSON.stringify(parsed, null, 2)}\n`);
  await writeAtomic(`${base}.md`, renderReportMarkdown(parsed));
  return `${base}.json`;
}

export async function readReport(path: string): Promise<ReplayReport> {
  return ReplayReportSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

// ---------------------------------------------------------------------------
// Markdown

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

function table(header: readonly string[], rows: readonly (readonly (string | number)[])[]): string {
  const line = (cells: readonly (string | number)[]): string => `| ${cells.join(" | ")} |`;
  return [line(header), line(header.map(() => "---")), ...rows.map(line)].join("\n");
}

function checksTable(checks: readonly Check[]): string {
  if (checks.length === 0) return "";
  return `\n${table(
    ["Check", "Value", "Bounds", "Result"],
    checks.map((entry) => [
      entry.name,
      entry.value,
      `${entry.min ?? "-"} to ${entry.max ?? "-"}`,
      entry.pass ? "pass" : "FAIL"
    ])
  )}\n`;
}

function shapeLines(shape: ShapeSummary): string {
  return table(
    [
      "Items",
      "Topics",
      "Leaves",
      "Areas",
      "Depth",
      "Fan-out 4-9",
      "Leaves 3-30",
      "Reachable",
      "Hard"
    ],
    [
      [
        shape.items,
        shape.topics,
        shape.leaves,
        shape.rootChildren,
        shape.depthMean.toFixed(2),
        pct(shape.fanOutInTarget),
        pct(shape.leafInRange),
        pct(shape.reachability),
        shape.hardViolations
      ]
    ]
  );
}

export function renderReportMarkdown(report: ReplayReport): string {
  const head = [
    `# ${report.kind} on ${report.dataset.name}`,
    "",
    `Seed ${report.seed} (${report.seedRole}), ${report.dataset.rows} rows x ${report.dataset.dim}, ` +
      `engine ${report.engine}, config ${report.configHash.slice(0, 12)}, ${report.createdAt}.`,
    ""
  ];
  const body: string[] = [];
  switch (report.kind) {
    case "parity":
      body.push(
        shapeLines(report.shape),
        report.truth
          ? `\nLeaf domain purity ${pct(report.truth.leafDomainPurity)}, depth-1 NMI ` +
              `${report.truth.depth1NmiDomain.toFixed(2)}, depth-2 NMI ` +
              `${report.truth.depth2NmiDomain.toFixed(2)}.`
          : "",
        `\nBuild ${(report.timings.totalMs / 1000).toFixed(1)} s (kNN ${(report.timings.knnMs / 1000).toFixed(1)} s, ` +
          `${report.knnExact ? "exact" : "IVF"}; communities ${(report.timings.communitiesMs / 1000).toFixed(1)} s; ` +
          `repair ${(report.timings.repairMs / 1000).toFixed(1)} s). Partition ${report.partitionHash.slice(0, 16)}` +
          `${report.deterministic === null ? "" : report.deterministic ? ", repeatable" : ", NOT repeatable"}.`,
        checksTable(report.checks)
      );
      break;
    case "growth":
      body.push(
        `Arrival ${report.arrival}: base ${report.base}, inserted ${report.inserted}; churn ${pct(report.churn)}, ` +
          `ambiguous ${pct(report.ambiguousRate)}, unadmitted ${pct(report.unadmittedRate)}, ` +
          `${report.insertMsPerItem.toFixed(3)} ms per insert.`,
        "\nAfter the inserts, settled:",
        shapeLines(report.settled.shape),
        checksTable(report.checks)
      );
      break;
    case "weekly-replay":
      body.push(
        `Arrival ${report.arrival}, gate ${report.gate}: base ${report.schedule.baseRows}, ` +
          `${report.schedule.weeks} weeks of ${pct(report.schedule.weeklyShare)}.`,
        "",
        table(
          [
            "Week",
            "Arrivals",
            "Growth",
            "Churn",
            "Ops",
            "Skipped (frozen/budget/cooldown)",
            "Proposals",
            "Depth",
            "Fan-out 4-9",
            "Hard"
          ],
          report.weeks.map((week) => [
            week.week,
            week.arrivals,
            pct(week.growth),
            pct(week.churn),
            Object.values(week.operations).reduce((total, value) => total + value, 0),
            `${week.skippedFrozen}/${week.skippedBudget}/${week.skippedCooldown ?? "-"}`,
            week.proposals ?? "-",
            week.depthMean.toFixed(2),
            pct(week.fanOutInTarget),
            week.hardViolations
          ])
        ),
        `\nMaximum weekly churn ${pct(report.maxChurn)}, median ${pct(report.medianChurn)}.`,
        report.engineChecks
          ? `\nEngine checks: ${report.engineChecks.audits} audits (${report.engineChecks.reparentCandidates} ` +
              `re-parent candidates, ${report.engineChecks.driftedTopics} drifted statistics); ` +
              `${report.engineChecks.undoExact}/${report.engineChecks.undoChecked} REBALANCE change-sets ` +
              `undone exactly.`
          : "",
        checksTable(report.checks)
      );
      break;
    case "audit":
      body.push(
        `Reachability ${pct(report.reachability)} (${report.reachable}/${report.expectedItems}); ` +
          `orphans: ${report.orphans.unreachableTopics} unreachable topics, ` +
          `${report.orphans.placementsOnRetiredTopics} placements on retired topics, ` +
          `${report.orphans.itemsWithoutPrimary} items without a primary placement; ` +
          `${report.hardViolationCount} hard violations (${report.awaitingApproval} awaiting approval).`,
        ...report.hardViolations.map((line) => `- ${line}`),
        `\n${report.passes ? "E1 passes." : "E1 FAILS."}`
      );
      break;
    case "knn-recall":
      body.push(
        ...report.subsets.map(
          (subset) =>
            `Subset of ${subset.sample} rows (exact ${(subset.exactMs / 1000).toFixed(1)} s):\n\n` +
            table(
              ["nprobe", "Recall", "Lists", "IVF ms"],
              subset.points.map((point) => [
                point.nprobe,
                pct(point.recall),
                point.lists,
                Math.round(point.ivfMs)
              ])
            ) +
            "\n"
        ),
        ...report.queries.map(
          (query) =>
            `All ${query.rows} rows, ${query.queries} exact queries: nprobe ${query.point.nprobe} gives ` +
            `${pct(query.point.recall)} recall (worst query ${pct(query.minRecall)}), IVF ${(query.point.ivfMs / 1000).toFixed(1)} s.`
        ),
        `\nTarget ${pct(report.target)}; configured nprobe ${report.configuredNprobe}; recommended ` +
          `${report.recommendedNprobe ?? "none reaches it"}.`
      );
      break;
  }
  return `${[...head, ...body].join("\n")}\n`;
}
