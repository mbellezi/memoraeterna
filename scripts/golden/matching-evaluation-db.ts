/**
 * Everything `evaluate-matching.ts` needs besides the scoring itself: the command line, the
 * connection (loopback only, never printed) and the read-only queries that fill an `EvaluationInput`.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";

import pg from "pg";
import { z } from "zod";

import { frozenFilePath } from "./freeze-guard.ts";
import { defaultGateOptions } from "./gate-f3.ts";
import {
  defaultAiTasks,
  defaultEvaluationOptions,
  defaultRelationStatuses,
  type AiCallRow,
  type EvaluationInput,
  type EvaluationOptions,
  type OperationRow,
  type RelationRow
} from "./matching-evaluation.ts";
import {
  matchingFixtureMappingPath,
  matchingMappingSchema,
  type MatchingMapping
} from "./matching-fixture.ts";
import { chooseVisibility } from "./relation-visibility.ts";
import {
  defaultCandidateDepth,
  parseRankerRule,
  spikeAFrozenRule,
  type Aggregation,
  type RelationsExport
} from "./relations-export.ts";

export const evaluateUsage = `Usage: npx tsx scripts/golden/evaluate-matching.ts --db <connection.json | postgres url> [options]
       npx tsx scripts/golden/evaluate-matching.ts --gate f3 --sample <label>=<source> [--sample ...] [options]
       npx tsx scripts/golden/evaluate-matching.ts --pre-freeze-feasibility --relations <export.json> --scores <pair-scores.json>
       npx tsx scripts/golden/evaluate-matching.ts --db <value> --export-relations <file.json>

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
  --statuses <list>   Relation statuses that count as a link on a library without bands
                      (default ${defaultRelationStatuses.join(",")}).
  --task <name>       AI task type whose calls are costed (repeatable; default ${defaultAiTasks.join(",")}).
  --since <iso>       Only AI calls started at or after this instant.
  --until <iso>       Only AI calls started before this instant.
  --baseline-seconds-per-note <n>   v6 reference for the time gate (default ${defaultEvaluationOptions.baselineSecondsPerNote}).
  --min-expected <n>  Held-out expected pairs required (default ${defaultEvaluationOptions.minExpected}).
  --max-forbidden <n> Held-out forbidden pairs allowed (default ${defaultEvaluationOptions.maxForbidden}).
  --check             Exit 0 when every measure of the exit criterion passes, 1 when one fails,
                      2 when none failed but one cannot be decided (roots missing, replayed calls, sealed).
  --frozen <file>     The freeze record (default ${frozenFilePath}). Without it the held-out partition is
                      sealed: the report and the JSON hold tuning results only (decision D3).

F3 gate (X1 and S1 over several samples; shown relations beside applied-only):
  --gate <f1a|f3>     f1a (default): one library, the F1a exit criterion. f3: the gate below.
  --sample <l>=<src>  One sample of the gate: a label and a connection (as --db) or a stored sample or
                      evaluation JSON. Repeatable; --db adds one more, labelled by --label.
  --live-judge <list> Comma-separated sample labels whose source judge ran live (S1's time and replay checks).
  --min-samples <n>   Samples required for a verdict (default ${defaultGateOptions.minSamples}, decision D2).

Offline modes:
  --pre-freeze-feasibility  Print exactly two held-out aggregates (reachable expected root pairs at depth k;
                      expected and forbidden root pairs a ranker links at a rule) and nothing else.
                      Needs --relations and --scores; takes --k (default ${defaultCandidateDepth}), --rule
                      (default max:${spikeAFrozenRule.threshold}, Spike A's MLX rule), --mapping and --label.
  --export-relations <file>  Write the library's candidate lists, decisions and relations as the offline
                      export that rescore.ts and candidate-recall.ts read (ids and scores only).
  --help              Show this text.`;

export interface EvaluateArgs {
  /** The library to read; null when the gate's samples come from `--sample` alone. */
  db: string | null;
  gate: "f1a" | "f3";
  /** F3 gate samples: a label and a connection, a stored gate sample or a stored evaluation. */
  samples: Array<{ label: string | null; source: string }>;
  liveJudge: string[];
  minSamples: number;
  frozen: string | null;
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

export interface FeasibilityArgs {
  relations: string;
  scores: string;
  mapping: string;
  k: number;
  rule: { aggregation: Aggregation; threshold: number };
  label: string | null;
}

