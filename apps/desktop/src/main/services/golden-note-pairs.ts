import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { z } from "zod";
import { aiCassetteReplayedUsageKey, type AiCassette, type AiCassetteStats } from "@app/ai";

import type { AppSettings } from "../../shared/ipc.js";
import type { AiService } from "./ai-service.js";
import { noteMatchDecisionOperations } from "./ai-task-parameters.js";
import { compareContent, contentKey } from "./content-order.js";
import {
  atomicNoteMatchingVersion,
  buildBatchRerankPrompt,
  parseBatchRerankOutput
} from "./knowledge-processing.js";

/**
 * DEV-only "note pair verdict" mode (MEMORA_GOLDEN_NOTE_PAIRS=<file>) for the F3 decider bake-off. It
 * asks the live generative decider (v9, the decide-only contract of `atomic-note-matching-v9`) about
 * given pairs of notes, grouped by source note: one call per source note and at most
 * {@link maxCandidatesPerCall} candidates, with exactly the request the note matcher builds
 * (`buildBatchRerankPrompt`, the `note_matching_reranking` operation and its repair, the matching
 * settings' output budget, the same repair rule), through the app's own AI service, so the cassette
 * records it and the profile's `reranking` route (Codex) answers. The raw verdicts go to
 * `.cache/golden/runs/<ts>/note-pair-verdicts.json`.
 *
 * It persists nothing: the module takes no database handle and imports no repository, the library is
 * not read, and nothing is written but that report. The notes travel in the pair file (title and idea
 * statement, which is all the v9 prompt shows), so the pairs need not belong to the profile's library
 * (the bake-off judges notes of three libraries and Spike A's benchmark in one run). The only rows
 * written are the AI audit of the calls themselves, by the AI service.
 *
 * The knob is exclusive: packaged builds refuse it, and so does any run that sets another golden,
 * corpus, reset or pilot knob, so a library is never changed while pairs are judged.
 */

export const notePairVerdictsFile = "note-pair-verdicts.json";
export const notePairsFormat = "memora-golden-note-pairs";
const reportFormat = "memora-golden-note-pair-verdicts";
/** A guard against a runaway list: the bake-off judges a few hundred pairs. */
export const maxNotePairs = 1_000;
/** Candidates one call carries (the matcher's budget at k = 20, F3 D10); a longer group is split. */
export const maxCandidatesPerCall = 20;
/** After this many failed calls in a row the rest of the list is skipped instead of retried. */
export const maxConsecutiveCallErrors = 3;

const noteKey = z.string().min(1).max(200);

export const notePairsFileSchema = z
  .object({
    format: z.literal(notePairsFormat),
    version: z.literal(1),
    /** The notes by key. Text is kept verbatim: the prompt is a function of the title and the idea. */
    notes: z.record(
      noteKey,
      // A note can have no title (some corpus notes have none): the prompt then shows an empty one.
      z.object({ title: z.string().max(500), idea: z.string().min(1).max(2_000) }).strict()
    ),
    pairs: z
      .array(
        z
          .object({
            /** The note whose call carries the pair; the candidate is judged against it. */
            source: noteKey,
            candidate: noteKey,
            label: z.string().min(1).max(200).optional()
          })
          .strict()
      )
      .min(1)
      .max(maxNotePairs)
  })
  .strict()
  .superRefine((file, context) => {
    const seen = new Set<string>();
    file.pairs.forEach((pair, index) => {
      for (const key of [pair.source, pair.candidate])
        if (!(key in file.notes))
          context.addIssue({
            code: "custom",
            path: ["pairs", index],
            message: `the note "${key}" is not in notes`
          });
      if (pair.source === pair.candidate)
        context.addIssue({
          code: "custom",
          path: ["pairs", index],
          message: "a note is not judged against itself"
        });
      const id = JSON.stringify([pair.source, pair.candidate]);
      if (seen.has(id))
        context.addIssue({
          code: "custom",
          path: ["pairs", index],
          message: "the pair is listed twice"
        });
      seen.add(id);
    });
  });
export type NotePairsFileContent = z.infer<typeof notePairsFileSchema>;

export interface NotePairsFile {
  path: string;
  sha256: string;
  content: NotePairsFileContent;
}

