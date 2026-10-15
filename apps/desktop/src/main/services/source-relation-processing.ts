import { compareContent } from "./content-order.js";
import { renderPrompt, joinPrompts, changedPromptIdentity } from "./prompt-runtime.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomicNoteRelationTypeSchema,
  SourceRelationCoverageSchema,
  SourceRelationSettingsSchema,
  sourceDecisionLimits,
  sourceDecisionPassesFloors,
  symmetricSourceRelationTypes,
  type SourceDecisionItem,
  type SourceRelationCoverage,
  type SourceRelationSettings
} from "@app/domain";
import {
  createAiConfigRepository,
  createSourceRelationRepository,
  type PgPool,
  type SourceRelationCandidate,
  type SourceRelationChunk,
  type SourceRelationNote,
  type SourceRelationWrite
} from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";
import { aiTaskBehaviorDefaults } from "./ai-task-parameters.js";
import { parseJsonOutput } from "./knowledge-processing.js";

/**
 * Compact, score-only source verdicts (docs/plan.md decision 17): the decider answers at most two
 * `[from, to, type, importance, confidence, [from chunks], [to chunks]]` items per pair of works and
 * writes no prose. Explanations are written when the owner opens a relation.
 */
export const sourceRelationPromptVersion = "source-relations-v5";
const sourceMatchingOperation = "source_relation_matching";
/** Every catalog prompt the source decision is composed of: its identity is in the run fingerprint. */
const sourceDecisionPromptIds = [
  "sources.decide",
  "sources.decide.repair",
  "sources.validation.default",
  "sources.validation.same_root"
] as const;

/** One verdict item; anything else (more members, prose, fractional scores) is malformed. */
const decisionItemSchema = z.tuple([
  z.string(),
  z.string(),
  AtomicNoteRelationTypeSchema,
  z.number().int().min(0).max(sourceDecisionLimits.maxScore),
  z.number().int().min(0).max(sourceDecisionLimits.maxScore),
  z.array(z.string()).min(1).max(sourceDecisionLimits.maxChunksPerSide),
  z.array(z.string()).min(1).max(sourceDecisionLimits.maxChunksPerSide)
]);
// The envelope has no length cap: the answer is bounded by the output token limit, and items beyond
// the allowance are dropped after ranking, so a surplus item can never discard the valid ones.
const decisionEnvelopeSchema = z.object({ relations: z.array(z.unknown()) });

const stateSchema = z.object({
  settings: SourceRelationSettingsSchema,
  configuration: z.string(),
  pairs: z.array(z.string()),
  completed: z.array(z.string()),
  inputTokens: z.number().nonnegative(),
  proposals: z.number().nonnegative(),
  persistedCount: z.number().nonnegative(),
  attempts: z.record(z.string(), z.number()),
  /** True only when a pair could not be completed (`coverage.budgetExhausted`); older runs set it for any limit. */
  partial: z.boolean(),
  /** Written when the root finishes; absent on runs that finished before coverage was recorded. */
  coverage: SourceRelationCoverageSchema.optional(),
  finished: z.boolean(),
  totalPairs: z.number().int().nonnegative().default(0)
});
type ExistingRelation = {
  id: string;
  sourceItemId: string;
  targetSourceItemId: string;
  relationType: string;
  sourceIdea: string | null;
  targetIdea: string | null;
  status: string;
};
export interface SourceRelationContext {
  chunks: SourceRelationChunk[];
  notes: SourceRelationNote[];
  /** Saved relations between the two works: they never reach the prompt. */
  existing: ExistingRelation[];
}
/** Equal scores break on the work title: candidate IDs are random on every import. */
const compareCandidateIdentity = (a: SourceRelationCandidate, b: SourceRelationCandidate) =>
  compareContent(a.title, b.title) || a.id.localeCompare(b.id);

