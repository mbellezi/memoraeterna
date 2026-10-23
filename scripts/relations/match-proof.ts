/**
 * The MATCH proof of F4 T83 (the orchestrator's): edit ten notes of a measurement clone the way a
 * person does, let the DEV app's MATCH jobs run, ask again for the same notes, and read back what
 * the jobs did. Every database step goes through the product's own code (`review` for the edit,
 * `enqueueRelationMatches` for the request), so the app's jobs start from exactly what a person's
 * edit or approval leaves.
 *
 *   npx tsx scripts/relations/match-proof.ts edit <clone> --plan <plan.json> [--notes 10] [--clear-relations]
 *   npx tsx scripts/relations/match-proof.ts request <clone> --plan <plan.json>
 *   npx tsx scripts/relations/match-proof.ts report <clone> --plan <plan.json> [--out <report.json>]
 *
 * `<clone>` is an APFS clone of a measurement profile under `<repo>/.cache/` whose scratch sidecar
 * runs (`.cache/f4/scripts/sidecar.sh start <clone> <port>`); the script reads its
 * `t44-connection.json` and refuses any other directory, so a real profile is never touched.
 *
 * - `edit` appends a marker sentence to the idea statement of the first `--notes` notes in content
 *   order (spread over the roots), through `review(edit)`: the note is protected, its vectors go and
 *   the `note-embedding` job is queued. `--clear-relations` also removes those notes' relations in
 *   the clone, so their pairs are new to MATCH and the link job has pairs to type (without it the
 *   edited notes' pairs are already related and are left out). The plan file records the notes.
 * - `request` queues MATCH for the planned notes again, as an approval does (the unchanged-text case).
 * - `report` reads the jobs, runs, relations, match states and AI calls since the plan was made and
 *   checks them; the exit code is 1 when a check fails.
 *
 * The orchestrator's order: stop nothing else; start the clone's scratch sidecar; `edit`; stop the
 * scratch sidecar; run the DEV app on the clone (`MEMORA_USER_DATA_DIR=<clone>`) until the MATCH and
 * link jobs ended (the edit's job runs about 60 s after its vector, the typing call after it); start
 * the sidecar; `report`; stop it; `request`; run the app again; `report --requested`.
 */
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createAtomicNoteRepository,
  createPgPool,
  noteRelationDirectionSql,
  type PgPool
} from "@app/db";

import { compareContent, contentKey } from "../../apps/desktop/src/main/services/content-order.ts";
import { linkRootOf } from "../../apps/desktop/src/main/services/relations/relation-link.ts";
import { enqueueRelationMatches } from "../../apps/desktop/src/main/services/relations/relation-match.ts";

export const repositoryRoot = resolve(import.meta.dirname, "..", "..");
/** Appended to an edited note's idea statement: an edit of what the ranker is shown. */
export const proofMarker = " (Revised for the MATCH proof.)";

export interface ProofCandidate {
  noteId: string;
  rootId: string;
  title: string;
  idea: string;
}

export interface ProofPlan {
  createdAt: string;
  clearedRelations: boolean;
  notes: Array<ProofCandidate & { editedIdea: string }>;
}

/**
 * The notes to edit: content order, one from each root in turn so the edits spread over the
 * library (a function of content, never of the notes' IDs, except to tell identical text apart).
 */
export function selectProofNotes(
  candidates: readonly ProofCandidate[],
  count: number
): ProofCandidate[] {
  const ordered = [...candidates].sort(
    (a, b) =>
      compareContent(contentKey(a.title, a.idea), contentKey(b.title, b.idea)) ||
      compareContent(a.noteId, b.noteId)
  );
  const queues = new Map<string, ProofCandidate[]>();
  for (const candidate of ordered)
    queues.set(candidate.rootId, [...(queues.get(candidate.rootId) ?? []), candidate]);
  const picked: ProofCandidate[] = [];
  while (picked.length < count && [...queues.values()].some((queue) => queue.length > 0))
    for (const queue of queues.values()) {
      const next = queue.shift();
      if (next && picked.length < count) picked.push(next);
    }
  return picked;
}

