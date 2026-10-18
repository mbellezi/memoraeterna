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
  type DecisionsFallbackReason,
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
  DecisionsDisabledError,
  DecisionsUnavailableError,
  decisionsLogOdds,
  decisionsNeighbourhood,
  findLocalModelCatalogEntry,
  isRankerCatalogEntry,
  rankerCatalogArtifactSha256,
  resolveDecisionsLimits,
  type DecisionsLimits
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
import {
  decisionsDesign,
  relationDecisionsInstruction,
  type DecisionsDesign
} from "./decisions-identity.js";

/** The ranker operation of note decide: `op:relation_decide`, else `class:decide`. */
export const relationDecideOperation = "relation_decide";

/** The operation of the Decisions decider's calls, for the AI audit. */
export const relationDecisionsOperation = "relation_decide_decisions";

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

// --- the reverse guard (D19) ----------------------------------------------------------------------

/**
 * The cosine of a note's K-th vector candidate, stored once the note is decided (`kth_cosine`);
 * null when it had fewer than K candidates, which opens its guard to every later note.
 */
export function kthVectorCosine(cosines: readonly number[], k: number): number | null {
  return cosines.length >= k ? cosines[k - 1]! : null;
}

/**
 * The reverse guard (D19): the earlier decided notes of the note's vector window (its top
 * guardFactor x K, best first) that its fused list missed and whose own K-th cosine the note
 * reaches. `states` holds the decided notes only; a note not decided yet is never added.
 */
export function reverseGuardIds(
  window: ReadonlyArray<{ id: string; cosine: number }>,
  fusedIds: ReadonlySet<string>,
  states: ReadonlyMap<string, { kthCosine: number | null }>
): string[] {
  return window
    .filter((candidate) => {
      if (fusedIds.has(candidate.id)) return false;
      const state = states.get(candidate.id);
      return (
        state !== undefined && (state.kthCosine === null || candidate.cosine >= state.kthCosine)
      );
    })
    .map((candidate) => candidate.id);
}

// --- public shapes --------------------------------------------------------------------------------

/** A note's matching vector and the embedding space it lives in. */
export interface MatcherNoteVector {
  embedding: number[];
  space: { model: string; provider: string; runtime: string; spaceKey: string };
}

/**
 * The decider one matching admission uses. `fallback` is set when the person turned the Decisions
 * decider on and this local decider decided in its place, with the reason (plan decision 30).
 */
export type MatchDeciderSummary =
  | {
      kind: "ranker";
      mode: NoteDeciderMode;
      deciderKey: string;
      calibration: RelationCalibrationState;
      profileId: string;
      modelId: string;
      fallback?: DecisionsFallbackReason;
    }
  | {
      kind: "generative";
      mode: NoteDeciderMode;
      deciderKey: string;
      calibration: "uncalibrated";
      profileId: string;
      modelId: string;
      fallback?: DecisionsFallbackReason;
    }
  | {
      /** The OpenAI Decisions API: remote, opt-in, with a calibration of its own (decision 30). */
      kind: "decisions";
      mode: NoteDeciderMode;
      deciderKey: string;
      calibration: RelationCalibrationState;
      /** A remote decider has no profile row. */
      profileId: null;
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
 * before its checkpoint, and resolves to the relations it persisted. Ingestion keeps them in the
 * stage checkpoint and persists none (0): the link job (`relation-link.ts`, T52) does (D21).
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
  /** Notes the Decisions decider could not decide, which a local decider decided, and the last reason. */
  decisionsFallback?: { notes: number; reason: DecisionsFallbackReason };
};

export interface RelationMatcherOptions {
  getPool: () => PgPool | null;
  ai: Pick<AiService, "rankPairs" | "runDefaultTask" | "decideRouteStatus" | "traceOperation"> &
    Partial<
      Pick<AiService, "ensureLegacyRouteMapping" | "resolveDecisions" | "decideWithDecisions">
    >;
  config?: RelationsConfig;
  /** The Decisions decider's typed limits (tests); the defaults of `packages/ai` apply when left out. */
  decisionsLimits?: DecisionsLimits;
  /** The generative decider's output budget, the one note-matching setting that still decides (T53b). */
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
  /** Why this decider decides although the person turned the Decisions decider on (decision 30). */
  decisionsFallback?: DecisionsFallbackReason;
}

interface GenerativeDecider {
  kind: "generative";
  mode: NoteDeciderMode;
  key: string;
  profileId: string;
  modelId: string;
  decisionsFallback?: DecisionsFallbackReason;
}

