/**
 * Generative calls per reference chapter (F3 X7, decision R9), from either a golden run summary
 * (calls by AI task) or an export of `ai_task_runs` by operation, and the library's chunk count.
 *
 *   npx tsx scripts/golden/calls-per-chapter.ts --summary .cache/golden/runs/<run>/summary.json
 *   npx tsx scripts/golden/calls-per-chapter.ts --operations ops.json --chunks 197
 *
 * Embedding and dedicated-ranker calls do not count as generative; topic calls are reported apart.
 * A "reference chapter" is 30 chunks (decision D2). Read-only: counts only, no text.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

/** Decision D2: the reference chapter. */
export const referenceChapterChunks = 30;

export type CallClass = "generative" | "topic" | "excluded";

export interface OperationCount {
  /** `ai_task_runs.operation` (the monitoring record's operation) when known. */
  operation: string | null;
  /** The AI task type (`knowledge-graph-generation`, `reranking`, ...). */
  task: string;
  calls: number;
  /** Calls answered from a cassette; unknown stays undefined. */
  replayed?: number | undefined;
}

const rate = z.number().nullable();
const chapterRowSchema = z.object({
  key: z.string(),
  class: z.enum(["generative", "topic", "excluded"]),
  calls: z.number().int().nonnegative(),
  replayed: z.number().int().nonnegative().nullable(),
  perChunk: rate,
  perChapter: rate
});
export const callsPerChapterSchema = z.object({
  chunks: z.number().nullable(),
  chapterChunks: z.number(),
  rows: z.array(chapterRowSchema),
  generative: z.object({ calls: z.number(), perChunk: rate, perChapter: rate }),
  topic: z.object({ calls: z.number(), perChunk: rate, perChapter: rate }),
  excluded: z.object({ calls: z.number() })
});
export type ChapterRow = z.infer<typeof chapterRowSchema>;
export type CallsPerChapter = z.infer<typeof callsPerChapterSchema>;

const excludedTasks = new Set(["embedding"]);
/** Dedicated rankers, embeddings and interactive or diagnostic operations are not ingestion generation. */
const excludedOperation =
  /(^|_)(embedding|rank|rank_pairs|gate)(_|$)|^ask$|^local_model_test$|^prompt_catalog_sample$|^benchmark_note_warmup$/u;
const topicOperation = /^topic_/u;

export function classify(row: Pick<OperationCount, "operation" | "task">): CallClass {
  if (excludedTasks.has(row.task)) return "excluded";
  if (row.operation) {
    if (excludedOperation.test(row.operation)) return "excluded";
    if (topicOperation.test(row.operation)) return "topic";
  }
  return "generative";
}

const per = (calls: number, chunks: number | null, scale: number): number | null =>
  chunks && chunks > 0 ? (calls / chunks) * scale : null;

/** Calls per chunk and per `chapterChunks`-chunk chapter, by operation (or task when unknown). */
export function summarizeCallsPerChapter(
  counts: readonly OperationCount[],
  chunks: number | null,
  chapterChunks: number = referenceChapterChunks
): CallsPerChapter {
  const grouped = new Map<string, ChapterRow>();
  for (const count of counts) {
    const key = count.operation ?? count.task;
    const cls = classify(count);
    const existing = grouped.get(key);
    const replayed = count.replayed === undefined ? null : count.replayed;
    if (existing) {
      existing.calls += count.calls;
      existing.replayed =
        existing.replayed === null || replayed === null ? null : existing.replayed + replayed;
    } else
      grouped.set(key, {
        key,
        class: cls,
        calls: count.calls,
        replayed,
        perChunk: null,
        perChapter: null
      });
  }
  const rows = [...grouped.values()]
    .map((row) => ({
      ...row,
      perChunk: per(row.calls, chunks, 1),
      perChapter: per(row.calls, chunks, chapterChunks)
    }))
    .sort((a, b) => b.calls - a.calls || a.key.localeCompare(b.key));
  const total = (cls: CallClass) =>
    rows.filter((row) => row.class === cls).reduce((sum, row) => sum + row.calls, 0);
  const generative = total("generative");
  const topic = total("topic");
  return {
    chunks,
    chapterChunks,
    rows,
    generative: {
      calls: generative,
      perChunk: per(generative, chunks, 1),
      perChapter: per(generative, chunks, chapterChunks)
    },
    topic: {
      calls: topic,
      perChunk: per(topic, chunks, 1),
      perChapter: per(topic, chunks, chapterChunks)
    },
    excluded: { calls: total("excluded") }
  };
}

// --- Inputs --------------------------------------------------------------------------------------

const goldenSummarySchema = z
  .object({
    format: z.literal("memora-golden-run"),
    ai: z.array(
      z
        .object({
          taskType: z.string(),
          calls: z.number().int().nonnegative(),
          replayed: z.number().int().nonnegative().optional()
        })
        .passthrough()
    ),
    outputs: z
      .object({ chunks: z.object({ count: z.number().int().nonnegative() }).passthrough() })
      .passthrough()
  })
  .passthrough();

