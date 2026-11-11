/**
 * Sources the cumulative graph budget bound, counted from recorded traces (F5 D23, T122). Until F5
 * a source's graph extraction lowered each call's caps to what was left of a per-source budget
 * (the two per-source graph-cap settings, 250 and 500 by default, removed in T123) and stopped once no
 * entity was left, so for a source whose answers reached it some batches were cut, asked with lower
 * caps or never sent. Since T122 every batch states the same caps and runs: such a source's prompts
 * change, a cassette replay meets them as misses, and its calls per chapter grow. This counts those
 * sources in a cassette, so any calls-per-chapter change is explained before R1.
 *
 *   npx tsx scripts/golden/cap-bound-sources.ts --cassette .cache/golden/cassettes/golden-x7-f3 \
 *     --cassette .cache/golden/cassettes/golden-small [--json .cache/f5/t122/cap-bound.json]
 *
 * A source is the source graph's first-attempt prompts (source excerpts or catalog metadata; the
 * budget never applied to the notes graph or to repairs) with the same title and language lines.
 * It is cap-bound when its recorded answers hold at least the entity or relation budget, or when
 * one of its prompts states caps below the source's own per-call caps. Answers are counted as
 * received, before validation, so the count can only err towards cap-bound. Two sources with the
 * same title and language count as one, which errs the same way. Read-only and offline ($0): it
 * prints counts only; a source is named by a hash of its title, never by text.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { parseJsonOutput } from "../../apps/desktop/src/main/services/knowledge-processing.ts";

/** The budget's defaults before F5 (the two settings T123 removes). */
export const defaultGraphBudget = { maxEntities: 250, maxRelations: 500 } as const;

const entrySchema = z.object({
  taskType: z.string(),
  request: z.object({ input: z.unknown() }).passthrough(),
  responses: z.array(z.object({ output: z.unknown() }).passthrough()).min(1)
});
export type CassetteEntry = z.infer<typeof entrySchema>;

/** The source graph's first-attempt extraction and the caps it states (both prompt generations). */
const capsPattern = /at most (\d+) entities(?:, \d+ claims,)? and (\d+) relations/u;
const sourceHeadings = ["\nSource excerpts:\n", "\nSource catalog metadata:\n"];
const repairMarker = "Previous invalid output:\n";

export interface SourceTrace {
  /** The first 12 hex digits of the SHA-256 of the title and language lines. */
  source: string;
  calls: number;
  entities: number;
  relations: number;
  /** Prompts that state caps below the source's own per-call caps (the budget lowered them). */
  loweredPrompts: number;
  /** Answers that are not JSON with entity and relation lists (counted as none). */
  unreadAnswers: number;
  capBound: boolean;
}

export interface CapBoundReport {
  cassette: string;
  budget: { maxEntities: number; maxRelations: number };
  /** First-attempt source-graph calls read. */
  graphCalls: number;
  sources: number;
  capBound: number;
  loweredPrompts: number;
  /** The most entities and relations one source's answers hold. */
  maxEntities: number;
  maxRelations: number;
  capBoundSources: SourceTrace[];
}

function line(prompt: string, label: string): string {
  const start = prompt.indexOf(`\n${label}: `);
  if (start < 0) return "";
  const rest = prompt.slice(start + label.length + 3);
  const end = rest.indexOf("\n");
  return end < 0 ? rest : rest.slice(0, end);
}

function counted(output: unknown): { entities: number; relations: number } | null {
  try {
    const value = parseJsonOutput(output) as { entities?: unknown; relations?: unknown } | null;
    if (!value || !Array.isArray(value.entities) || !Array.isArray(value.relations)) return null;
    return { entities: value.entities.length, relations: value.relations.length };
  } catch {
    return null;
  }
}

