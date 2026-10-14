/**
 * Request design for Spike A2: one Decisions request per source note.
 *
 * `input` = the frozen Spike A instruction, the query note and the candidate notes labelled with
 * short aliases (c1..cN, in a seeded random order so the old pipeline's ranking cannot leak
 * through position). `questions` = one predicate per candidate; the typed configuration adds one
 * choice question per candidate (relation type and direction, shuffled option order).
 *
 * Note text is Spike A's (`Title`, `Idea`, first 400 body characters), taken from its dataset.
 */
import { createHash } from "node:crypto";

import { seededRandom } from "../reranker/metrics.js";

import {
  decisionsModel,
  type ChoiceOption,
  type DecisionQuestion,
  type DecisionRequest
} from "./client.js";

export type ConfigName = "predicate" | "typed";

/** Most candidates one request carries (the old pipeline's shortlists hold at most 20). */
export const maxCandidatesPerRequest = 20;

export const predicateQuestion = (alias: string): string =>
  `${alias} has a substantive conceptual relationship with the query note (supports, contradicts, extends, depends on, exemplifies or clarifies it); sharing a topic alone does not count.`;

export const typeQuestion = (alias: string): string =>
  `How does the query note relate to ${alias}? The direction is always query note to ${alias}. Choose none when there is no substantive conceptual relationship; sharing a topic alone is none.`;

export const relationTypes = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "clarifies",
  "none"
] as const;
export type RelationType = (typeof relationTypes)[number];

const typeDescriptions: Record<RelationType, string> = {
  supports: "The query note gives supporting reasoning or evidence for the candidate's claim.",
  contradicts:
    "The query note takes a position incompatible with the candidate on the same question.",
  extends: "The query note adds substantive scope or mechanism to the candidate's claim.",
  depends_on: "The query note relies on the candidate as a genuine prerequisite.",
  example_of: "The query note is a concrete example of the idea in the candidate.",
  clarifies: "The query note explains or resolves an ambiguity in the candidate's claim.",
  none: "No substantive conceptual relationship; at most a shared topic, names or vocabulary."
};

const inputPreamble =
  'In this request, "Query" is the query note and each "Document" is one candidate note ' +
  "(c1, c2, ...). Answer every question about its own candidate only, independently of the others.";

function seedOf(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

function shuffled<T>(items: readonly T[], seed: string): T[] {
  const random = seededRandom(seedOf(seed));
  const result = [...items];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [result[index], result[swap]] = [result[swap]!, result[index]!];
  }
  return result;
}

export interface NoteRef {
  id: string;
  text: string;
}

export interface BuiltRequest {
  key: string;
  request: DecisionRequest;
  /** Candidate ids in alias order (`c1` is index 0). */
  candidateIds: string[];
  config: ConfigName;
}

export function buildRequest(params: {
  key: string;
  instruction: string;
  query: NoteRef;
  candidates: readonly NoteRef[];
  config: ConfigName;
  /** Changes the candidate order (robustness runs); empty for the primary design. */
  orderSalt?: string;
}): BuiltRequest {
  const ordered = shuffled(
    params.candidates,
    params.orderSalt ? `order:${params.orderSalt}:${params.key}` : `order:${params.key}`
  );
  const aliases = ordered.map((_, index) => `c${index + 1}`);
  const input = [
    params.instruction,
    inputPreamble,
    `Query note:\n${params.query.text}`,
    "Candidate notes:",
    ...ordered.map((note, index) => `[${aliases[index]}]\n${note.text}`)
  ].join("\n\n");
  const questions: DecisionQuestion[] = aliases.map((alias) => ({
    type: "predicate",
    name: `rel_${alias}`,
    instructions: predicateQuestion(alias)
  }));
  if (params.config === "typed") {
    for (const alias of aliases) {
      const choices: ChoiceOption[] = shuffled(relationTypes, `type:${params.key}:${alias}`).map(
        (value) => ({ value, description: typeDescriptions[value] })
      );
      questions.push({
        type: "choice",
        name: `type_${alias}`,
        instructions: typeQuestion(alias),
        choices
      });
    }
  }
  return {
    key: params.key,
    request: { model: decisionsModel, input, questions },
    candidateIds: ordered.map((note) => note.id),
    config: params.config
  };
}

/**
 * Fingerprint of everything that defines the design (instruction, wording, option semantics,
 * chunking, model). The held-out stages refuse to run unless it matches the one frozen on tuning.
 */
export function designFingerprint(instruction: string): string {
  const sample = buildRequest({
    key: "fingerprint",
    instruction,
    query: { id: "q", text: "QUERY" },
    candidates: [
      { id: "a", text: "A" },
      { id: "b", text: "B" },
      { id: "c", text: "C" }
    ],
    config: "typed"
  });
  return createHash("sha256")
    .update(JSON.stringify([sample.request, maxCandidatesPerRequest, typeDescriptions]))
    .digest("hex");
}
