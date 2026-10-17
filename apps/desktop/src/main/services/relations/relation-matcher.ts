// Relations v2 for one source (F3 T51, spec 3.8): retrieve, filter, decide, calibrate and band.
//
// For each note, in content order: candidates come from SQL only (vector, text and graph lists
// fused by RRF into K, plus the reverse guard of D19); lossless filters drop the note's human-
// decided and already-related pairs; the decision cache (D13) answers every direction it holds;
// the decider scores the rest. The default decider is the validated local ranker on
// `class:decide`, scoring both directions of every pending pair in `rankPairs` calls; the
// generative decider (the v9 decide-only call) serves the modes that allow it. Acceptance is the
// calibrated band alone (D17, D18); an uncalibrated decider only suggests. The step commits the
// raw decisions and the note's match state, then hands the accepted pairs on (`handOff`); the
// link job (T52) types and persists them.
import { sha256 } from "@app/conversion";
import {
  aggregateDirections,
  AtomicNoteMatchingSettingsSchema,
  AtomicNoteRelationTypeSchema,
  bandScore,
  findRelationCalibration,
  generativeDeciderCapabilities,
  NoteDeciderModeSchema,
  relationDecideContract,
  relationsConfig as defaultRelationsConfig,
  relationsDeciderModeSettingKey,
  renderRelationPairText,
  waitingForDeciderSkipReason,
  type AtomicNoteMatchingSettings,
  type AtomicNoteRelationType,
  type NoteDeciderMode,
  type NoteRelationWriteType,
  type RelationBandDecision,
  type RelationCalibrationEntry,
  type RelationCalibrationIdentity,
  type RelationCalibrationState,
  type RelationsConfig
} from "@app/domain";
import {
  aiRouteKeys,
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createKnowledgeGraphRepository,
  createLocalModelRepository,
  createNoteMatchStateRepository,
  createRelationDecisionRepository,
  createRelationMatchRunRepository,
  createSettingsRepository,
  createSimilarityDebugRepository,
  operationRouteKey,
  workloadClassRouteKey,
  type AtomicNoteRecord,
  type PgPool,
  type RelationDecisionInput,
  type RetrievalFence
} from "@app/db";
import {
  decideValidationForCatalogEntry,
  decideValidationParityFailed,
  findLocalModelCatalogEntry,
  isRankerCatalogEntry,
  rankerCatalogArtifactSha256
} from "@app/ai";

import type { AiService, AiTaskLogContext, DefaultAiTaskResult } from "../ai-service.js";
import { noteMatchDecisionOperations, withAiTaskParameterDefaults } from "../ai-task-parameters.js";
import { compareContent, contentKey } from "../content-order.js";
import {
  atomicNoteDeciderKey,
  atomicNoteDecisionContentHash,
  atomicNoteMatchingVersion,
  buildBatchRerankPrompt,
  fuseAtomicNoteCandidateRankings,
  mergeBatchRerankRepair,
  parseBatchRerankOutput,
  type BatchRerankDecision
} from "../knowledge-processing.js";
import { capturePromptPin, promptFingerprint, renderPrompt } from "../prompt-runtime.js";

/** The ranker operation of note decide: `op:relation_decide`, else `class:decide`. */
export const relationDecideOperation = "relation_decide";

/** Recorded on every relation the matcher hands on, and on its debug runs. */
export const relationMatcherVersion = "relations-v2-matcher-1";

/** The decider cache key format of D13 (v2: rendered input, runtime build, helper batch). */
const deciderCacheKeyVersion = "relation-decider-cache-key-v2";

/** The ranker instruction, rendered from the prompt catalog (`relations.decide.instruction`). */
export function relationDecideInstruction(): string {
  return renderPrompt("relations.decide.instruction");
}

// --- decider mode ---------------------------------------------------------------------------------

/** What the routes say about the deciders, for a profile whose mode is derived. */
export interface DeciderRouteFacts {
  /** `class:decide` (or `op:relation_decide`) holds a validated ranker, ready to score. */
  validatedRanker: boolean;
  /**
   * It holds a ranker that is not validated right now: one re-validates after a runtime-build
   * change (D13). Only a validated ranker is ever seeded there.
   */
  rankerValidating?: boolean;
  /** The `reranking` task route holds a generative model: the profile's pre-F3 decider. */
  generativeRerankingRoute: boolean;
}

/**
 * The note decider mode of a profile with no preset (D16, R3): `ranker` when a validated ranker
 * serves `class:decide`; otherwise `ranker-else-generative` when the `reranking` task route holds
 * a generative model (its pre-F3 decider, so every effective model stays the same); otherwise
 * `ranker`. A ranker that re-validates is still the profile's decider: matching waits for it (spec
 * 3.8 step 7) instead of switching deciders for the length of a validation. It is derived at every
 * matching admission, so a ranker validated later switches the profile to `ranker` without a write.
 */
export function deriveDeciderMode(facts: DeciderRouteFacts): NoteDeciderMode {
  if (facts.validatedRanker || facts.rankerValidating) return "ranker";
  return facts.generativeRerankingRoute ? "ranker-else-generative" : "ranker";
}

// --- identities -----------------------------------------------------------------------------------

/** The model identity of a catalog ranker on this install (D13). */
export interface RankerModelIdentity {
  provider: string;
  /** The catalog id: the same on every install of the model. */
  model: string;
  runtimeKind: "mlx" | "gguf";
  repository: string;
  revision: string;
  quantization: string;
  artifactSha256: string;
}

/**
 * The decider cache key v2 (D13): contract, instruction text, text template and body length, the
 * model identity, the runtime build and the effective parameters, the helper batch size included.
 * A stored score is reused only under an equal key and equal rendered-input hashes.
 */
export function rankerDeciderCacheKey(input: {
  instructionSha256: string;
  template: string;
  bodyCharacters: number;
  model: RankerModelIdentity;
  runtimeBuild: string | null;
  parameters: { batchSize?: number };
}): string {
  const { model } = input;
  return sha256(
    JSON.stringify({
      version: deciderCacheKeyVersion,
      contract: relationDecideContract,
      instruction: input.instructionSha256,
      template: [input.template, input.bodyCharacters],
      model: [
        model.provider,
        model.model,
        model.runtimeKind,
        model.repository,
        model.revision,
        model.quantization,
        model.artifactSha256
      ],
      runtimeBuild: input.runtimeBuild,
      parameters:
        input.parameters.batchSize === undefined ? {} : { batchSize: input.parameters.batchSize }
    })
  );
}

