import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";
import { aiCassetteReplayedUsageKey, type AiCassetteStats } from "@app/ai";
import {
  relationsConfig,
  sourceDecisionPassesFloors,
  type SourceRelationSettings
} from "@app/domain";
import { createSourceRelationRepository, type PgPool, type SourceRelationNote } from "@app/db";

import type { AiService } from "./ai-service.js";
import type { GoldenManifest } from "./golden-runner.js";
import { joinPrompts, renderPrompt } from "./prompt-runtime.js";
import {
  aliasOrder,
  askSourceJudge,
  distinctSourceVerdicts,
  parseSourceDecision,
  sourceDecisionAllowance,
  sourceDecisionMaxOutputTokens,
  sourceDecisionPrompt,
  sourcePairContext,
  sourceMatchingOperation,
  sourceRelationPromptVersion,
  sourceRelationWrites,
  type SourceDecisionParse,
  type SourceDecisionOutcome,
  type SourceDecisionRequest,
  type SourceJudgePair
} from "./source-relation-processing.js";

/**
 * DEV-only "source pair verdict" mode of the golden runner (MEMORA_GOLDEN_SOURCE_PAIRS=<file>). It
 * asks the live source decider about a given list of pairs of works, with exactly the request the
 * matcher builds for a pair (`sourcePairContext`, `sourceDecisionPrompt`, the same call context and
 * output budget, the same repair rule), and writes every raw verdict to
 * `.cache/golden/runs/<ts>/source-pair-verdicts.json` for the F3 discovery spike.
 *
 * It persists nothing: no source relation, decision row, run state or explanation, and it changes no
 * library data. It reads through {@link SourcePairReader}, which exposes only the three read queries
 * of the source relation repository, so the write paths are unreachable from here. The only rows
 * written are the AI audit of the calls themselves, by the AI service.
 */

export const sourcePairVerdictsFile = "source-pair-verdicts.json";
const reportFormat = "memora-golden-source-pair-verdicts";
/** A guard against a runaway list: the F3 spike needs fewer than 100 pairs. */
export const maxSourcePairs = 300;
/** After this many failed calls in a row the rest of the list is skipped instead of retried. */
export const maxConsecutiveCallErrors = 3;

export const sourcePairSchema = z
  .object({
    /** A top-level manifest key, or the exact title of a root source of the library. */
    left: z.string().trim().min(1).max(1000),
    right: z.string().trim().min(1).max(1000),
    label: z.string().trim().min(1).max(200).optional()
  })
  .strict();
export type SourcePair = z.infer<typeof sourcePairSchema>;
export const sourcePairsFileSchema = z.array(sourcePairSchema).min(1).max(maxSourcePairs);
/**
 * How the pairs are asked about: `pair`, one call per pair; `root`, one call per root for all its
 * listed pairs, as the matcher judges a root (D21; the C2 microbenchmark). The file is the list
 * itself (`pair`) or `{"grouping": "pair"|"root", "pairs": [...]}`.
 */
export type SourcePairGrouping = "pair" | "root";
const sourcePairsDocumentSchema = z
  .object({ grouping: z.enum(["pair", "root"]), pairs: sourcePairsFileSchema })
  .strict();

export interface SourcePairsFile {
  path: string;
  sha256: string;
  pairs: SourcePair[];
  /** Absent in a file read before grouping existed: one call per pair. */
  grouping?: SourcePairGrouping;
}

/** Reads and validates the pair list; a malformed file stops the run before it changes anything. */
export async function readSourcePairsFile(path: string): Promise<SourcePairsFile> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(
      `MEMORA_GOLDEN_SOURCE_PAIRS cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`MEMORA_GOLDEN_SOURCE_PAIRS ${path} is not valid JSON`, { cause: error });
  }
  const parsed = Array.isArray(json)
    ? sourcePairsFileSchema.safeParse(json)
    : sourcePairsDocumentSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(
      `MEMORA_GOLDEN_SOURCE_PAIRS ${path} must be a JSON list of {left, right, label?} ` +
        `(1 to ${maxSourcePairs} pairs), or {grouping, pairs}: ${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ")}`
    );
  const document = Array.isArray(parsed.data)
    ? { grouping: "pair" as const, pairs: parsed.data }
    : parsed.data;
  return {
    path,
    sha256: createHash("sha256").update(text).digest("hex"),
    pairs: document.pairs,
    grouping: document.grouping
  };
}

export interface SourcePairRoot {
  id: string;
  title: string;
  type: string;
}

type Query = Pick<PgPool, "query">;

/** The root sources of the library (read-only). */
export async function listLibraryRoots(pool: Query): Promise<SourcePairRoot[]> {
  const result = await pool.query<SourcePairRoot>(
    `select id, title, type::text as type from source_items
     where parent_source_item_id is null order by created_at, id`
  );
  return result.rows.map((row) => ({
    id: String(row.id),
    title: String(row.title),
    type: String(row.type)
  }));
}

