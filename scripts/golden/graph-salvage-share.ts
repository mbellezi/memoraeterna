/**
 * Offline salvage share of recorded knowledge-graph answers (F3 D35, T55, decision R9). For every
 * extraction answer in a cassette (first attempts and recorded repairs) it runs the recording-era
 * strict parse, and for the answers that parse rejects it runs the graph salvage that unpinned
 * extraction uses. The share is how many rejected answers salvage keeps with no further call.
 *
 *   npx tsx scripts/golden/graph-salvage-share.ts --cassette .cache/golden/cassettes/golden-small-f2 \
 *     --cassette .cache/topics/cassettes/e2e-plos --json .cache/f3/t55/salvage-share.json
 *
 * Read-only and offline ($0): it reads cassette entries and prints counts only, never text.
 */
import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { salvageKnowledgeGraph } from "../../apps/desktop/src/main/services/graph-salvage.ts";
import {
  parseJsonOutput,
  parseKnowledgeGraphOutput
} from "../../apps/desktop/src/main/services/knowledge-processing.ts";

const entrySchema = z.object({
  taskType: z.string(),
  request: z.object({ input: z.unknown() }).passthrough(),
  responses: z.array(z.object({ output: z.unknown() }).passthrough())
});

export interface SalvageShare {
  cassette: string;
  /** Extraction answers read (first attempts and repairs). */
  answers: number;
  /** Of those, the repair attempts. */
  repairAnswers: number;
  /** Answers the recording-era strict parse rejects. */
  strictFailures: number;
  /** Rejected answers that are not JSON at all. */
  invalidJson: number;
  /** Rejected, valid JSON, and kept by salvage (at least one valid entity) with no call. */
  salvageKept: number;
  /** Rejected and nothing valid left after salvage: they still need the repair call. */
  salvageEmpty: number;
  /** `salvageKept` over the rejected answers that are valid JSON; null with none. */
  keptShareOfValidJson: number | null;
  /** `salvageKept` over every rejected answer; null with none. */
  keptShareOfFailures: number | null;
  /** Items salvage dropped (no call), by reason, over the kept answers. */
  dropped: Record<string, number>;
  normalized: number;
  /** Entities and relations in the kept answers, as received and as kept: what salvage costs in content. */
  items: {
    entitiesReceived: number;
    entitiesKept: number;
    relationsReceived: number;
    relationsKept: number;
  };
  /** Recorded first attempts whose repair is in the cassette (repair prompts found). */
  recordedRepairs: number;
}

const extractionMarker = "Extract knowledge graph elements only from the";
const repairMarker = "Previous invalid output:\n";
const aliasMarker = "The only allowed evidence aliases in this batch are: ";

/** The evidence aliases a prompt allows, as the alias map the parser takes (alias to itself). */
export function aliasesOfPrompt(prompt: string): Map<string, string> {
  const start = prompt.indexOf(aliasMarker);
  if (start < 0) return new Map();
  const rest = prompt.slice(start + aliasMarker.length);
  const end = rest.indexOf("]");
  if (!rest.startsWith("[") || end < 0) return new Map();
  try {
    const list = z.array(z.string()).parse(JSON.parse(rest.slice(0, end + 1)));
    return new Map(list.map((alias) => [alias, alias]));
  } catch {
    return new Map();
  }
}

async function entryFiles(directory: string): Promise<string[]> {
  const names = await readdir(join(directory, "entries"), { recursive: true });
  return names.filter((name) => name.endsWith(".json")).sort();
}

export async function measureSalvageShare(cassetteDirectory: string): Promise<SalvageShare> {
  const report: SalvageShare = {
    cassette: cassetteDirectory,
    answers: 0,
    repairAnswers: 0,
    strictFailures: 0,
    invalidJson: 0,
    salvageKept: 0,
    salvageEmpty: 0,
    keptShareOfValidJson: null,
    keptShareOfFailures: null,
    dropped: {},
    normalized: 0,
    items: { entitiesReceived: 0, entitiesKept: 0, relationsReceived: 0, relationsKept: 0 },
    recordedRepairs: 0
  };
  for (const name of await entryFiles(cassetteDirectory)) {
    const parsed = entrySchema.safeParse(
      JSON.parse(await readFile(join(cassetteDirectory, "entries", name), "utf8"))
    );
    if (!parsed.success || parsed.data.taskType !== "knowledge-graph-generation") continue;
    const prompt = typeof parsed.data.request.input === "string" ? parsed.data.request.input : "";
    // Entity identity and relation-type prompts never carry this sentence.
    const isRepair = prompt.includes(repairMarker) && prompt.includes(aliasMarker);
    if (!prompt.includes(extractionMarker) && !isRepair) continue;
    if (isRepair) {
      report.recordedRepairs += parsed.data.responses.length;
      report.repairAnswers += parsed.data.responses.length;
    }
    const aliases = aliasesOfPrompt(prompt);
    for (const response of parsed.data.responses) {
      report.answers += 1;
      try {
        parseKnowledgeGraphOutput(response.output, aliases);
        continue;
      } catch {
        report.strictFailures += 1;
      }
      let value: unknown;
      try {
        value = parseJsonOutput(response.output);
      } catch {
        report.invalidJson += 1;
        continue;
      }
      const salvage = salvageKnowledgeGraph(value, aliases);
      if (salvage.nothingValid) {
        report.salvageEmpty += 1;
        continue;
      }
      report.salvageKept += 1;
      report.normalized += salvage.normalized;
      const received = value as { entities?: unknown[]; relations?: unknown[] };
      report.items.entitiesReceived += received.entities?.length ?? 0;
      report.items.relationsReceived += received.relations?.length ?? 0;
      report.items.entitiesKept += salvage.output.entities.length;
      report.items.relationsKept += salvage.output.relations.length;
      for (const [reason, count] of Object.entries(salvage.dropped))
        report.dropped[reason] = (report.dropped[reason] ?? 0) + (count ?? 0);
    }
  }
  const validJson = report.strictFailures - report.invalidJson;
  report.keptShareOfValidJson = validJson > 0 ? report.salvageKept / validJson : null;
  report.keptShareOfFailures =
    report.strictFailures > 0 ? report.salvageKept / report.strictFailures : null;
  return report;
}

async function main() {
  const { values } = parseArgs({
    options: { cassette: { type: "string", multiple: true }, json: { type: "string" } }
  });
  const cassettes = values.cassette ?? [];
  if (cassettes.length === 0) {
    console.error(
      "Usage: graph-salvage-share.ts --cassette <dir> [--cassette <dir>] [--json <out>]"
    );
    process.exitCode = 2;
    return;
  }
  const reports: SalvageShare[] = [];
  for (const cassette of cassettes) reports.push(await measureSalvageShare(resolve(cassette)));
  const total = reports.reduce(
    (sum, report) => ({
      answers: sum.answers + report.answers,
      strictFailures: sum.strictFailures + report.strictFailures,
      invalidJson: sum.invalidJson + report.invalidJson,
      salvageKept: sum.salvageKept + report.salvageKept
    }),
    { answers: 0, strictFailures: 0, invalidJson: 0, salvageKept: 0 }
  );
  const output = { total, cassettes: reports };
  console.log(JSON.stringify(output, null, 2));
  if (values.json) {
    await mkdir(dirname(resolve(values.json)), { recursive: true });
    await writeFile(resolve(values.json), `${JSON.stringify(output, null, 2)}\n`);
  }
}

if (import.meta.main) await main();