/**
 * The calibration identity of a ranker decider (D13): no runtime build and no batch size, so a
 * rebuilt helper or another batch keeps its calibration while the parity check passes.
 */
export function rankerCalibrationIdentity(input: {
  instructionSha256: string;
  config: Pick<RelationsConfig, "decide">;
  model: RankerModelIdentity;
}): RelationCalibrationIdentity {
  return {
    contract: relationDecideContract,
    instructionSha256: input.instructionSha256,
    template: input.config.decide.template,
    bodyCharacters: input.config.decide.bodyCharacters,
    rule: input.config.decide.rule,
    provider: input.model.provider,
    model: input.model.model,
    runtimeKind: input.model.runtimeKind,
    repository: input.model.repository,
    revision: input.model.revision,
    quantization: input.model.quantization,
    artifactSha256: input.model.artifactSha256
  };
}

/**
 * The write type a generative (v9) verdict keeps (D20): one that maps into the write vocabulary
 * (`contrasts` is written as `contradicts`); `similar_to`, `mentions` and `related` go to the typer
 * (`similar_to` never becomes `same_as`, D10).
 */
export function mapGenerativeRelationType(
  type: AtomicNoteRelationType
): NoteRelationWriteType | null {
  switch (type) {
    case "supports":
    case "extends":
    case "depends_on":
    case "clarifies":
      return type;
    case "contrasts":
      return "contradicts";
    default:
      return null;
  }
}

// --- public shapes --------------------------------------------------------------------------------

/** A note's matching vector and the embedding space it lives in. */
export interface MatcherNoteVector {
  embedding: number[];
  space: { model: string; provider: string; runtime: string; spaceKey: string };
}

/** The decider one matching admission uses. */
export type MatchDeciderSummary =
  | {
      kind: "ranker";
      mode: NoteDeciderMode;
      deciderKey: string;
      calibration: RelationCalibrationState;
      profileId: string;
      modelId: string;
    }
  | {
      kind: "generative";
      mode: NoteDeciderMode;
      deciderKey: string;
      calibration: "uncalibrated";
      profileId: string;
      modelId: string;
    };

/** An accepted pair of a decided note: in the accept band (applied or suggested). */
export interface DecidedPair {
  noteId: string;
  candidateId: string;
  candidateSourceItemId: string;
  band: "apply" | "suggest";
  /** The calibrated probability; null when the decider is provisional or uncalibrated. */
  probability: number | null;
  /** The banded score: `s` in log-odds for the ranker, the 0-1 verdict of the generative decider. */
  score: number;
  calibration: RelationCalibrationState;
  /** The generative decider's type in the write vocabulary; null: the typer types the pair. */
  relationType: NoteRelationWriteType | null;
  /** The judged subject of a generative verdict; null for the ranker (the typer decides). */
  subjectId: string | null;
  decisionSource: "model" | "cache" | "reverse_cache";
  vectorScore: number | null;
  graphScore: number | null;
}

export interface DecidedNote {
  noteId: string;
  sourceItemId: string;
  decider: MatchDeciderSummary;
  pairs: DecidedPair[];
}

/**
 * Hands one decided note's accepted pairs on, after its decisions and match state are committed and
 * before its checkpoint, and resolves to the relations it persisted. The link job of T52 takes this
 * over; until then the interim hand-off persists them (see {@link persistDecidedPairs}).
 */
export type DecidedNoteHandOff = (note: DecidedNote) => Promise<number>;

export interface MatchNotesInput {
  noteIds: readonly string[];
  /** The notes' matching vectors (KnowledgeService embeds a note that has none). */
  vectors: ReadonlyMap<string, MatcherNoteVector>;
  signal?: AbortSignal | undefined;
  logContext?: AiTaskLogContext;
  onProgress?: ((progress: number) => void | Promise<void>) | undefined;
  /** Called once a note is decided and handed on: a resumable checkpoint. */
  onNoteCompleted?: ((noteId: string, persistedCount: number) => void | Promise<void>) | undefined;
  /** The visibility fence of a re-match run (3.17): retrieval sees only these roots. */
  fence?: RetrievalFence | undefined;
  handOff: DecidedNoteHandOff;
}

/** A type, not an interface: the stage checkpoint stores it as a JSON record. */
export type MatchNotesResult = {
  persistedCount: number;
  /** Notes decided (with or without a model call). */
  decided: number;
  /** Accepted pairs handed on. */
  accepted: number;
  /** Set when no call was made because mode `ranker` has no validated ranker (C7). */
  skipped?: typeof waitingForDeciderSkipReason;
  decider: MatchDeciderSummary["kind"] | null;
};

export interface RelationMatcherOptions {
  getPool: () => PgPool | null;
  ai: Pick<AiService, "rankPairs" | "runDefaultTask" | "decideRouteStatus" | "traceOperation">;
  config?: RelationsConfig;
  /** The generative decider's output budget; the rest of these settings no longer decide anything. */
  getAtomicNoteMatchingSettings?: () => Promise<AtomicNoteMatchingSettings>;
  isDebugEnabled?: () => Promise<boolean>;
}

// --- internal shapes ------------------------------------------------------------------------------

interface RankerDecider {
  kind: "ranker";
  mode: NoteDeciderMode;
  profileId: string;
  modelId: string;
  model: RankerModelIdentity;
  runtimeBuild: string | null;
  parityFailed: boolean;
  instruction: string;
  instructionSha256: string;
  batchSize: number | undefined;
  perCall: number;
  cacheKey: string;
  calibration: RelationCalibrationEntry | null;
  uncalibratedPass: number;
}

interface GenerativeDecider {
  kind: "generative";
  mode: NoteDeciderMode;
  key: string;
  profileId: string;
  modelId: string;
}

type Decider = RankerDecider | GenerativeDecider;

interface Candidate {
  note: AtomicNoteRecord;
  contentKey: string;
  textRank: number | null;
  vectorRank: number | null;
  graphRank: number | null;
  textScore: number;
  vectorScore: number | null;
  graphScore: number | null;
  fusionScore: number;
  /** Added by the reverse guard (D19), not by the note's own fused list. */
  guard: boolean;
}

interface CandidateOutcome {
  candidate: Candidate;
  decisionSource: DecidedPair["decisionSource"] | "undecided";
  score: number | null;
  decision: RelationBandDecision | null;
  relationType: NoteRelationWriteType | null;
  subjectId: string | null;
}