/** A golden run's `summary.json`: calls by AI task and the chunk count of the run. */
export async function readGoldenSummary(
  path: string
): Promise<{ counts: OperationCount[]; chunks: number }> {
  const summary = goldenSummarySchema.parse(JSON.parse(await readFile(path, "utf8")));
  return {
    counts: summary.ai.map((entry) => ({
      operation: null,
      task: entry.taskType,
      calls: entry.calls,
      replayed: entry.replayed
    })),
    chunks: summary.outputs.chunks.count
  };
}

const operationsFileSchema = z.union([
  z.array(
    z.object({
      operation: z.string().nullable().default(null),
      task: z.string(),
      calls: z.number().int().nonnegative(),
      replayed: z.number().int().nonnegative().optional()
    })
  ),
  z.object({
    chunks: z.number().int().positive().optional(),
    operations: z.array(
      z.object({
        operation: z.string().nullable().default(null),
        task: z.string(),
        calls: z.number().int().nonnegative(),
        replayed: z.number().int().nonnegative().optional()
      })
    )
  })
]);

/** An export of calls by operation: a list, or `{ chunks, operations }`. */
export async function readOperations(
  path: string
): Promise<{ counts: OperationCount[]; chunks: number | null }> {
  const parsed = operationsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return Array.isArray(parsed)
    ? { counts: parsed, chunks: null }
    : { counts: parsed.operations, chunks: parsed.chunks ?? null };
}

// --- Markdown ------------------------------------------------------------------------------------

const fixed = (value: number | null, digits: number): string =>
  value === null ? "unknown" : value.toFixed(digits);

export function renderCallsPerChapterMarkdown(
  summary: CallsPerChapter,
  context: { label?: string | null } = {}
): string {
  const lines = [
    `# Generative calls per chapter${context.label ? `: ${context.label}` : ""}`,
    "",
    `${summary.chunks ?? "unknown"} chunks; a reference chapter is ${summary.chapterChunks} chunks.`,
    "",
    "| Operation or task | Class | Calls | Replayed | Per chunk | Per chapter |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...summary.rows.map(
      (row) =>
        `| ${row.key} | ${row.class} | ${row.calls} | ${row.replayed ?? "unknown"} | ${fixed(row.perChunk, 2)} | ${fixed(row.perChapter, 1)} |`
    ),
    `| **Generative total** | | ${summary.generative.calls} | | ${fixed(summary.generative.perChunk, 2)} | ${fixed(summary.generative.perChapter, 1)} |`,
    ""
  ];
  if (summary.topic.calls)
    lines.push(
      `Topic calls (reported apart): ${summary.topic.calls}, ${fixed(summary.topic.perChapter, 1)} per chapter.`
    );
  lines.push(
    `Not counted (embeddings, rankers, interactive): ${summary.excluded.calls} calls.`,
    ""
  );
  return lines.join("\n");
}

// --- Command line --------------------------------------------------------------------------------

export const callsPerChapterUsage = `Usage: npx tsx scripts/golden/calls-per-chapter.ts (--summary <summary.json> | --operations <file.json> --chunks <n>) [options]

  --summary <file>     A golden run's summary.json: calls by AI task and the run's chunk count.
  --operations <file>  Calls by operation: a list of {operation, task, calls, replayed?} or
                       {chunks, operations}.
  --chunks <n>         The library's chunk count (needed with --operations unless the file has it).
  --chapter <n>        Chunks per reference chapter (default ${referenceChapterChunks}).
  --label <text>       Name for the report header.
  --out <file.md>      Write the Markdown report here (default: print it).
  --json <file.json>   Also write the result as JSON.
  --help               Show this text.`;

export async function runCallsPerChapter(argv: readonly string[]): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      summary: { type: "string" },
      operations: { type: "string" },
      chunks: { type: "string" },
      chapter: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return callsPerChapterUsage;
  if (Boolean(values.summary) === Boolean(values.operations))
    throw new Error("Give exactly one of --summary and --operations.");
  const positive = (name: string, value: string | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed <= 0)
      throw new Error(`${name} must be a positive integer.`);
    return parsed;
  };
  const chapter = positive("--chapter", values.chapter) ?? referenceChapterChunks;
  const given = positive("--chunks", values.chunks);
  const read = values.summary
    ? await readGoldenSummary(values.summary)
    : await readOperations(values.operations!);
  const chunks = given ?? read.chunks;
  if (chunks === null) throw new Error("--chunks is required with --operations.");
  const summary = summarizeCallsPerChapter(read.counts, chunks, chapter);
  const markdown = renderCallsPerChapterMarkdown(summary, { label: values.label ?? null });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json) await write(values.json, `${JSON.stringify(summary, null, 2)}\n`);
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

if (import.meta.main) {
  try {
    const output = await runCallsPerChapter(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(`[calls-per-chapter] ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