/** Reads and validates the pair list; a malformed file stops the run before anything is called. */
export async function readNotePairsFile(path: string): Promise<NotePairsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `MEMORA_GOLDEN_NOTE_PAIRS cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`MEMORA_GOLDEN_NOTE_PAIRS ${path} is not valid JSON`, { cause: error });
  }
  const parsed = notePairsFileSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `MEMORA_GOLDEN_NOTE_PAIRS ${path} must be a ${notePairsFormat} file with notes and up to ` +
        `${maxNotePairs} {source, candidate, label?} pairs: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`
    );
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    content: parsed.data
  };
}

// --- The calls ------------------------------------------------------------------------------------------

export interface PlannedCandidate {
  /** Index of the pair in the file. */
  pair: number;
  key: string;
  /** The candidate's number in the prompt, from 1 in content order. */
  alias: number;
}

export interface PlannedCall {
  index: number;
  source: string;
  candidates: PlannedCandidate[];
}

/**
 * Groups the pairs by source note (in the order the sources first appear), puts each group's
 * candidates in content order (title, then idea; never ids, as the matcher does) and splits a group
 * longer than {@link maxCandidatesPerCall} into calls of that many.
 */
export function planCalls(content: NotePairsFileContent): PlannedCall[] {
  const bySource = new Map<string, Array<{ pair: number; key: string }>>();
  content.pairs.forEach((pair, index) => {
    const group = bySource.get(pair.source) ?? [];
    group.push({ pair: index, key: pair.candidate });
    bySource.set(pair.source, group);
  });
  const calls: PlannedCall[] = [];
  for (const [source, group] of bySource) {
    const ordered = [...group].sort((a, b) =>
      compareContent(
        contentKey(content.notes[a.key]!.title, content.notes[a.key]!.idea),
        contentKey(content.notes[b.key]!.title, content.notes[b.key]!.idea)
      )
    );
    for (let start = 0; start < ordered.length; start += maxCandidatesPerCall) {
      calls.push({
        index: calls.length,
        source,
        candidates: ordered
          .slice(start, start + maxCandidatesPerCall)
          .map((candidate, offset) => ({ ...candidate, alias: offset + 1 }))
      });
    }
  }
  return calls;
}

export type NotePairStatus = "decided" | "undecided" | "skipped" | "error";

export interface NoteCallAttemptReport {
  /** 0 for the first answer, 1 for the repair. */
  attempt: 0 | 1;
  /** Candidate numbers the call asked about. */
  aliases: number[];
  wallMs: number;
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  tokenUsage: Record<string, number> | null;
  costEstimate: number | null;
  aiTaskRunId: string;
  /** Served from the cassette: its duration and cost are not a measurement. */
  replayed: boolean;
  profileId: string;
  providerId: string;
  modelId: string;
  runtime: string;
  /** The decider's answer as returned by the adapter. */
  output: unknown;
  /** Numbers answered validly, and numbers to ask again (missing, malformed or duplicated). */
  decided: number[];
  retry: number[];
}

export interface NoteCallReport {
  index: number;
  source: string;
  candidates: number;
  status: "judged" | "error" | "skipped";
  reason?: string;
  attempts: NoteCallAttemptReport[];
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface NotePairVerdict {
  index: number;
  source: string;
  candidate: string;
  label: string | null;
  call: number;
  alias: number;
  status: NotePairStatus;
  reason?: string;
  /** The contract's integer score, 0 to 100. */
  score: number | null;
  relationType: string | null;
  /** 0 when the first answer decided it, 1 when the repair did. */
  attempt: 0 | 1 | null;
  aiTaskRunId: string | null;
}

export type NotePairRunStatus =
  "completed" | "completed_with_failures" | "diverged" | "token_limit";

export interface NotePairVerdictsReport {
  format: typeof reportFormat;
  version: 1;
  /** `running` while calls remain; the file is rewritten after every call. */
  state: "running" | "finished";
  status: NotePairRunStatus | null;
  stopReason?: string;
  contract: string;
  startedAt: string;
  finishedAt: string | null;
  pairsFile: { path: string; sha256: string; notes: number; pairs: number; calls: number };
  settings: { maxRerankOutputTokens: number };
  contentLanguage: string;
  cassette: Pick<AiCassetteStats, "mode" | "directory" | "served" | "recorded" | "misses"> | null;
  totals: Record<string, number>;
  calls: NoteCallReport[];
  pairs: NotePairVerdict[];
}

export interface NotePairVerdictsInput {
  file: NotePairsFile;
  ai: Pick<AiService, "runDefaultTask">;
  /** The matching settings' output budget (`atomicNoteMatchingSettings.maxRerankOutputTokens`). */
  maxRerankOutputTokens: number;
  contentLanguage: string;
  cassette: { stats(): AiCassetteStats } | null;
  now?: () => Date;
  /** Called with the report after every call (state `running`) and at the end (state `finished`). */
  onUpdate?: (report: NotePairVerdictsReport) => void | Promise<void>;
  onCall?: (call: NoteCallReport, total: number) => void;
}

/** The request of one call, as the matcher builds it; exported so tests can compare the two. */
export function noteCallRequest(
  content: NotePairsFileContent,
  call: PlannedCall,
  subset: ReadonlyArray<PlannedCandidate>,
  attempt: 0 | 1,
  maxRerankOutputTokens: number,
  contentLanguage: string
): {
  task: "reranking";
  input: string;
  context: Record<string, unknown>;
  limits: { maxOutputTokens: number };
} {
  const source = content.notes[call.source]!;
  return {
    task: "reranking",
    input: buildBatchRerankPrompt(
      { title: source.title, ideaStatement: source.idea },
      subset.map((candidate) => ({
        alias: candidate.alias,
        title: content.notes[candidate.key]!.title,
        ideaStatement: content.notes[candidate.key]!.idea
      }))
    ),
    context: {
      origin: "golden_note_pairs",
      stage: "noteMatching",
      operation: attempt ? noteMatchDecisionOperations.repair : noteMatchDecisionOperations.decide,
      promptVersion: atomicNoteMatchingVersion,
      contentLanguage,
      attempt,
      // The class, priority and budget class the matcher's generative decider states (D16, R5, D14).
      workloadClass: "decide",
      priority: "P2",
      budgetClass: "user"
    },
    limits: { maxOutputTokens: maxRerankOutputTokens }
  };
}

/**
 * Asks the decider about one call's candidates: the first answer, then one repair for the numbers it
 * did not answer validly, as the matcher does. Reads the answers with the production parser.
 */
async function judgeCall(
  input: NotePairVerdictsInput,
  call: PlannedCall,
  verdicts: NotePairVerdict[]
): Promise<NoteCallReport> {
  const { content } = input.file;
  const attempts: NoteCallAttemptReport[] = [];
  const base = { index: call.index, source: call.source, candidates: call.candidates.length };
  const summary = (status: NoteCallReport["status"], reason?: string): NoteCallReport => ({
    ...base,
    status,
    ...(reason ? { reason } : {}),
    attempts,
    wallMs: attempts.reduce((sum, attempt) => sum + attempt.wallMs, 0),
    inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0)
  });
  const decisions = new Map<
    number,
    { score: number; relationType: string; attempt: 0 | 1; runId: string }
  >();
  let subset: ReadonlyArray<PlannedCandidate> = call.candidates;
  /** The matcher keeps what the first answer decided when the repair fails; so does this. */
  let repairFailure: string | null = null;
  for (const attempt of [0, 1] as const) {
    const request = noteCallRequest(
      content,
      call,
      subset,
      attempt,
      input.maxRerankOutputTokens,
      input.contentLanguage
    );
    const started = Date.now();
    let execution: Awaited<ReturnType<typeof input.ai.runDefaultTask>> = null;
    let failure: string | null = null;
    try {
      execution = await input.ai.runDefaultTask(
        request.task,
        request.input,
        request.context,
        undefined,
        request.limits
      );
      if (!execution) failure = "errors.ai.noCompatibleModel";
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (failure !== null || !execution) {
      if (attempt === 0) return summary("error", failure ?? "the call failed");
      repairFailure = failure;
      break;
    }
    const asked = subset.map((candidate) => candidate.alias);
    // Only the numbers asked are allowed, so the repair's decisions complete the first answer's.
    const parsed = parseBatchRerankOutput(execution.output, asked);
    for (const [alias, decision] of parsed.decisions)
      decisions.set(alias, {
        score: Math.round(decision.score * 100),
        relationType: decision.relationType,
        attempt,
        runId: execution.aiTaskRunId
      });
    attempts.push({
      attempt,
      aliases: asked,
      wallMs: Date.now() - started,
      durationMs: execution.durationMs,
      inputTokens: execution.inputTokens ?? null,
      outputTokens: execution.outputTokens ?? null,
      tokenUsage: execution.tokenUsage ?? null,
      costEstimate: execution.costEstimate ?? null,
      aiTaskRunId: execution.aiTaskRunId,
      replayed: execution.tokenUsage?.[aiCassetteReplayedUsageKey] === 1,
      profileId: execution.profileId,
      providerId: execution.providerId,
      modelId: execution.modelId,
      runtime: execution.runtime,
      output: execution.output,
      decided: [...parsed.decisions.keys()],
      retry: parsed.retry
    });
    if (parsed.retry.length === 0) break;
    subset = call.candidates.filter((candidate) => parsed.retry.includes(candidate.alias));
  }
  for (const candidate of call.candidates) {
    const decision = decisions.get(candidate.alias);
    const verdict = verdicts[candidate.pair]!;
    if (decision) {
      verdict.status = "decided";
      verdict.score = decision.score;
      verdict.relationType = decision.relationType;
      verdict.attempt = decision.attempt;
      verdict.aiTaskRunId = decision.runId;
    } else {
      verdict.status = "undecided";
      verdict.reason = repairFailure
        ? `the repair call failed: ${repairFailure}`
        : "no valid item after the repair: the matcher leaves such a pair undecided";
    }
  }
  return summary("judged", repairFailure ? `the repair call failed: ${repairFailure}` : undefined);
}

function totals(report: Pick<NotePairVerdictsReport, "calls" | "pairs">): Record<string, number> {
  const attempts = report.calls.flatMap((call) => call.attempts);
  const count = (status: NotePairStatus) =>
    report.pairs.filter((pair) => pair.status === status).length;
  const decided = report.pairs.filter((pair) => pair.status === "decided");
  return {
    pairs: report.pairs.length,
    decided: decided.length,
    undecided: count("undecided"),
    errors: count("error"),
    skipped: count("skipped"),
    decidedByRepair: decided.filter((pair) => pair.attempt === 1).length,
    calls: attempts.length,
    callGroups: report.calls.length,
    repairs: attempts.filter((attempt) => attempt.attempt === 1).length,
    replayedCalls: attempts.filter((attempt) => attempt.replayed).length,
    inputTokens: report.calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: report.calls.reduce((sum, call) => sum + call.outputTokens, 0),
    providerMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    wallMs: report.calls.reduce((sum, call) => sum + call.wallMs, 0)
  };
}

/**
 * Asks the decider about every planned call, one at a time. A cassette miss in replay, the live token
 * cap, or repeated failed calls stop the calls; the pairs left are reported as skipped. Never rejects
 * for a call; persists nothing.
 */
export async function runNotePairVerdicts(
  input: NotePairVerdictsInput
): Promise<NotePairVerdictsReport> {
  const now = input.now ?? (() => new Date());
  const { content } = input.file;
  const plan = planCalls(content);
  const verdicts: NotePairVerdict[] = content.pairs.map((pair, index) => {
    const call = plan.find((candidate) =>
      candidate.candidates.some((entry) => entry.pair === index)
    )!;
    return {
      index,
      source: pair.source,
      candidate: pair.candidate,
      label: pair.label ?? null,
      call: call.index,
      alias: call.candidates.find((entry) => entry.pair === index)!.alias,
      status: "skipped",
      score: null,
      relationType: null,
      attempt: null,
      aiTaskRunId: null
    };
  });
  const cassetteStats = () => {
    const stats = input.cassette?.stats();
    return stats
      ? {
          mode: stats.mode,
          directory: stats.directory,
          served: stats.served,
          recorded: stats.recorded,
          misses: stats.misses
        }
      : null;
  };
  const report: NotePairVerdictsReport = {
    format: reportFormat,
    version: 1,
    state: "running",
    status: null,
    contract: atomicNoteMatchingVersion,
    startedAt: now().toISOString(),
    finishedAt: null,
    pairsFile: {
      path: input.file.path,
      sha256: input.file.sha256,
      notes: Object.keys(content.notes).length,
      pairs: content.pairs.length,
      calls: plan.length
    },
    settings: { maxRerankOutputTokens: input.maxRerankOutputTokens },
    contentLanguage: input.contentLanguage,
    cassette: cassetteStats(),
    totals: {},
    calls: [],
    pairs: verdicts
  };
  const publish = async () => {
    report.totals = totals(report);
    report.cassette = cassetteStats();
    await input.onUpdate?.(report);
  };
  let stopReason: { status: NotePairRunStatus; reason: string } | null = null;
  let consecutiveErrors = 0;
  for (const call of plan) {
    let entry: NoteCallReport;
    if (stopReason) {
      entry = {
        index: call.index,
        source: call.source,
        candidates: call.candidates.length,
        status: "skipped",
        reason: stopReason.reason,
        attempts: [],
        wallMs: 0,
        inputTokens: 0,
        outputTokens: 0
      };
    } else {
      const before = input.cassette?.stats();
      entry = await judgeCall(input, call, verdicts);
      if (entry.status === "error")
        for (const candidate of call.candidates) {
          verdicts[candidate.pair]!.status = "error";
          verdicts[candidate.pair]!.reason = entry.reason ?? "the call failed";
        }
      consecutiveErrors = entry.status === "error" ? consecutiveErrors + 1 : 0;
      const after = input.cassette?.stats();
      if (after?.mode === "replay" && after.misses > (before?.misses ?? 0))
        stopReason = {
          status: "diverged",
          reason: "a call missed the replay cassette: the request differs from every recorded one"
        };
      else if (
        after?.mode === "record" &&
        after.maxLiveTokens !== null &&
        after.liveTokens >= after.maxLiveTokens
      )
        stopReason = {
          status: "token_limit",
          reason: "the live token cap (MEMORA_GOLDEN_MAX_TOKENS) was reached"
        };
      else if (consecutiveErrors >= maxConsecutiveCallErrors)
        stopReason = {
          status: "completed_with_failures",
          reason: `${maxConsecutiveCallErrors} calls failed in a row`
        };
    }
    report.calls.push(entry);
    input.onCall?.(entry, plan.length);
    await publish();
  }
  const failures = verdicts.some((pair) => pair.status === "error" || pair.status === "undecided");
  report.status = stopReason?.status ?? (failures ? "completed_with_failures" : "completed");
  if (stopReason) report.stopReason = stopReason.reason;
  report.state = "finished";
  report.finishedAt = now().toISOString();
  await publish();
  return report;
}

/** Writes the report into the run directory, atomically, so a crash never leaves half a file. */
export async function writeNotePairVerdicts(
  directory: string,
  report: NotePairVerdictsReport
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, notePairVerdictsFile);
  const temporary = `${path}.partial`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}

// --- The knob -------------------------------------------------------------------------------------------

/**
 * Knobs that start other work or change a library. The note pair mode judges notes and nothing else,
 * so a run that sets one of them is refused rather than mixed.
 */
export const exclusiveKnobs = [
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_GOLDEN_RESET_ALSO",
  "MEMORA_GOLDEN_ALLOW_NONEMPTY",
  "MEMORA_GOLDEN_ONLY",
  "MEMORA_GOLDEN_TOPICS",
  "MEMORA_GOLDEN_TOPICS_ARRIVAL",
  "MEMORA_PROFILE_RESET",
  "MEMORA_LEGACY_WIPE",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK",
  "MEMORA_TOPIC_CORPUS",
  "MEMORA_LOCAL_MODEL_INSTALL"
] as const;

export interface GoldenNotePairsEnvironment {
  pairsPath: string;
  /** Cap on live remote tokens: required when recording. */
  maxLiveTokens: number | null;
  /** MEMORA_GOLDEN_EXIT=1: quit when the pairs are judged. */
  exitWhenDone: boolean;
}

/** Reads MEMORA_GOLDEN_NOTE_PAIRS; null when it is not set. Packaged builds and mixed knobs refuse it. */
export function readGoldenNotePairsEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): GoldenNotePairsEnvironment | null {
  const raw = env.MEMORA_GOLDEN_NOTE_PAIRS?.trim();
  if (!raw) return null;
  if (options.isPackaged) throw new Error("MEMORA_GOLDEN_NOTE_PAIRS is refused in packaged builds");
  const others = exclusiveKnobs.filter((name) => env[name]?.trim());
  if (others.length)
    throw new Error(
      `MEMORA_GOLDEN_NOTE_PAIRS cannot be combined with ${others.join(", ")}: it judges notes only`
    );
  const rawLimit = env.MEMORA_GOLDEN_MAX_TOKENS?.trim();
  const limit = rawLimit ? Number(rawLimit) : null;
  if (limit !== null && (!Number.isSafeInteger(limit) || limit <= 0))
    throw new Error("MEMORA_GOLDEN_MAX_TOKENS must be a positive integer");
  return {
    pairsPath: resolve(options.workspaceRoot, raw),
    maxLiveTokens: limit,
    exitWhenDone: env.MEMORA_GOLDEN_EXIT === "1"
  };
}

export interface GoldenNotePairsOptions {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  workspaceRoot: string;
  cassette: Pick<AiCassette, "stats" | "limitLiveTokens"> | null;
  ai: Pick<AiService, "runDefaultTask">;
  settings: {
    getApp(): Promise<Pick<AppSettings, "contentLanguage" | "atomicNoteMatchingSettings">>;
  };
  quit: () => void;
  log?: (event: string, data?: Record<string, unknown>) => void;
  now?: () => Date;
}

export interface GoldenNotePairsRun {
  pairs: number;
  calls: number;
  /** Judges the pairs and writes the report; never rejects. */
  start(): Promise<NotePairVerdictsReport | null>;
}

/**
 * Runs before anything starts: validates the request and the pair list. Nothing is called or written
 * before every check passed. Throws a refusal the caller reports.
 */
export async function prepareGoldenNotePairs(
  options: GoldenNotePairsOptions
): Promise<GoldenNotePairsRun> {
  if (options.isPackaged) throw new Error("The note pair mode never runs in packaged builds");
  const environment = readGoldenNotePairsEnvironment(options.env, options);
  if (!environment) throw new Error("MEMORA_GOLDEN_NOTE_PAIRS must name a pair list");
  const cassette = options.cassette?.stats();
  if (!options.cassette || !cassette)
    throw new Error("The note pair mode needs MEMORA_AI_CASSETTE=record or replay");
  if (cassette.mode === "record" && environment.maxLiveTokens === null)
    throw new Error(
      "Recording spends the configured remote route: set MEMORA_GOLDEN_MAX_TOKENS to a positive " +
        "cap on live tokens (a recording resumes from the cassette, so a cap that was too low can be raised)"
    );
  const file = await readNotePairsFile(environment.pairsPath);
  const calls = planCalls(file.content).length;
  // A recording may spend the remote route: past the cap the cassette makes no further provider call.
  if (cassette.mode === "record") options.cassette.limitLiveTokens(environment.maxLiveTokens);
  const log = (event: string, data: Record<string, unknown> = {}) =>
    (
      options.log ??
      ((name, payload) =>
        console.log("GOLDEN_NOTE_PAIRS", JSON.stringify({ event: name, ...payload })))
    )(event, data);
  log("prepared", { pairs: file.content.pairs.length, calls, cassette: cassette.mode });
  const now = options.now ?? (() => new Date());
  return {
    pairs: file.content.pairs.length,
    calls,
    async start() {
      const runDirectory = join(
        options.workspaceRoot,
        ".cache",
        "golden",
        "runs",
        now().toISOString().replace(/[:.]/g, "-")
      );
      try {
        const app = await options.settings.getApp();
        const report = await runNotePairVerdicts({
          file,
          ai: options.ai,
          maxRerankOutputTokens: app.atomicNoteMatchingSettings.maxRerankOutputTokens,
          contentLanguage: app.contentLanguage ?? "en",
          cassette: options.cassette,
          ...(options.now ? { now: options.now } : {}),
          onUpdate: async (current) => {
            await writeNotePairVerdicts(runDirectory, current);
          },
          onCall: (call, total) =>
            log("note_pair_call", {
              call: `${call.index + 1}/${total}`,
              candidates: call.candidates,
              status: call.status,
              attempts: call.attempts.length,
              wallMs: call.wallMs,
              ...(call.reason ? { reason: call.reason } : {})
            })
        });
        log("note_pairs", {
          status: report.status,
          path: join(runDirectory, notePairVerdictsFile),
          ...report.totals
        });
        return report;
      } catch (error) {
        log("failed", { error: error instanceof Error ? error.message : String(error) });
        return null;
      } finally {
        if (environment.exitWhenDone) options.quit();
      }
    }
  };
}
