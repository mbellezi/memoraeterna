import { createHash } from "node:crypto";

import { z } from "zod";

import type { AiTaskRequest } from "../contracts.js";
import type { DecisionsLimits } from "./limits.js";

/**
 * The request design of the Decisions API decider (F3 plan decision 30), the one Spike A2 and the
 * dense validation measured: one `POST /v1/decisions` request per query note, the frozen
 * instruction, the query note and up to 20 candidate notes `c1..cN` in a seeded order, and one
 * `predicate` question per candidate. The wording below is the wire contract of that design, not a
 * catalog prompt: only the instruction is application wording (the prompt catalog), and a change of
 * any of it changes {@link decisionsRequestDesignSha256}, hence the calibration identity.
 */
/**
 * The format tag of a Decisions task's input (and of its cassette key). The calibration's own contract
 * (`relationDecideDecisionsContract`, "relation-decide-decisions-v1") is the domain's.
 */
export const decisionsContract = "relation-decisions-v1";

/** The text between the instruction and the notes, in the validated requests. */
export const decisionsContextWording =
  'In this request, "Query" is the query note and each "Document" is one candidate note ' +
  "(c1, c2, ...). Answer every question about its own candidate only, independently of the others.";

export const decisionsQuestionWording = (alias: string): string =>
  `${alias} has a substantive conceptual relationship with the query note (supports, contradicts, extends, depends on, exemplifies or clarifies it); sharing a topic alone does not count.`;

export const decisionsCandidateAlias = (index: number): string => `c${index + 1}`;
export const decisionsQuestionName = (index: number): string =>
  `rel_${decisionsCandidateAlias(index)}`;

/** What one Decisions task carries: the request in the order it is sent (the candidates are shuffled). */
export const decisionsTaskInputSchema = z
  .object({
    contract: z.literal(decisionsContract),
    /** The instruction text from the prompt catalog. */
    instruction: z.string().min(1).max(4_000),
    /** The rendered query note. */
    query: z.string().min(1).max(32_000),
    /** The rendered candidate notes, `c1` first. */
    candidates: z.array(z.string().min(1).max(32_000)).min(1).max(100)
  })
  .strict();
export type DecisionsTaskInput = z.infer<typeof decisionsTaskInputSchema>;

/** A `reranking` task request for the Decisions adapter; its cassette key is this request's body. */
export function decisionsTaskRequest(
  input: DecisionsTaskInput,
  limits: Pick<DecisionsLimits, "model">
): AiTaskRequest {
  return {
    taskType: "reranking",
    input: JSON.stringify(decisionsTaskInputSchema.parse(input)),
    modelId: limits.model,
    requiredCapabilities: ["reranking"],
    parameters: {},
    metadata: {},
    workloadClass: "decide"
  };
}

/** The task input of a request, or null when the input is not a Decisions request. */
export function readDecisionsTaskInput(input: unknown): DecisionsTaskInput | null {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return null;
    }
  }
  const parsed = decisionsTaskInputSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export interface DecisionsWireRequest {
  model: string;
  input: string;
  questions: Array<{ type: "predicate"; name: string; instructions: string }>;
}

/** The wire request of a task: the validated design, byte for byte. */
export function buildDecisionsWireRequest(
  input: DecisionsTaskInput,
  model: string
): DecisionsWireRequest {
  return {
    model,
    input: [
      input.instruction,
      decisionsContextWording,
      `Query note:\n${input.query}`,
      "Candidate notes:",
      ...input.candidates.map((text, index) => `[${decisionsCandidateAlias(index)}]\n${text}`)
    ].join("\n\n"),
    questions: input.candidates.map((_, index) => ({
      type: "predicate" as const,
      name: decisionsQuestionName(index),
      instructions: decisionsQuestionWording(decisionsCandidateAlias(index))
    }))
  };
}

const answerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("predicate"),
    name: z.string().nullable(),
    probability: z.number().min(0).max(1)
  }),
  z.object({ type: z.literal("refusal"), name: z.string().nullable() })
]);

export const decisionsResponseSchema = z.object({
  model: z.string(),
  answers: z.array(z.unknown()),
  usage: z.object({
    input_tokens: z.number().nonnegative(),
    output_tokens: z.number().nonnegative().optional()
  })
});

/**
 * The probability of each candidate, in the order they were sent; null for a refusal or a missing
 * answer. Answers are matched by their echoed `name`, falling back to their position.
 */
export function readDecisionsAnswers(
  answers: readonly unknown[],
  count: number
): Array<number | null> {
  const probabilities: Array<number | null> = Array.from({ length: count }, () => null);
  answers.forEach((raw, position) => {
    const parsed = answerSchema.safeParse(raw);
    if (!parsed.success) return;
    const named = parsed.data.name ? /^rel_c(\d+)$/u.exec(parsed.data.name) : null;
    const index = named ? Number(named[1]) - 1 : position;
    if (index < 0 || index >= count) return;
    probabilities[index] = parsed.data.type === "predicate" ? parsed.data.probability : null;
  });
  return probabilities;
}

/** The mulberry32 generator the validated design shuffled with. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The indices of `count` items in a seeded order: a Fisher-Yates shuffle of 0..count-1 whose seed is
 * the first 32 bits of `sha256(seed)`. The same seed gives the same order on every machine.
 */
export function seededOrder(count: number, seed: string): number[] {
  const random = seededRandom(createHash("sha256").update(seed).digest().readUInt32BE(0));
  const order = Array.from({ length: count }, (_, index) => index);
  for (let index = order.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [order[index], order[swap]] = [order[swap]!, order[index]!];
  }
  return order;
}

/**
 * The shuffle seed of one request in one order: the salt and a content key of the query note and
 * the chunk (never an ID, so the request is a function of content, `rules/ai.md`).
 */
export function decisionsOrderSeed(salt: string, queryText: string, chunk: number): string {
  const key = createHash("sha256").update(queryText).digest("hex");
  return `order:${salt}:${key}:${chunk}`;
}

/** The log-odds of a probability on the bake-off scale: clipped to [epsilon, 1 - epsilon]. */
export function decisionsLogOdds(probability: number, epsilon: number): number {
  const clipped = Math.min(1 - epsilon, Math.max(epsilon, probability));
  return Math.log(clipped / (1 - clipped));
}
