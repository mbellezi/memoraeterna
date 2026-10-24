import { compareContent } from "./content-order.js";
import { renderPrompt, joinPrompts, changedPromptIdentity } from "./prompt-runtime.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomicNoteRelationTypeSchema,
  SourceRelationCoverageSchema,
  SourceRelationSettingsSchema,
  equivalentSourceRelationTypes,
  generativeDeciderCapabilities,
  relationsConfig as defaultRelationsConfig,
  sourceDecisionLimits,
  sourceDecisionPassesFloors,
  sourceVerdictWriteType,
  symmetricSourceRelationTypes,
  type RelationsConfig,
  type SourceDecisionItem,
  type SourceJudgeMode,
  type SourceRelationCoverage,
  type SourceRelationSettings
} from "@app/domain";
import {
  aiRouteKeys,
  createAiConfigRepository,
  createSourceRelationRepository,
  type PgPool,
  type RetrievalFence,
  type SourceRelationChunk,
  type SourceRelationNote,
  type SourceRelationWrite
} from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";
import { aiTaskBehaviorDefaults } from "./ai-task-parameters.js";
import { parseJsonOutput } from "./knowledge-processing.js";
import { InFlightRegistry } from "./relations/in-flight-registry.js";

/**
 * Source relations by design E (F3 D27, decision 17). Per root, with no batch barrier: (1) every
 * typed shown (applied or suggested, decision 29) cross-root note relation is promoted into a source
 * relation with no call; (2) discovery selects the root's nearest earlier roots and its reverse
 * neighbours on the stored composite vectors; (3) the selected pairs still undecided are judged in
 * one call per root (F4 D21) with the compact, score-only `source-relations-v6` verdict: the call
 * lists its pairs of works, and each pair answers at most two `[from, to, type, importance,
 * confidence, [from chunks], [to chunks]]` items and no prose. Items are split per pair and each
 * pair is decided once, under a key that leaves out what else shared its call; a hub root's pairs
 * are split into calls of at most `sourceJudge.maxPairsPerCall`. The judge mode `perPair` is F3's
 * judge instead: one call per pair with its own `source-relations-v5` prompt. Explanations are
 * written when the owner opens a relation. Promoted and judged relations alike are suggestions until
 * the owner keeps them (decision 29).
 */
export const sourceRelationPromptVersion = "source-relations-v6";
/** The contract each judge mode answers under: F3's per-pair judge keeps its own (F4 D21). */
export const sourceJudgePromptVersions = {
  perRoot: sourceRelationPromptVersion,
  perPair: "source-relations-v5"
} as const satisfies Record<SourceJudgeMode, string>;
export const sourceMatchingOperation = "source_relation_matching";
/** Every catalog prompt a mode's source decision is composed of: its identity is in the pair key. */
const sourceDecisionPromptIds = {
  perRoot: [
    "sources.decide",
    "sources.decide.repair",
    "sources.validation.default",
    "sources.validation.same_root"
  ],
  perPair: [
    "sources.decide.pair",
    "sources.decide.repair",
    "sources.validation.pair",
    "sources.validation.same_root"
  ]
} as const satisfies Record<SourceJudgeMode, readonly string[]>;
/** The validation feedback a mode's repair starts from. */
const sourceValidationPromptId = {
  perRoot: "sources.validation.default",
  perPair: "sources.validation.pair"
} as const satisfies Record<SourceJudgeMode, string>;

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

/**
 * One root's matching state in a run (`source_matching_runs`). States written before design E also
 * hold the shortlist's counters; they are read and ignored.
 */
const stateSchema = z.object({
  settings: SourceRelationSettingsSchema,
  configuration: z.string(),
  pairs: z.array(z.string()),
  completed: z.array(z.string()),
  inputTokens: z.number().nonnegative(),
  persistedCount: z.number().nonnegative(),
  attempts: z.record(z.string(), z.number()),
  /** True only when a pair could not be completed (`coverage.budgetExhausted`). */
  partial: z.boolean(),
  /** Written when the root finishes. */
  coverage: SourceRelationCoverageSchema.optional(),
  finished: z.boolean(),
  totalPairs: z.number().int().nonnegative().default(0),
  /**
   * What discovery did for the root: the pairs it planned (stored with the plan, so a resumed run
   * judges exactly them), or why it planned none.
   */
  discovery: z
    .object({
      status: z.enum(["planned", "deferred", "no_vector"]),
      roots: z.array(z.string()),
      candidates: z.number().int().nonnegative().default(0)
    })
    .optional()
});
type RootState = z.infer<typeof stateSchema>;

type ExistingRelation = {
  id: string;
  sourceItemId: string;
  targetSourceItemId: string;
  relationType: string;
  sourceIdea: string | null;
  targetIdea: string | null;
  status: string;
  /** Absent on fixtures of earlier rows: a judged relation. */
  origin?: "judged" | "promoted";
  sourceRootId?: string;
  targetRootId?: string;
};
export interface SourceRelationContext {
  chunks: SourceRelationChunk[];
  notes: SourceRelationNote[];
  /** Saved relations between the two works: they never reach the prompt. */
  existing: ExistingRelation[];
}
type SourceRelationReader = ReturnType<typeof createSourceRelationRepository>;

/**
 * What a pair of works is judged on, read-only: the evidence passages in content order (cut to the
 * settings' length) and the saved relations between the two works. Null when the pair has fewer than
 * two passages, which the matcher skips. `notes` are the pair's uncited note relations.
 */
