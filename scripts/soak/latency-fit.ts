/**
 * Fits the recorded Codex durations the soak's fake providers draw their latencies from (F3 T62,
 * spec 5.9): for every task, the `durationMs` of the recorded ChatGPT/Codex responses of the golden
 * and fixture cassettes, at 21 evenly spaced quantiles. Reads cassette entries (they hold library
 * text, so only this machine reads them) and writes numbers only.
 *
 *   npm run soak:latency-fit                       # the default cassettes -> .cache/f3/soak/latency-fit.json
 *   npm run soak:latency-fit -- --cassette .cache/golden/cassettes/golden-small-f2 --out fit.json
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  latencyFitFormat,
  latencyFitSchema,
  type LatencyFit
} from "../../apps/desktop/src/main/services/dev/soak-plan.ts";

/** The cassettes whose Codex entries stand in for the soak's remote answers. */
export const defaultCassettes = [
  ".cache/golden/cassettes/golden-small-f2",
  ".cache/golden/cassettes/matching-fixture-f2",
  ".cache/golden/cassettes/golden-small-v9-a",
  ".cache/golden/cassettes/matching-fixture-v9-a",
  ".cache/golden/cassettes/matching-fixture-v9-b",
  ".cache/golden/cassettes/golden-small-v5-a",
  ".cache/golden/cassettes/matching-fixture-v5-a",
  ".cache/golden/cassettes/matching-fixture-v5-b"
] as const;

export const defaultFitPath = ".cache/f3/soak/latency-fit.json";

/** Quantile points of a fit: 0 %, 5 %, ..., 100 %. */
export const quantilePoints = Array.from({ length: 21 }, (_, index) => index / 20);

/** The value at quantile `q` of sorted values, interpolating between neighbours. */
export function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) throw new Error("No values.");
  const position = q * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

/** One recorded response: the task it answered and how long the provider took. */
export interface RecordedDuration {
  task: string;
  durationMs: number;
}

/** The durations of the Codex responses (remote, provider `openai-codex`) of one parsed cassette entry. */
export function codexDurations(entry: unknown): RecordedDuration[] {
  if (typeof entry !== "object" || entry === null) return [];
  const { taskType, responses } = entry as { taskType?: unknown; responses?: unknown };
  if (typeof taskType !== "string" || !Array.isArray(responses)) return [];
  return responses.flatMap((response: unknown) => {
    const { providerId, runtime, durationMs } = (response ?? {}) as Record<string, unknown>;
    return providerId === "openai-codex" &&
      runtime === "remote" &&
      typeof durationMs === "number" &&
      Number.isFinite(durationMs) &&
      durationMs > 0
      ? [{ task: taskType, durationMs: Math.round(durationMs) }]
      : [];
  });
}

/** The fit of a set of recorded durations. */
export function fitDurations(
  durations: readonly RecordedDuration[],
  sources: readonly string[],
  now: Date = new Date()
): LatencyFit {
  const byTask = new Map<string, number[]>();
  for (const { task, durationMs } of durations)
    byTask.set(task, [...(byTask.get(task) ?? []), durationMs]);
  const tasks: LatencyFit["tasks"] = {};
  for (const [task, values] of [...byTask.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = values.toSorted((a, b) => a - b);
    tasks[task] = {
      count: sorted.length,
      quantilesMs: quantilePoints.map((q) => Math.round(quantile(sorted, q))),
      p50: Math.round(quantile(sorted, 0.5)),
      p90: Math.round(quantile(sorted, 0.9)),
      p99: Math.round(quantile(sorted, 0.99))
    };
  }
  return latencyFitSchema.parse({
    format: latencyFitFormat,
    version: 1,
    generatedAt: now.toISOString(),
    sources: [...sources],
    tasks
  });
}

async function* entryFiles(directory: string): AsyncGenerator<string> {
  let names;
  try {
    names = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name.name);
    if (name.isDirectory()) yield* entryFiles(path);
    else if (name.name.endsWith(".json")) yield path;
  }
}

/** Reads the Codex durations of every entry of a cassette directory. */
export async function readCassetteDurations(cassette: string): Promise<RecordedDuration[]> {
  const durations: RecordedDuration[] = [];
  for await (const file of entryFiles(join(cassette, "entries")))
    durations.push(...codexDurations(JSON.parse(await readFile(file, "utf8"))));
  return durations;
}

export const latencyFitUsage = `Usage: npx tsx scripts/soak/latency-fit.ts [--cassette <dir>]... [--out <file.json>]

  --cassette <dir>  A cassette directory to read (repeatable). Default: the golden and fixture
                    cassettes of F2 and the F3 bake-off (${defaultCassettes.length} directories).
  --out <file>      Where to write the fit. Default: ${defaultFitPath}.
  --help            Show this text.`;

export async function runLatencyFit(
  argv: readonly string[],
  root = process.cwd()
): Promise<string> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      cassette: { type: "string", multiple: true },
      out: { type: "string" },
      help: { type: "boolean", default: false }
    }
  });
  if (values.help) return latencyFitUsage;
  const cassettes = (values.cassette?.length ? values.cassette : [...defaultCassettes]).map(
    (path) => resolve(root, path)
  );
  const durations: RecordedDuration[] = [];
  const used: string[] = [];
  for (const cassette of cassettes) {
    const found = await readCassetteDurations(cassette);
    if (found.length > 0) used.push(relative(root, cassette));
    durations.push(...found);
  }
  if (durations.length === 0) throw new Error("No recorded Codex response was found.");
  const fit = fitDurations(durations, used);
  const out = resolve(root, values.out ?? defaultFitPath);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(fit, null, 2)}\n`);
  const rows = Object.entries(fit.tasks).map(
    ([task, value]) =>
      `${task.padEnd(30)} n=${String(value.count).padStart(5)}  p50 ${value.p50} ms  p90 ${value.p90} ms  p99 ${value.p99} ms`
  );
  return [`Wrote ${relative(root, out)} from ${used.length} cassette(s).`, ...rows].join("\n");
}

if (import.meta.main) {
  try {
    console.info(await runLatencyFit(process.argv.slice(2)));
  } catch (error) {
    console.error(`[latency-fit] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