const normalize = (text: string) => text.normalize("NFC").trim();
const shorten = (text: string, max = 70) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

/** The top-level manifest keys whose title is not the title of any root source of the library. */
export function missingManifestRoots(
  manifest: Pick<GoldenManifest, "sources">,
  roots: readonly Pick<SourcePairRoot, "title">[]
): string[] {
  const titles = new Set(roots.map((root) => normalize(root.title)));
  return manifest.sources
    .filter((source) => !titles.has(normalize(source.title)))
    .map((source) => source.key);
}

export type SourcePairResolution =
  { ok: true; root: SourcePairRoot; by: "manifestKey" | "title" } | { ok: false; reason: string };

/**
 * Finds the root source an identifier names: a top-level manifest key (resolved through the
 * manifest entry's title) or, when no key matches, an exact title. A key wins over a title. Two
 * roots with one title are ambiguous and refused.
 */
export function resolveSourcePairRoot(
  identifier: string,
  manifest: Pick<GoldenManifest, "sources">,
  roots: readonly SourcePairRoot[]
): SourcePairResolution {
  const wanted = normalize(identifier);
  const entry = manifest.sources.find((source) => source.key === wanted);
  if (!entry) {
    const book = manifest.sources.find(
      (source) =>
        source.kind === "container" && source.children.some((child) => child.key === wanted)
    );
    if (book)
      return {
        ok: false,
        reason: `"${wanted}" is a chapter of "${book.key}", not a root source; name the book`
      };
  }
  const title = normalize(entry ? entry.title : wanted);
  const matches = roots.filter((root) => normalize(root.title) === title);
  if (matches.length === 1)
    return { ok: true, root: matches[0]!, by: entry ? "manifestKey" : "title" };
  const subject = entry
    ? `manifest key "${wanted}" (title "${shorten(title)}")`
    : `title "${shorten(title)}"`;
  return {
    ok: false,
    reason: matches.length
      ? `${matches.length} root sources share ${subject}`
      : `no root source of the library matches ${subject}`
  };
}

/** The three read queries a verdict needs; nothing of the repository's write paths is reachable. */
export type SourcePairReader = Pick<
  ReturnType<typeof createSourceRelationRepository>,
  "pairNotes" | "pairChunks" | "existing"
>;

export function createSourcePairReader(pool: Query): SourcePairReader {
  const repository = createSourceRelationRepository(pool as PgPool);
  return {
    pairNotes: (left, right, limit) => repository.pairNotes(left, right, limit),
    pairChunks: (left, right, noteChunkIds, limit) =>
      repository.pairChunks(left, right, noteChunkIds, limit),
    existing: (left, right) => repository.existing(left, right)
  };
}

export type SourcePairStatus =
  "judged" | "invalid_output" | "unresolved" | "same_root" | "no_evidence" | "error" | "skipped";

type Side = "left" | "right";
export type SourcePairItemOutcome = Exclude<SourceDecisionOutcome, "persisted"> | "kept";

export interface SourcePairAttemptReport {
  /** 0 for the first answer, 1 for the repair. */
  attempt: 0 | 1;
  /** Wall time of the call as the runner saw it, queue wait included. */
  wallMs: number;
  /** Provider time of the call as the adapter reported it. */
  durationMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Normalized provider usage (reasoning tokens where the provider reports them). */
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
  answered: boolean;
  invalidItems: number;
  sameRoot: boolean;
  items: number;
}

export interface SourcePairItemReport {
  attempt: 0 | 1;
  /** Prompt aliases of the two works (sources, not roots: a book answers with its chapters). */
  from: string;
  to: string;
  fromRoot: Side;
  toRoot: Side;
  type: string;
  /** Raw integer scores from 0 to 100, as answered. */
  importance: number;
  confidence: number;
  /** Evidence passage aliases (c1..) of each side, as the decider cited them. */
  fromChunks: string[];
  toChunks: string[];
  passesFloors: boolean;
  /** `kept`: the matcher would persist it under the floors; nothing is persisted here. */
  outcome: SourcePairItemOutcome;
}