export async function sourcePairContext(
  repository: Pick<SourceRelationReader, "pairChunks" | "existing">,
  rootId: string,
  candidateId: string,
  notes: SourceRelationNote[],
  settings: Pick<SourceRelationSettings, "evidenceChunksPerSource" | "evidenceMaxCharacters">,
  bounds?: Pick<RelationsConfig["sourceJudge"], "exactEvidencePairs" | "boundedEvidenceChunks">
): Promise<SourceRelationContext | null> {
  const chunks = orderSourceRelationChunks(
    (
      await repository.pairChunks(
        rootId,
        candidateId,
        notes.flatMap((note) => [note.sourceChunkId, note.targetChunkId]),
        settings.evidenceChunksPerSource,
        ...(bounds ? [bounds] : [])
      )
    ).map((chunk) => ({
      ...chunk,
      content: chunk.content.slice(0, settings.evidenceMaxCharacters)
    }))
  );
  if (chunks.length < 2) return null;
  const existing = (await repository.existing(rootId, candidateId)) as ExistingRelation[];
  return {
    chunks,
    notes: orientSymmetricNotes(
      notes.filter(
        (note) =>
          chunks.some((chunk) => chunk.id === note.sourceChunkId) &&
          chunks.some((chunk) => chunk.id === note.targetChunkId)
      ),
      aliasOrder(chunks).sources
    ),
    // A relation between the two roots themselves holds whichever passages the pair shows.
    existing: existing.filter(
      (relation) =>
        (relation.sourceItemId === relation.sourceRootId &&
          relation.targetSourceItemId === relation.targetRootId) ||
        (chunks.some((chunk) => chunk.sourceItemId === relation.sourceItemId) &&
          chunks.some((chunk) => chunk.sourceItemId === relation.targetSourceItemId))
    )
  };
}

/** A pair answers at most two items (and no more than the settings allow per pair). */
export const sourceDecisionAllowance = (
  settings: Pick<SourceRelationSettings, "maxRelationsPerPair">
) => Math.min(sourceDecisionLimits.maxItemsPerPair, settings.maxRelationsPerPair);

