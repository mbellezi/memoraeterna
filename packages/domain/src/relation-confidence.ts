/**
 * How sure a suggested relation is, as a word, and which suggestions the Inbox takes (F5 D33,
 * Q30, Q37). Pure and browser-safe: the Inbox read model's SQL arm, the renderer's words and the
 * inline cards read the one rule here, so they never disagree. Which relations are shown at all
 * is decided only by the visibility module of the database package; confidence never hides one.
 */

/**
 * The bounds of the confidence words, typed configuration: `high` from 0.85 up, `medium` from 0.6
 * up to that, `low` below 0.6 *(cal.: the owner may change them; the read model reads these)*.
 */
export const relationConfidenceBands = { high: 0.85, medium: 0.6 } as const;

export const relationConfidenceWords = ["high", "medium", "low", "unknown"] as const;
export type RelationConfidenceWord = (typeof relationConfidenceWords)[number];

/**
 * The word for a calibrated probability. A relation written by an uncalibrated or threshold-only
 * decider has none (null): its confidence is unknown, never a number made up for it.
 */
export function confidenceBand(probability: number | null | undefined): RelationConfidenceWord {
  if (probability === null || probability === undefined || !Number.isFinite(probability))
    return "unknown";
  if (probability >= relationConfidenceBands.high) return "high";
  if (probability >= relationConfidenceBands.medium) return "medium";
  return "low";
}

/**
 * Whether a suggested relation also goes to the Inbox and counts in "needs you" (D33): its stance
 * is a contradiction, or its confidence is not "high" (a null probability is not high). `stance`
 * is the stored relation type; the Inbox's SQL arm applies the same rule on the same column.
 */
export function routesToInbox(input: {
  stance: string | null | undefined;
  probability: number | null | undefined;
}): boolean {
  if (input.stance === "contradicts") return true;
  return confidenceBand(input.probability) !== "high";
}

/**
 * The case table that drives both the domain test and the database test of the routing rule, so
 * the predicate and the SQL arm are proven against the same cases. `probability` is as stored.
 */
export const relationRoutingCases: ReadonlyArray<{
  stance: string;
  probability: number | null;
  routes: boolean;
}> = [
  { stance: "supports", probability: 0.64, routes: true },
  { stance: "supports", probability: 0.91, routes: false },
  { stance: "supports", probability: null, routes: true },
  { stance: "supports", probability: 0.85, routes: false },
  { stance: "supports", probability: 0.6, routes: true },
  { stance: "extends", probability: 0.2, routes: true },
  { stance: "contradicts", probability: 0.64, routes: true },
  { stance: "contradicts", probability: 0.91, routes: true },
  { stance: "contradicts", probability: null, routes: true }
];
