import { createHash, randomUUID } from "node:crypto";

import type { AiCassetteStats, AiWorkloadClass } from "@app/ai";
import type { PgPool } from "@app/db";
import {
  ConsultationInputSchema,
  type RelationsConfig,
  type SourceRelationSettings
} from "@app/domain";
import {
  clipIdea,
  defaultTopicTreeConfig,
  itemKey,
  validateNamingOutput,
  type NamingCall,
  type NamingTopic
} from "@app/domain/topic-tree";

import type { AiService } from "./ai-service.js";
import type { ConsultationService } from "./consultation-service.js";
import { compareContent } from "./content-order.js";
import {
  createSourcePairReader,
  runSourcePairVerdicts,
  type SourcePair,
  type SourcePairRoot
} from "./golden-source-pairs.js";
import { generateAtomicNoteCandidates, type KnowledgeAiRunner } from "./knowledge-processing.js";
import { sourceMatchingOperation } from "./source-relation-processing.js";
import { topicNamingLimits } from "./topic-tree/topic-naming.js";
import {
  buildTopicNamePrompt,
  topicNameOperation,
  topicNamePromptVersion,
  topicNamingOutputContract
} from "./topic-tree/topic-prompts.js";

/**
 * The strict-output probe (owner, 10-25; the orchestrator's label STRICTP): a few live calls of each
 * structured caller that gate S saw repairing at schema none (the Ask, topic naming, the source
 * judge and atomic notes) made through the product's own builders, contracts and parsers on the
 * library of a cloned profile, to show that each is sent a strict schema (`schema_mode` strict) and
 * answers without a repair. The report holds counts and outcome codes only: no prompt or answer text.
 *
 * DEV only: a golden run with `MEMORA_GOLDEN_STRICT_PROBE=1` (or `asks=<n>,names=<n>,pairs=<n>,
 * notes=<n>`) runs it instead of the manifest (`golden-runner.ts`), as a verdict-only run (no job,
 * no topic engine), through the normal AI service and its cassette, so the token cap applies. It
 * writes nothing to the library: the Ask and the judge only read, names and notes are validated and
 * dropped; the calls add their AI audit rows, which the report reads back per part. Every part's
 * route must run remotely, or nothing is asked.
 */

export const strictProbeKnob = "MEMORA_GOLDEN_STRICT_PROBE";
/** A pair list (the golden source pairs format, by root title); adjacent roots when absent. */
export const strictProbePairsKnob = "MEMORA_GOLDEN_STRICT_PROBE_PAIRS";

export const strictProbeParts = ["asks", "names", "pairs", "notes"] as const;
export type StrictProbePart = (typeof strictProbeParts)[number];
export type StrictProbePlan = Record<StrictProbePart, number>;

/** What `=1` asks for: about 60k Codex tokens at gate S's unit costs. */
export const strictProbeDefaults: StrictProbePlan = { asks: 3, names: 2, pairs: 8, notes: 3 };
/** The most of each part a probe asks for (a guard: the probe's budget is about 80k tokens). */
export const strictProbeMax: StrictProbePlan = { asks: 5, names: 4, pairs: 14, notes: 5 };

export const strictProbeLimits = {
  /** Topics one naming call names: each a root source shown by a sample of its notes. */
  topicsPerCall: 3,
  /** Notes shown for each of those topics, in title order. */
  notesPerTopic: 6,
  /** The passages one notes call reads: the first chunks of a document, within this many characters. */
  noteChunks: 4,
  noteCharacters: 6000
} as const;

/** Reads the knob; null when no probe is asked for. A malformed value is refused before anything runs. */
export function readStrictProbePlan(
  env: Readonly<Record<string, string | undefined>>
): StrictProbePlan | null {
  const raw = env[strictProbeKnob]?.trim();
  if (!raw) return null;
  if (raw === "1") return { ...strictProbeDefaults };
  const plan: StrictProbePlan = { asks: 0, names: 0, pairs: 0, notes: 0 };
  const usage =
    `${strictProbeKnob} must be 1 or a list such as asks=3,names=2,pairs=8,notes=3 ` +
    `(at most ${strictProbeParts.map((part) => `${part} ${strictProbeMax[part]}`).join(", ")})`;
  for (const entry of raw.split(",")) {
    const match = /^(asks|names|pairs|notes)=(\d{1,3})$/u.exec(entry.trim());
    if (!match) throw new Error(usage);
    const part = match[1] as StrictProbePart;
    const count = Number(match[2]);
    if (count > strictProbeMax[part]) throw new Error(usage);
    plan[part] = count;
  }
  if (strictProbeParts.every((part) => plan[part] === 0)) throw new Error(usage);
  return plan;
}

