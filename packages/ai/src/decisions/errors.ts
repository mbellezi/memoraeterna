import type { DecisionsFallbackReason } from "@app/domain";

/** The localized message of each reason the Decisions decider is not used or failed. */
export const decisionsErrorKeys: Record<DecisionsFallbackReason, string> = {
  no_key: "errors.relations.decisions.noKey",
  invalid_key: "errors.relations.decisions.invalidKey",
  spend_cap: "errors.relations.decisions.spendCap",
  quota: "errors.relations.decisions.quota",
  breaker_open: "errors.relations.decisions.breakerOpen",
  network: "errors.relations.decisions.network",
  error: "errors.relations.decisions.failed"
};

/**
 * The Decisions decider could not decide (no key, a refused key, the day's cap reached, an open
 * breaker, the network): the relation matcher decides with the local ranker instead. The message is
 * a localization key; `cause` is the provider's failure, already free of the key.
 */
export class DecisionsUnavailableError extends Error {
  public readonly reason: DecisionsFallbackReason;

  public constructor(reason: DecisionsFallbackReason, options?: ErrorOptions) {
    super(decisionsErrorKeys[reason], options);
    this.name = "DecisionsUnavailableError";
    this.reason = reason;
  }
}
