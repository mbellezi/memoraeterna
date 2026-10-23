// The typing step of the link job (F3 D20, T51t): after a source's notes are decided, the pairs the
// decider accepted are typed with one writer call per few pairs. The answer is codes only (a pair
// id, a type from the write vocabulary or `none`, a direction), so a pair costs no prose. `none` is a
// veto: the pair keeps its typing row and no relation is persisted, so a recalibration never asks
// again. The step commits its typing rows (the cache) before the link job persists the relations,
// and it never fails the job for typing: a pair it could not type comes back untyped (D20).
import { createHash } from "node:crypto";

import { executionLane } from "@app/ai";
import {
  aiRouteKeys,
  relationDecisionPair,
  type createAiConfigRepository,
  type createRelationTypingRepository
} from "@app/db";
import {
  NoteRelationBandSchema,
  relationTypingAliases,
  relationTypingContractVersion,
  relationTypingLimits,
  relationTypingOutputSchema,
  validateRelationTypingAnswer,
  type AiOutputContract,
  type NoteRelationBand,
  type NoteRelationWriteType,
  type RelationTypingItem,
  type RelationTypingLimits,
  type RelationTypingProblem
} from "@app/domain";

import type { AiPriorityInput } from "../ai-priority.js";
import type { AiService, AiTaskLogContext } from "../ai-service.js";
import {
  aiTaskBehaviorDefaults,
  relationTypingOperation,
  relationTypingRepairOperation
} from "../ai-task-parameters.js";
import { compareContent, contentKey } from "../content-order.js";
import {
  capturePromptPin,
  joinPrompts,
  promptFingerprint,
  renderPrompt
} from "../prompt-runtime.js";

export { relationTypingOperation, relationTypingRepairOperation };

/** The note text the typer reads, and the hash of exactly that text (the decider's, D13, D20). */
export interface TypingNote {
  id: string;
  /** The rendered input the decider saw for this note (`relation-pair-text-v1`). */
  text: string;
  /** SHA-256 of `text`: the typing cache is reused only while both hashes match. */
  hash: string;
}

/** An accepted pair. The order of the two notes carries no meaning. */
export interface TypingPair {
  first: TypingNote;
  second: TypingNote;
  /** Only the accept band is typed: a rejected candidate never reaches the typer (X4). */
  band: NoteRelationBand;
}

/** The stored direction of a typed pair (D8); `null` for a veto. */
export type TypedDirection = "lo_to_hi" | "hi_to_lo" | "symmetric";

/** A pair in the canonical (lo < hi) order, with the positions the typer sees (a before b). */
export interface ArrangedTypingPair {
  pairKey: string;
  lo: TypingNote;
  hi: TypingNote;
  /** The earlier note in content order, shown as `a`. */
  a: TypingNote;
  b: TypingNote;
  band: NoteRelationBand;
}

/** One pair of a call with the id the answer refers to it by. */
export interface TypingBatchItem {
  alias: string;
  pair: ArrangedTypingPair;
}

/**
 * Canonical, deduplicated and in content order. Prompts are a function of content, never of IDs:
 * `a` is the note whose text sorts first (the lower ID only when the two texts are identical), and
 * the pairs follow their texts; the pair key breaks a tie between indistinguishable pairs only.
 * `reverse` shows the notes in the opposite positions (the position-bias check, G25).
 */