/** Where each part's calls are routed: the keys a real call of that caller resolves. */
const partRoutes: Record<
  StrictProbePart,
  {
    task: Parameters<AiService["taskRouteLocality"]>[0];
    route: { operation: string; workloadClass: AiWorkloadClass };
  }
> = {
  asks: {
    task: "structured-output",
    route: { operation: "wiki-consultation", workloadClass: "answer" }
  },
  names: {
    task: "structured-output",
    route: { operation: topicNameOperation, workloadClass: "write-fast" }
  },
  pairs: {
    task: "reranking",
    route: { operation: sourceMatchingOperation, workloadClass: "decide" }
  },
  notes: {
    task: "atomic-note-generation",
    route: { operation: "atomic_note_generation", workloadClass: "write-quality" }
  }
};

/** One group of a part's audit rows. */
export interface StrictProbeAuditRow {
  runtime: string;
  schemaMode: string | null;
  isRepair: boolean;
  status: string;
  /** Served by the cassette (a resumed probe): no live call was made. */
  replayed: boolean;
  calls: number;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface StrictProbePartReport {
  /** What the part asked for: questions, naming calls, pairs or notes calls. */
  asked: number;
  /** Outcome codes and their counts (`answered`, `failed:<code>`, `accepted`, `rejected:<reason>`, ...). */
  outcomes: Record<string, number>;
  /** The AI audit rows made while the part ran, grouped (no prompt or answer). */
  audit: StrictProbeAuditRow[];
}

export interface StrictProbeReport {
  format: "strict-probe-v1";
  plan: StrictProbePlan;
  routes: Record<StrictProbePart, "local" | "remote" | null>;
  parts: Record<StrictProbePart, StrictProbePartReport>;
  /** Over every part: live remote calls, those sent strictly, repairs and failed calls. */
  totals: {
    liveRemoteCalls: number;
    strictCalls: number;
    repairCalls: number;
    failedCalls: number;
    servedCalls: number;
  };
}

export interface StrictProbeDeps {
  pool: Pick<PgPool, "query">;
  ai: Pick<AiService, "runDefaultTask" | "taskRouteLocality">;
  consultation: Pick<ConsultationService, "ask">;
  settings: { contentLanguage: string; sourceRelationSettings: SourceRelationSettings };
  relations: Pick<RelationsConfig, "discovery" | "sourceJudge">;
  cassette: { stats(): AiCassetteStats } | null;
  /** The pair list of `MEMORA_GOLDEN_STRICT_PROBE_PAIRS`, already read; null for adjacent roots. */
  pairs: { path: string; pairs: SourcePair[] } | null;
  now?: () => Date;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** A refusal before any call: the probe asked nothing. */
export class StrictProbeRefusal extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StrictProbeRefusal";
  }
}

const count = (outcomes: Record<string, number>, code: string) => {
  outcomes[code] = (outcomes[code] ?? 0) + 1;
};
/** An outcome code: an error's own short key, never its text when it is longer. */
const codeOf = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return /^[\w.:-]{1,80}$/u.test(message) ? message : "error";
};

/** The library's root sources in content order (title, then id). */
async function libraryRoots(pool: StrictProbeDeps["pool"]): Promise<SourcePairRoot[]> {
  const result = await pool.query<SourcePairRoot>(
    `select id::text as id, title, type::text as type from source_items
      where parent_source_item_id is null`
  );
  return result.rows
    .map((row) => ({ id: String(row.id), title: String(row.title), type: String(row.type) }))
    .sort((a, b) => compareContent(a.title, b.title) || compareContent(a.id, b.id));
}

const subtree = `with recursive tree(id, depth) as (
    select $1::uuid, 0
    union all
    select c.id, t.depth + 1 from source_items c join tree t on c.parent_source_item_id = t.id)`;