const isCurrentNote = (note: AtomicNoteRecord) =>
  note.status !== "rejected" && note.status !== "archived" && note.supersessionStatus === "current";

const noteContentKey = (note: { title: string; ideaStatement: string }) =>
  contentKey(note.title, note.ideaStatement);

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

const errorText = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);

// --- the matcher ----------------------------------------------------------------------------------

export class RelationMatcher {
  private readonly config: RelationsConfig;

  public constructor(private readonly options: RelationMatcherOptions) {
    this.config = options.config ?? defaultRelationsConfig;
  }

  /**
   * Decides the given notes in order. Each note's decisions, match state and hand-off are done
   * before its checkpoint; a required decider that fails, or decides nothing, throws before it.
   */
  public async matchNotes(input: MatchNotesInput): Promise<MatchNotesResult> {
    const pool = this.requirePool();
    const logContext = input.logContext ?? {};
    const notes = createAtomicNoteRepository(pool);
    const decider = await this.resolveDecider();
    const result: MatchNotesResult = {
      persistedCount: 0,
      decided: 0,
      accepted: 0,
      decider: decider === waitingForDeciderSkipReason ? null : decider.kind
    };
    if (decider === waitingForDeciderSkipReason) {
      // Mode `ranker` with no validated ranker: no call, nothing written; the stage is skipped and
      // re-runs when a ranker validates (D16, C7).
      return { ...result, skipped: waitingForDeciderSkipReason };
    }
    const matchingSettings = AtomicNoteMatchingSettingsSchema.parse(
      (await this.options.getAtomicNoteMatchingSettings?.()) ?? {}
    );
    for (const [noteIndex, noteId] of input.noteIds.entries()) {
      input.signal?.throwIfAborted();
      const note = await notes.findById(noteId);
      if (!note || !isCurrentNote(note)) {
        await input.onProgress?.((noteIndex + 1) / input.noteIds.length);
        await input.onNoteCompleted?.(noteId, 0);
        continue;
      }
      const decided = await this.decideNote(note, decider, {
        vector: input.vectors.get(note.id),
        signal: input.signal,
        logContext,
        fence: input.fence,
        maxOutputTokens: matchingSettings.maxRerankOutputTokens
      });
      if (decided === waitingForDeciderSkipReason) {
        // The ranker went into validation during the run: the rest waits for it, like a skip.
        return { ...result, skipped: waitingForDeciderSkipReason };
      }
      result.decided += 1;
      result.accepted += decided.pairs.length;
      const persisted = decided.pairs.length > 0 ? await input.handOff(decided) : 0;
      result.persistedCount += persisted;
      await input.onProgress?.((noteIndex + 1) / input.noteIds.length);
      await input.onNoteCompleted?.(note.id, persisted);
    }
    return result;
  }

  /** Decides the current notes of one source item (a record, or a root's own notes). */
  public async matchSource(
    sourceItemId: string,
    input: Omit<MatchNotesInput, "noteIds">
  ): Promise<MatchNotesResult> {
    const notes = await createAtomicNoteRepository(this.requirePool()).listBySourceItem(
      sourceItemId
    );
    return this.matchNotes({
      ...input,
      noteIds: notes.filter(isCurrentNote).map((note) => note.id)
    });
  }

  // --- decider resolution -------------------------------------------------------------------------

  /** The decider of this admission, or the skip of mode `ranker` without a validated ranker. */
  private async resolveDecider(): Promise<Decider | typeof waitingForDeciderSkipReason> {
    const pool = this.requirePool();
    const stored = NoteDeciderModeSchema.safeParse(
      await createSettingsRepository(pool).get(relationsDeciderModeSettingKey)
    );
    const { ranker, validating } = await this.rankerDecider();
    const mode =
      stored.success && stored.data
        ? stored.data
        : deriveDeciderMode({
            validatedRanker: ranker !== null,
            rankerValidating: validating,
            generativeRerankingRoute: await this.generativeRerankingTaskRoute()
          });
    if (mode !== "generative" && ranker) return { ...ranker, mode };
    if (mode === "ranker") return waitingForDeciderSkipReason;
    const generative = await this.generativeDecider();
    // A required decider that cannot run fails visibly, before any checkpoint.
    if (!generative) throw new Error("errors.ai.noCompatibleModel");
    return { ...generative, mode };
  }

  /**
   * The validated ranker of `op:relation_decide` / `class:decide`, or null when none is ready;
   * `validating` when the route holds a ranker that is not validated right now.
   */
  private async rankerDecider(): Promise<{
    ranker: Omit<RankerDecider, "mode"> | null;
    validating: boolean;
  }> {
    const pool = this.requirePool();
    const none = { ranker: null, validating: false };
    const routeKeys = [operationRouteKey(relationDecideOperation), workloadClassRouteKey("decide")];
    const route = await createAiConfigRepository(pool).getDefaultTask(
      workloadClassRouteKey("decide"),
      undefined,
      routeKeys
    );
    if (!route?.localModelId) return none;
    // Validation, a validation in progress and the model's files are the AI service's to judge.
    const status = await this.options.ai.decideRouteStatus(relationDecideOperation, "pairs");
    if (status !== "ready") return { ranker: null, validating: status === "not_validated" };
    const record = await createLocalModelRepository(pool).findById(route.localModelId);
    const entry = record ? findLocalModelCatalogEntry(record.catalogId) : undefined;
    if (!record || !entry || !isRankerCatalogEntry(entry)) return none;
    const runtimeKind = entry.runtime === "mlx" ? "mlx" : "gguf";
    const model: RankerModelIdentity = {
      provider: "local",
      model: entry.id,
      runtimeKind,
      repository: entry.repository,
      revision: entry.revision,
      quantization: entry.quantization,
      artifactSha256: rankerCatalogArtifactSha256(entry)
    };
    const instruction = relationDecideInstruction();
    const instructionSha256 = sha256(instruction);
    const batchSize = runtimeKind === "mlx" ? this.config.decide.helperBatchSize : undefined;
    const runtimeBuild =
      decideValidationForCatalogEntry(record.metadata.decideValidation, entry)?.runtimeBuild ??
      null;
    const calibration = findRelationCalibration(
      this.config,
      rankerCalibrationIdentity({ instructionSha256, config: this.config, model })
    );
    const ranker: Omit<RankerDecider, "mode"> = {
      kind: "ranker",
      profileId: route.profileId,
      modelId: route.modelId,
      model,
      runtimeBuild,
      parityFailed: decideValidationParityFailed(record.metadata.decideValidation),
      instruction,
      instructionSha256,
      batchSize,
      perCall: this.config.decide.rankPairsPerCall[runtimeKind],
      cacheKey: rankerDeciderCacheKey({
        instructionSha256,
        template: this.config.decide.template,
        bodyCharacters: this.config.decide.bodyCharacters,
        model,
        runtimeBuild,
        parameters: batchSize === undefined ? {} : { batchSize }
      }),
      calibration,
      uncalibratedPass: this.config.decide.uncalibratedPass.logOdds[runtimeKind]
    };
    return { ranker, validating: false };
  }