/** Counts the cap-bound sources of a cassette's entries. */
export function capBoundSources(
  entries: Iterable<CassetteEntry>,
  budget: { maxEntities: number; maxRelations: number } = defaultGraphBudget,
  cassette = ""
): CapBoundReport {
  const bySource = new Map<
    string,
    { trace: SourceTrace; caps: Array<{ entities: number; relations: number }> }
  >();
  let graphCalls = 0;
  for (const entry of entries) {
    if (entry.taskType !== "knowledge-graph-generation") continue;
    const prompt = typeof entry.request.input === "string" ? entry.request.input : "";
    const caps = capsPattern.exec(prompt);
    if (
      !caps ||
      prompt.includes(repairMarker) ||
      !sourceHeadings.some((heading) => prompt.includes(heading))
    )
      continue;
    graphCalls += 1;
    const source = createHash("sha256")
      .update(`${line(prompt, "Source title")}\u0000${line(prompt, "Source language")}`)
      .digest("hex")
      .slice(0, 12);
    const held = bySource.get(source) ?? {
      trace: {
        source,
        calls: 0,
        entities: 0,
        relations: 0,
        loweredPrompts: 0,
        unreadAnswers: 0,
        capBound: false
      },
      caps: []
    };
    held.trace.calls += 1;
    held.caps.push({ entities: Number(caps[1]), relations: Number(caps[2]) });
    // The import's own answer: a later occurrence of the same prompt is a re-run of it.
    const answer = counted(entry.responses[0]!.output);
    if (answer) {
      held.trace.entities += answer.entities;
      held.trace.relations += answer.relations;
    } else held.trace.unreadAnswers += 1;
    bySource.set(source, held);
  }
  const traces = [...bySource.values()].map(({ trace, caps }) => {
    // The first batch always had the whole budget, so the source's largest caps are its call caps.
    const callEntities = Math.max(...caps.map((cap) => cap.entities));
    const callRelations = Math.max(...caps.map((cap) => cap.relations));
    const loweredPrompts = caps.filter(
      (cap) => cap.entities < callEntities || cap.relations < callRelations
    ).length;
    return {
      ...trace,
      loweredPrompts,
      capBound:
        loweredPrompts > 0 ||
        trace.entities >= budget.maxEntities ||
        trace.relations >= budget.maxRelations
    };
  });
  const bound = traces
    .filter((trace) => trace.capBound)
    .sort((a, b) => b.entities - a.entities || a.source.localeCompare(b.source));
  return {
    cassette,
    budget: { ...budget },
    graphCalls,
    sources: traces.length,
    capBound: bound.length,
    loweredPrompts: traces.reduce((sum, trace) => sum + trace.loweredPrompts, 0),
    maxEntities: Math.max(0, ...traces.map((trace) => trace.entities)),
    maxRelations: Math.max(0, ...traces.map((trace) => trace.relations)),
    capBoundSources: bound
  };
}

/** Every entry of a cassette folder (`<cassette>/entries/**.json`); unreadable ones are skipped. */
export async function readCassetteEntries(cassette: string): Promise<CassetteEntry[]> {
  const names = (await readdir(join(cassette, "entries"), { recursive: true }))
    .filter((name) => name.endsWith(".json"))
    .sort();
  const entries: CassetteEntry[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(join(cassette, "entries", name), "utf8"));
    } catch {
      continue;
    }
    const parsed = entrySchema.safeParse(value);
    if (parsed.success) entries.push(parsed.data);
  }
  return entries;
}

async function main() {
  const { values } = parseArgs({
    options: {
      cassette: { type: "string", multiple: true },
      json: { type: "string" },
      "entity-budget": { type: "string" },
      "relation-budget": { type: "string" }
    }
  });
  const cassettes = values.cassette ?? [];
  if (cassettes.length === 0) {
    console.error(
      "Usage: cap-bound-sources.ts --cassette <dir> [--cassette <dir>] [--entity-budget 250] [--relation-budget 500] [--json <out>]"
    );
    process.exitCode = 2;
    return;
  }
  const budget = {
    maxEntities: Number(values["entity-budget"] ?? defaultGraphBudget.maxEntities),
    maxRelations: Number(values["relation-budget"] ?? defaultGraphBudget.maxRelations)
  };
  const reports: CapBoundReport[] = [];
  for (const cassette of cassettes) {
    const directory = resolve(cassette);
    reports.push(capBoundSources(await readCassetteEntries(directory), budget, cassette));
  }
  const output = {
    capBound: reports.reduce((sum, report) => sum + report.capBound, 0),
    cassettes: reports
  };
  console.log(JSON.stringify(output, null, 2));
  if (values.json) {
    await mkdir(dirname(resolve(values.json)), { recursive: true });
    await writeFile(resolve(values.json), `${JSON.stringify(output, null, 2)}\n`);
  }
}

if (import.meta.main) await main();