export interface SourcePairReport {
  index: number;
  label: string | null;
  left: string;
  right: string;
  status: SourcePairStatus;
  reason?: string;
  roots?: Record<Side, SourcePairRoot & { by: "manifestKey" | "title" }>;
  /**
   * Root grouping: the call this pair shared with the other pairs of its root. Only the lead pair
   * (the group's first) carries the calls, their usage and the request, so totals count each once.
   */
  batch?: { index: number; root: string; pairs: number; lead: boolean };
  request?: {
    allowance: number;
    maxOutputTokens: number;
    promptCharacters: number;
    noteRelations: number;
    sources: Array<{
      alias: string;
      rootAlias: string;
      /** `other`: a partner of the group's root in another of the call's pairs. */
      root: Side | "other";
      sourceItemId: string;
      title: string;
    }>;
    chunks: Array<{
      alias: string;
      source: string;
      chunkId: string;
      chunkIndex: number;
      characters: number;
      contentHash: string;
    }>;
  };
  attempts: SourcePairAttemptReport[];
  items: SourcePairItemReport[];
  /** Relations the matcher would keep under the floors (merged by endpoints and type). */
  kept: Array<{
    type: string;
    from: string;
    to: string;
    fromRoot: Side;
    importance: number;
    confidence: number;
    evidencePairs: number;
  }>;
  verdict: "related" | "not_related" | null;
  proposals: number;
  /** Relations already saved between the two works, which never reach the prompt. */
  existingRelations: Array<{ type: string; status: string; fromRoot: Side }>;
  wallMs: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

export type SourcePairRunStatus =
  "completed" | "completed_with_failures" | "diverged" | "token_limit";

export interface SourcePairVerdictsReport {
  format: typeof reportFormat;
  version: 1;
  /** `running` while pairs remain; the file is rewritten after every pair. */
  state: "running" | "finished";
  status: SourcePairRunStatus | null;
  stopReason?: string;
  mode: "verdict_only" | "after_batch";
  contract: string;
  startedAt: string;
  finishedAt: string | null;
  manifest: { name: string };
  pairsFile: { path: string; sha256: string; pairs: number };
  grouping: SourcePairGrouping;
  settings: SourceRelationSettings;
  contentLanguage: string;
  cassette: Pick<AiCassetteStats, "mode" | "directory" | "served" | "recorded" | "misses"> | null;
  totals: Record<string, number>;
  pairs: SourcePairReport[];
}

export interface SourcePairVerdictsInput {
  mode: SourcePairVerdictsReport["mode"];
  file: SourcePairsFile;
  manifest: Pick<GoldenManifest, "name" | "sources">;
  roots: readonly SourcePairRoot[];
  reader: SourcePairReader;
  ai: Pick<AiService, "runDefaultTask">;
  settings: SourceRelationSettings;
  contentLanguage: string;
  cassette: { stats(): AiCassetteStats } | null;
  now?: () => Date;
  /** Called with the report after every pair (state `running`) and at the end (state `finished`). */
  onUpdate?: (report: SourcePairVerdictsReport) => void | Promise<void>;
  onPair?: (pair: SourcePairReport, total: number) => void;
}

/** The measurements of a pair that no call was made for. */
const emptyOutcome = () => summarize([], [], []);

function describeRoot(side: { root: SourcePairRoot; by: "manifestKey" | "title" }) {
  return { id: side.root.id, title: side.root.title, type: side.root.type, by: side.by };
}

interface Judge {
  reader: SourcePairReader;
  ai: Pick<AiService, "runDefaultTask">;
  settings: SourceRelationSettings;
  contentLanguage: string;
}

/**
 * Asks the decider about one pair of works. The request is the matcher's: the pair's uncited note
 * relations, the evidence passages, the prompt, the call context and the output budget are built by
 * the matcher's own functions; a first answer with malformed items and room for more asks one repair.
 * Verdicts are read with the production parser and checked against the floors without persisting.
 */
async function judgePair(
  judge: Judge,
  base: Pick<SourcePairReport, "index" | "label" | "left" | "right">,
  sides: Record<Side, { root: SourcePairRoot; by: "manifestKey" | "title" }>
): Promise<SourcePairReport> {
  const { reader, ai, settings, contentLanguage } = judge;
  const roots = { left: describeRoot(sides.left), right: describeRoot(sides.right) };
  const notes: SourceRelationNote[] = await reader.pairNotes(
    sides.left.root.id,
    sides.right.root.id,
    relationsConfig.sourceJudge.noteRelationsPerPair
  );
  const context = await sourcePairContext(
    reader,
    sides.left.root.id,
    sides.right.root.id,
    notes,
    settings
  );
  if (!context)
    return {
      ...base,
      ...emptyOutcome(),
      status: "no_evidence",
      reason: "fewer than two evidence passages: the matcher skips such a pair",
      roots
    };
  const { chunks } = context;
  const { sources, roots: rootOrder } = aliasOrder(chunks);
  const sourceAlias = (id: string) => `s${sources.indexOf(id) + 1}`;
  const chunkAlias = (id: string) => `c${chunks.findIndex((chunk) => chunk.id === id) + 1}`;
  const sideOf = (rootId: string): Side => (rootId === sides.left.root.id ? "left" : "right");
  const sideOfSource = (id: string) =>
    sideOf(chunks.find((chunk) => chunk.sourceItemId === id)?.rootId ?? "");
  const allowance = sourceDecisionAllowance(settings);
  const maxOutputTokens = sourceDecisionMaxOutputTokens(settings, allowance);
  const prompt = sourceDecisionPrompt(
    context,
    allowance,
    settings.includeWeakTypes,
    settings.summaryMaxCharacters
  );
  const request: NonNullable<SourcePairReport["request"]> = {
    allowance,
    maxOutputTokens,
    promptCharacters: prompt.length,
    noteRelations: context.notes.length,
    sources: sources.map((id) => {
      const first = chunks.find((chunk) => chunk.sourceItemId === id)!;
      return {
        alias: sourceAlias(id),
        rootAlias: `w${rootOrder.indexOf(first.rootId) + 1}`,
        root: sideOf(first.rootId),
        sourceItemId: id,
        title: first.title
      };
    }),
    chunks: chunks.map((chunk, index) => ({
      alias: `c${index + 1}`,
      source: sourceAlias(chunk.sourceItemId),
      chunkId: chunk.id,
      chunkIndex: chunk.chunkIndex,
      characters: chunk.content.length,
      contentHash: chunk.contentHash
    }))
  };

  const attempts: SourcePairAttemptReport[] = [];
  const answers: SourceDecisionParse[] = [];
  let validationFeedback = renderPrompt("sources.validation.default");
  const sourceItemIds = [
    ...new Set([sides.left.root.id, sides.right.root.id, ...chunks.map((c) => c.sourceItemId)])
  ];
  const failed = (error: unknown): SourcePairReport => ({
    ...base,
    ...summarize(attempts, [], []),
    status: "error",
    reason: error instanceof Error ? error.message : String(error),
    roots,
    request
  });
  for (const attempt of [0, 1] as const) {
    const input = joinPrompts(
      prompt,
      attempt
        ? renderPrompt("sources.decide.repair", { validation_errors: validationFeedback })
        : ""
    );
    const started = Date.now();
    let execution: Awaited<ReturnType<typeof ai.runDefaultTask>>;
    try {
      execution = await ai.runDefaultTask(
        "reranking",
        input,
        {
          operation: sourceMatchingOperation,
          stage: "sourceMatching",
          workloadClass: "decide",
          priority: "P2",
          // A DEV measurement the developer starts: audited, never refused by the budget.
          budgetClass: "user",
          origin: "golden_source_pairs",
          contentLanguage,
          promptVersion: sourceRelationPromptVersion,
          sourceItemIds,
          attempt,
          // The same audit as the source judge's own calls: the second one is a repair.
          isRepair: attempt > 0
        },
        undefined,
        { maxOutputTokens }
      );
    } catch (error) {
      return failed(error);
    }
    if (!execution) return failed(new Error("errors.ai.noCompatibleModel"));
    const parsed = parseSourceDecision(execution.output, context, attempt);
    answers.push(parsed);
    attempts.push({
      attempt,
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
      answered: parsed.answered,
      invalidItems: parsed.invalid,
      sameRoot: parsed.sameRoot,
      items: parsed.items.length
    });
    // A clean answer, or one already holding all the relations the pair may keep, is final.
    if (
      (parsed.answered && parsed.invalid === 0) ||
      distinctSourceVerdicts(answers.flatMap((answer) => answer.items)) >= allowance
    )
      break;
    if (parsed.sameRoot) validationFeedback = renderPrompt("sources.validation.same_root");
  }

  const verdicts = answers.flatMap((answer) => answer.items);
  const last = answers.at(-1)!;
  // The floors and the allowance, as the matcher applies them. Saved relations are not consulted:
  // the report shows what the decider said, not what the library already holds.
  const written = sourceRelationWrites(
    verdicts,
    { chunks, notes: context.notes, existing: [] },
    settings,
    allowance
  );
  const items = verdicts.map((verdict, index): SourcePairItemReport => {
    const outcome = written.records[index]!.outcome;
    return {
      attempt: verdict.attempt,
      from: sourceAlias(verdict.sourceItemId),
      to: sourceAlias(verdict.targetSourceItemId),
      fromRoot: sideOfSource(verdict.sourceItemId),
      toRoot: sideOfSource(verdict.targetSourceItemId),
      type: verdict.type,
      importance: verdict.importance,
      confidence: verdict.confidence,
      fromChunks: verdict.sourceChunks.map((chunk) => chunkAlias(chunk.id)),
      toChunks: verdict.targetChunks.map((chunk) => chunkAlias(chunk.id)),
      passesFloors: sourceDecisionPassesFloors(verdict, settings),
      outcome: outcome === "persisted" ? "kept" : outcome
    };
  });
  const kept = written.relations.map((relation) => ({
    type: relation.relationType,
    from: sourceAlias(relation.sourceItemId),
    to: sourceAlias(relation.targetSourceItemId),
    fromRoot: sideOfSource(relation.sourceItemId),
    importance: Math.round(relation.importance * 100),
    confidence: Math.round(relation.confidence * 100),
    evidencePairs: relation.evidence.length
  }));
  const settled = verdicts.length > 0 || (last.answered && last.invalid === 0);
  return {
    ...base,
    ...summarize(attempts, items, kept),
    status: settled ? "judged" : "invalid_output",
    ...(settled
      ? {}
      : { reason: "no valid item and no clean answer: the matcher fails such a pair" }),
    roots,
    request,
    verdict: settled ? (kept.length ? "related" : "not_related") : null,
    proposals: written.proposals,
    existingRelations: context.existing.map((relation) => ({
      type: relation.relationType,
      status: relation.status,
      fromRoot: sideOfSource(relation.sourceItemId)
    }))
  };
}

type Sides = Record<Side, { root: SourcePairRoot; by: "manifestKey" | "title" }>;
interface JudgeablePair {
  base: Pick<SourcePairReport, "index" | "label" | "left" | "right">;
  sides: Sides;
}

/**
 * Root grouping (D21's microbenchmark): a greedy cover of the pairs by their roots. The root in the
 * most pairs left takes all of them (ties: the root the file names first), until none is left; each
 * group is asked about in one call, as the matcher asks about a root and its partners together.
 */
export function groupSourcePairsByRoot<T extends { sides: Record<Side, { root: { id: string } }> }>(
  pairs: readonly T[]
): Array<{ root: string; members: T[] }> {
  const named = new Map<string, number>();
  for (const pair of pairs)
    for (const side of ["left", "right"] as const)
      if (!named.has(pair.sides[side].root.id)) named.set(pair.sides[side].root.id, named.size);
  const groups: Array<{ root: string; members: T[] }> = [];
  let left = [...pairs];
  while (left.length) {
    const counts = new Map<string, number>();
    for (const pair of left)
      for (const side of ["left", "right"] as const)
        counts.set(pair.sides[side].root.id, (counts.get(pair.sides[side].root.id) ?? 0) + 1);
    const [root] = [...counts.entries()].toSorted(
      (a, b) => b[1] - a[1] || named.get(a[0])! - named.get(b[0])!
    )[0]!;
    const members = left.filter(
      (pair) => pair.sides.left.root.id === root || pair.sides.right.root.id === root
    );
    groups.push({ root, members });
    left = left.filter((pair) => !members.includes(pair));
  }
  return groups;
}

/**
 * Asks the decider about one root's pairs in one call, with the matcher's batched judge
 * (`askSourceJudge`: the union of each pair's own evidence, at most one repair for the pairs left
 * open). Each pair is reported apart, its items read with the production parser and checked against
 * the floors without persisting; the group's first judged pair carries the calls.
 */
async function judgeGroup(
  judge: Judge,
  root: string,
  members: readonly JudgeablePair[],
  groupIndex: number
): Promise<SourcePairReport[]> {
  const { reader, ai, settings, contentLanguage } = judge;
  const allowance = sourceDecisionAllowance(settings);
  const partnerOf = ({ sides }: JudgeablePair) =>
    sides.left.root.id === root ? sides.right.root.id : sides.left.root.id;
  const rootsOf = ({ sides }: JudgeablePair) => ({
    left: describeRoot(sides.left),
    right: describeRoot(sides.right)
  });
  const rootTitle =
    members[0]!.sides.left.root.id === root
      ? members[0]!.sides.left.root.title
      : members[0]!.sides.right.root.title;
  const reports = new Map<number, SourcePairReport>();
  const pairs: Array<SourceJudgePair & { member: JudgeablePair }> = [];
  for (const member of members) {
    try {
      const notes: SourceRelationNote[] = await reader.pairNotes(
        root,
        partnerOf(member),
        relationsConfig.sourceJudge.noteRelationsPerPair
      );
      const context = await sourcePairContext(reader, root, partnerOf(member), notes, settings);
      if (context)
        pairs.push({
          key: String(member.base.index),
          candidate: partnerOf(member),
          context,
          member
        });
      else
        reports.set(member.base.index, {
          ...member.base,
          ...emptyOutcome(),
          status: "no_evidence",
          reason: "fewer than two evidence passages: the matcher skips such a pair",
          roots: rootsOf(member)
        });
    } catch (error) {
      // Reading the evidence failed: the library, not the decider.
      reports.set(member.base.index, {
        ...member.base,
        ...emptyOutcome(),
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
        roots: rootsOf(member)
      });
    }
  }
  const attempts: SourcePairAttemptReport[] = [];
  const requests: Array<Required<SourceDecisionRequest>> = [];
  let failure: unknown = null;
  let result: Awaited<ReturnType<typeof askSourceJudge>> | null = null;
  if (pairs.length)
    try {
      result = await askSourceJudge({
        root,
        pairs,
        settings,
        call: async (call) => {
          const started = Date.now();
          const execution = await ai.runDefaultTask(
            "reranking",
            call.prompt,
            {
              operation: sourceMatchingOperation,
              stage: "sourceMatching",
              workloadClass: "decide",
              priority: "P2",
              origin: "golden_source_pairs",
              contentLanguage,
              promptVersion: sourceRelationPromptVersion,
              sourceItemIds: [
                ...new Set([
                  root,
                  ...call.pairs.map((pair) => pair.candidate),
                  ...call.request.chunks.map((chunk) => chunk.sourceItemId)
                ])
              ],
              attempt: call.attempt,
              isRepair: call.attempt > 0
            },
            undefined,
            { maxOutputTokens: call.maxOutputTokens }
          );
          if (!execution) throw new Error("errors.ai.noCompatibleModel");
          const parsed = parseSourceDecision(execution.output, call.request, call.attempt);
          requests.push(call.request);
          attempts.push({
            attempt: call.attempt,
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
            answered: parsed.answered,
            invalidItems: parsed.invalid,
            sameRoot: parsed.sameRoot,
            items: parsed.items.length
          });
          return execution;
        }
      });
    } catch (error) {
      failure = error;
    }
  const aliases = (request: Required<SourceDecisionRequest>) => {
    const { sources, roots } = aliasOrder(request.chunks);
    return {
      source: (id: string) => `s${sources.indexOf(id) + 1}`,
      root: (id: string) => `w${roots.indexOf(id) + 1}`,
      chunk: (id: string) => `c${request.chunks.findIndex((chunk) => chunk.id === id) + 1}`
    };
  };
  for (const [position, pair] of pairs.entries()) {
    const { member } = pair;
    const lead = position === 0;
    const sideOfRoot = (id: string): Side | "other" =>
      id === member.sides.left.root.id
        ? "left"
        : id === member.sides.right.root.id
          ? "right"
          : "other";
    const sideOfSource = (id: string): Side =>
      sideOfRoot(pair.context.chunks.find((chunk) => chunk.sourceItemId === id)?.rootId ?? "") ===
      "left"
        ? "left"
        : "right";
    const first = requests[0];
    const request: SourcePairReport["request"] =
      lead && first
        ? {
            allowance,
            maxOutputTokens: sourceDecisionMaxOutputTokens(settings, allowance * pairs.length),
            promptCharacters: sourceDecisionPrompt(
              first,
              allowance,
              settings.includeWeakTypes,
              settings.summaryMaxCharacters
            ).length,
            noteRelations: first.notes.length,
            sources: aliasOrder(first.chunks).sources.map((id) => {
              const chunk = first.chunks.find((candidate) => candidate.sourceItemId === id)!;
              return {
                alias: aliases(first).source(id),
                rootAlias: aliases(first).root(chunk.rootId),
                root: sideOfRoot(chunk.rootId),
                sourceItemId: id,
                title: chunk.title
              };
            }),
            chunks: first.chunks.map((chunk, index) => ({
              alias: `c${index + 1}`,
              source: aliases(first).source(chunk.sourceItemId),
              chunkId: chunk.id,
              chunkIndex: chunk.chunkIndex,
              characters: chunk.content.length,
              contentHash: chunk.contentHash
            }))
          }
        : undefined;
    const shared = {
      ...member.base,
      roots: rootsOf(member),
      batch: { index: groupIndex, root: rootTitle, pairs: pairs.length, lead },
      ...(request ? { request } : {})
    };
    const answer = result?.answers.get(pair.key);
    if (failure || !answer) {
      reports.set(member.base.index, {
        ...shared,
        ...summarize(lead ? attempts : [], [], []),
        status: "error",
        reason: failure instanceof Error ? failure.message : String(failure ?? "no answer")
      });
      continue;
    }
    const written = sourceRelationWrites(
      answer.items,
      { chunks: pair.context.chunks, notes: pair.context.notes, existing: [] },
      settings,
      allowance
    );
    const items = answer.items.map((verdict, index): SourcePairItemReport => {
      const alias = aliases(requests[verdict.attempt] ?? requests.at(-1)!);
      const outcome = written.records[index]!.outcome;
      return {
        attempt: verdict.attempt,
        from: alias.source(verdict.sourceItemId),
        to: alias.source(verdict.targetSourceItemId),
        fromRoot: sideOfSource(verdict.sourceItemId),
        toRoot: sideOfSource(verdict.targetSourceItemId),
        type: verdict.type,
        importance: verdict.importance,
        confidence: verdict.confidence,
        fromChunks: verdict.sourceChunks.map((chunk) => alias.chunk(chunk.id)),
        toChunks: verdict.targetChunks.map((chunk) => alias.chunk(chunk.id)),
        passesFloors: sourceDecisionPassesFloors(verdict, settings),
        outcome: outcome === "persisted" ? "kept" : outcome
      };
    });
    const finalAlias = aliases(requests[answer.calls.at(-1)!]!);
    const kept = written.relations.map((relation) => ({
      type: relation.relationType,
      from: finalAlias.source(relation.sourceItemId),
      to: finalAlias.source(relation.targetSourceItemId),
      fromRoot: sideOfSource(relation.sourceItemId),
      importance: Math.round(relation.importance * 100),
      confidence: Math.round(relation.confidence * 100),
      evidencePairs: relation.evidence.length
    }));
    const settled = answer.items.length > 0 || answer.clean;
    reports.set(member.base.index, {
      ...shared,
      ...summarize(lead ? attempts : [], items, kept),
      status: settled ? "judged" : "invalid_output",
      ...(settled
        ? {}
        : { reason: "no valid item and no clean answer: the matcher fails such a pair" }),
      verdict: settled ? (kept.length ? "related" : "not_related") : null,
      proposals: written.proposals,
      existingRelations: pair.context.existing.map((relation) => ({
        type: relation.relationType,
        status: relation.status,
        fromRoot: sideOfSource(relation.sourceItemId)
      }))
    });
  }
  return members.map((member) => ({
    ...reports.get(member.base.index)!,
    batch: {
      index: groupIndex,
      root: rootTitle,
      pairs: pairs.length,
      lead: pairs[0]?.member === member
    }
  }));
}

function summarize(
  attempts: SourcePairAttemptReport[],
  items: SourcePairItemReport[],
  kept: SourcePairReport["kept"]
) {
  return {
    attempts,
    items,
    kept,
    verdict: null as SourcePairReport["verdict"],
    proposals: 0,
    existingRelations: [] as SourcePairReport["existingRelations"],
    wallMs: attempts.reduce((sum, attempt) => sum + attempt.wallMs, 0),
    durationMs: attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0),
    inputTokens: attempts.reduce((sum, attempt) => sum + (attempt.inputTokens ?? 0), 0),
    outputTokens: attempts.reduce((sum, attempt) => sum + (attempt.outputTokens ?? 0), 0)
  };
}

