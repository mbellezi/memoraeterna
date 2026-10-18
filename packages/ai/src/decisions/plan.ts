import type { AiTaskRequest } from "../contracts.js";
import {
  decisionsContextWording,
  decisionsContract,
  decisionsLogOdds,
  decisionsOrderSeed,
  decisionsTaskRequest,
  seededOrder,
  type DecisionsTaskInput
} from "./design.js";
import type { DecisionsLimits } from "./limits.js";

/** One directed list: a query note and the candidates scored against it (query to candidate). */
export interface DecisionsList {
  query: string;
  /** In content order (never ID order); the plan shuffles them. */
  candidates: readonly string[];
}

/** One request of a plan: a chunk of one list in one candidate order (or in both, when they agree). */
export interface PlannedDecisionsRequest {
  /** Position in the plan. */
  id: number;
  listIndex: number;
  /** The list's candidate indices in the order this request sends them (`c1` first). */
  candidateIndices: number[];
  /** The orders this request answers: both when the two shuffles produce the same request. */
  orders: ReadonlyArray<"A" | "B">;
  input: DecisionsTaskInput;
}

/**
 * The requests that score some directed lists (Spike A2, the dense validation): each list is cut
 * into balanced chunks of at most `maxCandidatesPerRequest`, and each chunk is sent in the two candidate
 * orders of the design. A request that the two orders make identical (a single candidate, or two
 * shuffles that agree) is sent once and answers both: identical requests give identical answers.
 */
export function planDecisionRequests(
  lists: readonly DecisionsList[],
  instruction: string,
  limits: Pick<DecisionsLimits, "maxCandidatesPerRequest" | "orderSalts">
): PlannedDecisionsRequest[] {
  const requests: PlannedDecisionsRequest[] = [];
  lists.forEach((list, listIndex) => {
    if (list.candidates.length === 0) return;
    // Balanced chunks, as the frozen design cut them: 45 candidates are 3 x 15, not 20 + 20 + 5.
    const parts = Math.ceil(list.candidates.length / limits.maxCandidatesPerRequest);
    const each = Math.ceil(list.candidates.length / parts);
    for (let chunk = 0; chunk < parts; chunk += 1) {
      const start = chunk * each;
      const size = Math.min(each, list.candidates.length - start);
      if (size <= 0) break;
      const sent = (["A", "B"] as const).map((label, position) => {
        const order = seededOrder(
          size,
          decisionsOrderSeed(limits.orderSalts[position]!, list.query, chunk)
        );
        const candidateIndices = order.map((index) => start + index);
        return {
          label,
          candidateIndices,
          input: {
            contract: decisionsContract,
            instruction,
            query: list.query,
            candidates: candidateIndices.map((index) => list.candidates[index]!)
          } satisfies DecisionsTaskInput
        };
      });
      const [first, second] = sent as [(typeof sent)[number], (typeof sent)[number]];
      if (first.candidateIndices.join() === second.candidateIndices.join())
        requests.push({
          id: requests.length,
          listIndex,
          candidateIndices: first.candidateIndices,
          orders: ["A", "B"],
          input: first.input
        });
      else
        for (const one of sent)
          requests.push({
            id: requests.length,
            listIndex,
            candidateIndices: one.candidateIndices,
            orders: [one.label],
            input: one.input
          });
    }
  });
  return requests;
}

/** The task request of a planned request, for the adapter. */
export function plannedTaskRequest(
  request: PlannedDecisionsRequest,
  limits: Pick<DecisionsLimits, "model">
): AiTaskRequest {
  return decisionsTaskRequest(request.input, limits);
}

/**
 * Input tokens a plan is expected to use, for the cap check before it is sent: the UTF-8 bytes of
 * every request's text (the instruction, the fixed wording, the query and the candidates) at the
 * typed bytes per token, and the hidden tokens of each question. Bytes, not characters: Chinese or
 * Japanese text costs about one token per character, and its three bytes per character count as 1.2
 * tokens, where counting characters would give 0.4.
 */
export function estimatePlanInputTokens(
  requests: readonly PlannedDecisionsRequest[],
  limits: Pick<DecisionsLimits, "estimate">
): number {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  let total = 0;
  for (const request of requests) {
    const sent =
      bytes(request.input.instruction) +
      bytes(decisionsContextWording) +
      bytes(request.input.query) +
      request.input.candidates.reduce((sum, text) => sum + bytes(text), 0);
    total +=
      Math.ceil(sent / limits.estimate.bytesPerToken) +
      request.input.candidates.length * limits.estimate.tokensPerQuestion;
  }
  return total;
}

/** One candidate's score of a directed list. */
export interface DirectedDecision {
  /** Mean of the probabilities of the two orders; null when an order did not answer. */
  probability: number | null;
  /** Its log-odds on the bake-off scale; null with it. */
  logOdds: number | null;
}

/**
 * Combines the answers of a plan into one decision per candidate of every list: the mean of the
 * probabilities of the two orders, then its log-odds on the bake-off scale (the scale the
 * calibration is frozen on). A candidate with no answer in an order (a refusal) has none.
 */
export function combineDecisionAnswers(
  lists: readonly DecisionsList[],
  requests: readonly PlannedDecisionsRequest[],
  answers: ReadonlyMap<number, ReadonlyArray<number | null>>,
  limits: Pick<DecisionsLimits, "probabilityEpsilon">
): DirectedDecision[][] {
  const byOrder = lists.map((list) =>
    list.candidates.map(() => ({ A: null as number | null, B: null as number | null }))
  );
  for (const request of requests) {
    const probabilities = answers.get(request.id);
    if (!probabilities) throw new Error(`The plan has no answer for request ${request.id}.`);
    request.candidateIndices.forEach((candidateIndex, position) => {
      const slot = byOrder[request.listIndex]![candidateIndex]!;
      for (const order of request.orders) slot[order] = probabilities[position] ?? null;
    });
  }
  return byOrder.map((slots) =>
    slots.map(({ A, B }) => {
      if (A === null || B === null) return { probability: null, logOdds: null };
      const probability = (A + B) / 2;
      return {
        probability,
        logOdds: decisionsLogOdds(probability, limits.probabilityEpsilon)
      };
    })
  );
}
