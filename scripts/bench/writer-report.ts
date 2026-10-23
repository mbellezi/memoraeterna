/**
 * Report of the prompt-replay runs (F4 T69, record only): reads the run folders `writer-replay.ts`
 * left and writes the tables of `docs/spikes/local-writer-benchmark.md` — validity of the first answer,
 * repairs, salvage, speed, memory, swap and the yield against the recorded Codex answer, per arm and per
 * contract, with the recording's own first-pass record beside them. Bars are the spike's section 7.4
 * proposals, shown to read the numbers against; nothing here adopts a model (decision 26).
 *
 *   npx tsx scripts/bench/writer-report.ts <run dir>... [--format md|json] [--out <file>]
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { contractIds, type ContractId } from "./contracts/types.ts";
import { mean, percentile } from "./replay-metrics.ts";
import {
  manifestSchema,
  parseItemLines,
  type ItemRecord,
  type RunManifest
} from "./replay-records.ts";

/** Bars from `docs/spikes/hardware-tiers-and-models.md` 7.4, shown beside the numbers. */
export const spikeBars = {
  repairCallShare: 0.02,
  postSalvageValid: 1,
  decodeTpsBackground: 8,
  decodeTpsAnswer: 15,
  swapGrowthMiB: 256,
  yieldRecall: 0.85
} as const;

export interface ContractSummary {
  contract: ContractId | "all";
  items: number;
  /** Items whose prompt today differs from the recording's. */
  promptDriftItems: number;
  /** Calls made, repairs included, and the repairs among them. */
  calls: number;
  repairCalls: number;
  callErrors: number;
  /** Items whose first answer needed no repair call and ended usable. */
  noRepair: number;
  /** Items that also had nothing salvaged: every part of the first answer was valid. */
  firstPassClean: number;
  /** Items that ended with a usable answer after validation, salvage and repair. */
  finalOk: number;
  salvagedItems: number;
  errors: Record<string, number>;
  schemaModes: Record<string, number>;
  schemaOffered: number;
  /** The recording's own record under the same flow: items without a repair, items clean, repairs, salvage. */
  recordedNoRepair: number;
  recordedFirstPassClean: number;
  recordedRepairCalls: number;
  recordedSalvagedItems: number;
  /** Local output tokens of first asks over the recorded answers' output tokens. */
  outputTokenRatio: number | null;
  ttftMsP50: number | null;
  ttftMsP95: number | null;
  prefillTpsP50: number | null;
  decodeTpsP50: number | null;
  /** The slowest 5% of calls decode at or below this. */
  decodeTpsP05: number | null;
  wallMsP50: number | null;
  wallMsP95: number | null;
  wallHours: number;
  peakHelperRssMiB: number | null;
  /** The helper's physical-footprint peak, which counts the GPU buffers. */
  peakHelperFootprintMiB: number | null;
  peakSwapUsedMiB: number | null;
  minMemoryLevel: number | null;
  /** Mean of each yield metric over the items that have one. */
  yield: Record<string, number>;
}

export interface RunSummary {
  runId: string;
  arm: string;
  label: string;
  promptSource: string;
  schemaRequested: boolean;
  schemaSupported: boolean;
  seed: number | null;
  helperSha256: string | null;
  items: number;
  planned: number;
  wallHours: number;
  swapGrowthMiB: number | null;
  loadMs: number | null;
  overall: ContractSummary;
  byContract: ContractSummary[];
}

function numbers(values: ReadonlyArray<number | null | undefined>): number[] {
  return values.filter((value): value is number => value !== null && value !== undefined);
}

function maximum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.max(...values);
}

function minimum(values: readonly number[]): number | null {
  return values.length === 0 ? null : Math.min(...values);
}

