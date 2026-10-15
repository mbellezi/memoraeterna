// The schemas of the developer comparison report (`npm run topics:report`, F2 T22b, D21): the
// parts of a `topics:export` document the report reads, and the report it writes (one
// `ProfileReport` per profile, in a `ComparisonDocument`). Strict where the report writes, loose
// where it reads, so a newer export with extra fields still reports.
import { ShapeReportSchema } from "@app/domain/topic-tree";
import { z } from "zod";

import { ShapeSummarySchema, TruthSummarySchema } from "./report-data.js";

export const compareSchemaVersion = "topics-compare/v1";
export const exportFormat = "memora-topic-export";

const count = z.number().int().min(0);
const share = z.number().min(0).max(1);

// ---------------------------------------------------------------------------
// The export document (what `topics:export` wrote): only the fields the report reads

const ExportTopicSchema = z.looseObject({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  role: z.string(),
  title: z.string().nullable(),
  nameState: z.string(),
  nameSource: z.string().nullable(),
  nameLanguage: z.string().nullable(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  management: z.string(),
  position: z.number(),
  retiredAt: z.string().nullable(),
  redirectTo: z.string().nullable()
});

const ExportPlacementSchema = z.looseObject({
  item: z.string().min(1),
  kind: z.enum(["note", "source"]),
  topicId: z.string().min(1),
  rank: z.number().int().min(0),
  management: z.string(),
  decidedBy: z.string(),
  score: z.number().nullable(),
  margin: z.number().nullable(),
  needsGate: z.boolean(),
  needsSplitCheck: z.boolean(),
  needsVector: z.boolean()
});

const ExportChangeSetSchema = z.looseObject({
  id: z.string(),
  origin: z.string(),
  status: z.string(),
  createdAt: z.string()
});

const ExportGateDecisionSchema = z.looseObject({
  itemKind: z.string(),
  itemId: z.string(),
  deciderKey: z.string(),
  candidates: z.unknown(),
  chosenTopicId: z.string().nullable(),
  noneOfThese: z.boolean(),
  createdAt: z.string()
});

const ExportDailyMetricSchema = z.looseObject({
  day: z.string(),
  opsApplied: z.number(),
  itemsMoved: z.number(),
  primaryPathChanges: z.number(),
  unsortedShare: z.number().nullable(),
  meanDepth: z.number().nullable(),
  fanoutInTarget: z.number().nullable(),
  hardViolations: z.number().nullable(),
  softViolations: z.number().nullable(),
  gateCalls: z.number(),
  namingCalls: z.number()
});

export const ExportDocumentSchema = z.looseObject({
  format: z.literal(exportFormat),
  version: z.literal(1),
  name: z.string().min(1),
  label: z.string().nullable(),
  createdAt: z.string(),
  tree: z.looseObject({
    id: z.string(),
    status: z.string(),
    space: z.looseObject({
      spaceKey: z.string(),
      provider: z.string(),
      model: z.string(),
      runtime: z.string(),
      dimensions: z.number().int().positive()
    }),
    configHash: z.string(),
    seed: z.number(),
    generation: z.number(),
    createdAt: z.string(),
    activatedAt: z.string().nullable(),
    config: z.unknown()
  }),
  library: z.looseObject({ notes: count, rootSources: count }),
  roots: z.array(
    z.looseObject({ id: z.string(), title: z.string(), type: z.string(), notes: count })
  ),
  topics: z.array(ExportTopicSchema),
  placements: z.array(ExportPlacementSchema),
  gateDecisions: z.array(ExportGateDecisionSchema),
  changeSets: z.looseObject({
    total: count,
    listed: count,
    byOrigin: z.record(z.string(), z.number()),
    byStatus: z.record(z.string(), z.number()),
    items: z.array(ExportChangeSetSchema)
  }),
  dailyMetrics: z.array(ExportDailyMetricSchema),
  audit: ShapeReportSchema,
  vectors: z
    .looseObject({ rows: count, notesWithoutVector: count, spaceKey: z.string() })
    .nullable()
});
export type ExportDocument = z.infer<typeof ExportDocumentSchema>;

export function parseExportDocument(raw: unknown): ExportDocument {
  const parsed = ExportDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `Not a topics:export document (version 1): ${issue?.path.join(".") ?? ""} ${issue?.message ?? ""}`.trim()
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// The report

export const TargetCheckSchema = z
  .object({
    /** The exit criterion or measure it belongs to (E1, E2, E3, E5, D27). */
    id: z.string(),
    name: z.string(),
    value: z.number().nullable(),
    min: z.number().nullable(),
    max: z.number().nullable(),
    /** `na`: the data to judge it is not in this export (a short history, no vectors). */
    status: z.enum(["pass", "fail", "na"]),
    /** Reported, not gating, in the spec's exit-criteria protocol. */
    gating: z.boolean(),
    note: z.string().nullable()
  })
  .strict();
export type TargetCheck = z.infer<typeof TargetCheckSchema>;

const LevelSchema = z
  .object({ depth: count, topics: count, notes: count, unnamed: count })
  .strict();

const MarginSchema = z
  .object({
    n: count,
    p10: z.number().nullable(),
    p50: z.number().nullable(),
    p90: z.number().nullable(),
    /** Share of the primary note placements decided by PLACE with a margin below each bound. */
    below: z.record(z.string(), share)
  })
  .strict();

const GateSchema = z
  .object({
    decisions: count,
    accepted: count,
    none: count,
    byDecider: z.record(z.string(), count),
    candidatesMean: z.number().nullable(),
    /** Accepted decisions whose item still sits in the chosen topic or below it. */
    stillInChosen: share.nullable()
  })
  .strict();

const DaySchema = z
  .object({
    day: z.string(),
    opsApplied: count,
    itemsMoved: count,
    primaryPathChanges: count,
    /** Primary-path changes as a share of the exported items. */
    churn: z.number().min(0),
    gateCalls: count,
    namingCalls: count,
    meanDepth: z.number().nullable(),
    fanoutInTarget: share.nullable(),
    hardViolations: count.nullable()
  })
  .strict();

const SampleMemberSchema = z
  .object({ title: z.string(), source: z.string().nullable(), cosine: z.number() })
  .strict();

export const SampleSchema = z
  .object({
    topicId: z.string(),
    stratum: z.enum(["area", "level2", "deep"]),
    depth: count,
    title: z.string().nullable(),
    nameState: z.string(),
    nameSource: z.string().nullable(),
    description: z.string().nullable(),
    aliases: z.array(z.string()),
    notes: count,
    directItems: count,
    children: count,
    coherence: z.number(),
    /** Mean cosine of the five central members to the topic's centroid. */
    centralCosine: z.number(),
    members: z.array(SampleMemberSchema)
  })
  .strict();
export type Sample = z.infer<typeof SampleSchema>;

const FreshSideSchema = z
  .object({ shape: ShapeSummarySchema, partitionHash: z.string().length(64) })
  .strict();

export const FreshComparisonSchema = z
  .object({
    /** Rows compared: notes with a vector, in content-key order (D22). */
    rows: count,
    seed: z.number().int(),
    configHash: z.string().length(64),
    buildMs: z.number().min(0),
    app: FreshSideSchema,
    fresh: FreshSideSchema,
    /** The app's tree has the fresh build's partition (up to topic IDs). */
    identical: z.boolean(),
    /** Notes with a vector that the app has not placed (they are left out of the agreement). */
    unplaced: count,
    placedOnRetired: count,
    agreement: z
      .object({
        leafNmi: z.number(),
        depth1Nmi: z.number(),
        depth2Nmi: z.number(),
        /** The fresh build's Areas (top level) as a cut of the incremental tree. */
        cutNmi: z.number()
      })
      .strict(),
    /** Change-sets that explain a difference: anything but the one build. */
    laterChangeSets: z.record(z.string(), count)
  })
  .strict();
export type FreshComparison = z.infer<typeof FreshComparisonSchema>;

export const LegacyRecordSchema = z
  .object({
    recordedOn: z.string(),
    source: z.string(),
    pages: count,
    revisions: count,
    /** The wiki was a flat set of area pages: no deeper level was ever built. */
    levels: count,
    library: z.object({ sources: count, chunks: count, notes: count, vectors: count }).strict(),
    rowsWiped: count
  })
  .strict();
export type LegacyRecord = z.infer<typeof LegacyRecordSchema>;

/** The DEV profile's legacy wiki as docs/kpi-f2.md (gate W, 2026-10-15) recorded it. */
export const devLegacyRecord: LegacyRecord = {
  recordedOn: "2026-10-15",
  source: "docs/kpi-f2.md, Gate W",
  pages: 9,
  revisions: 9,
  levels: 1,
  library: { sources: 30, chunks: 197, notes: 160, vectors: 387 },
  rowsWiped: 5867
};

export const ProfileReportSchema = z
  .object({
    name: z.string(),
    label: z.string().nullable(),
    exportedAt: z.string(),
    tree: z
      .object({
        id: z.string(),
        generation: count,
        status: z.string(),
        spaceKey: z.string(),
        model: z.string(),
        runtime: z.string(),
        dimensions: z.number().int(),
        configHash: z.string(),
        seed: z.number(),
        activatedAt: z.string().nullable()
      })
      .strict(),
    library: z
      .object({
        notes: count,
        rootSources: count,
        vectorRows: count.nullable(),
        notesWithoutVector: count.nullable()
      })
      .strict(),
    targets: z.array(TargetCheckSchema),
    shape: ShapeSummarySchema,
    fanOutHistogram: z.record(z.string(), count),
    leafSizeHistogram: z.record(z.string(), count),
    levels: z.array(LevelSchema),
    naming: z
      .object({
        topics: count,
        named: count,
        provisional: count,
        unnamed: count,
        bySource: z.record(z.string(), count),
        byLanguage: z.record(z.string(), count)
      })
      .strict(),
    placements: z
      .object({
        total: count,
        primaryNotes: count,
        secondary: count,
        sources: count,
        atRoot: count,
        byDecision: z.record(z.string(), count),
        needsGate: count,
        needsSplitCheck: count,
        needsVector: count,
        margin: MarginSchema
      })
      .strict(),
    gate: GateSchema,
    changeSets: z
      .object({
        total: count,
        listed: count,
        byOrigin: z.record(z.string(), count),
        byStatus: z.record(z.string(), count),
        /** Undone automatic change-sets over automatic change-sets. */
        undoRate: share.nullable(),
        perDay: z.array(
          z
            .object({ day: z.string(), total: count, byOrigin: z.record(z.string(), count) })
            .strict()
        )
      })
      .strict(),
    churn: z
      .object({
        days: z.array(DaySchema),
        /** The largest seven-day sum of primary-path changes over the exported items. */
        worstWeek: z.number().min(0).nullable()
      })
      .strict(),
    samples: z.array(SampleSchema),
    fresh: FreshComparisonSchema.nullable(),
    truth: z
      .object({
        source: z.string(),
        coverage: share,
        app: TruthSummarySchema.nullable(),
        fresh: TruthSummarySchema.nullable()
      })
      .strict()
      .nullable(),
    legacy: LegacyRecordSchema.nullable(),
    caveats: z.array(z.string())
  })
  .strict();
export type ProfileReport = z.infer<typeof ProfileReportSchema>;

export const ComparisonDocumentSchema = z
  .object({
    schema: z.literal(compareSchemaVersion),
    createdAt: z.string(),
    profiles: z.array(ProfileReportSchema)
  })
  .strict();
export type ComparisonDocument = z.infer<typeof ComparisonDocumentSchema>;