/** Edits the notes of the plan through the product's review and writes nothing else but the plan. */
export async function proofEdit(
  pool: PgPool,
  input: { count: number; clearRelations: boolean; now?: () => Date }
): Promise<ProofPlan> {
  const rows = await pool.query<{ noteId: string; sourceId: string; title: string; idea: string }>(
    `select n.id::text as "noteId", n.created_from_source_item_id::text as "sourceId",
            n.title, n.idea_statement as idea
       from atomic_notes n
      where n.ownership = 'source' and n.supersession_status = 'current'
        and n.status not in ('rejected', 'archived')
        and coalesce(n.metadata ->> 'humanProtected', '') <> 'true'
        and exists (select 1 from note_match_state s where s.note_id = n.id)
      order by n.id
      limit 2000`
  );
  const candidates: ProofCandidate[] = [];
  const roots = new Map<string, string>();
  for (const row of rows.rows) {
    let rootId = roots.get(row.sourceId);
    if (!rootId) {
      rootId = await linkRootOf(pool, row.sourceId);
      roots.set(row.sourceId, rootId);
    }
    candidates.push({ noteId: row.noteId, rootId, title: row.title, idea: row.idea });
  }
  const picked = selectProofNotes(candidates, input.count);
  if (picked.length < input.count)
    throw new Error(`Only ${picked.length} notes qualify for ${input.count} edits.`);
  const notes = createAtomicNoteRepository(pool);
  const plan: ProofPlan = {
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    clearedRelations: input.clearRelations,
    notes: picked.map((note) => ({ ...note, editedIdea: `${note.idea}${proofMarker}` }))
  };
  for (const note of plan.notes)
    await notes.review({ id: note.noteId, action: "edit", ideaStatement: note.editedIdea });
  if (input.clearRelations)
    await pool.query(
      `delete from atomic_note_relations
        where source_atomic_note_id = any($1::uuid[]) or target_atomic_note_id = any($1::uuid[])`,
      [plan.notes.map((note) => note.noteId)]
    );
  return plan;
}

/** Queues MATCH for the planned notes again, as an approval does; resolves to the jobs queued. */
export async function proofRequest(pool: PgPool, plan: ProofPlan): Promise<number> {
  return (
    await enqueueRelationMatches(
      pool,
      plan.notes.map((note) => note.noteId)
    )
  ).length;
}

export interface ProofReport {
  since: string;
  matchJobs: Array<{
    noteId: string;
    status: string;
    outcome: string | null;
    resultStatus: string | null;
    attempts: number;
    fingerprinted: boolean;
    backlog: boolean;
    accepted: number;
  }>;
  linkJobs: Array<{ status: string; outcome: string | null; applied: number; suggested: number }>;
  runs: Array<{
    kind: string;
    titleKey: string | null;
    titleParams: unknown;
    jobId: string | null;
  }>;
  relations: Array<{
    band: string;
    relationType: string | null;
    directionSource: string | null;
    shown: string;
  }>;
  states: Array<{ noteId: string; hasHash: boolean }>;
  calls: Array<{
    workloadClass: string | null;
    lane: string | null;
    calls: number;
    inputTokens: number;
    outputTokens: number;
  }>;
}