  /** Whether the `reranking` task route itself holds a generative model (mode derivation). */
  private async generativeRerankingTaskRoute(): Promise<boolean> {
    const route = await createAiConfigRepository(this.requirePool()).getDefaultTask("reranking");
    return Boolean(route && isGenerativeRoute(route.requiredCapabilities));
  }

  /**
   * The generative decider as its call resolves it: `op:note_matching_reranking`, the stated class
   * `class:decide`, then the `reranking` task route (D16). A route that resolves to a dedicated
   * ranker is no generative decider: the v9 contract is never sent to a ranker.
   */
  private async generativeDecider(): Promise<Omit<GenerativeDecider, "mode"> | null> {
    const route = await createAiConfigRepository(this.requirePool()).getDefaultTask(
      "reranking",
      undefined,
      aiRouteKeys("reranking", {
        operation: noteMatchDecisionOperations.decide,
        workloadClass: "decide"
      })
    );
    if (!route || !isGenerativeRoute(route.requiredCapabilities)) return null;
    return {
      kind: "generative",
      key: atomicNoteDeciderKey({
        provider: route.provider,
        baseUrl: route.baseUrl,
        modelId: route.modelId,
        runtime: route.runtime,
        repository: route.repository,
        revision: route.revision,
        quantization: route.quantization,
        parameters: withAiTaskParameterDefaults(
          "reranking",
          { ...route.modelDefaultParameters, ...route.parameters },
          Boolean(route.localModelId),
          { operation: noteMatchDecisionOperations.decide }
        ),
        promptFingerprint: promptFingerprint(["notes.match"], capturePromptPin(), route.provider)
      }),
      profileId: route.profileId,
      modelId: route.modelId
    };
  }

  // --- one note -----------------------------------------------------------------------------------

  private async decideNote(
    note: AtomicNoteRecord,
    decider: Decider,
    context: {
      vector: MatcherNoteVector | undefined;
      signal: AbortSignal | undefined;
      logContext: AiTaskLogContext;
      fence: RetrievalFence | undefined;
      maxOutputTokens: number;
    }
  ): Promise<DecidedNote | typeof waitingForDeciderSkipReason> {
    const { candidates, kthCosine, graphError } = await this.retrieve(note, context);
    const outcomes =
      decider.kind === "ranker"
        ? await this.decideWithRanker(note, candidates, decider, context)
        : await this.decideGeneratively(note, candidates, decider, context);
    if (outcomes === waitingForDeciderSkipReason) return outcomes;
    // The note is decided: its k-th vector cosine opens the reverse guard to later notes (D19).
    if (context.vector)
      await createNoteMatchStateRepository(this.requirePool()).record({
        noteId: note.id,
        deciderKey: decider.kind === "ranker" ? decider.cacheKey : decider.key,
        spaceKey: context.vector.space.spaceKey,
        kthCosine
      });
    const summary = deciderSummary(decider);
    const accepted = outcomes
      .filter(
        (outcome): outcome is CandidateOutcome & { decision: RelationBandDecision } =>
          outcome.decision?.band === "apply" || outcome.decision?.band === "suggest"
      )
      .sort(
        (left, right) =>
          bandRank(left.decision.band) - bandRank(right.decision.band) ||
          (right.decision.probability ?? -1) - (left.decision.probability ?? -1) ||
          (right.score ?? 0) - (left.score ?? 0) ||
          compareContent(left.candidate.contentKey, right.candidate.contentKey) ||
          left.candidate.note.id.localeCompare(right.candidate.note.id)
      )
      .slice(0, this.config.maxShownPerNote);
    await this.recordDebug(note, context.vector, outcomes, accepted, summary, graphError);
    return {
      noteId: note.id,
      sourceItemId: note.createdFromSourceItemId,
      decider: summary,
      pairs: accepted.map((outcome) => ({
        noteId: note.id,
        candidateId: outcome.candidate.note.id,
        candidateSourceItemId: outcome.candidate.note.createdFromSourceItemId,
        band: outcome.decision.band as "apply" | "suggest",
        probability: outcome.decision.probability,
        score: outcome.score!,
        calibration: outcome.decision.calibration,
        relationType: outcome.relationType,
        subjectId: outcome.subjectId,
        decisionSource: outcome.decisionSource as DecidedPair["decisionSource"],
        vectorScore: outcome.candidate.vectorScore,
        graphScore: outcome.candidate.graphScore
      }))
    };
  }

