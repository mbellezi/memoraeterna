// Markdown tables from .cache/spikes/topic-tree/real-results.json (run-real.ts).
//
//   npx tsx scripts/spikes/topic-tree/summarize-real.ts
//
// Writes .cache/spikes/topic-tree/real-results.md.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { spikeDir } from "./real-data.js";

interface ShapeRow {
  reachability: number;
  leaves: number;
  internal: number;
  depthMean: number;
  depthP95: number;
  fanOut: { min: number; p50: number; max: number; inTarget4to9: number };
  leafSize: { min: number; p50: number; max: number; inRange3to30: number };
  singleChildChains: number;
  unsortedShare: number;
  coherence: { leafMean: number; leafP10: number };
  hardViolations: number;
}

interface Placement {
  ambiguityRate: number;
  crossParentAmbiguityRate: number;
  unadmittedRate: number;
}

interface Observation {
  items: number;
  rootChildren: number;
  depthMean: number;
  fanOutInTarget: number;
  leafDomainPurity: number;
  depth1NmiDomain: number;
}

interface GrowthRow {
  base: number;
  inserted: number;
  churn: number;
  insertMsPerItem: number;
  insertUnadmittedRate: number;
  insertGatedAtMargin: Record<string, number>;
  reachability: number;
  hardViolations: number;
  before?: Observation;
  after?: Observation;
}

interface MarginPoint {
  margin: number;
  gated: number;
  autoDomainPrecision: number;
  autoGroupPrecision: number | null;
  gatedDomainPrecision: number;
}

interface Calibration {
  holdout: string;
  referenceLeaf: string;
  base: number;
  heldOut: number;
  top1DomainAccuracy: number;
  top1GroupAccuracy: number | null;
  admittedLeafRate: number;
  marginCurve: MarginPoint[];
  zCurve: { z: number; ownAdmitted: number; otherAdmitted: number }[];
  floorCurve: { floor: number; referenceKept: number; otherDomainKept: number }[];
  cosineOwnLeaf: { p10: number; p50: number };
  cosineOtherDomainLeaf: { p10: number; p50: number; p90: number };
  coherencePureLeaves: { count: number; p10: number; p50: number; min: number };
  coherenceImpureLeaves: { count: number; p50: number; min: number };
}

interface BuilderResult {
  buildMs: number;
  deterministic: boolean;
  shape: ShapeRow;
  silhouette: number;
  placementInSample: Placement;
  rootDiagnostics?: {
    rootCommunities: number;
    rootChildren: number;
    rootSuperGrouped: boolean;
  } | null;
  truth: {
    leafNmiGroup: number;
    leafDomainPurity: number;
    depth1NmiDomain: number;
    depth2NmiDomain: number;
  };
  language: { topLevelNmiLanguage: number; bilingualLeafShare: number };
  churn80to20?: Record<string, GrowthRow>;
}

interface IncrementalResult {
  insertMsPerItem: number;
  settleOperations: number;
  insertAmbiguityRate: number;
  insertCrossParentAmbiguityRate: number;
  insertUnadmittedRate: number;
  beforeSettle: ShapeRow;
  shape: ShapeRow;
  silhouette: number;
  placementInSample: Placement;
  truth: { leafNmiGroup: number; leafDomainPurity: number; depth1NmiDomain: number };
}

interface DatasetResult {
  items: number;
  languages: { pt: number; en: number };
  domains: number;
  groups: number;
  twinGroups?: number;
  builders: Record<string, BuilderResult>;
  incremental?: Record<string, IncrementalResult | number> & { orderNmiLeaves?: number };
  calibration?: Record<string, { items: Calibration; articles: Calibration }>;
}

const holdoutText: Record<string, string> = {
  items: "random notes (siblings of the same article stay in the base)",
  "articles-twin-in-base": "whole articles one by one (the pt/en twin may stay in the base)",
  articles: "whole articles together with their pt/en twins"
};
const pct = (value: number, digits = 1): string => `${(value * 100).toFixed(digits)}%`;
const num = (value: number, digits = 2): string => value.toFixed(digits);