/** A root's current notes in title order, the sample a naming call shows of it. */
async function rootNotes(pool: StrictProbeDeps["pool"], rootId: string, limit: number) {
  const result = await pool.query<{ id: string; title: string; idea: string | null }>(
    `${subtree}
     select n.id::text as id, n.title, n.idea_statement as idea
       from atomic_notes n
      where n.created_from_source_item_id in (select id from tree)
        and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
      order by n.title, n.id
      limit $2`,
    [rootId, limit]
  );
  return result.rows;
}

/** The first chunks of a root's first document (shallowest source, then title), within the bound. */
async function rootChunks(pool: StrictProbeDeps["pool"], rootId: string) {
  const document = await pool.query<{ documentId: string; title: string; language: string | null }>(
    `${subtree}
     select d.id::text as "documentId", s.title, s.language
       from tree t
       join source_items s on s.id = t.id
       join documents d on d.source_item_id = s.id
      where exists (select 1 from chunks c where c.document_id = d.id)
      order by t.depth, s.title, s.id, d.created_at, d.id
      limit 1`,
    [rootId]
  );
  const first = document.rows[0];
  if (!first) return null;
  const chunks = await pool.query<{ id: string; content: string }>(
    `select id::text as id, content from chunks where document_id = $1::uuid
      order by chunk_index, id limit $2`,
    [first.documentId, strictProbeLimits.noteChunks]
  );
  const kept: Array<{ id: string; content: string }> = [];
  let characters = 0;
  for (const chunk of chunks.rows) {
    if (kept.length > 0 && characters + chunk.content.length > strictProbeLimits.noteCharacters)
      break;
    kept.push({ id: chunk.id, content: chunk.content });
    characters += chunk.content.length;
  }
  return { title: first.title, language: first.language, chunks: kept };
}

/** The audit rows of the calls made from `since` until `until`, grouped. */
async function auditRows(
  pool: StrictProbeDeps["pool"],
  since: Date,
  until: Date
): Promise<StrictProbeAuditRow[]> {
  const result = await pool.query<StrictProbeAuditRow>(
    `select runtime, schema_mode as "schemaMode", is_repair as "isRepair", status::text as status,
            (adapter = 'cassette-replay') as replayed, count(*)::int as calls,
            sum(input_tokens)::int as "inputTokens", sum(output_tokens)::int as "outputTokens"
       from ai_task_runs
      where started_at >= $1 and started_at <= $2 and task_type <> 'embedding'
      group by 1, 2, 3, 4, 5
      order by 1, 2, 3, 4, 5`,
    [since.toISOString(), until.toISOString()]
  );
  return result.rows.map((row) => ({
    runtime: String(row.runtime),
    schemaMode: row.schemaMode === null ? null : String(row.schemaMode),
    isRepair: row.isRepair === true,
    status: String(row.status),
    replayed: row.replayed === true,
    calls: Number(row.calls),
    inputTokens: row.inputTokens === null ? null : Number(row.inputTokens),
    outputTokens: row.outputTokens === null ? null : Number(row.outputTokens)
  }));
}

/** Pairs of roots next to each other in content order: (1, 2), (2, 3), ... */
function adjacentPairs(roots: readonly SourcePairRoot[], limit: number): SourcePair[] {
  return roots
    .slice(1)
    .map((root, index) => ({ left: roots[index]!.title, right: root.title }))
    .slice(0, limit);
}

async function askQuestions(deps: StrictProbeDeps, roots: readonly SourcePairRoot[], asks: number) {
  const outcomes: Record<string, number> = {};
  const titles = roots.slice(0, asks).map((root) => root.title);
  for (const title of titles) {
    try {
      await deps.consultation.ask(
        ConsultationInputSchema.parse({
          requestId: randomUUID(),
          // The soak driver's question: content, never an ID.
          question: `What does the library say about ${title}?`,
          privacy: "allow_remote",
          mode: "text"
        })
      );
      count(outcomes, "answered");
    } catch (error) {
      count(outcomes, `failed:${codeOf(error)}`);
    }
  }
  return { asked: titles.length, outcomes };
}