export function rankSourceCandidates(
  candidates: SourceRelationCandidate[],
  limit: number,
  reciprocalRankConstant = 60
): SourceRelationCandidate[] {
  const ranks = new Map<string, number>();
  for (const signal of ["textScore", "vectorScore", "graphScore", "noteScore"] as const) {
    candidates
      .filter((candidate) => candidate[signal] > 0)
      .toSorted((a, b) => b[signal] - a[signal] || compareCandidateIdentity(a, b))
      .forEach((candidate, index) =>
        ranks.set(
          candidate.id,
          (ranks.get(candidate.id) ?? 0) + 1 / (reciprocalRankConstant + 1 + index)
        )
      );
  }
  const ranked = candidates.toSorted(
    (a, b) => (ranks.get(b.id) ?? 0) - (ranks.get(a.id) ?? 0) || compareCandidateIdentity(a, b)
  );
  // Reserve discovery capacity for sources without note links; notes must not monopolize the shortlist.
  const discovery = ranked.filter((candidate) => candidate.noteScore === 0),
    notes = ranked.filter((candidate) => candidate.noteScore > 0);
  const selected: SourceRelationCandidate[] = [];
  while (selected.length < limit && (discovery.length || notes.length)) {
    const next =
      selected.length % 2 === 0
        ? (notes.shift() ?? discovery.shift())
        : (discovery.shift() ?? notes.shift());
    if (next) selected.push(next);
  }
  return selected;
}

/**
 * Chunks in document order across the pair: work title, source title, then chunk position. The
 * prompt's chunk, source and root aliases all follow this order, so identical content yields an
 * identical prompt; IDs only break ties between items that are indistinguishable by content.
 */
export function orderSourceRelationChunks<
  T extends Pick<
    SourceRelationChunk,
    "id" | "rootId" | "rootTitle" | "sourceItemId" | "title" | "chunkIndex" | "contentHash"
  >
>(chunks: ReadonlyArray<T>): T[] {
  return chunks.toSorted(
    (a, b) =>
      compareContent(a.rootTitle, b.rootTitle) ||
      compareContent(a.rootId, b.rootId) ||
      compareContent(a.title, b.title) ||
      compareContent(a.sourceItemId, b.sourceItemId) ||
      a.chunkIndex - b.chunkIndex ||
      compareContent(a.contentHash, b.contentHash) ||
      compareContent(a.id, b.id)
  );
}

/** Source and root aliases (s1.., w1..) number the sources and roots in order of first appearance. */
function aliasOrder(chunks: ReadonlyArray<SourceRelationChunk>) {
  return {
    sources: [...new Set(chunks.map((chunk) => chunk.sourceItemId))],
    roots: [...new Set(chunks.map((chunk) => chunk.rootId))]
  };
}

/**
 * Symmetric types (contrasts, similar_to) always read from the lower source alias to the higher one.
 * Note relations carry the direction of their stored pair, so they are turned to match.
 */
export function orientSymmetricNotes(
  notes: ReadonlyArray<SourceRelationNote>,
  sources: ReadonlyArray<string>
): SourceRelationNote[] {
  return notes.map((note) =>
    symmetricSourceRelationTypes.includes(note.type) &&
    sources.indexOf(note.sourceItemId) > sources.indexOf(note.targetSourceItemId)
      ? {
          ...note,
          sourceItemId: note.targetSourceItemId,
          targetSourceItemId: note.sourceItemId,
          sourceNoteId: note.targetNoteId,
          targetNoteId: note.sourceNoteId,
          sourceChunkId: note.targetChunkId,
          targetChunkId: note.sourceChunkId,
          sourceIdea: note.targetIdea,
          targetIdea: note.sourceIdea
        }
      : note
  );
}

/**
 * The decision prompt: sources (s), roots (w) and chunks (c) by content order, the uncited note
 * connections as hypotheses with the chunks they rest on, and nothing else. Saved relations are not
 * listed: the decider judges the pair, and persistence merges what it already knows.
 */