export function arrangeTypingPairs(
  pairs: readonly TypingPair[],
  options: { reverse?: boolean } = {}
): ArrangedTypingPair[] {
  const arranged = new Map<string, ArrangedTypingPair>();
  for (const pair of pairs) {
    if (!NoteRelationBandSchema.safeParse(pair.band).success)
      throw new Error("Only a pair in the accept band is typed.");
    for (const note of [pair.first, pair.second])
      if (!note.text.trim() || !note.hash)
        throw new Error("A pair to type needs each note's rendered text and hash.");
    const { lo, key } = relationDecisionPair(pair.first.id, pair.second.id);
    const [loNote, hiNote] =
      pair.first.id === lo ? [pair.first, pair.second] : [pair.second, pair.first];
    const earlier = arranged.get(key);
    if (earlier) {
      if (earlier.lo.hash !== loNote.hash || earlier.hi.hash !== hiNote.hash)
        throw new Error("One pair was given twice with different note texts.");
      continue;
    }
    const loFirst = compareContent(loNote.text, hiNote.text) <= 0;
    const [a, b] = loFirst !== Boolean(options.reverse) ? [loNote, hiNote] : [hiNote, loNote];
    arranged.set(key, { pairKey: key, lo: loNote, hi: hiNote, a, b, band: pair.band });
  }
  return [...arranged.values()].sort(
    (left, right) =>
      compareContent(
        contentKey(left.a.text, left.b.text),
        contentKey(right.a.text, right.b.text)
      ) || compareContent(left.pairKey, right.pairKey)
  );
}

/** Pairs in batches of at most `size`, each pair with its id for the call (`p1`, `p2`, ...). */
export function typingBatches(
  pairs: readonly ArrangedTypingPair[],
  size: number
): TypingBatchItem[][] {
  const aliases = relationTypingAliases(size);
  const batches: TypingBatchItem[][] = [];
  for (let start = 0; start < pairs.length; start += size)
    batches.push(
      pairs.slice(start, start + size).map((pair, index) => ({ alias: aliases[index]!, pair }))
    );
  return batches;
}

/** The typing prompt for one batch: both notes of each pair as `a` and `b`, aliases and no IDs. */
export function buildRelationTypingPrompt(batch: readonly TypingBatchItem[]): string {
  return renderPrompt("relations.type", {
    relation_pairs: batch.map(({ alias, pair }) => ({ p: alias, a: pair.a.text, b: pair.b.text }))
  });
}

const problemText: Record<RelationTypingProblem, string> = {
  missing: "no result",
  invalid_item: "the result needs the pair id p, the type t and the direction d",
  invalid_type: "t must be one of the listed relation types or none",
  invalid_direction: "d must be ab, ba, both or none",
  direction_mismatch:
    "d does not fit t: ab or ba for a directed type, both for contradicts or same_as, none for none",
  conflicting: "the pair was answered twice with different results"
};

/**
 * The one item-level re-ask: the same prompt for only the pairs whose results were missing or
 * invalid, under their own ids, followed by what was wrong with each (codes, never the model's text).
 */
export function buildRelationTypingRepairPrompt(
  batch: readonly TypingBatchItem[],
  problems: ReadonlyMap<string, RelationTypingProblem>
): string {
  const rejected = batch.filter(({ alias }) => problems.has(alias));
  return joinPrompts(
    buildRelationTypingPrompt(rejected),
    renderPrompt("relations.type.repair", {
      validation_errors: rejected
        .map(({ alias }) => `${alias}: ${problemText[problems.get(alias)!]}`)
        .join("\n")
    })
  );
}

/** The stored direction of a validated result: `ab` makes the `a` note the subject of a directed type. */
export function storedTypingDirection(
  pair: Pick<ArrangedTypingPair, "lo" | "a" | "b">,
  item: Pick<RelationTypingItem, "type" | "direction">
): TypedDirection | null {
  if (item.type === "none") return null;
  if (item.direction === "both") return "symmetric";
  const subject = item.direction === "ab" ? pair.a : pair.b;
  return subject.id === pair.lo.id ? "lo_to_hi" : "hi_to_lo";
}

// ---------------------------------------------------------------------------
// The typer's identity: the cache key