export interface ExportArgs {
  db: string;
  out: string;
  statuses: string[];
  label: string | null;
}

export type EvaluateCommand =
  | { kind: "help" }
  | ({ kind: "run" } & EvaluateArgs)
  | ({ kind: "feasibility" } & FeasibilityArgs)
  | ({ kind: "export" } & ExportArgs);

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

const knownStatuses = ["accepted", "pending_review", "rejected"];

function parseStatuses(value: string | undefined): string[] {
  const statuses = (value ?? defaultRelationStatuses.join(","))
    .split(",")
    .map((status) => status.trim())
    .filter(Boolean);
  if (!statuses.length || statuses.some((status) => !knownStatuses.includes(status)))
    throw new Error(`--statuses takes a comma-separated list of ${knownStatuses.join(", ")}.`);
  return statuses;
}

/** `S0=.cache/f3/scratch/s0.json` is a label and a source; a bare value keeps the label it was stored with. */
function parseSample(value: string): { label: string | null; source: string } {
  const separator = value.indexOf("=");
  // A postgres URL can hold `=` in its query string: only a short word before it is a label.
  if (
    separator <= 0 ||
    separator === value.length - 1 ||
    !/^[\w .-]{1,40}$/u.test(value.slice(0, separator))
  )
    return { label: null, source: value };
  return { label: value.slice(0, separator).trim(), source: value.slice(separator + 1).trim() };
}

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
      frozen: { type: "string" },
      gate: { type: "string" },
      sample: { type: "string", multiple: true },
      "live-judge": { type: "string" },
      "min-samples": { type: "string" },
      "pre-freeze-feasibility": { type: "boolean" },
      relations: { type: "string" },
      scores: { type: "string" },
      k: { type: "string" },
      rule: { type: "string" },
      "export-relations": { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return { kind: "help" };

  if (values["pre-freeze-feasibility"]) {
    // Held-out aggregates only: nothing that could print more is accepted next to the mode.
    const others = ["db", "sample", "gate", "json", "out", "export-relations", "check"] as const;
    const extra = others.filter((name) => values[name] !== undefined && values[name] !== false);
    if (extra.length)
      throw new Error(
        `--pre-freeze-feasibility prints two aggregates and nothing else; remove --${extra.join(", --")}.`
      );
    if (!values.relations || !values.scores)
      throw new Error("--pre-freeze-feasibility needs --relations and --scores.");
    const k = values.k === undefined ? defaultCandidateDepth : Number(values.k);
    if (!Number.isInteger(k) || k <= 0) throw new Error("--k must be a positive integer.");
    return {
      kind: "feasibility",
      relations: values.relations,
      scores: values.scores,
      mapping: values.mapping ?? matchingFixtureMappingPath,
      k,
      rule: values.rule ? parseRankerRule(values.rule) : { ...spikeAFrozenRule },
      label: values.label ?? null
    };
  }

  if (values["export-relations"]) {
    if (!values.db) throw new Error("--db is required.");
    return {
      kind: "export",
      db: values.db,
      out: values["export-relations"],
      statuses: parseStatuses(values.statuses),
      label: values.label ?? null
    };
  }

  const gate = values.gate ?? "f1a";
  if (gate !== "f1a" && gate !== "f3") throw new Error("--gate takes f1a or f3.");
  const samples = (values.sample ?? []).map(parseSample);
  if (gate === "f1a" && samples.length)
    throw new Error("--sample belongs to --gate f3; the F1a criterion scores one library.");
  if (gate === "f1a" && !values.db) throw new Error("--db is required.");
  if (gate === "f3" && !values.db && samples.length === 0)
    throw new Error("--gate f3 needs --sample <label>=<source> (or --db for a single sample).");
  const minSamples =
    values["min-samples"] === undefined
      ? defaultGateOptions.minSamples
      : Number(values["min-samples"]);
  if (!Number.isInteger(minSamples) || minSamples < 1)
    throw new Error("--min-samples must be a positive integer.");
  return {
    kind: "run",
    db: values.db ?? null,
    gate,
    samples,
    liveJudge: (values["live-judge"] ?? "")
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean),
    minSamples,
    frozen: values.frozen ?? null,
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
      statuses: parseStatuses(values.statuses),
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
  /** Statuses that count as a link on a library without the relations v2 columns (default accepted, pending_review). */
  statuses?: readonly string[] | undefined;
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

interface Schema {
  columns: Map<string, Set<string>>;
  has: (table: string, ...names: string[]) => boolean;
}

/** The public schema's columns, and a check that the library has the tables the evaluator reads. */
async function readSchema(db: Db): Promise<Schema> {
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
  return { columns, has };
}

/** The library's sources and its notes (not rejected, archived or superseded). */
async function readSourcesAndNotes(db: Db, has: Schema["has"]) {
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
  return { sources, notes };
}

/**
 * Reads the library through SELECT statements only. `input.gaps` lists what an older schema could
 * not provide (the evaluation still runs; the affected measures stay unknown).
 */
export async function readEvaluationInput(
  db: Db,
  mapping: MatchingMapping,
  options: ReadOptions
): Promise<EvaluationInput> {
  const { columns, has } = await readSchema(db);
  const gaps: string[] = [];
  const { sources, notes } = await readSourcesAndNotes(db, has);

  // Which note relations are shown and applied: the relations v2 predicate when the library has its
  // columns, the counted statuses otherwise (relation-visibility.ts is the swap point for T48).
  const visibility = chooseVisibility(has, options.statuses ?? defaultRelationStatuses);
  const noteRelations = (
    await db.query<RelationRow>(
      `select r.source_atomic_note_id::text as "sourceId", r.target_atomic_note_id::text as "targetId",
              r.status::text as status, (${visibility.shown("r")}) as shown,
              (${visibility.applied("r")}) as applied
       from atomic_note_relations r`
    )
  ).rows;
  const hasOrigin = has("source_relations", "origin");
  const sourceRelations = (
    await db.query<RelationRow>(
      `select source_item_id::text as "sourceId", target_source_item_id::text as "targetId",
              status::text as status, ${hasOrigin ? "origin::text" : "null::text"} as origin
       from source_relations`
    )
  ).rows;

  const monitoring = has("monitoring_operations", ...monitoringColumns);
  if (!monitoring)
    gaps.push(
      "monitoring_operations is missing: reranking calls cannot be split into note and source matching"
    );
  const finished = has("ai_task_runs", "finished_at");
  const monitoringJoin = monitoring
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
    : "";
  const timeWindow = (since: string, until: string) =>
    `(${since}::timestamptz is null or a.started_at >= ${since}::timestamptz)
         and (${until}::timestamptz is null or a.started_at < ${until}::timestamptz)`;
  const aiCalls = (
    await db.query<AiCallRow>(
      `select a.task_type as task, a.status, a.duration_ms::float8 as "durationMs",
              a.input_tokens::float8 as "inputTokens", a.output_tokens::float8 as "outputTokens",
              ${monitoring ? "m.reasoning_tokens" : "null::float8"} as "reasoningTokens",
              ${monitoring ? "m.operation" : "null::text"} as operation,
              ${monitoring ? "m.note_id" : "null::text"} as "noteId",
              ${monitoring ? "m.source_id" : "null::text"} as "sourceItemId",
              ${monitoring ? "m.prompt_version" : "null::text"} as "promptVersion",
              ${monitoring ? "coalesce(m.replayed, false)" : "false"} as replayed,
              to_char(a.started_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "startedAt",
              ${finished ? `to_char(a.finished_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` : "null::text"} as "finishedAt"
       from ai_task_runs a
       ${monitoringJoin}
       where a.task_type = any($1::text[])
         and ${timeWindow("$2", "$3")}`,
      [options.tasks, options.since, options.until]
    )
  ).rows;

  // Every call of the window by task and operation (any task), for generative calls per chapter.
  const operations = (
    await db.query<OperationRow>(
      `select a.task_type as task, ${monitoring ? "m.operation" : "null::text"} as operation,
              count(*)::int as calls,
              count(*) filter (where ${monitoring ? "coalesce(m.replayed, false)" : "false"})::int as replayed
       from ai_task_runs a
       ${monitoringJoin}
       where ${timeWindow("$1", "$2")}
       group by 1, 2`,
      [options.since, options.until]
    )
  ).rows;
  const chunks = columns.has("chunks")
    ? (await db.query<{ n: number }>(`select count(*)::int as n from chunks`)).rows[0]!.n
    : null;

  return {
    mapping,
    sources,
    notes,
    noteRelations,
    sourceRelations,
    aiCalls,
    ids: options.ids,
    gaps,
    operations,
    chunks
  };
}

/**
 * The offline export the F3 scripts read (`relations-export.ts`): sources, notes, the matching
 * candidate lists the debug mode recorded, the recorded decisions and the note relations, ids and
 * scores only. A relation row keeps its canonical pair order; the judged direction is not recovered
 * from `metadata` (decision D8 retires those keys).
 */
export async function readRelationsExportData(
  db: Db,
  statuses: readonly string[] = defaultRelationStatuses
): Promise<Omit<RelationsExport, "context">> {
  const { has } = await readSchema(db);
  const { sources, notes } = await readSourcesAndNotes(db, has);
  const candidates =
    has("similarity_debug_results", "run_id", "target_id", "final_rank", "target_type") &&
    has("similarity_debug_runs", "id", "kind", "query_target_id", "created_at")
      ? (
          await db.query<RelationsExport["candidates"][number]>(
            `select d.query_target_id::text as "sourceNoteId", r.target_id::text as "targetNoteId",
                    r.final_rank as "finalRank", r.text_rank as "textRank", r.vector_rank as "vectorRank",
                    r.graph_rank as "graphRank", r.text_score as "textScore", r.vector_score as "vectorScore",
                    r.metadata_score as "metadataScore", r.graph_score as "graphScore",
                    r.fusion_score as "fusionScore", r.rerank_score as "rerankScore",
                    r.final_score as "finalScore", r.passed_threshold as "passedThreshold"
             from similarity_debug_results r
             join similarity_debug_runs d on d.id = r.run_id
             where d.kind like 'atomic_note_matching%' and r.target_type = 'atomic_note'
               and d.query_target_id is not null
             order by d.created_at, r.run_id, r.final_rank`
          )
        ).rows
      : [];
  const decisions = has(
    "relation_decisions",
    "lo_atomic_note_id",
    "hi_atomic_note_id",
    "lo_to_hi_score"
  )
    ? (
        await db.query<RelationsExport["decisions"][number]>(
          `select lo_atomic_note_id::text as "loNoteId", hi_atomic_note_id::text as "hiNoteId",
                  decider_key as "deciderKey", lo_to_hi_score as "loToHiScore",
                  hi_to_lo_score as "hiToLoScore", lo_to_hi_relation_type as "loToHiType",
                  hi_to_lo_relation_type as "hiToLoType", accepted
           from relation_decisions order by pair_key, decider_key`
        )
      ).rows
    : [];
  const visibility = chooseVisibility(has, statuses);
  const number = (key: string) =>
    `case when jsonb_typeof(r.metadata -> '${key}') = 'number' then (r.metadata ->> '${key}')::float8 end`;
  const relations = (
    await db.query<RelationsExport["relations"][number]>(
      `select r.source_atomic_note_id::text as "sourceNoteId", r.target_atomic_note_id::text as "targetNoteId",
              r.status::text as status, r.relation_type as "relationType",
              r.vector_score::float8 as "vectorScore", r.graph_score::float8 as "graphScore",
              r.rerank_score::float8 as "rerankScore", r.final_score::float8 as "finalScore",
              ${number("textScore")} as "textScore", ${number("metadataScore")} as "metadataScore",
              ${number("fusionScore")} as "fusionScore", ${number("textRank")}::int as "textRank",
              ${number("vectorRank")}::int as "vectorRank", ${number("graphRank")}::int as "graphRank",
              (${visibility.shown("r")}) as shown, (${visibility.applied("r")}) as applied
       from atomic_note_relations r order by r.source_atomic_note_id, r.target_atomic_note_id`
    )
  ).rows;
  return {
    format: "memora-relations-export",
    version: 1,
    sources: sources.map((source) => ({ ...source })),
    notes,
    candidates,
    decisions,
    relations
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

/** Opens a read-only session, exports one consistent snapshot for the offline scripts and closes it. */
export async function readLibraryExport(
  connection: EvaluationConnection,
  options: { statuses?: readonly string[] | undefined; label?: string | null | undefined } = {}
): Promise<RelationsExport> {
  const client = createReadOnlyClient(connection.connectionString);
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const data = await readRelationsExportData(client, options.statuses);
    await client.query("commit");
    return {
      ...data,
      context: {
        label: options.label ?? null,
        database: connection.description,
        generatedAt: new Date().toISOString()
      }
    };
  } finally {
    await client.end();
  }
}