/**
 * The Decisions API as the decider of this admission (plan decision 30). The local decider that the
 * mode would have used decides in its place when Decisions cannot (`fallback`); null when there is
 * none, in which case a failure of Decisions fails the note visibly, for a job retry.
 */
interface DecisionsDecider {
  kind: "decisions";
  mode: NoteDeciderMode;
  design: DecisionsDesign;
  limits: DecisionsLimits;
  fallback: LocalDecider | null;
  /**
   * Set once the person turned the decider off (or left the setup) during this admission: the rest
   * of the admission is decided by `fallback`, with no reason recorded because it is no failure.
   */
  disabled: boolean;
}

type LocalDecider = RankerDecider | GenerativeDecider;
type Decider = LocalDecider | DecisionsDecider;

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
      const fellBack = decided.decider.kind === "decisions" ? undefined : decided.decider.fallback;
      if (fellBack)
        result.decisionsFallback = {
          notes: (result.decisionsFallback?.notes ?? 0) + 1,
          reason: fellBack
        };
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

  /**
   * Whether an admission now would decide: false while mode `ranker` waits for a validated ranker
   * (C7) or a required decider has no route. Matching skipped to wait re-runs once it is true.
   */
  public async deciderAvailable(): Promise<boolean> {
    try {
      return (await this.resolveDecider()) !== waitingForDeciderSkipReason;
    } catch {
      return false;
    }
  }

  /**
   * The key the next admission decides under (the decision cache and `relation_decisions` use it),
   * or null while mode `ranker` has no validated ranker. The re-match harness clears the decisions
   * of this key, so the decider scores every pair again.
   */
  public async currentDeciderKey(): Promise<string | null> {
    const decider = await this.resolveDecider();
    if (decider === waitingForDeciderSkipReason) return null;
    return deciderKeyOf(decider);
  }

  // --- decider resolution -------------------------------------------------------------------------

  /**
   * The decider of this admission, or the skip of mode `ranker` without a validated ranker. When the
   * person turned the Decisions API on and it may decide, it is the decider and the local decider
   * the mode would have used is its fallback; when it is on and may not decide, the local decider
   * decides and says why (plan decision 30).
   */
  private async resolveDecider(): Promise<Decider | typeof waitingForDeciderSkipReason> {
    const pool = this.requirePool();
    // The routes are read here before any call: the generative-decide `op:` routes that the
    // legacy mapping writes must exist first, as they do for a call (D16, D34).
    await this.options.ai.ensureLegacyRouteMapping?.();
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
    const decisions = (await this.options.ai.resolveDecisions?.()) ?? {
      use: "local" as const,
      reason: null
    };
    let local: LocalDecider | typeof waitingForDeciderSkipReason;
    try {
      local = await this.localDecider(mode, ranker);
    } catch (error) {
      // With Decisions deciding, a local decider that cannot run is only a missing fallback.
      if (decisions.use !== "decisions") throw error;
      local = waitingForDeciderSkipReason;
    }
    if (decisions.use === "decisions")
      return {
        kind: "decisions",
        mode,
        design: this.decisionsDesign(),
        limits: this.decisionsLimits(),
        fallback: local === waitingForDeciderSkipReason ? null : local,
        disabled: false
      };
    if (local === waitingForDeciderSkipReason || !decisions.reason) return local;
    return { ...local, decisionsFallback: decisions.reason };
  }

  /** The local decider a mode names: the validated ranker, the generative judge, or none yet. */
  private async localDecider(
    mode: NoteDeciderMode,
    ranker: Omit<RankerDecider, "mode"> | null
  ): Promise<LocalDecider | typeof waitingForDeciderSkipReason> {
    if (mode !== "generative" && ranker) return { ...ranker, mode };
    if (mode === "ranker") return waitingForDeciderSkipReason;
    const generative = await this.generativeDecider();
    // A required decider that cannot run fails visibly, before any checkpoint.
    if (!generative) throw new Error("errors.ai.noCompatibleModel");
    return { ...generative, mode };
  }

  private decisionsLimits(): DecisionsLimits {
    return this.options.decisionsLimits ?? resolveDecisionsLimits();
  }

  /** The Decisions decider's identity, cache key and calibration for the catalog's instruction. */
  private decisionsDesign(): DecisionsDesign {
    return decisionsDesign({
      instruction: relationDecisionsInstruction(),
      config: this.config,
      limits: this.decisionsLimits()
    });
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
    // The Decisions decider scores the candidate lists the local retrieval built; when it cannot, the
    // local decider the mode names decides this note, and the summary says why (decision 30). When
    // the person turned it off, or left the setup that offers it, it is no failure: the local
    // decider decides this note and the rest of the admission, and no reason is recorded.
    let effective: Decider = decider;
    let fallback: DecisionsFallbackReason | undefined;
    let outcomes: CandidateOutcome[] | typeof waitingForDeciderSkipReason | undefined;
    if (decider.kind === "decisions") {
      let cause: unknown;
      if (!decider.disabled) {
        try {
          outcomes = await this.decideWithDecisions(note, candidates, decider, context);
        } catch (error) {
          if (context.signal?.aborted) throw error;
          if (error instanceof DecisionsDisabledError) decider.disabled = true;
          else if (error instanceof DecisionsUnavailableError) {
            fallback = error.reason;
            cause = error;
          } else throw error;
        }
      }
      if (outcomes === undefined) {
        if (!decider.fallback) {
          // Turned off with no local decider: the stage waits for one, like mode `ranker` without a
          // validated ranker. A failure with none fails the note visibly, for a job retry.
          if (decider.disabled) return waitingForDeciderSkipReason;
          throw new Error("errors.matching.rerankingFailed", { cause });
        }
        effective = decider.fallback;
        outcomes = await this.decideLocally(note, candidates, decider.fallback, context);
      }
    } else outcomes = await this.decideLocally(note, candidates, decider, context);
    if (outcomes === waitingForDeciderSkipReason) return outcomes;
    // The note is decided: its k-th vector cosine opens the reverse guard to later notes (D19).
    if (context.vector)
      await createNoteMatchStateRepository(this.requirePool()).record({
        noteId: note.id,
        deciderKey: deciderKeyOf(effective),
        spaceKey: context.vector.space.spaceKey,
        kthCosine
      });
    const summary = deciderSummary(effective, fallback);
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
    const kthCosine = kthVectorCosine(
      vectorList.map((candidate) => candidate.vectorScore),
      k
    );
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
    const guardIds = reverseGuardIds(
      window.map((candidate) => ({ id: candidate.note.id, cosine: candidate.vectorScore })),
      fusedIds,
      states
    );
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

  /** The local decider the mode names scores the note's candidates. */
  private decideLocally(
    note: AtomicNoteRecord,
    candidates: readonly Candidate[],
    decider: LocalDecider,
    context: {
      signal: AbortSignal | undefined;
      logContext: AiTaskLogContext;
      maxOutputTokens: number;
    }
  ): Promise<CandidateOutcome[] | typeof waitingForDeciderSkipReason> {
    return decider.kind === "ranker"
      ? this.decideWithRanker(note, candidates, decider, context)
      : this.decideGeneratively(note, candidates, decider, context);
  }

  /**
   * The rendered texts of the note and its candidates, and the directions a decider scored before:
   * stored scores under its cache key are reused only where both rendered-input hashes still match
   * (D13). `scores` holds each candidate's two directions (null where none is stored) and
   * `fromCache` the candidates both of whose directions are stored.
   */
  private async storedPairScores(
    note: AtomicNoteRecord,
    candidates: readonly Candidate[],
    deciderKey: string
  ) {
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
      deciderKey,
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
    return { own, pairs, scores, fromCache };
  }

  /**
   * Both directions of every candidate pair on the Decisions API (plan decision 30). The candidate
   * lists are the local retrieval's, unchanged. Directions stored under the Decisions cache key are
   * reused; the rest are scored as directed lists: the note against its candidates (up to 20 per
   * request, in two candidate orders) and each candidate against the note, one request per
   * candidate. These online, partial requests are the design the decider's identity names; a
   * calibration frozen for another design does not apply to them. A direction scores the log-odds of
   * the mean of its two orders' probabilities and a pair the mean of its two directions, banded
   * under the decider's own calibration: automatic apply in its apply band, suggestions below, and
   * only suggestions while no frozen entry matches the identity.
   */
  private async decideWithDecisions(
    note: AtomicNoteRecord,
    candidates: readonly Candidate[],
    decider: DecisionsDecider,
    context: {
      signal: AbortSignal | undefined;
      logContext: AiTaskLogContext;
      fence: RetrievalFence | undefined;
    }
  ): Promise<CandidateOutcome[]> {
    const ai = this.options.ai;
    const decide = ai.decideWithDecisions?.bind(ai);
    if (!decide) throw new DecisionsUnavailableError("error");
    const { design } = decider;
    const decisions = createRelationDecisionRepository(this.requirePool());
    const { own, pairs, scores, fromCache } = await this.storedPairScores(
      note,
      candidates,
      design.cacheKey
    );
    type Pair = (typeof pairs)[number];
    type Wanted = { pair: Pair; direction: "loToHi" | "hiToLo" };
    const { limits } = decider;
    const bodyCharacters = this.config.decide.bodyCharacters;
    const render = (record: AtomicNoteRecord) => renderRelationPairText(record, bodyCharacters);
    const known = new Map<string, AtomicNoteRecord>([
      [note.id, note],
      ...candidates.map((candidate) => [candidate.note.id, candidate.note] as const)
    ]);
    const byContent = (left: AtomicNoteRecord, right: AtomicNoteRecord) =>
      compareContent(noteContentKey(left), noteContentKey(right)) ||
      left.id.localeCompare(right.id);
    const sourceIds = new Set([note.createdFromSourceItemId]);
    const notes = createAtomicNoteRepository(this.requirePool());
    const fence = context.fence ? { fence: context.fence } : {};
    /**
     * Scores some directions in one call, and stores each one as soon as it is scored, with the run
     * that scored it, so a later failure or fallback does not discard what was already paid for. Each
     * list queries one note: its targets (the note's own retrieval list, or the note a candidate is
     * asked about) and, as far as a request has room (`maxNeighbourhood`), the notes the queried
     * note was decided against before, in content order. That online, partial makeup is the request
     * design the calibration identity names (`decisionsNeighbourhood`). Only the directions asked
     * for are read from the answers.
     */
    const ask = async (
      queries: ReadonlyArray<{
        id: string;
        text: string;
        targets: AtomicNoteRecord[];
        wanted: Map<string, Wanted>;
      }>
    ) => {
      if (queries.length === 0) return;
      const partners = await decisions.findDecidedPartners({
        deciderKey: design.cacheKey,
        noteIds: queries.map((query) => query.id)
      });
      const unknown = [...new Set([...partners.values()].flat())].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        // Context sent to a provider obeys what retrieval obeys: current notes, outside the
        // fence's hidden roots.
        const loaded = await notes.findManyByIds(unknown);
        const retrievable = await notes.filterRetrievableCandidateIds({
          candidateIds: loaded.map((record) => record.id),
          ...fence
        });
        for (const record of loaded)
          if (isCurrentNote(record) && retrievable.has(record.id)) known.set(record.id, record);
      }
      const lists = queries.map((query) => {
        const targetIds = new Set(query.targets.map((target) => target.id));
        return decisionsNeighbourhood({
          targets: query.targets,
          partners: (partners.get(query.id) ?? [])
            .filter((id) => !targetIds.has(id) && known.has(id))
            .map((id) => known.get(id)!),
          maxNeighbourhood: limits.maxNeighbourhood,
          // Content order, never IDs: the request is a function of the notes' content.
          compare: byContent
        });
      });
      for (const member of lists.flat()) sourceIds.add(member.createdFromSourceItemId);
      const scored = await decide(
        {
          operation: relationDecisionsOperation,
          instruction: design.instruction,
          lists: queries.map((query, index) => ({
            query: query.text,
            candidates: lists[index]!.map(render)
          })),
          // Note decide is background work (P2) unless its caller states a priority (D30).
          priority: context.logContext.priority ?? "P2",
          sourceIds: [...sourceIds],
          ...(context.logContext.jobId ? { jobId: context.logContext.jobId } : {}),
          stage: context.logContext.stage ?? "atomic_note_matching"
        },
        context.signal
      );
      for (const [listIndex, query] of queries.entries())
        for (const [index, member] of lists[listIndex]!.entries()) {
          const entry = query.wanted.get(member.id);
          if (!entry) continue;
          const decided = scored.decisions[listIndex]?.[index];
          const logOdds = decided?.logOdds ?? null;
          // A refusal leaves the direction undecided: it is not stored, and the pair is not banded.
          if (logOdds === null) continue;
          const { pair, direction } = entry;
          scores.get(pair.candidate.note.id)![direction] = logOdds;
          await decisions.recordRankerScores({
            loAtomicNoteId: pair.lo,
            hiAtomicNoteId: pair.hi,
            loInputHash: pair.loHash,
            hiInputHash: pair.hiHash,
            deciderKey: design.cacheKey,
            loToHi: direction === "loToHi" ? logOdds : null,
            hiToLo: direction === "hiToLo" ? logOdds : null,
            aiTaskRunId: decided?.aiTaskRunId ?? null
          });
        }
    };
    // The directions still to score. First the note against its candidates, in one list.
    const forward: Wanted[] = [];
    const backward: Wanted[] = [];
    for (const pair of pairs) {
      if (fromCache.has(pair.candidate.note.id)) continue;
      const value = scores.get(pair.candidate.note.id)!;
      const toCandidate = pair.noteIsLo ? "loToHi" : "hiToLo";
      const toNote = pair.noteIsLo ? "hiToLo" : "loToHi";
      if (value[toCandidate] === null) forward.push({ pair, direction: toCandidate });
      if (value[toNote] === null) backward.push({ pair, direction: toNote });
    }
    if (forward.length > 0)
      await ask([
        {
          id: note.id,
          text: own.text,
          targets: candidates.map((candidate) => candidate.note),
          wanted: new Map(forward.map((entry) => [entry.pair.candidate.note.id, entry]))
        }
      ]);
    // Then each candidate against the note, but only where the pair can still be accepted. A pair's
    // score is the mean of its two directions, so a direction below `2 x edge - ceiling` leaves the
    // mean under the lowest band edge whatever the other direction says: the pair is out, and the
    // request that would have said so is not sent (a lossless filter, `rules/knowledge.md`).
    const edge = lowestAcceptEdge(design);
    const ceiling = decisionsLogOdds(1, limits.probabilityEpsilon);
    const reachable = (entry: Wanted) => {
      if (this.config.decide.rule !== "mean") return true;
      const toCandidate = entry.pair.noteIsLo ? "loToHi" : "hiToLo";
      const forwardScore = scores.get(entry.pair.candidate.note.id)![toCandidate];
      return forwardScore !== null && (forwardScore + ceiling) / 2 >= edge;
    };
    await ask(
      backward.filter(reachable).map((entry) => ({
        id: entry.pair.candidate.note.id,
        text: entry.pair.other.text,
        targets: [note],
        wanted: new Map([[note.id, entry]])
      }))
    );
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
        decision: bandScore(score, design.calibration, design.uncalibratedPass),
        relationType: null,
        subjectId: null
      };
    });
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
    const { own, pairs, scores, fromCache } = await this.storedPairScores(
      note,
      candidates,
      decider.cacheKey
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
            // Note decide is background work (P2) unless its caller states a priority (D30).
            priority: context.logContext.priority ?? "P2",
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
            workloadClass: "decide",
            priority: context.logContext.priority ?? "P2"
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
 * The lowest score the Decisions decider accepts: its suggest edge (or its apply edge when it has
 * no suggest band) under a frozen calibration, else the pass of an uncalibrated one.
 */
function lowestAcceptEdge(design: DecisionsDesign): number {
  const entry = design.calibration;
  if (!entry) return design.uncalibratedPass;
  if (entry.kind !== "isotonic") return Math.min(entry.applyAt, entry.suggestAt ?? Infinity);
  return Math.min(entry.applyFrom ?? Infinity, entry.suggestFrom ?? Infinity);
}

/** The key a decider's decisions are stored and reused under. */
function deciderKeyOf(decider: Decider): string {
  return decider.kind === "ranker"
    ? decider.cacheKey
    : decider.kind === "decisions"
      ? decider.design.cacheKey
      : decider.key;
}

/**
 * What a decided note records of its decider. `fallback` is the reason a local decider decided
 * although the Decisions API was on: found while this note was decided, else when the admission began.
 */
function deciderSummary(decider: Decider, fallback?: DecisionsFallbackReason): MatchDeciderSummary {
  if (decider.kind === "decisions")
    return {
      kind: "decisions",
      mode: decider.mode,
      deciderKey: decider.design.cacheKey,
      calibration: decider.design.calibration ? "frozen" : "uncalibrated",
      profileId: null,
      modelId: decider.design.identity.model
    };
  const reason = fallback ?? decider.decisionsFallback;
  if (decider.kind === "generative")
    return {
      kind: "generative",
      mode: decider.mode,
      deciderKey: decider.key,
      calibration: "uncalibrated",
      profileId: decider.profileId,
      modelId: decider.modelId,
      ...(reason ? { fallback: reason } : {})
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
    modelId: decider.modelId,
    ...(reason ? { fallback: reason } : {})
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