/** Reads what the jobs did since the plan was made (read only). */
export async function proofReport(pool: PgPool, plan: ProofPlan): Promise<ProofReport> {
  const since = plan.createdAt;
  const ids = plan.notes.map((note) => note.noteId);
  const match = await pool.query(
    `select (payload ->> 'noteId') as "noteId", status, outcome, result ->> 'status' as "resultStatus",
            attempts, input_fingerprint is not null as fingerprinted,
            coalesce((payload ->> 'backlog')::boolean, false) as backlog,
            coalesce((result ->> 'accepted')::int, 0) as accepted
       from jobs where type = 'relation-match' and created_at >= $1 and payload ->> 'noteId' = any($2::text[])
      order by created_at, id`,
    [since, ids]
  );
  const link = await pool.query(
    `select status, outcome, coalesce((result ->> 'applied')::int, 0) as applied,
            coalesce((result ->> 'suggested')::int, 0) as suggested
       from jobs where type = 'relation-link' and created_at >= $1 order by created_at, id`,
    [since]
  );
  const runs = await pool.query(
    `select kind, title_key as "titleKey", title_params as "titleParams", job_id::text as "jobId"
       from relation_match_runs where started_at >= $1 and kind not in ('review', 'veto')
      order by started_at`,
    [since]
  );
  const relations = await pool.query(
    `select r.band, r.relation_type as "relationType", r.direction_source as "directionSource",
            ${noteRelationDirectionSql("r")} as shown
       from atomic_note_relations r
      where r.created_at >= $1
        and (r.source_atomic_note_id = any($2::uuid[]) or r.target_atomic_note_id = any($2::uuid[]))
      order by r.created_at, r.id`,
    [since, ids]
  );
  const states = await pool.query(
    `select n.id::text as "noteId", s.input_hash is not null as "hasHash"
       from unnest($1::uuid[]) as n(id) left join note_match_state s on s.note_id = n.id
      order by n.id`,
    [ids]
  );
  const calls = await pool.query(
    `select workload_class as "workloadClass", lane, count(*)::int as calls,
            coalesce(sum(input_tokens), 0)::int as "inputTokens",
            coalesce(sum(output_tokens), 0)::int as "outputTokens"
       from ai_task_runs where started_at >= $1 group by 1, 2 order by 1, 2`,
    [since]
  );
  return {
    since,
    matchJobs: match.rows,
    linkJobs: link.rows,
    runs: runs.rows,
    relations: relations.rows,
    states: states.rows,
    calls: calls.rows
  };
}

export interface ProofCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * The card's tests, read from the report. After the edits only (`requested` false) each planned
 * note has one MATCH job that ended done or without change; after the second request each has a
 * second one that was skipped by its fingerprint and decided nothing.
 */
export function proofVerdict(
  plan: ProofPlan,
  report: ProofReport,
  options: { requested: boolean }
): { ok: boolean; checks: ProofCheck[] } {
  const jobsOf = (noteId: string) => report.matchJobs.filter((job) => job.noteId === noteId);
  const wanted = options.requested ? 2 : 1;
  const checks: ProofCheck[] = [];
  const check = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });
  const counts = plan.notes.map((note) => jobsOf(note.noteId).length);
  check(
    "one MATCH job per edit (and one per request)",
    counts.every((count) => count === wanted),
    `jobs per note: ${counts.join(",")}; expected ${wanted} each`
  );
  const first = plan.notes.map((note) => jobsOf(note.noteId)[0]);
  check(
    "each edit's job ended done or with no change, decided once",
    first.every(
      (job) =>
        job?.status === "succeeded" &&
        (job.outcome === "done" || job.outcome === "no_change") &&
        job.attempts === 1 &&
        !job.backlog
    ),
    first.map((job) => `${job?.status ?? "none"}/${job?.outcome ?? "-"}`).join(" ")
  );
  if (options.requested) {
    const second = plan.notes.map((note) => jobsOf(note.noteId)[1]);
    check(
      "an unchanged text is skipped by its fingerprint without a decision",
      second.every((job) => job?.status === "succeeded" && job.outcome === "skipped"),
      second.map((job) => `${job?.status ?? "none"}/${job?.outcome ?? "-"}`).join(" ")
    );
  }
  check(
    "no MATCH or link job failed",
    [...report.matchJobs, ...report.linkJobs].every((job) => job.status !== "failed"),
    `${report.matchJobs.length} MATCH, ${report.linkJobs.length} link jobs`
  );
  check(
    "every planned note keeps the hash of the text it was matched with",
    report.states.every((state) => state.hasHash),
    `${report.states.filter((state) => state.hasHash).length}/${report.states.length}`
  );
  check(
    "the relations MATCH left are suggestions with no direction of a decider's",
    report.relations.every(
      (relation) => relation.band === "suggest" && relation.directionSource !== "decider"
    ) && report.relations.every((relation) => relation.shown === "unknown"),
    `${report.relations.length} relations: ${JSON.stringify(
      Object.fromEntries(
        report.relations.map((relation) => [
          `${relation.band}/${relation.directionSource ?? "none"}`,
          report.relations.filter(
            (other) =>
              other.band === relation.band && other.directionSource === relation.directionSource
          ).length
        ])
      )
    )}`
  );
  const named = report.runs.filter((run) => run.titleKey === "changes.titles.relationMatched");
  const accepting = report.matchJobs.filter((job) => job.accepted > 0).length;
  check(
    "a link run persisted for the notes MATCH handed over is named after its note",
    accepting === 0 || named.length > 0,
    `${named.length} runs titled for a note, ${accepting} MATCH jobs accepted pairs`
  );
  return { ok: checks.every((entry) => entry.ok), checks };
}