export function summarizeContract(
  contract: ContractId | "all",
  records: readonly ItemRecord[]
): ContractSummary {
  const calls = records.flatMap((record) => record.calls);
  const answered = calls.filter((call) => call.error === null);
  const errors: Record<string, number> = {};
  for (const record of records)
    if (record.outcome.error)
      errors[record.outcome.error] = (errors[record.outcome.error] ?? 0) + 1;
  const schemaModes: Record<string, number> = {};
  for (const call of answered) {
    const mode = call.schemaMode ?? "unreported";
    schemaModes[mode] = (schemaModes[mode] ?? 0) + 1;
  }
  // Output tokens of the first ask over the recorded answer's, on the items that have both counts.
  const counted = records.flatMap((record) => {
    const local = record.calls[0]?.outputTokens;
    const theirs = record.recorded.outputTokens;
    return local != null && theirs != null ? [{ local, theirs }] : [];
  });
  const recordedOutput = counted.reduce((sum, row) => sum + row.theirs, 0);
  const yieldNames = [...new Set(records.flatMap((record) => Object.keys(record.yield ?? {})))];
  return {
    contract,
    items: records.length,
    promptDriftItems: records.filter((record) => record.promptDrift).length,
    calls: calls.length,
    repairCalls: calls.filter((call) => call.isRepair).length,
    callErrors: calls.length - answered.length,
    noRepair: records.filter((record) => record.repairCalls === 0 && record.outcome.ok).length,
    firstPassClean: records.filter((record) => record.firstPassClean).length,
    finalOk: records.filter((record) => record.outcome.ok).length,
    salvagedItems: records.reduce((sum, record) => sum + record.outcome.salvagedItems, 0),
    errors,
    schemaModes,
    schemaOffered: calls.filter((call) => call.schemaOffered).length,
    recordedNoRepair: records.filter(
      (record) => record.baseline.repairCalls === 0 && record.baseline.ok
    ).length,
    recordedFirstPassClean: records.filter((record) => record.baseline.firstPassClean).length,
    recordedRepairCalls: records.reduce((sum, record) => sum + record.baseline.repairCalls, 0),
    recordedSalvagedItems: records.reduce((sum, record) => sum + record.baseline.salvagedItems, 0),
    outputTokenRatio:
      counted.length > 0 && recordedOutput > 0
        ? counted.reduce((sum, row) => sum + row.local, 0) / recordedOutput
        : null,
    ttftMsP50: percentile(numbers(answered.map((call) => call.ttftMs)), 50),
    ttftMsP95: percentile(numbers(answered.map((call) => call.ttftMs)), 95),
    prefillTpsP50: percentile(numbers(answered.map((call) => call.prefillTps)), 50),
    decodeTpsP50: percentile(numbers(answered.map((call) => call.decodeTps)), 50),
    decodeTpsP05: percentile(numbers(answered.map((call) => call.decodeTps)), 5),
    wallMsP50: percentile(
      answered.map((call) => call.wallMs),
      50
    ),
    wallMsP95: percentile(
      answered.map((call) => call.wallMs),
      95
    ),
    wallHours: calls.reduce((sum, call) => sum + call.wallMs, 0) / 3_600_000,
    peakHelperRssMiB: maximum(numbers(calls.map((call) => call.peakHelperRssMiB))),
    peakHelperFootprintMiB: maximum(numbers(calls.map((call) => call.peakHelperFootprintMiB))),
    peakSwapUsedMiB: maximum(numbers(calls.map((call) => call.peakSwapUsedMiB))),
    minMemoryLevel: minimum(numbers(calls.map((call) => call.minMemoryLevel))),
    yield: Object.fromEntries(
      yieldNames.map((name) => [
        name,
        mean(numbers(records.map((record) => record.yield?.[name]))) ?? 0
      ])
    )
  };
}

export function summarizeRun(manifest: RunManifest, records: readonly ItemRecord[]): RunSummary {
  const byContract = contractIds
    .map((contract) => ({
      contract,
      rows: records.filter((record) => record.contract === contract)
    }))
    .filter(({ rows }) => rows.length > 0)
    .map(({ contract, rows }) => summarizeContract(contract, rows));
  const overall = summarizeContract("all", records);
  const peakSwap = overall.peakSwapUsedMiB;
  return {
    runId: manifest.runId,
    arm: manifest.arm.id,
    label: manifest.arm.label,
    promptSource: manifest.selection.promptSource,
    schemaRequested: manifest.schema.requested,
    schemaSupported: manifest.schema.supported,
    seed: manifest.seed,
    helperSha256: manifest.helper.sha256,
    items: records.length,
    planned: manifest.cassette.items,
    wallHours: overall.wallHours,
    swapGrowthMiB:
      peakSwap !== null && manifest.swapBeforeMiB !== null
        ? Math.max(0, peakSwap - manifest.swapBeforeMiB)
        : null,
    loadMs: manifest.warmup.loadMs,
    overall,
    byContract
  };
}

/** Reads a run folder: its manifest and the item lines that parse (a torn last line is dropped). */
export async function readRun(directory: string): Promise<{
  manifest: RunManifest;
  records: ItemRecord[];
}> {
  const manifest = manifestSchema.parse(
    JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"))
  );
  let text = "";
  try {
    text = await readFile(join(directory, "items.ndjson"), "utf8");
  } catch {
    // A run that stopped before its first item has no lines.
  }
  const records = parseItemLines(text);
  return { manifest, records };
}