async function nameTopics(deps: StrictProbeDeps, roots: readonly SourcePairRoot[], names: number) {
  const outcomes: Record<string, number> = {};
  const naming = defaultTopicTreeConfig.naming;
  const { contentLanguage } = deps.settings;
  const topics: Array<Omit<NamingTopic, "alias">> = [];
  for (const root of roots) {
    if (topics.length >= names * strictProbeLimits.topicsPerCall) break;
    const notes = await rootNotes(deps.pool, root.id, strictProbeLimits.notesPerTopic);
    if (notes.length < 2) continue;
    topics.push({
      topicId: root.id,
      size: notes.length,
      members: notes.map((note) => ({
        key: itemKey("note", note.id),
        kind: "note" as const,
        title: clipIdea(note.title, topicNamingLimits.memberTitleMaxChars),
        idea: note.idea === null ? null : clipIdea(note.idea, naming.ideaMaxChars),
        rootSource: itemKey("source", root.id)
      })),
      subtopics: [],
      childTitles: [],
      currentTitle: null
    });
  }
  let asked = 0;
  for (let start = 0; start < topics.length; start += strictProbeLimits.topicsPerCall) {
    const call: NamingCall = {
      groups: [
        {
          parentId: "strict-probe",
          parentTitle: null,
          namedSiblings: [],
          topics: topics
            .slice(start, start + strictProbeLimits.topicsPerCall)
            .map((topic, index) => ({ ...topic, alias: `T${index + 1}` }))
        }
      ]
    };
    const named = call.groups[0]!.topics;
    asked += 1;
    try {
      const result = await deps.ai.runDefaultTask(
        "structured-output",
        buildTopicNamePrompt(call, { contentLanguage, config: naming }),
        {
          stage: "topic_naming",
          operation: topicNameOperation,
          origin: "strict_probe",
          workloadClass: "write-fast",
          // A DEV measurement the developer starts (not the Gardener's P3 work): audited, never
          // refused by the budget; the class and the request are the naming job's.
          priority: "P2",
          budgetClass: "user",
          contentLanguage,
          promptVersion: topicNamePromptVersion,
          outputContract: topicNamingOutputContract,
          attempt: 0,
          isRepair: false,
          sourceItemIds: named.map((topic) => topic.topicId).sort()
        },
        undefined,
        {
          maxOutputTokens:
            topicNamingLimits.outputTokensBase +
            topicNamingLimits.outputTokensPerTopic * named.length
        }
      );
      if (!result) {
        count(outcomes, "failed:errors.ai.noCompatibleModel");
        continue;
      }
      // The product's validation; a rejected topic would be asked again, which the probe counts.
      const validation = validateNamingOutput(result.output, call, {
        contentLanguage,
        config: naming
      });
      if (validation.accepted.length)
        outcomes.accepted = (outcomes.accepted ?? 0) + validation.accepted.length;
      for (const rejected of validation.rejected) count(outcomes, `rejected:${rejected.reason}`);
    } catch (error) {
      count(outcomes, `failed:${codeOf(error)}`);
    }
  }
  return { asked, outcomes };
}

async function judgePairs(deps: StrictProbeDeps, roots: SourcePairRoot[], pairs: number) {
  const outcomes: Record<string, number> = {};
  const list = deps.pairs ? deps.pairs.pairs.slice(0, pairs) : adjacentPairs(roots, pairs);
  if (list.length === 0) return { asked: 0, outcomes };
  const text = JSON.stringify(list);
  // The matcher's request for each pair, through the golden source pair runner (persists nothing).
  const report = await runSourcePairVerdicts({
    mode: "verdict_only",
    file: {
      path: deps.pairs?.path ?? "strict-probe:adjacent-roots",
      sha256: createHash("sha256").update(text).digest("hex"),
      pairs: list,
      grouping: "pair"
    },
    manifest: { name: "strict-probe", sources: [] },
    roots,
    reader: createSourcePairReader(deps.pool),
    ai: deps.ai,
    settings: deps.settings.sourceRelationSettings,
    contentLanguage: deps.settings.contentLanguage,
    relations: deps.relations,
    cassette: deps.cassette,
    ...(deps.now ? { now: deps.now } : {})
  });
  for (const pair of report.pairs) count(outcomes, pair.status);
  return { asked: list.length, outcomes };
}