const results = JSON.parse(await readFile(join(spikeDir, "real-results.json"), "utf8")) as {
  datasets: Record<string, DatasetResult>;
};
const lines: string[] = ["# Spike B real-data results", ""];
for (const [name, data] of Object.entries(results.datasets)) {
  lines.push(
    `## ${name} (${data.items} items: ${data.languages.pt} pt / ${data.languages.en} en, ` +
      `${data.domains} domains, ${data.groups} groups, ${data.twinGroups ?? "-"} twin groups)`,
    "",
    "Re-placement ambiguity is IN-SAMPLE (the items are inside their own leaf): a self-consistency diagnostic, not evidence for the ambiguity bar.",
    "",
    "| Build | Reach | Leaves / internal | Root children | Depth mean / p95 | Fan-out min-p50-max (4-9) | Leaf min-p50-max (3-30) | Chains | Unsorted | Coherence mean / p10 | Silhouette | Re-placement ambiguity, in-sample (cross-parent) | Unadmitted | Leaf domain purity | Depth-1 / 2 NMI domain | Top-level NMI language | Build ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
  );
  const row = (
    label: string,
    shape: ShapeRow,
    rootChildren: string,
    silhouette: number,
    placement: Placement,
    purity: number,
    nmi: string,
    language: string,
    ms: string
  ): string =>
    `| ${label} | ${pct(shape.reachability, 0)} | ${shape.leaves} / ${shape.internal} | ${rootChildren} | ` +
    `${num(shape.depthMean)} / ${shape.depthP95} | ${shape.fanOut.min}-${shape.fanOut.p50}-${shape.fanOut.max} (${pct(shape.fanOut.inTarget4to9, 0)}) | ` +
    `${shape.leafSize.min}-${shape.leafSize.p50}-${shape.leafSize.max} (${pct(shape.leafSize.inRange3to30, 0)}) | ` +
    `${shape.singleChildChains} | ${pct(shape.unsortedShare)} | ${num(shape.coherence.leafMean, 3)} / ${num(shape.coherence.leafP10, 3)} | ` +
    `${num(silhouette, 3)} | ${pct(placement.ambiguityRate)} (${pct(placement.crossParentAmbiguityRate)}) | ` +
    `${pct(placement.unadmittedRate)} | ${pct(purity, 0)} | ${nmi} | ${language} | ${ms} |`;
  for (const [builder, result] of Object.entries(data.builders)) {
    const diagnostics = result.rootDiagnostics;
    lines.push(
      row(
        builder,
        result.shape,
        diagnostics
          ? `${diagnostics.rootChildren} (from ${diagnostics.rootCommunities} communities${diagnostics.rootSuperGrouped ? ", grouped" : ""})`
          : "-",
        result.silhouette,
        result.placementInSample,
        result.truth.leafDomainPurity,
        `${num(result.truth.depth1NmiDomain)} / ${num(result.truth.depth2NmiDomain)}`,
        num(result.language.topLevelNmiLanguage, 3),
        String(result.buildMs)
      )
    );
  }
  const incremental = data.incremental;
  if (incremental) {
    for (const label of ["chronological", "shuffled"]) {
      const run = incremental[label];
      if (!run || typeof run === "number") continue;
      lines.push(
        row(
          `incremental ${label}`,
          run.shape,
          "-",
          run.silhouette,
          run.placementInSample,
          run.truth.leafDomainPurity,
          `${num(run.truth.depth1NmiDomain)} / -`,
          "-",
          `${num(run.insertMsPerItem)}/item`
        )
      );
    }
  }
  lines.push("");

  const growthRows = Object.entries(data.builders).flatMap(([builder, result]) =>
    Object.entries(result.churn80to20 ?? {}).map(([order, run]) => {
      const before = run.before;
      const after = run.after;
      const arrow = (a: string | undefined, b: string | undefined): string =>
        a === undefined || b === undefined ? "-" : `${a} -> ${b}`;
      return (
        `| ${builder} | ${order} | ${run.base} + ${run.inserted} | ${pct(run.churn)} | ` +
        `${pct(run.insertGatedAtMargin["0.03"] ?? 0)} | ${pct(run.insertUnadmittedRate)} | ` +
        `${arrow(before && String(before.rootChildren), after && String(after.rootChildren))} | ` +
        `${arrow(before && num(before.depthMean), after && num(after.depthMean))} | ` +
        `${arrow(before && pct(before.fanOutInTarget, 0), after && pct(after.fanOutInTarget, 0))} | ` +
        `${arrow(before && num(before.depth1NmiDomain), after && num(after.depth1NmiDomain))} | ` +
        `${pct(run.reachability, 0)} | ${run.hardViolations} | ${num(run.insertMsPerItem)} |`
      );
    })
  );
  if (growthRows.length > 0) {
    lines.push(
      "Growth 80/20: build on 80%, insert the last 20% one by one with local repair. Arrival: items = random notes, chronological = import order, articles = whole new articles with their pt/en twins, domains = whole new domains. Insert gated = admitted placements whose margin to the runner-up leaf is below 0.03 (out of sample); before/after = the tree right after the build / after the inserts.",
      "",
      "| Build | Arrival | Base + inserted | Churn | Insert gated at 0.03 | Insert unadmitted | Root children | Depth mean | Fan-out 4-9 | Depth-1 NMI | Reach | Hard | ms/insert |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...growthRows,
      ""
    );
  }
  if (incremental) {
    const parts = ["chronological", "shuffled"].flatMap((label) => {
      const run = incremental[label];
      if (!run || typeof run === "number") return [];
      return [
        `${label}: insert ambiguity ${pct(run.insertAmbiguityRate)} (cross-parent ${pct(run.insertCrossParentAmbiguityRate)}), ` +
          `insert unadmitted ${pct(run.insertUnadmittedRate)}, fan-out max before settle ${run.beforeSettle.fanOut.max}, ` +
          `settle operations ${run.settleOperations}`
      ];
    });
    lines.push(
      `Incremental from empty: NMI between the two orders (leaf partitions) ${num(Number(incremental.orderNmiLeaves ?? 0), 3)}; ${parts.join("; ")}.`,
      ""
    );
  }

  for (const [builder, reports] of Object.entries(data.calibration ?? {})) {
    for (const report of [reports.items, reports.articles]) {
      lines.push(
        `Calibration, ${builder}, held out: ${holdoutText[report.holdout] ?? report.holdout} ` +
          `(${report.base} base / ${report.heldOut} held out). Top-1 leaf right by domain ${pct(report.top1DomainAccuracy)}` +
          `${report.top1GroupAccuracy === null ? "" : `, by article ${pct(report.top1GroupAccuracy)}`}; admitted to a leaf ${pct(report.admittedLeafRate)}. ` +
          `Reference leaf = ${report.referenceLeaf}; its cosine p10 / p50 ${num(report.cosineOwnLeaf.p10, 3)} / ${num(report.cosineOwnLeaf.p50, 3)}; ` +
          `best other-domain leaf p10 / p50 / p90 ${num(report.cosineOtherDomainLeaf.p10, 3)} / ${num(report.cosineOtherDomainLeaf.p50, 3)} / ${num(report.cosineOtherDomainLeaf.p90, 3)}. ` +
          `Leaf coherence: pure leaves (${report.coherencePureLeaves.count}) p10 ${num(report.coherencePureLeaves.p10, 3)}, min ${num(report.coherencePureLeaves.min, 3)}; ` +
          `impure leaves (${report.coherenceImpureLeaves.count}) median ${num(report.coherenceImpureLeaves.p50, 3)}, min ${num(report.coherenceImpureLeaves.min, 3)}.`,
        "",
        "| Margin | Gated | Auto precision (domain) | Gated precision (domain) |",
        "| --- | --- | --- | --- |",
        ...report.marginCurve.map(
          (point) =>
            `| ${point.margin} | ${pct(point.gated)} | ${pct(point.autoDomainPrecision)} | ${pct(point.gatedDomainPrecision)} |`
        ),
        "",
        "| z | Reference leaf admitted | Best other-domain leaf admitted |",
        "| --- | --- | --- |",
        ...report.zCurve.map(
          (point) => `| ${point.z} | ${pct(point.ownAdmitted)} | ${pct(point.otherAdmitted)} |`
        ),
        "",
        "| Leaf-only cosine floor | Reference leaf kept | Other-domain leaf kept |",
        "| --- | --- | --- |",
        ...report.floorCurve.map(
          (point) =>
            `| ${point.floor} | ${pct(point.referenceKept)} | ${pct(point.otherDomainKept)} |`
        ),
        ""
      );
    }
  }
}
const outputPath = join(spikeDir, "real-results.md");
await writeFile(outputPath, `${lines.join("\n")}\n`, "utf8");
console.log(`Wrote ${outputPath}`);