const percent = (value: number | null, digits = 1) =>
  value === null ? "n/a" : `${(value * 100).toFixed(digits)}%`;
const fixed = (value: number | null, digits = 1) =>
  value === null ? "n/a" : value.toFixed(digits);
const share = (part: number, whole: number) => (whole === 0 ? null : part / whole);

function barMark(ok: boolean | null): string {
  return ok === null ? "" : ok ? " (meets bar)" : " (misses bar)";
}

/** Markdown tables of the runs: one overview, then per contract, then the bars. */
export function renderReport(summaries: readonly RunSummary[]): string {
  const lines: string[] = [];
  lines.push("## Runs", "");
  lines.push(
    "| Arm | Run | Prompts | Schema (asked / runtime takes it) | Items | Wall hours | Load (s) | Seed | Helper |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |"
  );
  for (const run of summaries)
    lines.push(
      `| ${run.label} | ${run.runId} | ${run.promptSource} | ${run.schemaRequested ? "yes" : "no"} / ${run.schemaSupported ? "yes" : "no"} | ${run.items} of ${run.planned} | ${fixed(run.wallHours, 2)} | ${fixed(run.loadMs === null ? null : run.loadMs / 1000)} | ${run.seed ?? "none"} | ${run.helperSha256?.slice(0, 8) ?? "n/a"} |`
    );
  lines.push("", "## Structure: first answer, repairs and final validity", "");
  lines.push(
    "| Arm | Contract | Items | No repair needed | Codex: no repair | Clean (nothing salvaged) | Codex: clean | Repair calls | Repair share of calls | Final valid | Salvaged items (Codex) | Call errors | Schema modes |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |"
  );
  for (const run of summaries)
    for (const row of [...run.byContract, run.overall]) {
      const repairShare = share(row.repairCalls, row.calls);
      lines.push(
        `| ${run.arm} | ${row.contract} | ${row.items} | ${percent(share(row.noRepair, row.items))} | ${percent(share(row.recordedNoRepair, row.items))} | ${percent(share(row.firstPassClean, row.items))} | ${percent(share(row.recordedFirstPassClean, row.items))} | ${row.repairCalls} | ${percent(repairShare)}${barMark(row.contract === "all" && repairShare !== null ? repairShare <= spikeBars.repairCallShare : null)} | ${percent(share(row.finalOk, row.items))} | ${row.salvagedItems} (${row.recordedSalvagedItems}) | ${row.callErrors} | ${
          Object.entries(row.schemaModes)
            .map(([mode, count]) => `${mode} ${count}`)
            .join(", ") || "n/a"
        } |`
      );
    }
  lines.push("", "## Speed and memory", "");
  lines.push(
    "| Arm | Contract | TTFT p50 / p95 (s) | Prefill p50 (tok/s) | Decode p50 / slowest 5% (tok/s) | Call p50 / p95 (s) | Output tokens vs Codex | Peak helper footprint / RSS (GiB) | Min memory level |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  );
  for (const run of summaries)
    for (const row of [...run.byContract, run.overall])
      lines.push(
        `| ${run.arm} | ${row.contract} | ${fixed(row.ttftMsP50 === null ? null : row.ttftMsP50 / 1000)} / ${fixed(row.ttftMsP95 === null ? null : row.ttftMsP95 / 1000)} | ${fixed(row.prefillTpsP50, 0)} | ${fixed(row.decodeTpsP50)} / ${fixed(row.decodeTpsP05)} | ${fixed(row.wallMsP50 === null ? null : row.wallMsP50 / 1000)} / ${fixed(row.wallMsP95 === null ? null : row.wallMsP95 / 1000)} | ${fixed(row.outputTokenRatio, 2)} | ${fixed(row.peakHelperFootprintMiB === null ? null : row.peakHelperFootprintMiB / 1024, 1)} / ${fixed(row.peakHelperRssMiB === null ? null : row.peakHelperRssMiB / 1024, 1)} | ${fixed(row.minMemoryLevel, 0)} |`
      );
  lines.push("", "## Yield against the recorded Codex answer", "");
  lines.push(
    "Means over the items with a usable local answer and a readable recorded one; each metric is a share of what the Codex answer holds unless it says ratio.",
    ""
  );
  lines.push("| Arm | Contract | Metrics |", "| --- | --- | --- |");
  for (const run of summaries)
    for (const row of run.byContract)
      lines.push(
        `| ${run.arm} | ${row.contract} | ${
          Object.entries(row.yield)
            .map(
              ([name, value]) =>
                `${name} ${/Ratio$/u.test(name) ? value.toFixed(2) : percent(value)}`
            )
            .join("; ") || "n/a"
        } |`
      );
  lines.push("", "## Against the spike's proposed bars (record only)", "");
  lines.push(
    "| Arm | Decode p50 | Repairs | Final valid | Swap growth | Recall of Codex entities and relations |",
    "| --- | --- | --- | --- | --- | --- |"
  );
  for (const run of summaries) {
    const graph = run.byContract.find((row) => row.contract === "graph");
    const decode = run.overall.decodeTpsP50;
    const swap = run.swapGrowthMiB;
    const repairs = share(run.overall.repairCalls, run.overall.calls);
    const valid = share(run.overall.finalOk, run.overall.items);
    const recall =
      graph && graph.yield.entityRecall !== undefined && graph.yield.relationRecall !== undefined
        ? Math.min(graph.yield.entityRecall, graph.yield.relationRecall)
        : null;
    lines.push(
      `| ${run.arm} | ${fixed(decode)} tok/s${barMark(decode === null ? null : decode >= spikeBars.decodeTpsBackground)} (background ${spikeBars.decodeTpsBackground}, answer ${spikeBars.decodeTpsAnswer}) | ${percent(repairs)}${barMark(repairs === null ? null : repairs <= spikeBars.repairCallShare)} | ${percent(valid)}${barMark(valid === null ? null : valid >= spikeBars.postSalvageValid)} | ${swap === null ? "n/a" : `${swap.toFixed(0)} MiB`}${barMark(swap === null ? null : swap <= spikeBars.swapGrowthMiB)} | ${percent(recall)}${barMark(recall === null ? null : recall >= spikeBars.yieldRecall)} |`
    );
  }
  lines.push(...renderSchemaComparison(summaries));
  lines.push("");
  return lines.join("\n");
}

/**
 * With and without the output schema (T102's replay): a run that asked for the schema against the
 * run of the same arm and prompts that did not. The speed ratio is the bar T102 pre-registers.
 */
function renderSchemaComparison(summaries: readonly RunSummary[]): string[] {
  const rows: string[] = [];
  for (const run of summaries.filter((candidate) => candidate.schemaRequested)) {
    const plain = summaries.find(
      (candidate) =>
        !candidate.schemaRequested &&
        candidate.arm === run.arm &&
        candidate.promptSource === run.promptSource
    );
    if (!plain) continue;
    for (const row of [...run.byContract, run.overall]) {
      const before =
        row.contract === "all"
          ? plain.overall
          : plain.byContract.find((candidate) => candidate.contract === row.contract);
      if (!before) continue;
      const ratio =
        before.decodeTpsP50 && row.decodeTpsP50 ? row.decodeTpsP50 / before.decodeTpsP50 : null;
      const modes = Object.entries(row.schemaModes)
        .map(([mode, count]) => `${mode} ${count}`)
        .join(", ");
      rows.push(
        `| ${run.arm} | ${row.contract} | ${fixed(before.decodeTpsP50)} → ${fixed(row.decodeTpsP50)} (${fixed(ratio, 2)}x) | ${percent(share(before.noRepair, before.items))} → ${percent(share(row.noRepair, row.items))} | ${percent(share(before.repairCalls, before.calls))} → ${percent(share(row.repairCalls, row.calls))} | ${percent(share(before.finalOk, before.items))} → ${percent(share(row.finalOk, row.items))} | ${modes || "n/a"} |`
      );
    }
  }
  if (rows.length === 0) return [];
  return [
    "",
    "## With and without the output schema",
    "",
    "| Arm | Contract | Decode p50 tok/s (plain → schema) | No repair needed | Repair share of calls | Final valid | Schema modes (schema run) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows
  ];
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { format: { type: "string", default: "md" }, out: { type: "string" } }
  });
  if (positionals.length === 0 || !["md", "json"].includes(values.format ?? "md")) {
    console.error("Usage: writer-report.ts <run dir>... [--format md|json] [--out <file>]");
    process.exit(2);
  }
  const summaries: RunSummary[] = [];
  for (const directory of positionals) {
    const { manifest, records } = await readRun(resolve(directory));
    summaries.push(summarizeRun(manifest, records));
  }
  const text =
    values.format === "json" ? `${JSON.stringify(summaries, null, 2)}\n` : renderReport(summaries);
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true });
    await writeFile(resolve(values.out), text);
  } else {
    process.stdout.write(text);
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`[writer-report] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
