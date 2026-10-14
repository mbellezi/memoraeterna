/**
 * Everything `evaluate-matching.ts` needs besides the scoring itself: the command line, the
 * connection (loopback only, never printed) and the read-only queries that fill an `EvaluationInput`.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import pg from "pg";
import { z } from "zod";

import {
  defaultAiTasks,
  defaultEvaluationOptions,
  defaultRelationStatuses,
  type AiCallRow,
  type EvaluationInput,
  type EvaluationOptions
} from "./matching-evaluation.ts";
import {
  matchingFixtureMappingPath,
  matchingMappingSchema,
  type MatchingMapping
} from "./matching-fixture.ts";

export const evaluateUsage = `Usage: npx tsx scripts/golden/evaluate-matching.ts --db <connection.json | postgres url> [options]

Scores a library against the matching-quality fixture (scripts/golden/build-matching-fixture.ts).
Read-only: the session is opened with default_transaction_read_only and nothing is written to the database.

  --db <value>        DEV connection file (dev-connection.json shape), a scratch connection file
                      (.cache/f0/scratch-<name>.json) or a postgres:// URL. Loopback hosts only.
  --mapping <file>    Mapping written by the build (default ${matchingFixtureMappingPath}).
  --ids <file>        Library built by the benchmark controller: its manifest.json (key to source id).
                      Without it, fixture roots are found by title.
  --out <file.md>     Write the Markdown report here (default: print it).
  --json <file.json>  Also write the full result as JSON.
  --label <text>      Name for the report header.
  --statuses <list>   Relation statuses that count as a link (default ${defaultRelationStatuses.join(",")}).
  --task <name>       AI task type whose calls are costed (repeatable; default ${defaultAiTasks.join(",")}).
  --since <iso>       Only AI calls started at or after this instant.
  --until <iso>       Only AI calls started before this instant.
  --baseline-seconds-per-note <n>   v6 reference for the time gate (default ${defaultEvaluationOptions.baselineSecondsPerNote}).
  --min-expected <n>  Held-out expected pairs required (default ${defaultEvaluationOptions.minExpected}).
  --max-forbidden <n> Held-out forbidden pairs allowed (default ${defaultEvaluationOptions.maxForbidden}).
  --check             Exit 0 when every measure of the exit criterion passes, 1 when one fails,
                      2 when none failed but one cannot be decided (roots missing, replayed calls).
  --help              Show this text.`;

export interface EvaluateArgs {
  db: string;
  mapping: string;
  ids: string | null;
  out: string | null;
  json: string | null;
  label: string | null;
  tasks: string[];
  since: Date | null;
  until: Date | null;
  check: boolean;
  options: EvaluationOptions;
}

export type EvaluateCommand = { kind: "help" } | ({ kind: "run" } & EvaluateArgs);

const instant = (name: string, value: string | undefined): Date | null => {
  if (value === undefined) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${name} must be an ISO timestamp.`);
  return parsed;
};

const nonNegative = (name: string, value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a number >= 0.`);
  return parsed;
};

export function parseEvaluateArgs(argv: readonly string[]): EvaluateCommand {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      db: { type: "string" },
      mapping: { type: "string" },
      ids: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      label: { type: "string" },
      statuses: { type: "string" },
      task: { type: "string", multiple: true },
      since: { type: "string" },
      until: { type: "string" },
      "baseline-seconds-per-note": { type: "string" },
      "min-expected": { type: "string" },
      "max-forbidden": { type: "string" },
      check: { type: "boolean" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };
  if (!values.db) throw new Error("--db is required.");
  const statuses = (values.statuses ?? defaultRelationStatuses.join(","))
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  const known = ["accepted", "pending_review", "rejected"];
  if (!statuses.length || statuses.some((status) => !known.includes(status)))
    throw new Error(`--statuses takes a comma-separated list of ${known.join(", ")}.`);
  return {
    kind: "run",
    db: values.db,
    mapping: values.mapping ?? matchingFixtureMappingPath,
    ids: values.ids ?? null,
    out: values.out ?? null,
    json: values.json ?? null,
    label: values.label ?? null,
    tasks: values.task?.length ? values.task : [...defaultAiTasks],
    since: instant("--since", values.since),
    until: instant("--until", values.until),
    check: values.check === true,
    options: {
      statuses,
      minExpected: nonNegative(
        "--min-expected",
        values["min-expected"],
        defaultEvaluationOptions.minExpected
      ),
      maxForbidden: nonNegative(
        "--max-forbidden",
        values["max-forbidden"],
        defaultEvaluationOptions.maxForbidden
      ),
      baselineSecondsPerNote: nonNegative(
        "--baseline-seconds-per-note",
        values["baseline-seconds-per-note"],
        defaultEvaluationOptions.baselineSecondsPerNote
      )
    }
  };
}

// --- Connection ----------------------------------------------------------------------------------

const connectionFileSchema = z
  .object({ connectionString: z.string().min(1), status: z.string().optional() })
  .passthrough();

export interface EvaluationConnection {
  /** Contains the password: hand it to the driver only. */
  connectionString: string;
  /** `host:port/database`, safe to print. */
  description: string;
}

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Accepts a postgres:// URL or a JSON file with `connectionString`; refuses non-loopback hosts. */
export async function resolveEvaluationConnection(value: string): Promise<EvaluationConnection> {
  let connectionString = value;
  if (!/^postgres(ql)?:\/\//iu.test(value)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(value, "utf8"));
    } catch {
      throw new Error(`Cannot read the connection file "${value}".`);
    }
    const file = connectionFileSchema.safeParse(parsed);
    if (!file.success)
      throw new Error(`The connection file "${value}" has no "connectionString" field.`);
    if (file.data.status === "stopped")
      throw new Error(`The cluster in "${value}" is stopped; start it before evaluating.`);
    connectionString = file.data.connectionString;
  }
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("The connection string is not a valid postgres:// URL.");
  }
  if (!loopbackHosts.has(url.hostname))
    throw new Error("Only a loopback PostgreSQL (127.0.0.1, localhost, ::1) can be evaluated.");
  return {
    connectionString,
    description: `${url.hostname}:${url.port || "5432"}/${decodeURIComponent(url.pathname.slice(1))}`
  };
}