  /**
   * The note's candidates (D17, D19, D28): the vector, text and graph lists fused by RRF into K,
   * plus every earlier decided note among the vector top guardFactor x K whose own k-th cosine
   * this note reaches. Excluded: notes that are not current and the fence's hidden roots, inside
   * each signal before fusion so they take no slot; then pairs a person decided or that already
   * have a relation (any state, vetoed included), after it, so a note's K is the same on a re-run.
   */
  private async retrieve(
    note: AtomicNoteRecord,
    context: {
      vector: MatcherNoteVector | undefined;
      fence: RetrievalFence | undefined;
    }
  ): Promise<{ candidates: Candidate[]; kthCosine: number | null; graphError: string | null }> {
    const pool = this.requirePool();
    const notes = createAtomicNoteRepository(pool);
    const retrieval = this.config.retrieval;
    const fence = context.fence ? { fence: context.fence } : {};
    const vector = context.vector;
    const space = vector
      ? {
          embeddingModel: vector.space.model,
          embeddingSpaceKey: vector.space.spaceKey,
          embeddingProvider: vector.space.provider,
          embeddingRuntime: vector.space.runtime
        }
      : {};
    const textList =
      retrieval.textK > 0
        ? await notes.findTextMatchingCandidates({
            noteId: note.id,
            limit: retrieval.textK,
            ...fence
          })
        : [];
    const vectorList = vector
      ? await notes.findVectorMatchingCandidates({
          noteId: note.id,
          embedding: vector.embedding,
          ...space,
          limit: retrieval.vectorK,
          ...fence
        })
      : [];
    let graphList: Awaited<
      ReturnType<ReturnType<typeof createKnowledgeGraphRepository>["findAtomicNoteCandidates"]>
    > = [];
    let graphError: string | null = null;
    if (retrieval.graphK > 0) {
      try {
        graphList = await createKnowledgeGraphRepository(pool).findAtomicNoteCandidates(
          note.id,
          retrieval.graphPoolK
        );
      } catch (error) {
        // The graph signal is absent, never a failure of matching.
        graphError = errorText(error);
      }
    }
    if (graphList.length > 0) {
      // The AGE paths keep archived, superseded and hidden notes: the text and vector queries'
      // exclusions are applied to the deeper list in SQL, then it is cut to graphK.
      const retrievable = await notes.filterRetrievableCandidateIds({
        candidateIds: graphList.map((candidate) => candidate.noteId),
        ...fence
      });
      graphList = graphList
        .filter((candidate) => retrievable.has(candidate.noteId))
        .slice(0, retrieval.graphK);
    }
    const fused = fuseAtomicNoteCandidateRankings(
      textList.map((candidate) => ({
        noteId: candidate.note.id,
        contentKey: noteContentKey(candidate.note),
        score: candidate.textScore
      })),
      vectorList.map((candidate) => ({
        noteId: candidate.note.id,
        contentKey: noteContentKey(candidate.note),
        score: candidate.vectorScore
      })),
      graphList.map((candidate) => ({
        noteId: candidate.noteId,
        contentKey: candidate.contentKey,
        score: candidate.graphScore
      })),
      retrieval.fusedK,
      retrieval.minimumGraphOnly,
      retrieval.rrfK
    );
    const k = retrieval.fusedK;
    const kthCosine = vectorList.length >= k ? vectorList[k - 1]!.vectorScore : null;
    // The reverse guard (D19): earlier decided notes in the vector top guardFactor x K whose own
    // k-th cosine this note reaches (every later note, for one decided with fewer than K). The k-th
    // cosine is the one stored when x was decided, as D19 says. A refreshed one (x's k-th over the
    // notes released since) judges 14-22% fewer pairs on young libraries but loses more batch-mode
    // pairs, at one more vector query per guard note (T51's 200-order replay at K = 10).
    const fusedIds = new Set(fused.map((candidate) => candidate.noteId));
    const window = vectorList.slice(0, retrieval.guardFactor * k);
    const states: ReadonlyMap<string, { kthCosine: number | null }> =
      vector && window.length > 0
        ? await createNoteMatchStateRepository(pool).read(
            window.map((candidate) => candidate.note.id),
            vector.space.spaceKey
          )
        : new Map();
    const guardIds = window
      .filter((candidate) => {
        if (fusedIds.has(candidate.note.id)) return false;
        const state = states.get(candidate.note.id);
        return (
          state !== undefined &&
          (state.kthCosine === null || candidate.vectorScore >= state.kthCosine)
        );
      })
      .map((candidate) => candidate.note.id);
    const ids = [...fusedIds, ...guardIds];
    const scored = ids.length
      ? await notes.scoreMatchingCandidates({
          noteId: note.id,
          candidateIds: ids,
          ...(vector ? { embedding: vector.embedding } : {}),
          ...space
        })
      : [];
    const records = new Map(scored.map((candidate) => [candidate.note.id, candidate]));
    const statuses = await createAtomicNoteRelationRepository(pool).pairStatuses(note.id, ids);
    const fusedById = new Map(fused.map((candidate) => [candidate.noteId, candidate]));
    const vectorRanks = new Map(
      vectorList.map((candidate, index) => [candidate.note.id, index + 1])
    );
    const candidates: Candidate[] = [];
    for (const id of ids) {
      const record = records.get(id);
      // A pair a person decided, or one with a relation already, takes no part (lossless filters).
      if (!record || statuses.has(id) || !isCurrentNote(record.note)) continue;
      const fusedCandidate = fusedById.get(id);
      const hasVector = vector !== undefined && record.hasVector !== false;
      candidates.push({
        note: record.note,
        contentKey: noteContentKey(record.note),
        textRank: fusedCandidate?.textRank ?? null,
        vectorRank: fusedCandidate?.vectorRank ?? vectorRanks.get(id) ?? null,
        graphRank: fusedCandidate?.graphRank ?? null,
        textScore: record.textScore,
        vectorScore: hasVector ? record.vectorScore : null,
        graphScore: fusedCandidate?.graphScore ?? null,
        fusionScore: fusedCandidate?.fusionScore ?? 0,
        guard: !fusedCandidate
      });
    }
    // Content order, never the IDs: every request below is a function of content.
    candidates.sort(
      (left, right) =>
        compareContent(left.contentKey, right.contentKey) ||
        left.note.id.localeCompare(right.note.id)
    );
    return { candidates, kthCosine, graphError };
  }