/** The output budget of one decision call for the pair's allowance. */
export const sourceDecisionMaxOutputTokens = (
  settings: Pick<SourceRelationSettings, "maxOutputTokens">,
  allowance: number
) => Math.min(settings.maxOutputTokens, 500 + allowance * 700);

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
export function aliasOrder(chunks: ReadonlyArray<SourceRelationChunk>) {
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

/** Two works a call judges, as root IDs (the new root and one partner). */
export type SourceRootPair = readonly [string, string];

/** A pair of works as one key, whichever order its roots come in. */
export const sourceRootPairKey = (left: string, right: string) =>
  JSON.stringify([left, right].toSorted(compareContent));

/** What one judge call is asked about: the evidence of its pairs of works, and those pairs. */
export type SourceDecisionRequest = Pick<SourceRelationContext, "chunks" | "notes"> & {
  /** The pairs of works the call judges; every two roots of the evidence when absent. */
  pairs?: ReadonlyArray<SourceRootPair>;
};

/**
 * The listed pairs of works as indexes into the roots' alias order: each pair from its lower alias,
 * the pairs by their aliases (content order, never IDs). Without a list every two roots of the
 * evidence are a pair, which is the single pair of a pair's own evidence.
 */
function listedRootPairs(
  pairs: ReadonlyArray<SourceRootPair> | undefined,
  roots: readonly string[]
): Array<readonly [number, number]> {
  const indexed = pairs
    ? pairs.map(([left, right]) => [roots.indexOf(left), roots.indexOf(right)] as const)
    : roots.flatMap((_, left) =>
        roots.slice(left + 1).map((_, offset) => [left, left + 1 + offset] as const)
      );
  const unique = new Map<string, readonly [number, number]>();
  for (const [left, right] of indexed)
    if (left >= 0 && right >= 0 && left !== right) {
      const pair = [Math.min(left, right), Math.max(left, right)] as const;
      unique.set(pair.join(), pair);
    }
  return [...unique.values()].toSorted((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * The request of one call for a root and its partners (D21): the union of the pairs' evidence, each
 * passage once, in content order; their uncited note relations, each once, grouped by partner in the
 * partners' alias order and turned for the call's aliases; and the pairs of works.
 */
export function sourceBatchRequest(
  root: string,
  pairs: ReadonlyArray<{
    candidate: string;
    context: Pick<SourceRelationContext, "chunks" | "notes">;
  }>
): Required<SourceDecisionRequest> {
  const chunks = orderSourceRelationChunks([
    ...new Map(
      pairs.flatMap((pair) => pair.context.chunks).map((chunk) => [chunk.id, chunk])
    ).values()
  ]);
  const { sources, roots } = aliasOrder(chunks);
  const byPartner = pairs.toSorted(
    (a, b) => roots.indexOf(a.candidate) - roots.indexOf(b.candidate)
  );
  const notes = [
    ...new Map(
      byPartner.flatMap((pair) => pair.context.notes).map((note) => [note.id, note])
    ).values()
  ];
  return {
    chunks,
    notes: orientSymmetricNotes(notes, sources),
    pairs: byPartner.map((pair) => [root, pair.candidate] as const)
  };
}

/**
 * What both judge prompts show: sources (s), roots (w) and chunks (c) by content order and the
 * uncited note connections as hypotheses with the chunks they rest on.
 */
function sourceDecisionValues(
  context: Pick<SourceDecisionRequest, "chunks" | "notes">,
  maxItems: number,
  includeWeakTypes: boolean,
  summaryMaxCharacters: number
) {
  const { sources, roots } = aliasOrder(context.chunks);
  const sourceAlias = (id: string) => `s${sources.indexOf(id) + 1}`;
  const chunkAlias = (id: string) => `c${context.chunks.findIndex((chunk) => chunk.id === id) + 1}`;
  return {
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
  };
}

/**
 * The decision prompt: the pairs of works to judge (root aliases), sources (s), roots (w) and chunks
 * (c) by content order, the uncited note connections as hypotheses with the chunks they rest on, and
 * nothing else. Saved relations are not listed: the decider judges the pairs, and persistence merges
 * what it already knows.
 */
export function sourceDecisionPrompt(
  context: SourceDecisionRequest,
  maxItems: number,
  includeWeakTypes: boolean,
  summaryMaxCharacters = 1200
) {
  const { roots } = aliasOrder(context.chunks);
  return renderPrompt("sources.decide", {
    ...sourceDecisionValues(context, maxItems, includeWeakTypes, summaryMaxCharacters),
    candidates: listedRootPairs(context.pairs, roots).map(([left, right]) => [
      `w${left + 1}`,
      `w${right + 1}`
    ])
  });
}

/**
 * F3's per-pair decision prompt (`sources.decide.pair`, `source-relations-v5`): one pair of works'
 * evidence, with no list of pairs. The judge mode `perPair` sends it, byte for byte F3's.
 */
export function sourcePairDecisionPrompt(
  context: Pick<SourceDecisionRequest, "chunks" | "notes">,
  maxItems: number,
  includeWeakTypes: boolean,
  summaryMaxCharacters = 1200
) {
  return renderPrompt(
    "sources.decide.pair",
    sourceDecisionValues(context, maxItems, includeWeakTypes, summaryMaxCharacters)
  );
}

/** The prompt a judge mode sends for a request (without the repair suffix). */
export function sourceJudgePrompt(
  mode: SourceJudgeMode,
  request: SourceDecisionRequest,
  maxItems: number,
  settings: Pick<SourceRelationSettings, "includeWeakTypes" | "summaryMaxCharacters">
) {
  return (mode === "perPair" ? sourcePairDecisionPrompt : sourceDecisionPrompt)(
    request,
    maxItems,
    settings.includeWeakTypes,
    settings.summaryMaxCharacters
  );
}

/** The validation feedback a judge mode's repair starts from. */
export const sourceJudgeValidation = (mode: SourceJudgeMode) =>
  renderPrompt(sourceValidationPromptId[mode]);

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
  /**
   * Malformed items: wrong shape, unknown aliases, evidence of another source, one work, or two
   * works the request does not list as a pair.
   */
  invalid: number;
  /** One of the malformed items joined two sources of the same work. */
  sameRoot: boolean;
  /**
   * For each malformed item, the listed pairs of works (`sourceRootPairKey`) it may have been meant
   * for: its own pair; each pair of its work when it joins two sources of one work; none when it
   * joins two works not listed together; every pair when its aliases cannot be read. A batched call
   * asks again only about the pairs a malformed item may have been meant for (D21).
   */
  suspects: string[][];
}

/**
 * Reads a source verdict. Valid items are kept; a malformed one is counted and dropped. A symmetric
 * type answered from the higher alias reads the same from the lower one, so it is turned, never
 * refused. An item must join two works the request lists as a pair (any two works when it lists
 * none).
 */
export function parseSourceDecision(
  output: unknown,
  context: Pick<SourceDecisionRequest, "chunks" | "pairs">,
  attempt: 0 | 1
): SourceDecisionParse {
  let raw: unknown[];
  try {
    raw = decisionEnvelopeSchema.parse(parseJsonOutput(output)).relations;
  } catch {
    return { answered: false, items: [], invalid: 0, sameRoot: false, suspects: [] };
  }
  const { sources, roots } = aliasOrder(context.chunks);
  const chunkByAlias = new Map(context.chunks.map((chunk, i) => [`c${i + 1}`, chunk]));
  const sourceByAlias = new Map(sources.map((id, i) => [`s${i + 1}`, id]));
  const rootOf = (id: string) => context.chunks.find((chunk) => chunk.sourceItemId === id)?.rootId;
  const listed = listedRootPairs(context.pairs, roots).map(
    ([left, right]) => [roots[left]!, roots[right]!] as const
  );
  const everyPair = listed.map(([left, right]) => sourceRootPairKey(left, right));
  const listedKeys = new Set(everyPair);
  /** The listed pairs a malformed item may have been meant for, read from its two aliases. */
  const suspectsOf = (entry: unknown): string[] => {
    const [fromAlias, toAlias] = Array.isArray(entry) ? (entry as unknown[]) : [];
    const from = typeof fromAlias === "string" ? sourceByAlias.get(fromAlias) : undefined;
    const to = typeof toAlias === "string" ? sourceByAlias.get(toAlias) : undefined;
    const fromRoot = from && rootOf(from),
      toRoot = to && rootOf(to);
    if (!fromRoot || !toRoot) return everyPair;
    if (fromRoot === toRoot)
      return listed
        .filter((pair) => pair.includes(fromRoot))
        .map(([left, right]) => sourceRootPairKey(left, right));
    const key = sourceRootPairKey(fromRoot, toRoot);
    return listedKeys.has(key) ? [key] : [];
  };
  const items: SourceDecisionVerdict[] = [];
  const suspects: string[][] = [];
  let invalid = 0,
    sameRoot = false;
  const malformed = (entry: unknown) => {
    invalid++;
    suspects.push(suspectsOf(entry));
  };
  for (const entry of raw) {
    const parsed = decisionItemSchema.safeParse(entry);
    if (!parsed.success) {
      malformed(entry);
      continue;
    }
    const [fromAlias, toAlias, type, importance, confidence, fromChunks, toChunks] = parsed.data;
    let from = sourceByAlias.get(fromAlias),
      to = sourceByAlias.get(toAlias);
    if (!from || !to || from === to) {
      malformed(entry);
      continue;
    }
    if (rootOf(from) === rootOf(to)) {
      sameRoot = true;
      malformed(entry);
      continue;
    }
    if (!listedKeys.has(sourceRootPairKey(rootOf(from)!, rootOf(to)!))) {
      malformed(entry);
      continue;
    }
    let fromEvidence = [...new Set(fromChunks)].map((alias) => chunkByAlias.get(alias));
    let toEvidence = [...new Set(toChunks)].map((alias) => chunkByAlias.get(alias));
    if (
      fromEvidence.some((chunk) => chunk?.sourceItemId !== from) ||
      toEvidence.some((chunk) => chunk?.sourceItemId !== to)
    ) {
      malformed(entry);
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
  return { answered: true, items, invalid, sameRoot, suspects };
}

const verdictIdentity = (
  item: Pick<SourceDecisionVerdict, "sourceItemId" | "targetSourceItemId" | "type">
) => JSON.stringify([item.sourceItemId, item.targetSourceItemId, item.type]);

/** The number of distinct relations (endpoints and type) among verdict items. */
export function distinctSourceVerdicts(items: ReadonlyArray<SourceDecisionVerdict>): number {
  return new Set(items.map(verdictIdentity)).size;
}

export type SourceDecisionOutcome =
  | "persisted"
  | "below_floors"
  | "owner_rejected"
  | "over_allowance"
  /** A type the write vocabulary drops (Q14: `similar_to` unless the configuration keeps it). */
  | "weak_type";

/** A stored raw verdict: what the decider answered and what became of it under the floors. */
export type SourceDecisionRecord = SourceDecisionItem & { outcome: SourceDecisionOutcome };

/** How a verdict is written: the source judge's part of the typed relations configuration. */
export type SourceJudgeWriteOptions = Pick<RelationsConfig["sourceJudge"], "keepSimilarTo">;

/**
 * Turns verdict items into relation writes. Items with the same endpoints and type are one relation
 * (scores the highest answered, evidence the union); relations rank by importance, then confidence,
 * and only the allowance is kept. The type is written in the write vocabulary (`contrasts` as
 * `contradicts`; `similar_to` dropped as weak unless kept, Q14). A relation the owner rejected is
 * never brought back; one already saved (or promoted for the same pair of works) is not a new
 * proposal, and its evidence merges on persistence. Floors apply to the raw scores divided by 100.
 * A note connection whose passages the item cites is note-backed evidence.
 */
export function sourceRelationWrites(
  items: ReadonlyArray<SourceDecisionVerdict>,
  context: SourceRelationContext,
  settings: Pick<SourceRelationSettings, "minImportance" | "minConfidence" | "includeWeakTypes">,
  allowance: number,
  options: SourceJudgeWriteOptions = defaultRelationsConfig.sourceJudge
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
    const type = sourceVerdictWriteType(verdict.type, options);
    if (type === null) {
      outcomes.set(key, "weak_type");
      continue;
    }
    const types = equivalentSourceRelationTypes(type);
    const symmetric = symmetricSourceRelationTypes.includes(type);
    const [sourceRoot, targetRoot] = [
      verdict.sourceChunks[0]?.rootId,
      verdict.targetChunks[0]?.rootId
    ];
    const equivalent = context.existing.filter(
      (relation) =>
        types.includes(relation.relationType) &&
        ((relation.sourceItemId === verdict.sourceItemId &&
          relation.targetSourceItemId === verdict.targetSourceItemId) ||
          (symmetric &&
            relation.sourceItemId === verdict.targetSourceItemId &&
            relation.targetSourceItemId === verdict.sourceItemId) ||
          // The one relation between the two roots themselves (as promotion keeps it).
          (relation.sourceItemId === relation.sourceRootId &&
            relation.targetSourceItemId === relation.targetRootId &&
            ((relation.sourceRootId === sourceRoot && relation.targetRootId === targetRoot) ||
              (symmetric &&
                relation.sourceRootId === targetRoot &&
                relation.targetRootId === sourceRoot))))
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
        types.includes(note.type) &&
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
      relationType: type,
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

/** Adds up the roots of one run; unknown (a root finished before coverage was recorded) stays unknown. */
export function combineSourceRelationCoverage(
  parts: ReadonlyArray<SourceRelationCoverage | undefined>
): SourceRelationCoverage | undefined {
  const known = parts.filter((part): part is SourceRelationCoverage => part !== undefined);
  if (known.length !== parts.length) return undefined;
  return {
    judgedPairs: known.reduce((sum, part) => sum + part.judgedPairs, 0),
    candidatePairs: known.reduce((sum, part) => sum + part.candidatePairs, 0),
    budgetExhausted: known.some((part) => part.budgetExhausted),
    promoted: known.reduce((sum, part) => sum + (part.promoted ?? 0), 0)
  };
}

function hash(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * The settings that shape the judge's request: they belong to the pair key. The floors and the input
 * budget only decide what is kept of a verdict or whether a call is made, so changing them never
 * re-judges a pair (D27; the raw items are stored with every decision).
 */
export function sourceJudgeRequestSettings(
  settings: SourceRelationSettings,
  judge: Pick<
    RelationsConfig["sourceJudge"],
    "noteRelationsPerPair" | "exactEvidencePairs" | "boundedEvidenceChunks"
  >
) {
  return {
    evidenceChunksPerSource: settings.evidenceChunksPerSource,
    evidenceMaxCharacters: settings.evidenceMaxCharacters,
    summaryMaxCharacters: settings.summaryMaxCharacters,
    maxOutputTokens: settings.maxOutputTokens,
    maxRelationsPerPair: settings.maxRelationsPerPair,
    includeWeakTypes: settings.includeWeakTypes,
    noteRelationsPerPair: judge.noteRelationsPerPair,
    // The evidence fallback of large roots (R19) selects other passages.
    exactEvidencePairs: judge.exactEvidencePairs,
    boundedEvidenceChunks: judge.boundedEvidenceChunks
  };
}

/**
 * The in-flight registry of judged pairs (D24) for a caller that brings none: two runs that select
 * the same unordered pair share one call; the second waits for the first and then finds its
 * decision. The link jobs pass theirs, which also holds the note pairs they are typing.
 */
const judgingPairs = new InFlightRegistry();
/** A source-pair key in the in-flight registry, apart from the note-pair keys of typing. */
const judgingKey = (key: string) => `source-pair:${key}`;

export interface MatchSourcesOptions {
  pool: PgPool;
  ai: Pick<AiService, "runDefaultTask"> & Partial<Pick<AiService, "ensureLegacyRouteMapping">>;
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
  /**
   * `defer`: promotion only; discovery is recorded as deferred (relation remote calls switched off,
   * or a hierarchy root whose last record has not linked yet). Defaults to `run`. A deferred
   * discovery, or one that found no composite vector, is not final: a later `run` call, with the
   * same run key or another, plans it. Only a planned discovery is kept.
   */
  discovery?: "run" | "defer";
  /** A re-match run's visibility fence (3.17): discovery sees only the released roots. */
  fence?: RetrievalFence | undefined;
  /** The discovery and judge parts of the typed relations configuration. */
  config?: Pick<RelationsConfig, "discovery" | "sourceJudge">;
  /** The in-flight registry the pairs are judged under (D24); the link jobs pass theirs. */
  registry?: InFlightRegistry;
}

/** A type, not an interface: the stage checkpoint stores it as a JSON record. */
export type SourceMatchingResult = {
  persistedCount: number;
  partial: boolean;
  coverage?: SourceRelationCoverage;
  inputTokens: number;
  rootCount: number;
  completed: number;
  total: number;
  /** Source relations promoted or refreshed, and retired, by promotion. */
  promoted: number;
  retired: number;
  /** Roots whose discovery was deferred, or that had no composite vector to discover with. */
  discoveryDeferred: number;
  discoveryWithoutVector: number;
};

/**
 * Matches the roots of `sourceIds` by design E (D27): for each root, in content order, promotion,
 * then discovery and the judging of each selected pair once. Promotion is committed before any
 * call, so a judge that fails leaves it in place; a resumed run judges the pairs it planned, also
 * under another judge. With no judge routed nothing that needs one is planned and the run fails.
 */
export async function matchSources(options: MatchSourcesOptions): Promise<SourceMatchingResult> {
  const { pool, ai, signal } = options,
    repository = createSourceRelationRepository(pool),
    config = options.config ?? defaultRelationsConfig,
    registry = options.registry ?? judgingPairs;
  // The class routes exist before a route is read, as for a real call (D34).
  await ai.ensureLegacyRouteMapping?.();
  const routeKeys = aiRouteKeys("reranking", {
    operation: sourceMatchingOperation,
    workloadClass: "decide"
  });
  const judgeRoute = () =>
    createAiConfigRepository(pool).getDefaultTask("reranking", undefined, routeKeys);
  type Route = NonNullable<Awaited<ReturnType<typeof judgeRoute>>>;
  // What the task adds beneath the profile's parameters changes the effective parameters, so it is
  // part of the key. It is empty, and absent, while source matching adds nothing.
  const taskDefaultsIdentity = (model: Route) => {
    const taskDefaults = aiTaskBehaviorDefaults(
      "reranking",
      Boolean(model.localModelId),
      sourceMatchingOperation
    );
    return Object.keys(taskDefaults).length ? { taskDefaults } : {};
  };
  // The judge's identity (D27): contract, prompt identity, request-shaping settings, language, and
  // the judge model with its parameters. Floors, budgets and selection limits stay out of it.
  const mode = config.sourceJudge.mode;
  const judgeIdentity = (model: Route) => {
    const prompts = changedPromptIdentity(sourceDecisionPromptIds[mode]);
    return hash({
      version: sourceJudgePromptVersions[mode],
      ...taskDefaultsIdentity(model),
      ...(prompts ? { prompts } : {}),
      language: options.contentLanguage,
      request: sourceJudgeRequestSettings(options.settings, config.sourceJudge),
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
  const initialRoute = await judgeRoute();
  // A route that resolves to a dedicated ranker is no judge: the contract is never sent to it.
  const usableRoute = (route: Route | null) =>
    route &&
    generativeDeciderCapabilities.some((capability) =>
      route.requiredCapabilities.includes(capability)
    )
      ? route
      : null;
  const configuration = usableRoute(initialRoute) ? judgeIdentity(initialRoute!) : null;
  const roots = await repository.roots(options.sourceIds);
  let persistedCount = 0,
    partial = false,
    inputTokens = 0,
    promoted = 0,
    retired = 0,
    discoveryDeferred = 0,
    discoveryWithoutVector = 0;
  const coverages: Array<SourceRelationCoverage | undefined> = [];
  const plans: Array<{
    root: string;
    state: RootState;
    save: () => Promise<void>;
    promoted: number;
  }> = [];
  const freshState = (): RootState => ({
    settings: options.settings,
    configuration: configuration ?? "no-judge",
    pairs: [],
    completed: [],
    attempts: {},
    inputTokens: 0,
    persistedCount: 0,
    partial: false,
    finished: false,
    totalPairs: 0
  });
  // A root whose discovery would need a judge that is not routed: nothing of it is planned.
  let judgeMissing = false;
  for (const root of roots) {
    signal?.throwIfAborted();
    const runKey = `${options.runKey}:${root}`;
    const saved = stateSchema.safeParse((await repository.runState(runKey)) ?? undefined);
    // A state of another judge configuration (or of the shortlist before design E) starts over: the
    // pair keys carry the configuration, so nothing is judged twice. Its discovery plan is kept: the
    // plan does not depend on the judge, and planning again would not select the reverse neighbours
    // whose bars the plan moved.
    const state =
      saved.success && saved.data.configuration === (configuration ?? "no-judge")
        ? saved.data
        : freshState();
    if (saved.success && state !== saved.data && saved.data.discovery?.status === "planned") {
      state.discovery = saved.data.discovery;
      state.totalPairs = saved.data.discovery.roots.length;
    }
    const save = () => repository.saveRun(runKey, root, state);
    // (1) Promotion, with no call; idempotent, so a resumed run promotes again at no cost.
    const promotion = await repository.promoteFromNotes(root);
    promoted += promotion.promoted + promotion.refreshed;
    retired += promotion.retired;
    // A deferred discovery, or one without a composite vector, is no plan: a later call plans it
    // (a hierarchy root once its last record has linked, a composite written since).
    if (state.discovery?.status !== "planned") {
      let discovery: RootState["discovery"];
      if (options.discovery === "defer")
        discovery = { status: "deferred", roots: [], candidates: 0 };
      else {
        const vector = await repository.discoveryVector(root);
        if (!vector) discovery = { status: "no_vector", roots: [], candidates: 0 };
        else {
          const input = {
            rootId: root,
            vector,
            fingerprint: await repository.fingerprint(root),
            neighbours: config.discovery.neighbours,
            owed: await repository.owedDiscoveryRoots(root, runKey),
            ...(options.fence ? { fence: options.fence } : {})
          };
          // Without a judge a plan would move the bars of its reverse neighbours and never judge
          // them: a root with pairs to judge plans nothing, and the run fails visibly below.
          if (!configuration && (await repository.previewDiscovery(input)).pairs.length) {
            judgeMissing = true;
            continue;
          }
          // (2) Discovery: planned, and its state stored, in one transaction per space.
          const plan = await repository.planDiscovery(input);
          discovery = {
            status: "planned",
            roots: plan.pairs.map((pair) => pair.rootId),
            candidates: plan.candidates
          };
        }
      }
      if (discovery.status === "planned") {
        // A root finished without a plan has its pairs to judge now.
        state.finished = false;
        delete state.coverage;
      }
      state.discovery = discovery;
      state.totalPairs = discovery.roots.length;
      await save();
    }
    if (state.discovery?.status === "deferred") discoveryDeferred += 1;
    if (state.discovery?.status === "no_vector") discoveryWithoutVector += 1;
    plans.push({ root, state, save, promoted: promotion.promoted + promotion.refreshed });
  }
  if (judgeMissing) throw new Error("errors.ai.noCompatibleModel");
  let total = plans.reduce((sum, plan) => sum + plan.state.totalPairs, 0);
  let done = plans.reduce(
    (sum, plan) =>
      sum + (plan.state.finished ? plan.state.totalPairs : plan.state.completed.length),
    0
  );
  const report = () =>
    options.onProgress?.(total > 0 ? done / total : 1, { completed: done, total });
  await report();
  for (const { root, state, save, promoted: rootPromoted } of plans) {
    signal?.throwIfAborted();
    if (!state.finished) {
      const settings = state.settings;
      const coverage: SourceRelationCoverage = {
        judgedPairs: 0,
        candidatePairs: state.discovery?.roots.length ?? 0,
        budgetExhausted: false,
        promoted: rootPromoted
      };
      // (3) The pair key keeps only what changes the judge (D27); it never names the other pairs
      // that share the root's call (D21), so a pair is decided once whatever it was asked beside.
      const pending: Array<{ candidate: string; key: string }> = [];
      for (const candidate of state.discovery?.roots ?? []) {
        signal?.throwIfAborted();
        if (!configuration) throw new Error("errors.ai.noCompatibleModel");
        const key = hash({
          roots: [root, candidate].sort(),
          configuration,
          inputs: await Promise.all(
            [root, candidate].sort().map((id) => repository.fingerprint(id))
          ),
          notes: (await repository.pairNoteFingerprints(root, candidate)).toSorted(),
          regeneration: options.regenerate ? options.runKey : null
        });
        if (state.completed.includes(key)) {
          // Judged before this run resumed: already counted as done.
          coverage.judgedPairs++;
          continue;
        }
        const decided = await repository.decision(key);
        if (decided) {
          // Decided under the same key by an earlier run (or the other root): reused, no call. A
          // pair this run asked about committed before its checkpoint was saved: recovered.
          if (state.pairs.includes(key))
            state.persistedCount += Number(decided.persistedCount ?? 0);
          state.completed.push(key);
          coverage.judgedPairs++;
          done++;
          await save();
          await report();
          continue;
        }
        pending.push({ candidate, key });
      }
      // The undecided pairs are judged together, one call for the root (D21), under the in-flight
      // registry by pair key (D24): a pair another job is judging is waited for and then read from
      // that job's decision; each round judges only the pairs nobody has decided.
      const rounds = pending.length
        ? await registry.run(
            pending.map((pair) => judgingKey(pair.key)),
            async (claimed) => {
              const outcomes = new Map<string, RootPairOutcome | "decided">();
              const undecided: typeof pending = [];
              for (const pair of pending.filter((p) => claimed.includes(judgingKey(p.key))))
                if (await repository.decision(pair.key)) outcomes.set(pair.key, "decided");
                else undecided.push(pair);
              if (undecided.length)
                for (const [key, outcome] of await judgeRoot({
                  ai,
                  repository,
                  root,
                  pairs: undecided,
                  state,
                  save,
                  settings,
                  configuration: configuration!,
                  currentConfiguration: async () => {
                    const route = usableRoute(await judgeRoute());
                    return route ? judgeIdentity(route) : null;
                  },
                  contentLanguage: options.contentLanguage,
                  judge: config.sourceJudge,
                  ...(signal ? { signal } : {}),
                  ...(options.context ? { context: options.context } : {})
                }))
                  outcomes.set(key, outcome);
              return outcomes;
            },
            signal
          )
        : [];
      const outcomes = new Map(rounds.flatMap((round) => [...round]));
      for (const { candidate, key } of pending) {
        const outcome = outcomes.get(key);
        if (outcome === "decided") {
          state.completed.push(key);
          coverage.judgedPairs++;
          done++;
        } else if (outcome === "no_evidence") {
          // Without evidence on both sides the pair cannot be judged, so it is no candidate (and a
          // resumed run does not look at it again).
          coverage.candidatePairs--;
          total--;
          state.totalPairs--;
          if (state.discovery)
            state.discovery.roots = state.discovery.roots.filter((id) => id !== candidate);
        } else if (outcome === "budget") {
          // Only a pair the input budget left incomplete is a failure to cover.
          state.partial = true;
          coverage.budgetExhausted = true;
        } else if (outcome === "judged") {
          coverage.judgedPairs++;
          done++;
        }
      }
      if (pending.length) {
        await save();
        await report();
      }
      state.finished = true;
      state.coverage = coverage;
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
    completed: done,
    total,
    promoted,
    retired,
    discoveryDeferred,
    discoveryWithoutVector
  };
}

/**
 * Re-promotes the roots of these sources (D27, R14): each root's pairs with every other root are
 * recomputed from the current typed shown note relations, with no call. What typing, a change of
 * type or direction, a review or a revert of note relations enqueues for both roots. A pair two of
 * the roots share is recomputed twice; the second pass changes nothing.
 */
export async function promoteSourceRelations(
  pool: PgPool,
  sourceIds: readonly string[]
): Promise<{ promoted: number; refreshed: number; retired: number }> {
  const repository = createSourceRelationRepository(pool);
  const totals = { promoted: 0, refreshed: 0, retired: 0 };
  for (const root of await repository.roots([...new Set(sourceIds)])) {
    const pass = await repository.promoteFromNotes(root);
    totals.promoted += pass.promoted;
    totals.refreshed += pass.refreshed;
    totals.retired += pass.retired;
  }
  return totals;
}

/** A pair of works one call judges: its key, the partner of the call's root, and its evidence. */
export interface SourceJudgePair {
  key: string;
  candidate: string;
  context: SourceRelationContext;
}

/** One call of the batched judge, as the asker hands it to its caller to make. */
export interface SourceJudgeCall {
  /** 0 for the root's call, 1 for the one repair that asks again about the pairs left open. */
  attempt: 0 | 1;
  pairs: readonly SourceJudgePair[];
  request: Required<SourceDecisionRequest>;
  /** The full prompt, the repair suffix included. */
  prompt: string;
  maxOutputTokens: number;
}

/** What the calls answered about one pair. */
export interface SourceJudgeAnswer {
  /** The pair's valid items, from every call that asked about it, in answer order. */
  items: SourceDecisionVerdict[];
  /** The last call that asked about the pair had the envelope and no malformed item that could be its. */
  clean: boolean;
  /** Malformed items that may have been meant for the pair, over its calls. */
  invalid: number;
  /** The calls that asked about it (indexes into the asker's calls), the final one last. */
  calls: number[];
}

/**
 * The calls a root's pairs are asked in (D21): the pairs in their partners' content order (root
 * title, then ID), at most `maxPairsPerCall` a call, so a hub root's pairs never share one huge
 * prompt; one pair a call under the judge mode `perPair`. The split never names a pair's key.
 */
export function sourceJudgeCalls<
  T extends { candidate: string; context: Pick<SourceRelationContext, "chunks"> }
>(
  pairs: readonly T[],
  judge: Pick<RelationsConfig["sourceJudge"], "mode" | "maxPairsPerCall">
): T[][] {
  const { roots } = aliasOrder(orderSourceRelationChunks(pairs.flatMap((p) => p.context.chunks)));
  const ordered = pairs.toSorted(
    (a, b) =>
      roots.indexOf(a.candidate) - roots.indexOf(b.candidate) ||
      compareContent(a.candidate, b.candidate)
  );
  const size = judge.mode === "perPair" ? 1 : Math.max(1, judge.maxPairsPerCall);
  const calls: T[][] = [];
  for (let start = 0; start < ordered.length; start += size)
    calls.push(ordered.slice(start, start + size));
  return calls;
}

/**
 * The batched source judge (D21): one call asks about the pairs of the root at once (at most
 * `maxPairsPerCall` of them, `sourceJudgeCalls`); items are split per pair by the two works they
 * join. A pair is settled by a clean answer (no malformed item could be its) or once its valid items
 * fill its allowance; the pairs left open (no envelope, or a malformed item that may have been
 * theirs) are asked about once more, together with the others of their call, with the repair suffix.
 * A pair that starts at attempt 1 (an earlier run had an answer about it) gets only that repair.
 * `call` makes the call, or returns null to stop before it (the input budget): its pairs then stay
 * unanswered (`stopped`). Valid items of the first answer are kept beside the repair's. `settle`
 * receives each answered pair once its answer is final, before any later call is made. Under the
 * judge mode `perPair` each pair is asked alone with F3's own prompt.
 */
export async function askSourceJudge(input: {
  root: string;
  pairs: readonly SourceJudgePair[];
  startAttempt?: (pair: SourceJudgePair) => 0 | 1;
  settings: Pick<
    SourceRelationSettings,
    "maxRelationsPerPair" | "maxOutputTokens" | "includeWeakTypes" | "summaryMaxCharacters"
  >;
  /** The mode and the pair cap of the run's typed configuration; the shipped ones when absent. */
  judge?: Pick<RelationsConfig["sourceJudge"], "mode" | "maxPairsPerCall">;
  call: (call: SourceJudgeCall) => Promise<{ output: unknown } | null>;
  settle?: (pair: SourceJudgePair, answer: SourceJudgeAnswer) => Promise<void>;
}): Promise<{
  answers: Map<string, SourceJudgeAnswer>;
  stopped: string[];
  parses: SourceDecisionParse[];
}> {
  const { root, settings } = input;
  const judge = input.judge ?? defaultRelationsConfig.sourceJudge;
  const allowance = sourceDecisionAllowance(settings);
  const answers = new Map<string, SourceJudgeAnswer>();
  const stopped: string[] = [];
  const parses: SourceDecisionParse[] = [];
  // The repair's feedback is its call's own: a same-work item in one call never words another's.
  let feedback = sourceJudgeValidation(judge.mode);
  const ask = async (attempt: 0 | 1, pairs: readonly SourceJudgePair[]) => {
    const request = sourceBatchRequest(root, pairs);
    const prompt = joinPrompts(
      sourceJudgePrompt(judge.mode, request, allowance, settings),
      attempt ? renderPrompt("sources.decide.repair", { validation_errors: feedback }) : ""
    );
    const execution = await input.call({
      attempt,
      pairs,
      request,
      prompt,
      maxOutputTokens: sourceDecisionMaxOutputTokens(settings, allowance * pairs.length)
    });
    if (!execution) {
      stopped.push(...pairs.map((pair) => pair.key));
      return;
    }
    const parsed = parseSourceDecision(execution.output, request, attempt);
    const index = parses.push(parsed) - 1;
    for (const pair of pairs) {
      const key = sourceRootPairKey(root, pair.candidate);
      const answer = answers.get(pair.key) ?? { items: [], clean: false, invalid: 0, calls: [] };
      answer.items.push(
        ...parsed.items.filter(
          (item) =>
            sourceRootPairKey(item.sourceChunks[0]!.rootId, item.targetChunks[0]!.rootId) === key
        )
      );
      const invalid = parsed.suspects.filter((suspects) => suspects.includes(key)).length;
      answer.invalid += invalid;
      answer.clean = parsed.answered && invalid === 0;
      answer.calls.push(index);
      answers.set(pair.key, answer);
    }
    if (parsed.sameRoot) feedback = renderPrompt("sources.validation.same_root");
  };
  const start = input.startAttempt ?? (() => 0 as const);
  for (const group of sourceJudgeCalls(input.pairs, judge)) {
    feedback = sourceJudgeValidation(judge.mode);
    const repair = group.filter((pair) => start(pair) === 1);
    const first = group.filter((pair) => start(pair) === 0);
    if (first.length) {
      await ask(0, first);
      for (const pair of first) {
        const answer = answers.get(pair.key);
        if (!answer) continue;
        // A clean answer, or one already holding all the relations the pair may keep, is final; a
        // final pair is settled before the repair is asked, so a failed repair cannot lose it.
        if (!answer.clean && distinctSourceVerdicts(answer.items) < allowance) repair.push(pair);
        else await input.settle?.(pair, answer);
      }
    }
    if (repair.length) {
      await ask(1, repair);
      for (const pair of repair) {
        const answer = answers.get(pair.key);
        if (answer && !stopped.includes(pair.key)) await input.settle?.(pair, answer);
      }
    }
  }
  return { answers, stopped, parses };
}

type RootPairOutcome = "judged" | "no_evidence" | "budget";
type JudgeExecution = NonNullable<Awaited<ReturnType<AiService["runDefaultTask"]>>>;

/**
 * Judges the undecided pairs of one root in one call (D21), one call per `maxPairsPerCall` pairs:
 * each pair's uncited note relations as hypotheses and its evidence passages, the union in one v6
 * prompt, at most one repair for the pairs left open, then one decision per pair committed with that
 * pair's raw items (`perPair`: F3's v5 call for each pair). `no_evidence`: fewer than two passages;
 * `budget`: the input budget stopped it before an answer. A pair whose answers keep nothing valid and
 * never settle fails the root visibly, after the others commit. An attempt counts once its call has
 * answered: a call that crashed, was cancelled or failed before its answer spends no pair's attempt.
 */
async function judgeRoot(input: {
  ai: Pick<AiService, "runDefaultTask">;
  repository: SourceRelationReader;
  root: string;
  pairs: ReadonlyArray<{ candidate: string; key: string }>;
  state: RootState;
  save: () => Promise<void>;
  settings: SourceRelationSettings;
  configuration: string;
  currentConfiguration: () => Promise<string | null>;
  contentLanguage: string;
  judge: RelationsConfig["sourceJudge"];
  signal?: AbortSignal;
  context?: AiTaskLogContext;
}): Promise<Map<string, RootPairOutcome>> {
  const { ai, repository, root, state, save, settings, signal } = input;
  const promptVersion = sourceJudgePromptVersions[input.judge.mode];
  const outcomes = new Map<string, RootPairOutcome>();
  const pairs: SourceJudgePair[] = [];
  for (const pair of input.pairs) {
    const notes = await repository.pairNotes(
      root,
      pair.candidate,
      input.judge.noteRelationsPerPair
    );
    const context = await sourcePairContext(
      repository,
      root,
      pair.candidate,
      notes,
      settings,
      input.judge
    );
    if (context) pairs.push({ ...pair, context });
    else outcomes.set(pair.key, "no_evidence");
  }
  // A pair already asked about twice in this run state is not asked again: it fails.
  const failed = pairs.filter((pair) => (state.attempts[pair.key] ?? 0) >= 2).map((p) => p.key);
  const asked = pairs.filter((pair) => !failed.includes(pair.key));
  const executions: Array<{ execution: JudgeExecution; pairs: number }> = [];
  const allowance = sourceDecisionAllowance(settings);
  /** Commits a pair once its answer is final: one decision with that pair's own raw items. */
  const settle = async (pair: SourceJudgePair, answer: SourceJudgeAnswer) => {
    // Answers that keep nothing valid and never settle fail the pair visibly: committing them would
    // cache "no relation" for a pair the decider did not decide.
    if (!answer.items.length && !answer.clean) {
      failed.push(pair.key);
      return;
    }
    signal?.throwIfAborted();
    const calls = answer.calls.map((index) => executions[index]!);
    const final = calls.at(-1)!;
    const output = sourceRelationWrites(
      answer.items,
      pair.context,
      settings,
      allowance,
      input.judge
    );
    const created = await repository.commitDecision(
      pair.key,
      root,
      pair.candidate,
      output.relations,
      {
        promptVersion,
        profileId: final.execution.profileId,
        model: final.execution.modelId,
        provider: final.execution.providerId,
        runtime: final.execution.runtime,
        aiTaskRunId: final.execution.aiTaskRunId,
        aiTaskRunIds: calls.flatMap(({ execution }) =>
          execution.aiTaskRunId ? [execution.aiTaskRunId] : []
        ),
        configuration: input.configuration,
        // The final call's usage, which every pair it judged shares (`callPairs`).
        inputTokens: final.execution.inputTokens ?? null,
        outputTokens: final.execution.outputTokens ?? null,
        callPairs: final.pairs,
        contentLanguage: input.contentLanguage,
        proposals: output.proposals,
        // Raw verdicts apart from the floors: the floors can be tuned again without calls.
        items: output.records,
        floors: {
          minImportance: settings.minImportance,
          minConfidence: settings.minConfidence,
          includeWeakTypes: settings.includeWeakTypes
        },
        invalidItems: answer.invalid
      }
    );
    state.persistedCount += created;
    state.completed.push(pair.key);
    await save();
    outcomes.set(pair.key, "judged");
  };
  const result = await askSourceJudge({
    root,
    pairs: asked,
    settle,
    startAttempt: (pair) => ((state.attempts[pair.key] ?? 0) >= 1 ? 1 : 0),
    settings,
    judge: input.judge,
    call: async (call) => {
      // Allow the current call to exceed the budget; stop only subsequent calls.
      if (state.inputTokens > settings.maxInputTokens) return null;
      if ((await input.currentConfiguration()) !== input.configuration)
        throw new Error("errors.sourceRelations.configurationChanged");
      // A pair asked about may commit before the checkpoint is saved; its decision is recovered.
      for (const pair of call.pairs)
        if (!state.pairs.includes(pair.key)) state.pairs.push(pair.key);
      await save();
      const execution = await ai.runDefaultTask(
        "reranking",
        call.prompt,
        {
          ...input.context,
          operation: sourceMatchingOperation,
          stage: "sourceMatching",
          workloadClass: "decide",
          priority: "P2",
          // The link job's wrapper states its own class; an imported source's judge runs for its user.
          budgetClass: input.context?.budgetClass ?? "user",
          contentLanguage: input.contentLanguage,
          promptVersion,
          sourceItemIds: [
            ...new Set([
              root,
              ...call.pairs.map((pair) => pair.candidate),
              ...call.request.chunks.map((chunk) => chunk.sourceItemId)
            ])
          ],
          attempt: call.attempt,
          // The second call asks again after an answer that failed validation: a repair (D35).
          isRepair: call.attempt > 0
        },
        signal,
        { maxOutputTokens: call.maxOutputTokens }
      );
      if (!execution) throw new Error("errors.ai.noCompatibleModel");
      // The call answered: each of its pairs has spent this attempt, whatever the answer holds. A
      // call that threw before (a crash, a cancel, a transient error) leaves every first attempt.
      for (const pair of call.pairs) state.attempts[pair.key] = call.attempt + 1;
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
      executions.push({ execution, pairs: call.pairs.length });
      return execution;
    }
  });
  for (const key of result.stopped) outcomes.set(key, "budget");
  if (failed.length) throw new Error("errors.sourceRelations.invalidOutput");
  return outcomes;
}