async function generateNotes(
  deps: StrictProbeDeps,
  roots: readonly SourcePairRoot[],
  notes: number
) {
  const outcomes: Record<string, number> = {};
  let asked = 0;
  for (const root of roots) {
    if (asked >= notes) break;
    const source = await rootChunks(deps.pool, root.id);
    if (!source || source.chunks.length === 0) continue;
    asked += 1;
    const run: KnowledgeAiRunner = async (prompt, context) => {
      const result = await deps.ai.runDefaultTask("atomic-note-generation", prompt, {
        ...context,
        sourceItemId: root.id,
        stage: "atomic_note_generation",
        origin: "strict_probe",
        workloadClass: "write-quality",
        priority: "P2",
        budgetClass: "user"
      });
      return result
        ? {
            output: result.output,
            providerId: result.providerId,
            modelId: result.modelId,
            runtime: result.runtime,
            profileId: result.profileId,
            aiTaskRunId: result.aiTaskRunId
          }
        : null;
    };
    try {
      // The product path (unpinned): strict terms for a remote runtime, items read one by one.
      const generated = await generateAtomicNoteCandidates(
        { title: source.title, language: source.language ?? deps.settings.contentLanguage },
        source.chunks,
        run
      );
      if (!generated) count(outcomes, "failed:errors.ai.noCompatibleModel");
      else if (generated.output.notes.length === 0) count(outcomes, "no_notes");
      else count(outcomes, "notes");
    } catch (error) {
      count(outcomes, `failed:${codeOf(error)}`);
    }
  }
  return { asked, outcomes };
}

/**
 * Runs the probe: checks every asked part's route first (all remote, or nothing is asked), then
 * the parts in order, each with the audit rows made while it ran.
 */
export async function runStrictProbe(
  plan: StrictProbePlan,
  deps: StrictProbeDeps
): Promise<StrictProbeReport> {
  const now = deps.now ?? (() => new Date());
  const routes = {} as StrictProbeReport["routes"];
  for (const part of strictProbeParts) {
    const { task, route } = partRoutes[part];
    routes[part] = plan[part] > 0 ? await deps.ai.taskRouteLocality(task, route) : null;
  }
  const notRemote = strictProbeParts.filter((part) => plan[part] > 0 && routes[part] !== "remote");
  if (notRemote.length)
    throw new StrictProbeRefusal(
      `${strictProbeKnob}: the route of ${notRemote.map((part) => `${part} (${routes[part] ?? "none"})`).join(", ")} ` +
        "does not run remotely, so it would not be sent a strict schema; nothing was asked"
    );
  const roots = await libraryRoots(deps.pool);
  if (roots.length < 2)
    throw new StrictProbeRefusal(
      `${strictProbeKnob} needs a library with two root sources at least`
    );
  const parts = {} as StrictProbeReport["parts"];
  const runners: Record<
    StrictProbePart,
    () => Promise<{ asked: number; outcomes: Record<string, number> }>
  > = {
    asks: () => askQuestions(deps, roots, plan.asks),
    names: () => nameTopics(deps, roots, plan.names),
    pairs: () => judgePairs(deps, roots, plan.pairs),
    notes: () => generateNotes(deps, roots, plan.notes)
  };
  for (const part of strictProbeParts) {
    if (plan[part] === 0) {
      parts[part] = { asked: 0, outcomes: {}, audit: [] };
      continue;
    }
    const since = now();
    const result = await runners[part]();
    const audit = await auditRows(deps.pool, since, now());
    parts[part] = { ...result, audit };
    deps.log?.("strict_probe_part", { part, asked: result.asked, outcomes: result.outcomes });
  }
  const rows = strictProbeParts.flatMap((part) => parts[part].audit);
  const live = rows.filter((row) => row.runtime === "remote" && !row.replayed);
  const sum = (selected: StrictProbeAuditRow[]) =>
    selected.reduce((total, row) => total + row.calls, 0);
  return {
    format: "strict-probe-v1",
    plan,
    routes,
    parts,
    totals: {
      liveRemoteCalls: sum(live),
      strictCalls: sum(live.filter((row) => row.schemaMode === "strict")),
      repairCalls: sum(rows.filter((row) => row.isRepair)),
      failedCalls: sum(rows.filter((row) => row.status !== "succeeded")),
      servedCalls: sum(rows.filter((row) => row.replayed))
    }
  };
}