  /**
   * Both directions of every candidate pair on the validated ranker (D16): stored scores under the
   * decider cache key and both rendered-input hashes are reused (D13), the rest is scored in one
   * `rankPairs` input, note -> candidate and candidate -> note side by side, so both directions
   * of a pair share one bounded call. Raw log-odds are recorded per direction.
   */
  private async decideWithRanker(
    note: AtomicNoteRecord,
    candidates: readonly Candidate[],
    decider: RankerDecider,
    context: { signal: AbortSignal | undefined; logContext: AiTaskLogContext }
  ): Promise<CandidateOutcome[] | typeof waitingForDeciderSkipReason> {
    const decisions = createRelationDecisionRepository(this.requirePool());
    const bodyCharacters = this.config.decide.bodyCharacters;
    const render = (record: AtomicNoteRecord) => {
      const text = renderRelationPairText(record, bodyCharacters);
      return { text, hash: sha256(text) };
    };
    const own = render(note);
    const pairs = candidates.map((candidate) => {
      const other = render(candidate.note);
      const noteIsLo = note.id < candidate.note.id;
      return {
        candidate,
        other,
        noteIsLo,
        lo: noteIsLo ? note.id : candidate.note.id,
        hi: noteIsLo ? candidate.note.id : note.id,
        loHash: noteIsLo ? own.hash : other.hash,
        hiHash: noteIsLo ? other.hash : own.hash
      };
    });
    const stored = await decisions.findRankerScores({
      deciderKey: decider.cacheKey,
      pairs: pairs.map((pair) => ({
        loAtomicNoteId: pair.lo,
        hiAtomicNoteId: pair.hi,
        loInputHash: pair.loHash,
        hiInputHash: pair.hiHash
      }))
    });
    const scores = new Map(
      pairs.map((pair) => {
        const found = stored.get(`${pair.lo}:${pair.hi}`);
        return [
          pair.candidate.note.id,
          { loToHi: found?.loToHi ?? null, hiToLo: found?.hiToLo ?? null }
        ];
      })
    );
    const fromCache = new Set(
      pairs
        .filter((pair) => {
          const value = scores.get(pair.candidate.note.id)!;
          return value.loToHi !== null && value.hiToLo !== null;
        })
        .map((pair) => pair.candidate.note.id)
    );
    // Directed pairs still to score, in the candidates' content order: note -> candidate, then back.
    const requests: Array<{
      pair: (typeof pairs)[number];
      direction: "loToHi" | "hiToLo";
      query: string;
      document: string;
    }> = [];
    for (const pair of pairs) {
      if (fromCache.has(pair.candidate.note.id)) continue;
      const value = scores.get(pair.candidate.note.id)!;
      const forward = pair.noteIsLo ? "loToHi" : "hiToLo";
      const backward = pair.noteIsLo ? "hiToLo" : "loToHi";
      if (value[forward] === null)
        requests.push({ pair, direction: forward, query: own.text, document: pair.other.text });
      if (value[backward] === null)
        requests.push({ pair, direction: backward, query: pair.other.text, document: own.text });
    }
    let uncalibrated = decider.parityFailed;
    if (requests.length > 0) {
      let ranked: Awaited<ReturnType<AiService["rankPairs"]>>;
      try {
        ranked = await this.options.ai.rankPairs(
          {
            operation: relationDecideOperation,
            instruction: decider.instruction,
            pairs: requests.map((request) => ({
              query: request.query,
              document: request.document
            })),
            ...(decider.batchSize === undefined ? {} : { helperBatchSize: decider.batchSize }),
            ...(context.logContext.priority ? { priority: context.logContext.priority } : {}),
            sourceIds: [
              ...new Set([
                note.createdFromSourceItemId,
                ...requests.map((request) => request.pair.candidate.note.createdFromSourceItemId)
              ])
            ],
            ...(context.logContext.jobId ? { jobId: context.logContext.jobId } : {}),
            stage: context.logContext.stage ?? "atomic_note_matching"
          },
          context.signal
        );
      } catch (error) {
        if (context.signal?.aborted) throw error;
        // A ranker that went into validation meanwhile: mode `ranker` waits for it (C7).
        if (
          decider.mode === "ranker" &&
          error instanceof Error &&
          error.message === "errors.localModels.rankerNotValidated"
        )
          return waitingForDeciderSkipReason;
        // A required decider fails visibly, before the checkpoint; the cause keeps a transient
        // failure retryable by the job supervisor.
        throw new Error("errors.matching.rerankingFailed", { cause: error });
      }
      if (ranked.logOdds.length !== requests.length)
        throw new Error("errors.matching.rerankingFailed");
      uncalibrated ||= ranked.uncalibrated;
      // The key the scores were made under: the build and batch the calls report.
      const recordedKey = rankerDeciderCacheKey({
        instructionSha256: decider.instructionSha256,
        template: this.config.decide.template,
        bodyCharacters,
        model: decider.model,
        runtimeBuild: ranked.runtimeBuild,
        parameters: ranked.parameters
      });
      const fresh = new Map<
        string,
        { loToHi: number | null; hiToLo: number | null; run: string | null }
      >();
      requests.forEach((request, index) => {
        const id = request.pair.candidate.note.id;
        const value = scores.get(id)!;
        const logOdds = ranked.logOdds[index]!;
        value[request.direction] = logOdds;
        const entry = fresh.get(id) ?? { loToHi: null, hiToLo: null, run: null };
        entry[request.direction] = logOdds;
        entry.run ??= ranked.aiTaskRunIds[Math.floor(index / decider.perCall)] ?? null;
        fresh.set(id, entry);
      });
      for (const pair of pairs) {
        const entry = fresh.get(pair.candidate.note.id);
        if (!entry) continue;
        await decisions.recordRankerScores({
          loAtomicNoteId: pair.lo,
          hiAtomicNoteId: pair.hi,
          loInputHash: pair.loHash,
          hiInputHash: pair.hiHash,
          deciderKey: recordedKey,
          loToHi: entry.loToHi,
          hiToLo: entry.hiToLo,
          aiTaskRunId: entry.run
        });
      }
    }
    const calibration = uncalibrated ? null : decider.calibration;
    return pairs.map((pair) => {
      const value = scores.get(pair.candidate.note.id)!;
      if (value.loToHi === null || value.hiToLo === null)
        return {
          candidate: pair.candidate,
          decisionSource: "undecided",
          score: null,
          decision: null,
          relationType: null,
          subjectId: null
        };
      const score = aggregateDirections(value.loToHi, value.hiToLo, this.config.decide.rule);
      return {
        candidate: pair.candidate,
        decisionSource: fromCache.has(pair.candidate.note.id) ? "cache" : "model",
        score,
        decision: bandScore(score, calibration, decider.uncalibratedPass),
        relationType: null,
        subjectId: null
      };
    });
  }