export function sourceDecisionPrompt(
  context: Pick<SourceRelationContext, "chunks" | "notes">,
  maxItems: number,
  includeWeakTypes: boolean,
  summaryMaxCharacters = 1200
) {
  const { sources, roots } = aliasOrder(context.chunks);
  const sourceAlias = (id: string) => `s${sources.indexOf(id) + 1}`;
  const chunkAlias = (id: string) => `c${context.chunks.findIndex((chunk) => chunk.id === id) + 1}`;
  return renderPrompt("sources.decide", {
    max_relations: maxItems,
    weak_types: includeWeakTypes ? ", mentions, related" : "",
    sources: sources.map((id) => {
      const first = context.chunks.find((chunk) => chunk.sourceItemId === id)!;
      return {
        key: sourceAlias(id),
        root: `w${roots.indexOf(first.rootId) + 1}`,
        title: first.title,
        summary: first.summary?.slice(0, summaryMaxCharacters) ?? null
      };
    }),
    chunks: context.chunks.map((chunk, i) => ({
      key: `c${i + 1}`,
      source: sourceAlias(chunk.sourceItemId),
      text: chunk.content
    })),
    note_relations: context.notes.map((note) => ({
      source: sourceAlias(note.sourceItemId),
      target: sourceAlias(note.targetSourceItemId),
      type: note.type,
      sourceIdea: note.sourceIdea,
      targetIdea: note.targetIdea,
      evidence: [chunkAlias(note.sourceChunkId), chunkAlias(note.targetChunkId)]
    }))
  });
}

/** A valid verdict item, aliases resolved: endpoints are sources, evidence their own chunks. */
export interface SourceDecisionVerdict {
  sourceItemId: string;
  targetSourceItemId: string;
  type: SourceDecisionItem["type"];
  /** Raw integer scores from 0 to 100, as answered. */
  importance: number;
  confidence: number;
  sourceChunks: SourceRelationChunk[];
  targetChunks: SourceRelationChunk[];
  attempt: 0 | 1;
}

export interface SourceDecisionParse {
  /** The answer had the `{"relations":[...]}` envelope. */
  answered: boolean;
  /** Valid items in answer order; nothing in one item can invalidate another. */
  items: SourceDecisionVerdict[];
  /** Malformed items: wrong shape, unknown aliases, evidence of another source, or one work. */
  invalid: number;
  /** One of the malformed items joined two sources of the same work. */
  sameRoot: boolean;
}

/**
 * Reads a source verdict. Valid items are kept; a malformed one is counted and dropped. A symmetric
 * type answered from the higher alias reads the same from the lower one, so it is turned, never
 * refused.
 */
export function parseSourceDecision(
  output: unknown,
  context: Pick<SourceRelationContext, "chunks">,
  attempt: 0 | 1
): SourceDecisionParse {
  let raw: unknown[];
  try {
    raw = decisionEnvelopeSchema.parse(parseJsonOutput(output)).relations;
  } catch {
    return { answered: false, items: [], invalid: 0, sameRoot: false };
  }
  const { sources } = aliasOrder(context.chunks);
  const chunkByAlias = new Map(context.chunks.map((chunk, i) => [`c${i + 1}`, chunk]));
  const sourceByAlias = new Map(sources.map((id, i) => [`s${i + 1}`, id]));
  const rootOf = (id: string) => context.chunks.find((chunk) => chunk.sourceItemId === id)?.rootId;
  const items: SourceDecisionVerdict[] = [];
  let invalid = 0,
    sameRoot = false;
  for (const entry of raw) {
    const parsed = decisionItemSchema.safeParse(entry);
    if (!parsed.success) {
      invalid++;
      continue;
    }
    const [fromAlias, toAlias, type, importance, confidence, fromChunks, toChunks] = parsed.data;
    let from = sourceByAlias.get(fromAlias),
      to = sourceByAlias.get(toAlias);
    if (!from || !to || from === to) {
      invalid++;
      continue;
    }
    if (rootOf(from) === rootOf(to)) {
      invalid++;
      sameRoot = true;
      continue;
    }
    let fromEvidence = [...new Set(fromChunks)].map((alias) => chunkByAlias.get(alias));
    let toEvidence = [...new Set(toChunks)].map((alias) => chunkByAlias.get(alias));
    if (
      fromEvidence.some((chunk) => chunk?.sourceItemId !== from) ||
      toEvidence.some((chunk) => chunk?.sourceItemId !== to)
    ) {
      invalid++;
      continue;
    }
    if (
      symmetricSourceRelationTypes.includes(type) &&
      sources.indexOf(from) > sources.indexOf(to)
    ) {
      [from, to] = [to, from];
      [fromEvidence, toEvidence] = [toEvidence, fromEvidence];
    }
    items.push({
      sourceItemId: from,
      targetSourceItemId: to,
      type,
      importance,
      confidence,
      sourceChunks: fromEvidence as SourceRelationChunk[],
      targetChunks: toEvidence as SourceRelationChunk[],
      attempt
    });
  }
  return { answered: true, items, invalid, sameRoot };
}

