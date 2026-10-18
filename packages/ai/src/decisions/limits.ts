import { z } from "zod";

import { resolveAiRuntimeConfig, type AiRuntimeConfig } from "../remote-execution.js";

/**
 * Typed limits of the OpenAI Decisions API decider (F3 plan decision 30; Spike A2 and the dense
 * validation). Everything numeric about the provider and the request design lives here, not in the
 * adapter: the endpoint, the model, the published price, how many candidates one request carries,
 * the two candidate orders, the probability scale, the deadlines and the retries.
 */
export const decisionsLimitsSchema = z
  .object({
    /** The one fixed endpoint; the adapter follows no redirect. */
    url: z.literal("https://api.openai.com/v1/decisions"),
    /** The adapter's provider id: the scheduler lane is `remote:<providerId>`. */
    providerId: z.string().min(1),
    /** The only model of the public beta (Spike A2). */
    model: z.string().min(1),
    /** Published price of an input token, US$ per million; output and cached tokens are free. */
    pricePerMillionInputTokensUsd: z.number().nonnegative(),
    /** Candidates one request carries; a longer list is split (the bake-off's chunking). */
    maxCandidatesPerRequest: z.number().int().min(1).max(100),
    /**
     * Candidates a queried note's request carries when its decided neighbourhood is added to the
     * notes asked about (the frozen design sends the whole neighbourhood; the validated requests
     * averaged 10.4 candidates). A request never drops a note asked about, and a neighbourhood past
     * this size is cut in content order. It bounds the cost of a decision, not the design.
     */
    maxNeighbourhood: z.number().int().min(1).max(100),
    /**
     * The shuffle salts of the two candidate orders (the bake-off's `bakeoff-1` and `bakeoff-2`):
     * a score is the mean of the probabilities of both orders, never of one (Spike A2: one extra
     * order flips 3% of decisions; the dense test measured 10%).
     */
    orderSalts: z.tuple([z.string().min(1), z.string().min(1)]),
    /** The probability is clipped to [epsilon, 1 - epsilon] before the log-odds (the bake-off scale). */
    probabilityEpsilon: z.number().gt(0).lt(0.5),
    /** Largest response body read. */
    maxResponseBytes: z.number().int().positive(),
    /** Total deadline of one request, retries and their backoffs included, from its execution start. */
    totalDeadlineMs: z.number().int().positive(),
    retry: z
      .object({
        /** Attempts of one request, the first included (429, 5xx, timeouts and network failures). */
        maxAttempts: z.number().int().min(1).max(10),
        baseDelayMs: z.number().int().positive(),
        maxDelayMs: z.number().int().positive(),
        /** The longest `Retry-After` waited for inside the call; a longer one fails the request. */
        maxInlineRetryAfterMs: z.number().int().nonnegative()
      })
      .strict(),
    /**
     * The estimate a request's cost is checked against the day's cap with before it is sent: input
     * tokens from characters, and the hidden tokens each question adds (Spike A2: about 150).
     */
    estimate: z
      .object({
        charactersPerToken: z.number().positive(),
        tokensPerQuestion: z.number().int().nonnegative()
      })
      .strict()
  })
  .strict();
export type DecisionsLimits = z.infer<typeof decisionsLimitsSchema>;

export const defaultDecisionsLimits: DecisionsLimits = {
  url: "https://api.openai.com/v1/decisions",
  providerId: "openai-decisions",
  model: "gpt-6-luna",
  pricePerMillionInputTokensUsd: 0.1,
  maxCandidatesPerRequest: 20,
  maxNeighbourhood: 12,
  orderSalts: ["bakeoff-1", "bakeoff-2"],
  probabilityEpsilon: 1e-7,
  maxResponseBytes: 4_000_000,
  totalDeadlineMs: 30_000,
  retry: { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 8_000, maxInlineRetryAfterMs: 10_000 },
  estimate: { charactersPerToken: 2.5, tokensPerQuestion: 150 }
};

export type DecisionsLimitsInput = Partial<Omit<DecisionsLimits, "retry" | "estimate">> & {
  retry?: Partial<DecisionsLimits["retry"]>;
  estimate?: Partial<DecisionsLimits["estimate"]>;
};

export function resolveDecisionsLimits(input: DecisionsLimitsInput = {}): DecisionsLimits {
  return decisionsLimitsSchema.parse({
    ...defaultDecisionsLimits,
    ...input,
    retry: { ...defaultDecisionsLimits.retry, ...input.retry },
    estimate: { ...defaultDecisionsLimits.estimate, ...input.estimate }
  });
}

/** The remote execution config a request runs under: its own deadline and retry policy. */
export function decisionsRuntimeConfig(limits: DecisionsLimits): AiRuntimeConfig {
  return resolveAiRuntimeConfig({
    deadlines: { totalMs: { decide: limits.totalDeadlineMs } },
    retry: limits.retry
  });
}

/** The cost in US$ of input tokens at the typed price. */
export function decisionsCostUsd(inputTokens: number, limits: DecisionsLimits): number {
  return (inputTokens * limits.pricePerMillionInputTokensUsd) / 1_000_000;
}

/** The lane the decider's requests run on: one remote lane of its own, with its own breaker. */
export function decisionsLaneKey(limits: Pick<DecisionsLimits, "providerId">): `remote:${string}` {
  return `remote:${limits.providerId}`;
}