export async function readMapping(path: string): Promise<MatchingMapping> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `Cannot read the mapping "${path}". Build it first: npx tsx scripts/golden/build-matching-fixture.ts`
    );
  }
  return matchingMappingSchema.parse(JSON.parse(text));
}

const idsFileSchema = z.object({ ids: z.record(z.string(), z.string().uuid()) }).passthrough();

/** The benchmark controller's `manifest.json`: benchmark id to source item id. */
export async function readBenchmarkIds(path: string): Promise<Record<string, string>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Cannot read the benchmark manifest "${path}".`);
  }
  return idsFileSchema.parse(parsed).ids;
}

// --- Queries -------------------------------------------------------------------------------------

export interface Db {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export interface ReadOptions {
  tasks: readonly string[];
  since: Date | null;
  until: Date | null;
  ids?: Readonly<Record<string, string>> | undefined;
}

const required: Record<string, string[]> = {
  source_items: ["id", "title", "parent_source_item_id"],
  atomic_notes: ["id", "created_from_source_item_id"],
  atomic_note_relations: ["source_atomic_note_id", "target_atomic_note_id", "status"],
  source_relations: ["source_item_id", "target_source_item_id", "status"],
  ai_task_runs: [
    "id",
    "task_type",
    "status",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "started_at"
  ]
};
const monitoringColumns = [
  "ai_task_run_id",
  "kind",
  "operation",
  "context",
  "token_usage",
  "started_at"
];

/**
 * Reads the library through SELECT statements only. `input.gaps` lists what an older schema could
 * not provide (the evaluation still runs; the affected measures stay unknown).
 */
export async function readEvaluationInput(
  db: Db,
  mapping: MatchingMapping,
  options: ReadOptions
): Promise<EvaluationInput> {
  const columns = new Map<string, Set<string>>();
  for (const row of (
    await db.query<{ table_name: string; column_name: string }>(
      `select table_name, column_name from information_schema.columns where table_schema = 'public'`
    )
  ).rows) {
    const set = columns.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    columns.set(row.table_name, set);
  }
  const has = (table: string, ...names: string[]) =>
    names.every((name) => columns.get(table)?.has(name));
  for (const [table, names] of Object.entries(required)) {
    const missing = names.filter((name) => !has(table, name));
    if (missing.length)
      throw new Error(`This is not a Memora library: ${table} lacks ${missing.join(", ")}.`);
  }
  const gaps: string[] = [];

  const sources = (
    await db.query<{ id: string; parentId: string | null; title: string }>(
      `select id::text as id, parent_source_item_id::text as "parentId", title from source_items`
    )
  ).rows;

  const noteFilters = [
    has("atomic_notes", "status") ? `status::text not in ('rejected', 'archived')` : null,
    has("atomic_notes", "supersession_status") ? `supersession_status = 'current'` : null
  ].filter((filter): filter is string => filter !== null);
  const notes = (
    await db.query<{ id: string; sourceItemId: string }>(
      `select id::text as id, created_from_source_item_id::text as "sourceItemId" from atomic_notes
       ${noteFilters.length ? `where ${noteFilters.join(" and ")}` : ""}`
    )
  ).rows;

  const noteRelations = (
    await db.query<{ sourceId: string; targetId: string; status: string }>(
      `select source_atomic_note_id::text as "sourceId", target_atomic_note_id::text as "targetId",
              status::text as status from atomic_note_relations`
    )
  ).rows;
  const sourceRelations = (
    await db.query<{ sourceId: string; targetId: string; status: string }>(
      `select source_item_id::text as "sourceId", target_source_item_id::text as "targetId",
              status::text as status from source_relations`
    )
  ).rows;

  const monitoring = has("monitoring_operations", ...monitoringColumns);
  if (!monitoring)
    gaps.push(
      "monitoring_operations is missing: reranking calls cannot be split into note and source matching"
    );
  const aiCalls = (
    await db.query<AiCallRow>(
      `select a.task_type as task, a.status, a.duration_ms::float8 as "durationMs",
              a.input_tokens::float8 as "inputTokens", a.output_tokens::float8 as "outputTokens",
              ${monitoring ? "m.reasoning_tokens" : "null::float8"} as "reasoningTokens",
              ${monitoring ? "m.operation" : "null::text"} as operation,
              ${monitoring ? "m.note_id" : "null::text"} as "noteId",
              ${monitoring ? "m.source_id" : "null::text"} as "sourceItemId",
              ${monitoring ? "m.prompt_version" : "null::text"} as "promptVersion",
              ${monitoring ? "coalesce(m.replayed, false)" : "false"} as replayed
       from ai_task_runs a
       ${
         monitoring
           ? `left join (
                select distinct on (ai_task_run_id) ai_task_run_id, operation,
                       context ->> 'atomicNoteId' as note_id,
                       context ->> 'sourceItemId' as source_id,
                       context ->> 'promptVersion' as prompt_version,
                       (token_usage ? 'cassette.replayed') as replayed,
                       case when jsonb_typeof(token_usage -> 'reasoningTokens') = 'number'
                            then (token_usage ->> 'reasoningTokens')::float8 end as reasoning_tokens
                from monitoring_operations
                where kind = 'ai' and ai_task_run_id is not null
                order by ai_task_run_id, started_at
              ) m on m.ai_task_run_id = a.id`
           : ""
       }
       where a.task_type = any($1::text[])
         and ($2::timestamptz is null or a.started_at >= $2::timestamptz)
         and ($3::timestamptz is null or a.started_at < $3::timestamptz)`,
      [options.tasks, options.since, options.until]
    )
  ).rows;

  return {
    mapping,
    sources,
    notes,
    noteRelations,
    sourceRelations,
    aiCalls,
    ids: options.ids,
    gaps
  };
}

/** A session that cannot write: read-only by default, with a bounded statement time. */
export function createReadOnlyClient(connectionString: string): pg.Client {
  return new pg.Client({
    connectionString,
    options: "-c default_transaction_read_only=on -c statement_timeout=120000",
    connectionTimeoutMillis: 10_000
  });
}

/** Opens a read-only session, reads one consistent snapshot of the library and closes it. */
export async function readLibrary(
  connection: EvaluationConnection,
  mapping: MatchingMapping,
  options: ReadOptions
): Promise<EvaluationInput> {
  const client = createReadOnlyClient(connection.connectionString);
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const input = await readEvaluationInput(client, mapping, options);
    await client.query("commit");
    return input;
  } finally {
    await client.end();
  }
}
