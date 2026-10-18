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
 * relation with no call; (2) discovery selects the root's nearest earlier root and its reverse neighbours on the stored
 * composite vectors; (3) each selected unordered pair is judged once with the compact, score-only
 * `source-relations-v5` verdict: at most two `[from, to, type, importance, confidence, [from
 * chunks], [to chunks]]` items per pair and no prose. Explanations are written when the owner opens
 * a relation. Promoted and judged relations alike are suggestions until the owner keeps them
 * (decision 29).
 */
export const sourceRelationPromptVersion = "source-relations-v5";
export const sourceMatchingOperation = "source_relation_matching";
/** Every catalog prompt the source decision is composed of: its identity is in the pair key. */
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
  const judgeIdentity = (model: Route) => {
    const prompts = changedPromptIdentity(sourceDecisionPromptIds);
    return hash({
      version: sourceRelationPromptVersion,
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
  // A route that resolves to a dedicated ranker is no judge: the v5 contract is never sent to it.
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
      for (const candidate of state.discovery?.roots ?? []) {
        signal?.throwIfAborted();
        if (!configuration) throw new Error("errors.ai.noCompatibleModel");
        // (3) The pair key keeps only what changes the judge (D27).
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
        // The pair is judged under the in-flight registry (D24): while another job judges it this
        // one waits, then reads that job's decision; it judges only a pair nobody has decided.
        const [outcome] = await registry.run(
          [judgingKey(key)],
          async () =>
            (await repository.decision(key))
              ? ("decided" as const)
              : judgePair({
                  pool,
                  ai,
                  repository,
                  root,
                  candidate,
                  key,
                  state,
                  save,
                  settings,
                  configuration,
                  currentConfiguration: async () => {
                    const route = usableRoute(await judgeRoute());
                    return route ? judgeIdentity(route) : null;
                  },
                  contentLanguage: options.contentLanguage,
                  judge: config.sourceJudge,
                  ...(signal ? { signal } : {}),
                  ...(options.context ? { context: options.context } : {})
                }),
          signal
        );
        if (outcome === "decided") {
          state.completed.push(key);
          coverage.judgedPairs++;
          done++;
          await save();
          await report();
          continue;
        }
        if (outcome === "no_evidence") {
          // Without evidence on both sides the pair cannot be judged, so it is no candidate (and a
          // resumed run does not look at it again).
          coverage.candidatePairs--;
          total--;
          state.totalPairs--;
          if (state.discovery)
            state.discovery.roots = state.discovery.roots.filter((id) => id !== candidate);
          await save();
          await report();
          continue;
        }
        if (outcome === "budget") {
          // Only a pair the input budget left incomplete is a failure to cover.
          state.partial = true;
          coverage.budgetExhausted = true;
          break;
        }
        coverage.judgedPairs++;
        done++;
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

/**
 * Judges one pair of works once (D27): its uncited note relations as hypotheses, the evidence
 * passages, the v5 prompt, at most one repair, then one decision committed with every raw item.
 * `no_evidence`: fewer than two passages; `budget`: the input budget stopped it before an answer.
 */
async function judgePair(input: {
  pool: PgPool;
  ai: Pick<AiService, "runDefaultTask">;
  repository: SourceRelationReader;
  root: string;
  candidate: string;
  key: string;
  state: RootState;
  save: () => Promise<void>;
  settings: SourceRelationSettings;
  configuration: string;
  currentConfiguration: () => Promise<string | null>;
  contentLanguage: string;
  judge: RelationsConfig["sourceJudge"];
  signal?: AbortSignal;
  context?: AiTaskLogContext;
}): Promise<"judged" | "no_evidence" | "budget"> {
  const { ai, repository, root, candidate, key, state, save, settings, signal } = input;
  const notes = await repository.pairNotes(root, candidate, input.judge.noteRelationsPerPair);
  const context = await sourcePairContext(
    repository,
    root,
    candidate,
    notes,
    settings,
    input.judge
  );
  if (!context) return "no_evidence";
  const { chunks } = context;
  const allowance = sourceDecisionAllowance(settings);
  const prompt = sourceDecisionPrompt(
    context,
    allowance,
    settings.includeWeakTypes,
    settings.summaryMaxCharacters
  );
  let validationFeedback = renderPrompt("sources.validation.default");
  if ((state.attempts[key] ?? 0) >= 2) throw new Error("errors.sourceRelations.invalidOutput");
  const answers: SourceDecisionParse[] = [];
  let finalExecution: Awaited<ReturnType<typeof ai.runDefaultTask>> = null;
  const aiTaskRunIds: string[] = [];
  while ((state.attempts[key] ?? 0) < 2) {
    const attempt = (state.attempts[key] ?? 0) as 0 | 1;
    const request = joinPrompts(
      prompt,
      attempt
        ? renderPrompt("sources.decide.repair", { validation_errors: validationFeedback })
        : ""
    );
    // Allow the current call to exceed the budget; stop only subsequent calls.
    if (state.inputTokens > settings.maxInputTokens) return "budget";
    if ((await input.currentConfiguration()) !== input.configuration)
      throw new Error("errors.sourceRelations.configurationChanged");
    if (!state.pairs.includes(key)) state.pairs.push(key);
    state.attempts[key] = attempt + 1;
    await save();
    const execution = await ai.runDefaultTask(
      "reranking",
      request,
      {
        ...input.context,
        operation: sourceMatchingOperation,
        stage: "sourceMatching",
        workloadClass: "decide",
        priority: "P2",
        contentLanguage: input.contentLanguage,
        promptVersion: sourceRelationPromptVersion,
        sourceItemIds: [
          ...new Set([root, candidate, ...chunks.map((chunk) => chunk.sourceItemId)])
        ],
        attempt
      },
      signal,
      { maxOutputTokens: sourceDecisionMaxOutputTokens(settings, allowance) }
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
  if (!last || !finalExecution) throw new Error("errors.sourceRelations.invalidOutput");
  // Answers that keep nothing valid and never settle fail the pair visibly: committing them would
  // cache "no relation" for a pair the decider did not decide.
  if (!items.length && !(last.answered && last.invalid === 0))
    throw new Error("errors.sourceRelations.invalidOutput");
  signal?.throwIfAborted();
  const output = sourceRelationWrites(items, context, settings, allowance, input.judge);
  const created = await repository.commitDecision(key, root, candidate, output.relations, {
    promptVersion: sourceRelationPromptVersion,
    profileId: finalExecution.profileId,
    model: finalExecution.modelId,
    provider: finalExecution.providerId,
    runtime: finalExecution.runtime,
    aiTaskRunId: finalExecution.aiTaskRunId,
    aiTaskRunIds,
    configuration: input.configuration,
    inputTokens: finalExecution.inputTokens ?? null,
    outputTokens: finalExecution.outputTokens ?? null,
    contentLanguage: input.contentLanguage,
    proposals: output.proposals,
    // Raw verdicts apart from the floors: the floors can be tuned again without calls.
    items: output.records,
    floors: {
      minImportance: settings.minImportance,
      minConfidence: settings.minConfidence,
      includeWeakTypes: settings.includeWeakTypes
    },
    invalidItems: answers.reduce((sum, answer) => sum + answer.invalid, 0)
  });
  state.persistedCount += created;
  state.completed.push(key);
  await save();
  return "judged";
}
