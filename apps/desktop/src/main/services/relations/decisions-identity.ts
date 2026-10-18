// What a Decisions score belongs to (F3 plan decision 30): the instruction of the prompt catalog,
// the request design, the text template and the model give the decider's cache key (a stored
// direction is reused only by the decider that scored it) and its calibration identity (the frozen
// bands it applies under). There is no runtime build: the provider's model is the whole runtime, so
// the identity names the fingerprint of the request design instead. The identity here is the one T58
// froze (`frozenRelationCalibrations`): the same contract, instruction, template, body length, rule,
// provider, model and request design, computed from the product's own request builder.
import { sha256 } from "@app/conversion";
import {
  decisionsRequestDesignSha256,
  resolveDecisionsLimits,
  type DecisionsLimits
} from "@app/ai";
import {
  findRelationCalibration,
  relationCalibrationIdentityKey,
  relationDecideDecisionsContract,
  type RelationCalibrationEntry,
  type RelationsConfig,
  type RemoteRelationCalibrationIdentity
} from "@app/domain";

import { renderPrompt } from "../prompt-runtime.js";

/** The decider cache key format (v2: the calibration identity's key). */
const decisionsCacheKeyVersion = "relation-decisions-cache-key-v2";

/** The provider the frozen identity names (the OpenAI Platform), not the adapter's lane name. */
export const decisionsCalibrationProvider = "openai";

/** The instruction, rendered from the prompt catalog (`relations.decisions.instruction`). */
export function relationDecisionsInstruction(): string {
  return renderPrompt("relations.decisions.instruction");
}

export interface DecisionsDesign {
  instruction: string;
  instructionSha256: string;
  identity: RemoteRelationCalibrationIdentity;
  cacheKey: string;
  /** The frozen calibration of exactly this identity, or null: the decider is then uncalibrated. */
  calibration: RelationCalibrationEntry | null;
  /** The mean log-odds an uncalibrated Decisions decider must reach to be suggested. */
  uncalibratedPass: number;
}

/**
 * The identity, cache key and calibration of the Decisions decider for an instruction, under the
 * relation config and the typed limits. A change of the instruction, the wording, the model, the
 * candidates per request, the orders, the scale, the template or the body length is another
 * identity: the decider is then uncalibrated (it only suggests) until a new freeze, and its stored
 * scores are not reused.
 */
export function decisionsDesign(input: {
  instruction: string;
  config: Pick<RelationsConfig, "decide" | "decisions" | "calibrations">;
  limits?: DecisionsLimits;
}): DecisionsDesign {
  const limits = input.limits ?? resolveDecisionsLimits();
  const { template, bodyCharacters, rule } = input.config.decide;
  const instructionSha256 = sha256(input.instruction);
  const identity: RemoteRelationCalibrationIdentity = {
    contract: relationDecideDecisionsContract,
    instructionSha256,
    template,
    bodyCharacters,
    rule,
    provider: decisionsCalibrationProvider,
    model: limits.model,
    runtimeKind: "remote",
    requestDesignSha256: decisionsRequestDesignSha256(input.instruction, limits, bodyCharacters)
  };
  return {
    instruction: input.instruction,
    instructionSha256,
    identity,
    cacheKey: sha256(
      JSON.stringify({
        version: decisionsCacheKeyVersion,
        identity: relationCalibrationIdentityKey(identity)
      })
    ),
    calibration: findRelationCalibration(input.config, identity),
    uncalibratedPass: input.config.decisions.uncalibratedPassLogOdds
  };
}