const verdictIdentity = (
  item: Pick<SourceDecisionVerdict, "sourceItemId" | "targetSourceItemId" | "type">
) => JSON.stringify([item.sourceItemId, item.targetSourceItemId, item.type]);

/** The number of distinct relations (endpoints and type) among verdict items. */
export function distinctSourceVerdicts(items: ReadonlyArray<SourceDecisionVerdict>): number {
  return new Set(items.map(verdictIdentity)).size;
}

export type SourceDecisionOutcome =
  "persisted" | "below_floors" | "owner_rejected" | "over_allowance";

/** A stored raw verdict: what the decider answered and what became of it under the floors. */
export type SourceDecisionRecord = SourceDecisionItem & { outcome: SourceDecisionOutcome };

/**
 * Turns verdict items into relation writes. Items with the same endpoints and type are one relation
 * (scores the highest answered, evidence the union); relations rank by importance, then confidence,
 * and only the allowance is kept. A relation the owner rejected is never brought back; one already
 * saved is not a new proposal, and its evidence merges on persistence. Floors apply to the raw
 * scores divided by 100. A note connection whose passages the item cites is note-backed evidence.
 */
export function sourceRelationWrites(
  items: ReadonlyArray<SourceDecisionVerdict>,
  context: SourceRelationContext,
  settings: Pick<SourceRelationSettings, "minImportance" | "minConfidence" | "includeWeakTypes">,
  allowance: number
): { proposals: number; relations: SourceRelationWrite[]; records: SourceDecisionRecord[] } {
  const groups = new Map<string, SourceDecisionVerdict>();
  for (const item of items) {
    const key = verdictIdentity(item);
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        ...item,
        sourceChunks: [...item.sourceChunks],
        targetChunks: [...item.targetChunks]
      });
      continue;
    }
    group.importance = Math.max(group.importance, item.importance);
    group.confidence = Math.max(group.confidence, item.confidence);
    for (const chunk of item.sourceChunks)
      if (!group.sourceChunks.some((known) => known.id === chunk.id))
        group.sourceChunks.push(chunk);
    for (const chunk of item.targetChunks)
      if (!group.targetChunks.some((known) => known.id === chunk.id))
        group.targetChunks.push(chunk);
  }
  const ranked = [...groups.entries()].toSorted(
    ([, a], [, b]) => b.importance - a.importance || b.confidence - a.confidence
  );
  const outcomes = new Map<string, SourceDecisionOutcome>();
  const relations: SourceRelationWrite[] = [];
  let proposals = 0;
  for (const [index, [key, verdict]] of ranked.entries()) {
    if (index >= allowance) {
      outcomes.set(key, "over_allowance");
      continue;
    }
    const symmetric = symmetricSourceRelationTypes.includes(verdict.type);
    const equivalent = context.existing.filter(
      (relation) =>
        relation.relationType === verdict.type &&
        ((relation.sourceItemId === verdict.sourceItemId &&
          relation.targetSourceItemId === verdict.targetSourceItemId) ||
          (symmetric &&
            relation.sourceItemId === verdict.targetSourceItemId &&
            relation.targetSourceItemId === verdict.sourceItemId))
    );
    if (equivalent.some((relation) => relation.status === "rejected")) {
      outcomes.set(key, "owner_rejected");
      continue;
    }
    if (!equivalent.length) proposals++;
    if (!sourceDecisionPassesFloors(verdict, settings)) {
      outcomes.set(key, "below_floors");
      continue;
    }
    outcomes.set(key, "persisted");
    const notes = context.notes.filter(
      (note) =>
        note.type === verdict.type &&
        note.sourceItemId === verdict.sourceItemId &&
        note.targetSourceItemId === verdict.targetSourceItemId &&
        verdict.sourceChunks.some((chunk) => chunk.id === note.sourceChunkId) &&
        verdict.targetChunks.some((chunk) => chunk.id === note.targetChunkId)
    );
    const chunk = (id: string) => context.chunks.find((candidate) => candidate.id === id)!;
    const evidence: SourceRelationWrite["evidence"] = notes.map((note) => ({
      source: chunk(note.sourceChunkId),
      target: chunk(note.targetChunkId),
      note
    }));
    for (const source of verdict.sourceChunks)
      for (const target of verdict.targetChunks)
        if (
          !notes.some(
            (note) => note.sourceChunkId === source.id && note.targetChunkId === target.id
          )
        )
          evidence.push({ source, target, note: null });
    relations.push({
      existingId: null,
      sourceItemId: verdict.sourceItemId,
      targetSourceItemId: verdict.targetSourceItemId,
      relationType: verdict.type,
      sourceIdea: null,
      targetIdea: null,
      explanation: null,
      importance: verdict.importance / sourceDecisionLimits.maxScore,
      confidence: verdict.confidence / sourceDecisionLimits.maxScore,
      evidence
    });
  }
  const records = items.map((item) => ({
    from: item.sourceItemId,
    to: item.targetSourceItemId,
    type: item.type,
    importance: item.importance,
    confidence: item.confidence,
    fromChunks: item.sourceChunks.map((chunk) => chunk.id),
    toChunks: item.targetChunks.map((chunk) => chunk.id),
    attempt: item.attempt,
    outcome: outcomes.get(verdictIdentity(item))!
  }));
  return { proposals, relations, records };
}