  /**
   * The generative decider (the v9 decide-only call, D16): one judgment per unordered pair, no
   * prose. A direction decided before, or the verdict of the reverse direction on the same content,
   * answers without a call; the rest is asked in one call with one repair of the missing items.
   * It has no calibration: a verdict at or above the uncalibrated pass is suggested (D18). A v9
   * type that maps into the write vocabulary is kept with its judged direction (D20).
   */
  private async decideGeneratively(
    note: AtomicNoteRecord,
    candidates: readonly Candidate[],
    decider: GenerativeDecider,
    context: {
      signal: AbortSignal | undefined;
      logContext: AiTaskLogContext;
      maxOutputTokens: number;
    }
  ): Promise<CandidateOutcome[]> {
    const decisions = createRelationDecisionRepository(this.requirePool());
    const sourceContentHash = atomicNoteDecisionContentHash(note);
    const targets = (subset: readonly Candidate[]) =>
      subset.map((candidate) => ({
        atomicNoteId: candidate.note.id,
        contentHash: atomicNoteDecisionContentHash(candidate.note)
      }));
    type Verdict = { score: number; relationType: AtomicNoteRelationType };
    const collect = (verdicts: ReadonlyMap<string, { score: number; relationType: string }>) => {
      const into = new Map<string, Verdict>();
      for (const [targetId, verdict] of verdicts) {
        const relationType = AtomicNoteRelationTypeSchema.safeParse(verdict.relationType);
        if (relationType.success)
          into.set(targetId, { score: verdict.score, relationType: relationType.data });
      }
      return into;
    };
    const lookup = { sourceAtomicNoteId: note.id, sourceContentHash, deciderKey: decider.key };
    const cached =
      candidates.length > 0
        ? collect(await decisions.findVerdicts({ ...lookup, targets: targets(candidates) }))
        : new Map<string, Verdict>();
    const undecided = candidates.filter((candidate) => !cached.has(candidate.note.id));
    // The reverse direction's verdict answers this one too; nothing is written for the reuse.
    const reused =
      undecided.length > 0
        ? collect(await decisions.findReverseVerdicts({ ...lookup, targets: targets(undecided) }))
        : new Map<string, Verdict>();
    const pending = undecided.filter((candidate) => !reused.has(candidate.note.id));
    // Candidate numbers follow the content order of the candidates, never their IDs.
    const aliases = new Map(pending.map((candidate, index) => [candidate.note.id, index + 1]));
    const run = (subset: readonly Candidate[], attempt: number) =>
      this.options.ai.runDefaultTask(
        "reranking",
        buildBatchRerankPrompt(
          note,
          subset.map((candidate) => ({
            alias: aliases.get(candidate.note.id)!,
            title: candidate.note.title,
            ideaStatement: candidate.note.ideaStatement
          }))
        ),
        withSourceItems(
          {
            ...context.logContext,
            atomicNoteId: note.id,
            operation: attempt
              ? noteMatchDecisionOperations.repair
              : noteMatchDecisionOperations.decide,
            promptVersion: atomicNoteMatchingVersion,
            attempt,
            // The decide class: its deadline and the lean shape, on its `op:` route (D16, R5).
            workloadClass: "decide"
          },
          [
            note.createdFromSourceItemId,
            ...subset.map((candidate) => candidate.note.createdFromSourceItemId)
          ]
        ),
        context.signal,
        { maxOutputTokens: context.maxOutputTokens }
      );
    const decided = new Map<string, BatchRerankDecision & { aiTaskRunId: string }>();
    let execution: DefaultAiTaskResult | null = null;
    if (pending.length > 0) {
      try {
        execution = await run(pending, 0);
      } catch (error) {
        if (context.signal?.aborted) throw error;
        throw new Error("errors.matching.rerankingFailed", { cause: error });
      }
      if (!execution) throw new Error("errors.ai.noCompatibleModel");
      const asked = pending.map((candidate) => aliases.get(candidate.note.id)!);
      const initial = parseBatchRerankOutput(execution.output, asked);
      const runIds = new Map(asked.map((alias) => [alias, execution!.aiTaskRunId]));
      let merged = initial.decisions;
      let repairFailed = false;
      let repairCause: unknown;
      if (initial.retry.length > 0) {
        // One repair call asks again only for the missing or malformed items.
        const retry = new Set(initial.retry);
        try {
          const repair = await run(
            pending.filter((candidate) => retry.has(aliases.get(candidate.note.id)!)),
            1
          );
          if (repair) {
            const repaired = parseBatchRerankOutput(repair.output, initial.retry);
            for (const alias of repaired.decisions.keys()) runIds.set(alias, repair.aiTaskRunId);
            merged = mergeBatchRerankRepair(initial, repaired);
          } else repairFailed = true;
        } catch (error) {
          if (context.signal?.aborted) throw error;
          repairFailed = true;
          repairCause = error;
        }
      }
      for (const candidate of pending) {
        const alias = aliases.get(candidate.note.id)!;
        const decision = merged.get(alias);
        if (decision)
          decided.set(candidate.note.id, { ...decision, aiTaskRunId: runIds.get(alias)! });
      }
      // A required decider whose repair failed, or that decided nothing in two calls, fails the
      // note before its checkpoint: the undecided items would otherwise be lost for good.
      const undecidedCount = pending.length - decided.size;
      if (undecidedCount > 0 && (repairFailed || decided.size === 0))
        throw new Error("errors.matching.rerankingFailed", { cause: repairCause });
      // Verdicts are recorded only while the route is the one they were asked under.
      const current = await this.generativeDecider();
      if (current?.key === decider.key && execution.profileId === decider.profileId) {
        const records: RelationDecisionInput[] = [];
        for (const candidate of pending) {
          const verdict = decided.get(candidate.note.id);
          if (!verdict) continue;
          records.push({
            sourceAtomicNoteId: note.id,
            targetAtomicNoteId: candidate.note.id,
            sourceContentHash,
            targetContentHash: atomicNoteDecisionContentHash(candidate.note),
            deciderKey: decider.key,
            score: verdict.score,
            relationType: verdict.relationType,
            aiTaskRunId: verdict.aiTaskRunId
          });
        }
        for (const record of records) await decisions.record(record);
      }
    }
    const pass = this.config.decide.uncalibratedPass.probability;
    return candidates.map((candidate) => {
      const id = candidate.note.id;
      const model = decided.get(id);
      const fromCache = cached.get(id);
      const fromReverse = reused.get(id);
      const verdict = model ?? fromCache ?? fromReverse;
      if (!verdict)
        return {
          candidate,
          decisionSource: "undecided",
          score: null,
          decision: null,
          relationType: null,
          subjectId: null
        };
      // The type belongs to the direction it was judged in: candidate -> note for a reused verdict.
      const subjectId = !model && !fromCache && fromReverse ? id : note.id;
      return {
        candidate,
        decisionSource: model ? "model" : fromCache ? "cache" : "reverse_cache",
        score: verdict.score,
        decision: bandScore(verdict.score, null, pass),
        relationType: mapGenerativeRelationType(verdict.relationType),
        subjectId
      };
    });
  }

  // --- helpers ------------------------------------------------------------------------------------

