import { createHash } from "node:crypto";

import { canonicalJson } from "../cassette.js";
import {
  buildDecisionsWireRequest,
  decisionsCandidateAlias,
  decisionsContract,
  seededOrder
} from "./design.js";
import type { DecisionsLimits } from "./limits.js";

/**
 * The fingerprints a frozen calibration of the Decisions decider names (plan decision 30, T58's
 * re-freeze 8017633d): the identity's `requestDesignSha256` and the Spike A2 fingerprint inside it.
 * The product's requests must be the design that was frozen, so these are computed here, from the
 * product's own builder and limits, and a test holds them to the frozen values. A change of the
 * instruction, the wording, the model, the candidates per request, the orders or the scale changes
 * them, and the calibration then no longer applies (the decider is uncalibrated until a new freeze).
 */

/** The relation types of Spike A2's typed configuration, which the product never sends. */
const typedRelationTypes = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "clarifies",
  "none"
] as const;

const typedDescriptions: Record<(typeof typedRelationTypes)[number], string> = {
  supports: "The query note gives supporting reasoning or evidence for the candidate's claim.",
  contradicts:
    "The query note takes a position incompatible with the candidate on the same question.",
  extends: "The query note adds substantive scope or mechanism to the candidate's claim.",
  depends_on: "The query note relies on the candidate as a genuine prerequisite.",
  example_of: "The query note is a concrete example of the idea in the candidate.",
  clarifies: "The query note explains or resolves an ambiguity in the candidate's claim.",
  none: "No substantive conceptual relationship; at most a shared topic, names or vocabulary."
};

const typedQuestion = (alias: string): string =>
  `How does the query note relate to ${alias}? The direction is always query note to ${alias}. Choose none when there is no substantive conceptual relationship; sharing a topic alone is none.`;

const permuted = <T>(items: readonly T[], seed: string): T[] =>
  seededOrder(items.length, seed).map((index) => items[index]!);

const sha256Hex = (value: string): string => createHash("sha256").update(value).digest("hex");

/**
 * Spike A2's `designFingerprint(instruction)`, reproduced byte for byte: the typed-configuration
 * sample request of three candidates (the spike's request builder with its seeded orders), the
 * candidates per request and the type descriptions. The typed part is never sent by the product; it
 * is here because the frozen request design hashes this fingerprint.
 */
export function decisionsSpikeFingerprint(
  instruction: string,
  limits: Pick<DecisionsLimits, "model" | "maxCandidatesPerRequest">
): string {
  const candidates = permuted(["A", "B", "C"], "order:fingerprint");
  const predicates = buildDecisionsWireRequest(
    { contract: decisionsContract, instruction, query: "QUERY", candidates },
    limits.model
  );
  const aliases = candidates.map((_, index) => decisionsCandidateAlias(index));
  const request = {
    model: predicates.model,
    input: predicates.input,
    questions: [
      ...predicates.questions,
      ...aliases.map((alias) => ({
        type: "choice",
        name: `type_${alias}`,
        instructions: typedQuestion(alias),
        choices: permuted(typedRelationTypes, `type:fingerprint:${alias}`).map((value) => ({
          value,
          description: typedDescriptions[value]
        }))
      }))
    ]
  };
  return sha256Hex(JSON.stringify([request, limits.maxCandidatesPerRequest, typedDescriptions]));
}

/**
 * Everything the request design is, beyond what Spike A2's fingerprint covers: the predicate
 * question, the neighbourhood, the two orders and how their answers are combined, and the scale. The
 * `candidates` and `orders` texts are the frozen design's own words.
 */
export function decisionsRequestDesign(
  instruction: string,
  limits: Pick<
    DecisionsLimits,
    "model" | "maxCandidatesPerRequest" | "orderSalts" | "probabilityEpsilon"
  >,
  bodyCharacters: number
) {
  return {
    designFingerprint: decisionsSpikeFingerprint(instruction, limits),
    question: "predicate",
    model: limits.model,
    candidates:
      "the note's decided neighbourhood (its own list and the notes whose lists hold it), in id order, chunked at 20 (balanced)",
    directions: "both",
    orderSalts: [...limits.orderSalts],
    orders: "the mean of the two orders' predicate probabilities",
    scale: { kind: "logit", epsilon: limits.probabilityEpsilon },
    bodyCharacters,
    maxCandidatesPerRequest: limits.maxCandidatesPerRequest
  };
}

/** The fingerprint of the request design: the calibration identity's `requestDesignSha256`. */
export const decisionsRequestDesignSha256 = (
  instruction: string,
  limits: Parameters<typeof decisionsRequestDesign>[1],
  bodyCharacters: number
): string => sha256Hex(canonicalJson(decisionsRequestDesign(instruction, limits, bodyCharacters)));