/** The writer route the typing calls resolve to (`op:` route, then `class:write-fast`). */
export interface TyperRoute {
  lane: "local" | "remote";
  provider: string;
  modelId: string;
  runtime: string;
  repository: string | null;
  revision: string | null;
  quantization: string | null;
  /** The effective parameters the route adds beneath the call: the profile's and the task's. */
  parameters: Record<string, unknown>;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** The identity of the typing prompts as they are now: the catalog's revisions and the user's edits. */
export function relationTypingPromptIdentity(): string {
  return promptFingerprint(["relations.type", "relations.type.repair"], capturePromptPin(), false);
}

/**
 * The typer key: the contract, the effective prompt, the model identity and its effective
 * parameters. A stored verdict is reused only under the same key and both notes' hashes (D20).
 */
export function relationTyperKey(route: TyperRoute, promptIdentity: string): string {
  return createHash("sha256")
    .update(
      stableJson({
        contract: relationTypingContractVersion,
        prompt: promptIdentity,
        provider: route.provider,
        model: route.modelId,
        runtime: route.runtime,
        repository: route.repository,
        revision: route.revision,
        quantization: route.quantization,
        parameters: route.parameters
      })
    )
    .digest("hex");
}

/** Resolves the writer route of the typing calls from the AI configuration; null without one. */
export function createTyperRouteResolver(
  config: Pick<ReturnType<typeof createAiConfigRepository>, "getDefaultTask">
): () => Promise<TyperRoute | null> {
  return async () => {
    const selection = await config.getDefaultTask(
      "structured-output",
      undefined,
      aiRouteKeys("structured-output", {
        operation: relationTypingOperation,
        workloadClass: "write-fast"
      })
    );
    if (!selection) return null;
    const local = Boolean(selection.localModelId);
    return {
      lane: executionLane(selection).lane === "local" ? "local" : "remote",
      provider: selection.provider,
      modelId: selection.modelId,
      runtime: selection.runtime,
      repository: selection.repository,
      revision: selection.revision,
      quantization: selection.quantization,
      parameters: {
        ...aiTaskBehaviorDefaults("structured-output", local, relationTypingOperation),
        ...selection.modelDefaultParameters,
        ...selection.parameters
      }
    };
  };
}

// ---------------------------------------------------------------------------
// The step

export type RelationTypingStore = Pick<
  ReturnType<typeof createRelationTypingRepository>,
  "find" | "record"
>;

export interface RelationTypingDeps {
  ai: Pick<AiService, "runDefaultTask">;
  /** The typing cache (`relation_typings`); null types without reading or writing it (the check). */
  store: RelationTypingStore | null;
  resolveRoute: () => Promise<TyperRoute | null>;
  contentLanguage?: string;
  logger?: { warn(message: string, error?: unknown): void };
}

export interface RelationTypingOptions {
  /** Lane priority of the calls: P1 for an interactive import's link job, P2 by default (D30). */
  priority?: AiPriorityInput;
  jobId?: string;
  ingestionRunId?: string;
  sourceItemIds?: string[];
  /**
   * Called before every model call. False means the daily cap of background remote calls is reached
   * (D26): the pairs not yet typed come back untyped and nothing else is asked.
   */
  reserveCall?: (route: TyperRoute) => Promise<boolean>;
  /** `MEMORA_GOLDEN_RELATIONS=local`: no remote call; a pair with no cached typing is untyped. */
  remoteCallsOff?: boolean;
  limits?: Partial<RelationTypingLimits>;
  /** Show the notes of every pair in the opposite positions and read nothing from the cache (G25). */
  reverseOrder?: boolean;
}

export type TypingUntypedReason = "no_route" | "daily_cap" | "remote_calls_off" | "failed";

export type TypingOutcome =
  | {
      kind: "typed";
      relationType: NoteRelationWriteType;
      direction: TypedDirection;
      origin: "model" | "cache";
    }
  /** The typer vetoed the pair: no relation is persisted. */
  | { kind: "none"; origin: "model" | "cache" }
  | { kind: "untyped"; reason: TypingUntypedReason };

export interface PairTyping {
  pairKey: string;
  /** The canonical endpoints (lo < hi). */
  loNoteId: string;
  hiNoteId: string;
  band: NoteRelationBand;
  outcome: TypingOutcome;
  /** The AI run that typed it (the cached one for a cache hit); null when untyped. */
  aiTaskRunId: string | null;
  /** The note the typer saw first (as `a`): the earlier one in content order, or the other when reversed. */
  shownFirstNoteId: string;
}

export interface RelationTypingResult {
  /** The key the verdicts were cached under; null when there was no writer route. */
  typerKey: string | null;
  pairs: Map<string, PairTyping>;
  calls: number;
  /** Calls that were an item-level re-ask. */
  repairs: number;
  cacheHits: number;
  /** Calls that failed or left an item unanswered; two on one batch leave its pairs untyped. */
  failedAttempts: number;
  inputTokens: number;
  outputTokens: number;
  aiTaskRunIds: string[];
}

/** The contract a typing call states (F4 D23), one per batch size so its strict schema is built once. */
const outputContracts = new Map<number, AiOutputContract>();
function outputContractFor(maxPairs: number): AiOutputContract {
  let contract = outputContracts.get(maxPairs);
  if (!contract) {
    contract = { name: "relation_typing", contract: relationTypingOutputSchema(maxPairs) };
    outputContracts.set(maxPairs, contract);
  }
  return contract;
}

/**
 * Types accepted pairs. Cached verdicts (typed or vetoed) are reused with no call; the others go to
 * the writer in batches of `limits.pairsPerCall`, in content order, one batch at a time. A batch
 * whose answer misses or spoils some items gets one re-ask for those items only; a call that fails
 * is asked once more; what is still unanswered is untyped. Typed and vetoed pairs are cached before
 * this returns. A cancelled `signal` rejects; no other failure does.
 */
export async function typeRelationPairs(
  deps: RelationTypingDeps,
  input: readonly TypingPair[],
  options: RelationTypingOptions = {},
  signal?: AbortSignal
): Promise<RelationTypingResult> {
  const limits: RelationTypingLimits = { ...relationTypingLimits, ...options.limits };
  const arranged = arrangeTypingPairs(input, { reverse: options.reverseOrder === true });
  const result: RelationTypingResult = {
    typerKey: null,
    pairs: new Map(),
    calls: 0,
    repairs: 0,
    cacheHits: 0,
    failedAttempts: 0,
    inputTokens: 0,
    outputTokens: 0,
    aiTaskRunIds: []
  };
  const settle = (pair: ArrangedTypingPair, outcome: TypingOutcome, aiTaskRunId: string | null) => {
    result.pairs.set(pair.pairKey, {
      pairKey: pair.pairKey,
      loNoteId: pair.lo.id,
      hiNoteId: pair.hi.id,
      band: pair.band,
      outcome,
      aiTaskRunId,
      shownFirstNoteId: pair.a.id
    });
  };
  const untyped = (pairs: readonly ArrangedTypingPair[], reason: TypingUntypedReason) => {
    for (const pair of pairs) settle(pair, { kind: "untyped", reason }, null);
  };
  if (!arranged.length) return result;

  const route = await deps.resolveRoute();
  if (!route) {
    untyped(arranged, "no_route");
    return result;
  }
  const typerKey = relationTyperKey(route, relationTypingPromptIdentity());
  result.typerKey = typerKey;

  // Cached verdicts first: a hit makes no call whatever the mode. The check reads none.
  const store = options.reverseOrder ? null : deps.store;
  let pending = arranged;
  if (store) {
    const cached = await store.find({
      typerKey,
      pairs: arranged.map((pair) => ({
        loAtomicNoteId: pair.lo.id,
        hiAtomicNoteId: pair.hi.id,
        loHash: pair.lo.hash,
        hiHash: pair.hi.hash
      }))
    });
    pending = [];
    for (const pair of arranged) {
      const verdict = cached.get(pair.pairKey);
      if (!verdict) {
        pending.push(pair);
        continue;
      }
      result.cacheHits += 1;
      settle(
        pair,
        verdict.relationType === "none" || verdict.direction === null
          ? { kind: "none", origin: "cache" }
          : {
              kind: "typed",
              relationType: verdict.relationType,
              direction: verdict.direction,
              origin: "cache"
            },
        verdict.aiTaskRunId
      );
    }
  }
  if (!pending.length) return result;
  if (options.remoteCallsOff && route.lane === "remote") {
    untyped(pending, "remote_calls_off");
    return result;
  }

  const batches = typingBatches(pending, limits.pairsPerCall);
  const outputContract = outputContractFor(limits.pairsPerCall);

  /** Asks one batch; the reason it stopped early (cap, no route) or null when it ended normally. */
  const typeBatch = async (batch: TypingBatchItem[]): Promise<TypingUntypedReason | null> => {
    let remaining = batch;
    let problems: Map<string, RelationTypingProblem> | null = null;
    for (let attempt = 0; remaining.length > 0 && attempt < limits.attemptsPerBatch; attempt += 1) {
      signal?.throwIfAborted();
      if (options.reserveCall && !(await options.reserveCall(route))) {
        untyped(
          remaining.map((item) => item.pair),
          "daily_cap"
        );
        return "daily_cap";
      }
      const repair = problems !== null;
      const prompt = repair
        ? buildRelationTypingRepairPrompt(remaining, problems!)
        : buildRelationTypingPrompt(remaining);
      const logContext: AiTaskLogContext = {
        stage: "relation_typing",
        operation: repair ? relationTypingRepairOperation : relationTypingOperation,
        origin: "job",
        workloadClass: "write-fast",
        priority: options.priority ?? "P2",
        promptVersion: relationTypingContractVersion,
        outputContract,
        attempt,
        isRepair: repair,
        ...(deps.contentLanguage ? { contentLanguage: deps.contentLanguage } : {}),
        ...(options.jobId ? { jobId: options.jobId } : {}),
        ...(options.ingestionRunId ? { ingestionRunId: options.ingestionRunId } : {}),
        ...(options.sourceItemIds ? { sourceItemIds: options.sourceItemIds } : {})
      };
      const callLimits = {
        maxOutputTokens: limits.outputTokensBase + limits.outputTokensPerPair * remaining.length
      };
      result.calls += 1;
      if (repair) result.repairs += 1;
      let execution;
      try {
        execution = await deps.ai.runDefaultTask(
          "structured-output",
          prompt,
          logContext,
          signal,
          callLimits
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        result.failedAttempts += 1;
        deps.logger?.warn("A relation typing call failed", error);
        problems = null;
        continue;
      }
      if (!execution) {
        untyped(
          remaining.map((item) => item.pair),
          "no_route"
        );
        return "no_route";
      }
      result.inputTokens += execution.inputTokens ?? 0;
      result.outputTokens += execution.outputTokens ?? 0;
      result.aiTaskRunIds.push(execution.aiTaskRunId);
      const answer = validateRelationTypingAnswer(
        execution.output,
        remaining.map((item) => item.alias)
      );
      for (const item of remaining) {
        const verdict = answer.accepted.get(item.alias);
        if (!verdict) continue;
        const direction = storedTypingDirection(item.pair, verdict);
        const outcome: TypingOutcome =
          verdict.type === "none" || direction === null
            ? { kind: "none", origin: "model" }
            : {
                kind: "typed",
                relationType: verdict.type,
                direction,
                origin: "model"
              };
        settle(item.pair, outcome, execution.aiTaskRunId);
        await store?.record({
          loAtomicNoteId: item.pair.lo.id,
          hiAtomicNoteId: item.pair.hi.id,
          typerKey,
          loHash: item.pair.lo.hash,
          hiHash: item.pair.hi.hash,
          relationType: verdict.type,
          direction,
          aiTaskRunId: execution.aiTaskRunId
        });
      }
      remaining = remaining.filter((item) => !answer.accepted.has(item.alias));
      if (remaining.length) result.failedAttempts += 1;
      problems = answer.problems.size ? new Map(answer.problems) : null;
    }
    untyped(
      remaining.map((item) => item.pair),
      "failed"
    );
    return null;
  };

  for (const [index, batch] of batches.entries()) {
    const stopped = await typeBatch(batch);
    if (stopped) {
      // The cap or a missing route ends the rest of the work too.
      untyped(
        batches.slice(index + 1).flatMap((later) => later.map((item) => item.pair)),
        stopped === "no_route" ? "no_route" : "daily_cap"
      );
      break;
    }
  }
  return result;
}