function totals(pairs: readonly SourcePairReport[]): Record<string, number> {
  const count = (status: SourcePairStatus) => pairs.filter((pair) => pair.status === status).length;
  const attempts = pairs.flatMap((pair) => pair.attempts);
  const items = pairs.flatMap((pair) => pair.items);
  const judged = pairs.filter((pair) => pair.status === "judged");
  return {
    pairs: pairs.length,
    judged: judged.length,
    related: judged.filter((pair) => pair.verdict === "related").length,
    notRelated: judged.filter((pair) => pair.verdict === "not_related").length,
    invalidOutput: count("invalid_output"),
    unresolved: count("unresolved"),
    sameRoot: count("same_root"),
    noEvidence: count("no_evidence"),
    errors: count("error"),
    skipped: count("skipped"),
    calls: attempts.length,
    repairs: attempts.filter((attempt) => attempt.attempt === 1).length,
    replayedCalls: attempts.filter((attempt) => attempt.replayed).length,
    inputTokens: pairs.reduce((sum, pair) => sum + pair.inputTokens, 0),
    outputTokens: pairs.reduce((sum, pair) => sum + pair.outputTokens, 0),
    providerMs: pairs.reduce((sum, pair) => sum + pair.durationMs, 0),
    wallMs: pairs.reduce((sum, pair) => sum + pair.wallMs, 0),
    items: items.length,
    keptItems: items.filter((item) => item.outcome === "kept").length,
    belowFloorItems: items.filter((item) => item.outcome === "below_floors").length,
    overAllowanceItems: items.filter((item) => item.outcome === "over_allowance").length,
    invalidItems: attempts.reduce((sum, attempt) => sum + attempt.invalidItems, 0)
  };
}

