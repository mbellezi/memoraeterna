/**
 * Compares two golden runs (usually a recording and its replay).
 *
 *   npx tsx scripts/golden/compare.ts <run A> <run B>
 *
 * Each argument is a run directory under .cache/golden/runs/ or its summary.json. Exits 0 when
 * both runs completed with identical content digests (chunks, notes, relations, summaries,
 * entities), stage outcomes and AI calls and tokens per task; wall times are only reported.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

const digestSchema = z.object({ count: z.number(), sha256: z.string() });
const summarySchema = z
  .object({
    status: z.string(),
    error: z.string().optional(),
    wallMs: z.object({ total: z.number(), processing: z.number() }).partial().optional(),
    cassette: z
      .object({ mode: z.string(), served: z.number(), recorded: z.number(), misses: z.number() })
      .passthrough()
      .nullable()
      .optional(),
    stages: z
      .record(z.string(), z.object({ statuses: z.record(z.string(), z.number()) }).passthrough())
      .optional(),
    ai: z
      .array(
        z
          .object({
            taskType: z.string(),
            status: z.string(),
            calls: z.number(),
            inputTokens: z.number().nullable(),
            outputTokens: z.number().nullable(),
            durationMs: z.number().nullable()
          })
          .passthrough()
      )
      .optional(),
    outputs: z.record(z.string(), digestSchema).optional()
  })
  .passthrough();
type Summary = z.infer<typeof summarySchema>;

const [left, right] = process.argv.slice(2);
if (!left || !right) {
  console.error("Usage: compare.ts <run A dir | summary.json> <run B dir | summary.json>");
  process.exit(2);
}
const a = await load(left);
const b = await load(right);
const differences: string[] = [];

for (const [name, run] of [
  ["A", a],
  ["B", b]
] as const)
  if (run.status !== "completed")
    differences.push(`run ${name} status is ${run.status}${run.error ? `: ${run.error}` : ""}`);

const outputKeys = new Set([...Object.keys(a.outputs ?? {}), ...Object.keys(b.outputs ?? {})]);
console.log("Content");
for (const key of [...outputKeys].sort()) {
  const x = a.outputs?.[key];
  const y = b.outputs?.[key];
  const same = x?.sha256 === y?.sha256 && x?.count === y?.count;
  console.log(
    `  ${key.padEnd(16)} ${same ? "same" : "DIFFERENT"}  ${x?.count ?? "-"} / ${y?.count ?? "-"}`
  );
  if (!same) differences.push(`content ${key} differs`);
}

console.log("Stages");
const stageNames = new Set([...Object.keys(a.stages ?? {}), ...Object.keys(b.stages ?? {})]);
for (const stage of [...stageNames].sort()) {
  const x = JSON.stringify(a.stages?.[stage]?.statuses ?? {});
  const y = JSON.stringify(b.stages?.[stage]?.statuses ?? {});
  console.log(
    `  ${stage.padEnd(24)} ${x === y ? "same" : "DIFFERENT"}  ${x}${x === y ? "" : ` / ${y}`}`
  );
  if (x !== y) differences.push(`stage ${stage} outcomes differ`);
}

console.log("AI calls per task (calls, input tokens, output tokens; time A / B)");
const tasks = aggregate(a);
const otherTasks = aggregate(b);
for (const task of [...new Set([...tasks.keys(), ...otherTasks.keys()])].sort()) {
  const x = tasks.get(task) ?? { calls: 0, input: 0, output: 0, ms: 0 };
  const y = otherTasks.get(task) ?? { calls: 0, input: 0, output: 0, ms: 0 };
  const same = x.calls === y.calls && x.input === y.input && x.output === y.output;
  console.log(
    `  ${task.padEnd(36)} ${same ? "same" : "DIFFERENT"}  ${x.calls}/${y.calls} calls, ` +
      `${x.input}/${y.input} in, ${x.output}/${y.output} out; ` +
      `${seconds(x.ms)} / ${seconds(y.ms)}`
  );
  if (!same) differences.push(`AI usage for ${task} differs`);
}
console.log(
  `Wall time: ${seconds(a.wallMs?.total ?? 0)} / ${seconds(b.wallMs?.total ?? 0)}; ` +
    `cassette: ${describeCassette(a)} / ${describeCassette(b)}`
);
if (differences.length) {
  console.log(`\n${differences.length} differences:\n- ${differences.join("\n- ")}`);
  process.exit(1);
}
console.log("\nIdentical content, stage outcomes and AI usage.");

async function load(path: string): Promise<Summary> {
  const file = (await stat(path)).isDirectory() ? join(path, "summary.json") : path;
  return summarySchema.parse(JSON.parse(await readFile(file, "utf8")));
}

function aggregate(summary: Summary) {
  const result = new Map<string, { calls: number; input: number; output: number; ms: number }>();
  for (const row of summary.ai ?? []) {
    const key = `${row.taskType} (${row.status})`;
    const total = result.get(key) ?? { calls: 0, input: 0, output: 0, ms: 0 };
    total.calls += row.calls;
    total.input += row.inputTokens ?? 0;
    total.output += row.outputTokens ?? 0;
    total.ms += row.durationMs ?? 0;
    result.set(key, total);
  }
  return result;
}

function seconds(ms: number) {
  return `${(ms / 1000).toFixed(1)} s`;
}

function describeCassette(summary: Summary) {
  const cassette = summary.cassette;
  return cassette
    ? `${cassette.mode} (${cassette.served} served, ${cassette.recorded} recorded, ${cassette.misses} misses)`
    : "none";
}