/** The scratch clone's connection string, read from its `t44-connection.json`. */
export async function cloneConnectionString(clone: string): Promise<string> {
  const real = await realpath(resolve(clone));
  const cache = join(await realpath(repositoryRoot), ".cache") + sep;
  if (!real.startsWith(cache))
    throw new Error(`Refusing ${real}: the proof works on a clone under ${cache} only.`);
  const connection = JSON.parse(await readFile(join(real, "t44-connection.json"), "utf8")) as {
    connectionString?: unknown;
  };
  if (typeof connection.connectionString !== "string" || !connection.connectionString)
    throw new Error("The clone's scratch sidecar is not running (no connection string).");
  return connection.connectionString;
}

export const usage = `Usage:
  npx tsx scripts/relations/match-proof.ts edit <clone> --plan <plan.json> [--notes 10] [--clear-relations]
  npx tsx scripts/relations/match-proof.ts request <clone> --plan <plan.json>
  npx tsx scripts/relations/match-proof.ts report <clone> --plan <plan.json> [--requested] [--out <report.json>]`;

export async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      plan: { type: "string" },
      notes: { type: "string", default: "10" },
      "clear-relations": { type: "boolean", default: false },
      requested: { type: "boolean", default: false },
      out: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true,
    strict: true
  });
  const [command, clone] = positionals;
  if (values.help || !command || !clone || !values.plan || positionals.length !== 2) {
    console.info(usage);
    return values.help ? 0 : 2;
  }
  const pool = createPgPool({ connectionString: await cloneConnectionString(clone), max: 2 });
  try {
    if (command === "edit") {
      const count = Number(values.notes);
      if (!Number.isInteger(count) || count < 1 || count > 100)
        throw new Error("--notes is a whole number from 1 to 100.");
      const plan = await proofEdit(pool, {
        count,
        clearRelations: values["clear-relations"] === true
      });
      await writeFile(resolve(values.plan), `${JSON.stringify(plan, null, 2)}\n`, { flag: "wx" });
      console.info(`edited ${plan.notes.length} notes; plan written to ${values.plan}`);
      return 0;
    }
    const plan = JSON.parse(await readFile(resolve(values.plan), "utf8")) as ProofPlan;
    if (command === "request") {
      console.info(`queued ${await proofRequest(pool, plan)} MATCH jobs`);
      return 0;
    }
    if (command === "report") {
      const report = await proofReport(pool, plan);
      const verdict = proofVerdict(plan, report, { requested: values.requested === true });
      const text = `${JSON.stringify({ verdict, report }, null, 2)}\n`;
      if (values.out) await writeFile(resolve(values.out), text);
      for (const entry of verdict.checks)
        console.info(`${entry.ok ? "PASS" : "FAIL"} ${entry.name}: ${entry.detail}`);
      console.info(`calls: ${JSON.stringify(report.calls)}`);
      return verdict.ok ? 0 : 1;
    }
    console.info(usage);
    return 2;
  } finally {
    await closePgPool(pool);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[match-proof] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