/** What one root's planning and judging found out about its coverage, before it is stored. */
interface CoverageTally extends SourceRelationCoverage {
  /** Keys another root of the same run judges; they count as judged once that root has done so. */
  sharedKeys: string[];
}
/** Adds up the roots of one run; unknown (a root finished before coverage was recorded) stays unknown. */
export function combineSourceRelationCoverage(
  parts: ReadonlyArray<SourceRelationCoverage | undefined>
): SourceRelationCoverage | undefined {
  const known = parts.filter((part): part is SourceRelationCoverage => part !== undefined);
  if (known.length !== parts.length) return undefined;
  return {
    judgedPairs: known.reduce((sum, part) => sum + part.judgedPairs, 0),
    candidatePairs: known.reduce((sum, part) => sum + part.candidatePairs, 0),
    capReached: known.some((part) => part.capReached),
    relationLimitReached: known.some((part) => part.relationLimitReached),
    budgetExhausted: known.some((part) => part.budgetExhausted)
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
export async function matchSources(options: {
  pool: PgPool;
  ai: Pick<AiService, "runDefaultTask">;
  sourceIds: string[];
  runKey: string;
  settings: SourceRelationSettings;
  contentLanguage: string;
  regenerate?: boolean;
  signal?: AbortSignal;
  context?: AiTaskLogContext;
  onProgress?: (
    progress: number,
    counts: { completed: number; total: number }
  ) => void | Promise<void>;
}) {
  const { pool, ai, signal } = options,
    repository = createSourceRelationRepository(pool);
  const selection = await createAiConfigRepository(pool).getDefaultTask("reranking");
  if (!selection) throw new Error("errors.ai.noCompatibleModel");
  // What the task adds beneath the profile's parameters changes the effective parameters, so it is
  // part of the fingerprint. It is empty, and absent, while source matching adds nothing.
  const taskDefaultsIdentity = (model: typeof selection) => {
    const taskDefaults = aiTaskBehaviorDefaults(
      "reranking",
      Boolean(model.localModelId),
      sourceMatchingOperation
    );
    return Object.keys(taskDefaults).length ? { taskDefaults } : {};
  };
  const fingerprintConfiguration = (model: typeof selection) => {
    const prompts = changedPromptIdentity(sourceDecisionPromptIds);
    return hash({
      version: sourceRelationPromptVersion,
      ...taskDefaultsIdentity(model),
      ...(prompts ? { prompts } : {}),
      language: options.contentLanguage,
      settings: options.settings,
      profile: model.profileId,
      provider: model.providerConfigId,
      model: model.modelId,
      runtime: model.runtime,
      endpoint: model.baseUrl,
      providerKind: model.provider,
      repository: model.repository,
      quantization: model.quantization,
      localModel: model.localModelId,
      revision: model.revision,
      parameters: model.parameters,
      defaults: model.modelDefaultParameters
    });
  };
  const configuration = fingerprintConfiguration(selection);
  const roots = await repository.roots(options.sourceIds);
  let persistedCount = 0,
    partial = false,
    inputTokens = 0;
  const coverages: Array<SourceRelationCoverage | undefined> = [];
  const plans: Array<{
    root: string;
    state: z.infer<typeof stateSchema>;
    save: () => Promise<void>;
    pairs: Array<{ candidate: SourceRelationCandidate; notes: SourceRelationNote[]; key: string }>;
    /** Null when the root had finished before this run: its saved coverage stands. */
    tally: CoverageTally | null;
  }> = [];
  const plannedKeys = new Set<string>(),
    completedKeys = new Set<string>();
  for (const root of roots) {
    signal?.throwIfAborted();
    const runKey = `${options.runKey}:${root}`;
    const saved = await repository.runState(runKey);
    const state = stateSchema.parse(
      saved ?? {
        settings: options.settings,
        configuration,
        pairs: [],
        completed: [],
        attempts: {},
        inputTokens: 0,
        proposals: 0,
        persistedCount: 0,
        partial: false,
        finished: false
      }
    );
    // A run started under another contract, route or setting stops visibly: its budgets and
    // completed pairs belong to that configuration.
    if (state.configuration !== configuration)
      throw new Error("errors.sourceRelations.configurationChanged");
    const save = () => repository.saveRun(runKey, root, state);
    const settings = state.settings;
    // Recover the SQL-commit/checkpoint gap without regenerating or resetting the relation budget.
    for (const key of state.pairs.filter((key) => !state.completed.includes(key))) {
      const decision = await repository.decision(key);
      if (decision) {
        state.proposals += Number(decision.proposals ?? 0);
        state.persistedCount += Number(decision.persistedCount ?? 0);
        state.completed.push(key);
      }
    }
    await save();
    state.completed.forEach((key) => completedKeys.add(key));
    const pairs: (typeof plans)[number]["pairs"] = [];
    let tally: CoverageTally | null = null;
    if (!state.finished) {
      const candidates = rankSourceCandidates(
        (await repository.candidates(root, settings.maxCandidates)).filter(
          (candidate) => candidate.id !== root
        ),
        settings.maxCandidates,
        settings.reciprocalRankConstant
      );
      tally = {
        candidatePairs: candidates.length,
        judgedPairs: 0,
        sharedKeys: [],
        capReached: false,
        relationLimitReached: false,
        budgetExhausted: false
      };
      let reservedPairs = state.pairs.length,
        halted = false;
      for (const candidate of candidates) {
        signal?.throwIfAborted();
        // The key holds every note relation between the two roots, cited or not: a relation saved
        // from one side removes its note relations from the prompt, never the pair from the cache,
        // so the other side does not judge the same pair again.
        const key = hash({
          roots: [root, candidate.id].sort(),
          configuration,
          inputs: await Promise.all(
            [root, candidate.id].sort().map((id) => repository.fingerprint(id))
          ),
          notes: (await repository.pairNoteFingerprints(root, candidate.id)).toSorted(),
          regeneration: options.regenerate ? options.runKey : null
        });
        if (state.completed.includes(key)) {
          tally.judgedPairs++;
          continue;
        }
        if (plannedKeys.has(key)) {
          // Another root of this run judges it: counted once that root has done so.
          tally.sharedKeys.push(key);
          continue;
        }
        if (await repository.decision(key)) {
          tally.judgedPairs++;
          continue;
        }
        // Once a limit stops the plan nothing more is planned, but the candidates after it are still
        // counted when an earlier run already judged them.
        if (!halted) {
          const capHit = !state.pairs.includes(key) && reservedPairs >= settings.maxPairs,
            relationLimitHit = state.proposals >= settings.maxRelations;
          if (capHit || relationLimitHit) {
            halted = true;
            tally.capReached = capHit;
            tally.relationLimitReached = relationLimitHit;
          }
        }
        if (halted) continue;
        if (!state.pairs.includes(key)) reservedPairs++;
        plannedKeys.add(key);
        pairs.push({
          candidate,
          notes: await repository.pairNotes(root, candidate.id, settings.noteRelationsPerPair),
          key
        });
      }
    }
    if (!state.finished) {
      state.totalPairs = state.completed.length + pairs.length;
      await save();
    }
    plans.push({ root, state, save, pairs, tally });
  }
  let total = plans.reduce(
    (sum, plan) => sum + Math.max(plan.state.totalPairs, plan.state.completed.length),
    0
  );
  const report = () =>
    options.onProgress?.(total > 0 ? completedKeys.size / total : 1, {
      completed: completedKeys.size,
      total
    });
  await report();
  for (const { root, state, save, pairs, tally } of plans) {
    signal?.throwIfAborted();
    const settings = state.settings;
    if (!state.finished && tally) {
      for (const { candidate, notes, key } of pairs) {
        signal?.throwIfAborted();
        if (state.proposals >= settings.maxRelations) {
          tally.relationLimitReached = true;
          break;
        }
        const chunks = orderSourceRelationChunks(
          (
            await repository.pairChunks(
              root,
              candidate.id,
              notes.flatMap((note) => [note.sourceChunkId, note.targetChunkId]),
              settings.evidenceChunksPerSource
            )
          ).map((chunk) => ({
            ...chunk,
            content: chunk.content.slice(0, settings.evidenceMaxCharacters)
          }))
        );
        if (chunks.length < 2) {
          // Without evidence on both sides the pair cannot be judged, so it is no candidate.
          tally.candidatePairs--;
          total--;
          state.totalPairs--;
          await save();
          await report();
          continue;
        }
        // A pair answers at most two items, within what is left of the root's proposal budget.
        const allowance = Math.min(
          sourceDecisionLimits.maxItemsPerPair,
          settings.maxRelationsPerPair,
          settings.maxRelations - state.proposals
        );
        const existing = (await repository.existing(root, candidate.id)) as ExistingRelation[];
        const context: SourceRelationContext = {
          chunks,
          notes: orientSymmetricNotes(
            notes.filter(
              (note) =>
                chunks.some((chunk) => chunk.id === note.sourceChunkId) &&
                chunks.some((chunk) => chunk.id === note.targetChunkId)
            ),
            aliasOrder(chunks).sources
          ),
          existing: existing.filter(
            (relation) =>
              chunks.some((chunk) => chunk.sourceItemId === relation.sourceItemId) &&
              chunks.some((chunk) => chunk.sourceItemId === relation.targetSourceItemId)
          )
        };
        const prompt = sourceDecisionPrompt(
          context,
          allowance,
          settings.includeWeakTypes,
          settings.summaryMaxCharacters
        );
        let completed = false;
        let validationFeedback = renderPrompt("sources.validation.default");
        if ((state.attempts[key] ?? 0) >= 2)
          throw new Error("errors.sourceRelations.invalidOutput");
        const answers: SourceDecisionParse[] = [];
        let finalExecution: Awaited<ReturnType<typeof ai.runDefaultTask>> = null;
        const aiTaskRunIds: string[] = [];
        let budgetStopped = false;
        while ((state.attempts[key] ?? 0) < 2) {
          const attempt = (state.attempts[key] ?? 0) as 0 | 1;
          const input = joinPrompts(
            prompt,
            attempt
              ? renderPrompt("sources.decide.repair", { validation_errors: validationFeedback })
              : ""
          );
          // Allow the current call to exceed the budget; stop only subsequent calls.
          if (state.inputTokens > settings.maxInputTokens) {
            budgetStopped = true;
            break;
          }
          const currentSelection = await createAiConfigRepository(pool).getDefaultTask("reranking");
          if (!currentSelection || fingerprintConfiguration(currentSelection) !== configuration)
            throw new Error("errors.sourceRelations.configurationChanged");
          if (!state.pairs.includes(key)) state.pairs.push(key);
          state.attempts[key] = attempt + 1;
          await save();
          const execution = await ai.runDefaultTask(
            "reranking",
            input,
            {
              ...options.context,
              operation: sourceMatchingOperation,
              stage: "sourceMatching",
              contentLanguage: options.contentLanguage,
              promptVersion: sourceRelationPromptVersion,
              sourceItemIds: [
                ...new Set([root, candidate.id, ...chunks.map((chunk) => chunk.sourceItemId)])
              ],
              attempt
            },
            signal,
            { maxOutputTokens: Math.min(settings.maxOutputTokens, 500 + allowance * 700) }
          );
          if (!execution) throw new Error("errors.ai.noCompatibleModel");
          const reportedInputTokens = execution.inputTokens;
          if (
            typeof reportedInputTokens === "number" &&
            Number.isSafeInteger(reportedInputTokens) &&
            reportedInputTokens >= 0
          ) {
            state.inputTokens += reportedInputTokens;
          }
          // Persist reported usage even if validation, cancellation or persistence fails next.
          await save();
          const parsed = parseSourceDecision(execution.output, context, attempt);
          answers.push(parsed);
          finalExecution = execution;
          if (execution.aiTaskRunId) aiTaskRunIds.push(execution.aiTaskRunId);
          // A clean answer, or one already holding all the relations the pair may keep, is final.
          // Otherwise one repair asks again; the valid items of the first answer are kept.
          if (
            (parsed.answered && parsed.invalid === 0) ||
            distinctSourceVerdicts(answers.flatMap((answer) => answer.items)) >= allowance
          )
            break;
          if (parsed.sameRoot) validationFeedback = renderPrompt("sources.validation.same_root");
        }
        const items = answers.flatMap((answer) => answer.items);
        const last = answers.at(-1);
        if (!budgetStopped && last && finalExecution) {
          // Answers that keep nothing valid and never settle fail the pair visibly: committing them
          // would cache "no relation" for a pair the decider did not decide.
          if (!items.length && !(last.answered && last.invalid === 0))
            throw new Error("errors.sourceRelations.invalidOutput");
          signal?.throwIfAborted();
          const output = sourceRelationWrites(items, context, settings, allowance);
          const created = await repository.commitDecision(
            key,
            root,
            candidate.id,
            output.relations,
            {
              promptVersion: sourceRelationPromptVersion,
              profileId: finalExecution.profileId,
              model: finalExecution.modelId,
              provider: finalExecution.providerId,
              runtime: finalExecution.runtime,
              aiTaskRunId: finalExecution.aiTaskRunId,
              aiTaskRunIds,
              configuration,
              inputTokens: finalExecution.inputTokens ?? null,
              outputTokens: finalExecution.outputTokens ?? null,
              candidateSignals: {
                id: candidate.id,
                textScore: candidate.textScore,
                vectorScore: candidate.vectorScore,
                graphScore: candidate.graphScore,
                noteScore: candidate.noteScore
              },
              contentLanguage: options.contentLanguage,
              proposals: output.proposals,
              // Raw verdicts apart from the floors: the floors can be tuned again without calls.
              items: output.records,
              floors: {
                minImportance: settings.minImportance,
                minConfidence: settings.minConfidence,
                includeWeakTypes: settings.includeWeakTypes
              },
              invalidItems: answers.reduce((sum, answer) => sum + answer.invalid, 0)
            }
          );
          state.proposals += output.proposals;
          state.persistedCount += created;
          state.completed.push(key);
          completed = true;
          await save();
        }
        if (!completed) {
          // Only a pair the input budget left incomplete is a failure to cover; the caps are not.
          state.partial = true;
          tally.budgetExhausted = true;
          break;
        }
        completedKeys.add(key);
        tally.judgedPairs++;
        await report();
      }
      state.finished = true;
      const { sharedKeys, ...coverage } = tally;
      state.coverage = {
        ...coverage,
        judgedPairs:
          coverage.judgedPairs + sharedKeys.filter((key) => completedKeys.has(key)).length
      };
      await save();
    }
    persistedCount += state.persistedCount;
    inputTokens += state.inputTokens;
    partial ||= state.partial;
    coverages.push(state.coverage);
    await report();
  }
  const coverage = combineSourceRelationCoverage(coverages);
  return {
    persistedCount,
    partial,
    ...(coverage ? { coverage } : {}),
    inputTokens,
    rootCount: roots.length,
    completed: completedKeys.size,
    total
  };
}