/**
 * Resolves the list against the library, then asks the decider about each resolvable pair, one at a
 * time. Unresolved pairs and same-root pairs are reported, never fatal. A cassette miss in replay,
 * the live token cap, or repeated failed calls stop the calls; the pairs left are reported as skipped.
 * Never rejects for a pair; persists nothing.
 */
export async function runSourcePairVerdicts(
  input: SourcePairVerdictsInput
): Promise<SourcePairVerdictsReport> {
  const now = input.now ?? (() => new Date());
  const judge: Judge = {
    reader: input.reader,
    ai: input.ai,
    settings: input.settings,
    contentLanguage: input.contentLanguage
  };
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
  const report: SourcePairVerdictsReport = {
    format: reportFormat,
    version: 1,
    state: "running",
    status: null,
    mode: input.mode,
    contract: sourceRelationPromptVersion,
    startedAt: now().toISOString(),
    finishedAt: null,
    manifest: { name: input.manifest.name },
    pairsFile: { path: input.file.path, sha256: input.file.sha256, pairs: input.file.pairs.length },
    grouping: input.file.grouping ?? "pair",
    settings: input.settings,
    contentLanguage: input.contentLanguage,
    cassette: cassetteStats(),
    totals: {},
    pairs: []
  };
  const publish = async () => {
    report.totals = totals(report.pairs);
    report.cassette = cassetteStats();
    await input.onUpdate?.(report);
  };
  let stopReason: { status: SourcePairRunStatus; reason: string } | null = null;
  let consecutiveErrors = 0;
  // Every pair is resolved first: an unresolved or same-root pair is reported as it is, the others
  // are asked about one call per pair, or one call per root under root grouping.
  const fixed = new Map<number, SourcePairReport>();
  const judgeable: JudgeablePair[] = [];
  for (const [index, pair] of input.file.pairs.entries()) {
    const base = { index, label: pair.label ?? null, left: pair.left, right: pair.right };
    const left = resolveSourcePairRoot(pair.left, input.manifest, input.roots);
    const right = resolveSourcePairRoot(pair.right, input.manifest, input.roots);
    if (!left.ok || !right.ok)
      fixed.set(index, {
        ...base,
        ...emptyOutcome(),
        status: "unresolved",
        reason: [
          !left.ok ? `left: ${left.reason}` : null,
          !right.ok ? `right: ${right.reason}` : null
        ]
          .filter(Boolean)
          .join("; ")
      });
    else if (left.root.id === right.root.id)
      fixed.set(index, {
        ...base,
        ...emptyOutcome(),
        status: "same_root",
        reason:
          "both identifiers name the same root source: a source relation never joins a work to itself",
        roots: { left: describeRoot(left), right: describeRoot(right) }
      });
    else judgeable.push({ base, sides: { left, right } });
  }
  const groups: Array<{ root: string | null; members: JudgeablePair[] }> =
    input.file.grouping === "root"
      ? groupSourcePairsByRoot(judgeable)
      : judgeable.map((pair) => ({ root: null, members: [pair] }));
  const steps = [
    ...[...fixed.entries()].map(([index, entry]) => ({ first: index, entry, group: null })),
    ...groups.map((group) => ({ first: group.members[0]!.base.index, entry: null, group }))
  ].toSorted((a, b) => a.first - b.first);
  for (const step of steps) {
    let entries: SourcePairReport[];
    if (step.entry) entries = [step.entry];
    else if (stopReason) {
      const reason = stopReason.reason;
      entries = step.group!.members.map(({ base, sides }) => ({
        ...base,
        ...emptyOutcome(),
        status: "skipped" as const,
        reason,
        roots: { left: describeRoot(sides.left), right: describeRoot(sides.right) }
      }));
    } else {
      const group = step.group!;
      const before = input.cassette?.stats();
      if (group.root === null) {
        const { base, sides } = group.members[0]!;
        try {
          entries = [await judgePair(judge, base, sides)];
        } catch (error) {
          // Reading the evidence failed: the library, not the decider.
          entries = [
            {
              ...base,
              ...emptyOutcome(),
              status: "error",
              reason: error instanceof Error ? error.message : String(error),
              roots: { left: describeRoot(sides.left), right: describeRoot(sides.right) }
            }
          ];
        }
      } else entries = await judgeGroup(judge, group.root, group.members, groups.indexOf(group));
      consecutiveErrors = entries.some((entry) => entry.status === "error")
        ? consecutiveErrors + 1
        : 0;
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
    for (const entry of entries) {
      report.pairs.push(entry);
      input.onPair?.(entry, input.file.pairs.length);
    }
    // Root grouping answers pairs out of file order; the report keeps the file's order.
    report.pairs.sort((a, b) => a.index - b.index);
    await publish();
  }
  const failures = report.pairs.some(
    (pair) => pair.status === "error" || pair.status === "invalid_output"
  );
  report.status = stopReason?.status ?? (failures ? "completed_with_failures" : "completed");
  if (stopReason) report.stopReason = stopReason.reason;
  report.state = "finished";
  report.finishedAt = now().toISOString();
  await publish();
  return report;
}

/** Writes the report next to the run's summary, atomically, so a crash never leaves half a file. */
export async function writeSourcePairVerdicts(
  directory: string,
  report: SourcePairVerdictsReport
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const path = join(directory, sourcePairVerdictsFile);
  const temporary = `${path}.partial`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await rename(temporary, path);
  return path;
}