  /** Per-candidate breakdowns in the similarity debug tables, only while debug mode is on. */
  private async recordDebug(
    note: AtomicNoteRecord,
    vector: MatcherNoteVector | undefined,
    outcomes: readonly CandidateOutcome[],
    accepted: readonly CandidateOutcome[],
    decider: MatchDeciderSummary,
    graphError: string | null
  ): Promise<void> {
    try {
      if (!(await this.options.isDebugEnabled?.())) return;
      const handedOn = new Set(accepted.map((outcome) => outcome.candidate.note.id));
      await createSimilarityDebugRepository(this.requirePool()).record({
        kind: "atomic_note_matching",
        queryText: `${note.title}\n${note.ideaStatement}`,
        queryTargetId: note.id,
        mode: vector ? "hybrid" : "text_metadata",
        model: vector?.space.model ?? null,
        dimensions: vector?.embedding.length ?? null,
        requestedLimit: this.config.retrieval.fusedK,
        strategy: "text_vector_graph_rrf_with_reverse_guard",
        metadata: {
          version: relationMatcherVersion,
          retrieval: this.config.retrieval,
          decider: { ...decider },
          graphError,
          candidates: outcomes.length,
          guard: outcomes.filter((outcome) => outcome.candidate.guard).length,
          handedOn: handedOn.size
        },
        results: outcomes.map((outcome, index) => ({
          targetType: "atomic_note",
          targetId: outcome.candidate.note.id,
          targetLabel: outcome.candidate.note.title,
          finalRank: index + 1,
          textRank: outcome.candidate.textRank,
          vectorRank: outcome.candidate.vectorRank,
          graphRank: outcome.candidate.graphRank,
          textScore: outcome.candidate.textScore,
          vectorScore: outcome.candidate.vectorScore,
          graphScore: outcome.candidate.graphScore,
          rerankScore: outcome.score,
          fusionScore: outcome.candidate.fusionScore,
          finalScore: outcome.decision?.probability ?? outcome.score ?? 0,
          passedThreshold: handedOn.has(outcome.candidate.note.id),
          explanation: null,
          metadata: {
            guard: outcome.candidate.guard,
            decisionSource: outcome.decisionSource,
            band: outcome.decision?.band ?? null,
            calibration: outcome.decision?.calibration ?? null,
            relationType: outcome.relationType,
            candidateStatus: outcome.candidate.note.status
          }
        }))
      });
    } catch {
      // Debug persistence never makes matching fail.
    }
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

/**
 * The interim hand-off (until T52's link job): persists a decided note's accepted pairs at once,
 * each with its band, probability and decider key, in one `match` run whose events record every
 * change (D14). A ranker pair is untyped (D20's untyped fallback: neutral stance, typed later); a
 * generative pair keeps its mapped v9 type and judged direction. A pair a person decided is never
 * changed (I-R3). Resolves to the relations it created or changed.
 */
export function persistDecidedPairs(input: {
  pool: PgPool;
  ai?: Pick<AiService, "traceOperation">;
  logContext?: AiTaskLogContext;
}): DecidedNoteHandOff & { finish: (outcome: "succeeded" | "failed") => Promise<void> } {
  const relations = createAtomicNoteRelationRepository(input.pool);
  const runs = createRelationMatchRunRepository(input.pool);
  let runId: string | null = null;
  let persisted = 0;
  const handOff = async (note: DecidedNote) => {
    runId ??= (
      await runs.start({
        kind: "match",
        rootId: input.logContext?.sourceItemId ?? note.sourceItemId,
        deciderKey: note.decider.deciderKey,
        calibrationVersion: note.decider.calibration
      })
    ).id;
    let count = 0;
    for (const pair of note.pairs) {
      const subject = pair.subjectId ?? note.noteId;
      const object = subject === note.noteId ? pair.candidateId : note.noteId;
      const write = () =>
        relations.upsertDecided({
          subjectAtomicNoteId: subject,
          objectAtomicNoteId: object,
          relationType: pair.relationType,
          band: pair.band,
          probability: pair.probability,
          deciderKey: note.decider.deciderKey,
          vectorScore: pair.vectorScore,
          graphScore: pair.graphScore,
          rerankScore: note.decider.kind === "generative" ? pair.score : null,
          // D17: the calibrated probability; without one, the decider's own probability.
          finalScore:
            pair.probability ?? (note.decider.kind === "ranker" ? sigmoid(pair.score) : pair.score),
          // The decider writes no prose: the explanation is written on demand.
          explanation: "knowledge.relations.explanations.reranked",
          matchingProfileId: note.decider.profileId,
          matchingModel: note.decider.modelId,
          metadata: {
            version: relationMatcherVersion,
            decisionSource: pair.decisionSource,
            calibration: pair.calibration,
            score: pair.score
          },
          runId
        });
      const context = withSourceItems({ ...input.logContext, atomicNoteId: note.noteId }, [
        note.sourceItemId,
        pair.candidateSourceItemId
      ]);
      const written = await (input.ai?.traceOperation?.(
        "atomic_note_relation_creation",
        context,
        write,
        { targetAtomicNoteId: pair.candidateId, band: pair.band, relationType: pair.relationType }
      ) ?? write());
      if (written.change === "created" || written.change === "updated") count += 1;
    }
    persisted += count;
    return count;
  };
  return Object.assign(handOff, {
    /** Closes the run, when anything was handed on. */
    finish: async (outcome: "succeeded" | "failed") => {
      if (runId) await runs.finish(runId, { outcome, counts: { persisted } });
    }
  });
}

function deciderSummary(decider: Decider): MatchDeciderSummary {
  if (decider.kind === "generative")
    return {
      kind: "generative",
      mode: decider.mode,
      deciderKey: decider.key,
      calibration: "uncalibrated",
      profileId: decider.profileId,
      modelId: decider.modelId
    };
  return {
    kind: "ranker",
    mode: decider.mode,
    deciderKey: decider.cacheKey,
    calibration:
      decider.parityFailed || !decider.calibration
        ? "uncalibrated"
        : decider.calibration.kind === "isotonic"
          ? "frozen"
          : "provisional",
    profileId: decider.profileId,
    modelId: decider.modelId
  };
}

const bandRank = (band: "apply" | "suggest" | null) =>
  band === "apply" ? 0 : band === "suggest" ? 1 : 2;

/** A generative model is a decider whatever else it declares; a dedicated ranker is not one. */
function isGenerativeRoute(capabilities: readonly string[] | undefined): boolean {
  return generativeDeciderCapabilities.some((capability) =>
    (capabilities ?? []).includes(capability)
  );
}

function withSourceItems(context: AiTaskLogContext, sourceItemIds: string[]): AiTaskLogContext {
  const combined = [
    ...new Set([
      ...(context.sourceItemId ? [context.sourceItemId] : []),
      ...(context.sourceItemIds ?? []),
      ...sourceItemIds
    ])
  ];
  return {
    ...context,
    ...(combined[0] ? { sourceItemId: combined[0] } : {}),
    sourceItemIds: combined
  };
}
