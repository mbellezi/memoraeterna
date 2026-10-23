// The autonomy matrix (F4 spec 3.2, D12) and the background policy of each Gardener job kind: which
// work a kind does, which model calls it makes, and whether every one of its rows is background work
// (then the global gates hold it at claim) or only some (an import's own link job is the user's: its
// background rows are held per call, at admission).
import type { GardenerAutonomy } from "./controls.js";

/** The work of a kind, as the rows of table 3.2 name it. */
export const gardenerWorks = [
  /** PLACE: placement and the reachability sweep. */
  "place",
  /** The placement gate's local ranker. */
  "gate",
  /** Builds, hard-invariant repairs and REBALANCE's structural pass (soft operations: below). */
  "structure",
  /** Deterministic lints (AUDIT). */
  "lint",
  /** Local deciding: suggestions only (decision 29). */
  "decide",
  /** Soft REBALANCE operations (an operation inside a structural job, not a kind). */
  "rebalance_soft",
  /** Naming. */
  "naming",
  /** Areas. */
  "areas",
  /** REFRESH overview patches. */
  "refresh",
  /** The explanation backfill. */
  "backfill",
  /** MATCH's remote typing and discovery. */
  "typing",
  /** Derived artifacts: composites, catalog headers and topic label vectors. */
  "derived",
  /** Retention and other housekeeping. */
  "housekeeping"
] as const;
export type GardenerWork = (typeof gardenerWorks)[number];

/**
 * The model calls a kind makes: none, local deciding (the ranker), embeddings, or generative
 * writing (a local or a remote writer, or a remote graph call).
 */
export type GardenerKindAi = "none" | "decide" | "embed" | "generative";

export interface GardenerKindPolicy {
  readonly work: GardenerWork;
  readonly ai: GardenerKindAi;
  /**
   * `background`: every row is the Gardener's, so pause, autonomy, only-idle and only-AC hold the
   * kind at claim. `mixed`: an import's own rows are the user's and never wait for those gates; the
   * kind's background calls are held at admission instead.
   */
  readonly budget: "background" | "mixed";
}

const kind = (
  work: GardenerWork,
  ai: GardenerKindAi,
  budget: GardenerKindPolicy["budget"] = "background"
): GardenerKindPolicy => Object.freeze({ work, ai, budget });

/**
 * Every Gardener job kind (spec 3.1). Ingestion, its inline stages, note re-embedding, relation
 * labels, the vault projection, model downloads and DEV jobs are not Gardener work: never gated here.
 */
export const gardenerKindPolicies: Readonly<Record<string, GardenerKindPolicy>> = Object.freeze({
  "topic-place": kind("place", "none"),
  "topic-sweep": kind("place", "none"),
  "topic-gate": kind("gate", "decide"),
  "topic-rebalance": kind("structure", "none"),
  "topic-build": kind("structure", "none"),
  "topic-audit": kind("lint", "none"),
  "topic-name": kind("naming", "generative"),
  "topic-label-embed": kind("derived", "embed"),
  "topic-areas": kind("areas", "generative"),
  "relation-match": kind("decide", "decide"),
  "relation-link": kind("typing", "generative", "mixed"),
  "relation-promote": kind("typing", "none", "mixed"),
  "relation-retype": kind("typing", "generative"),
  "relation-composite": kind("derived", "embed"),
  "catalog-header": kind("derived", "generative"),
  "topic-overview": kind("refresh", "generative"),
  "relation-explain-backfill": kind("backfill", "generative"),
  "gardener-retention": kind("housekeeping", "none")
});

export function gardenerKindPolicy(type: string): GardenerKindPolicy | null {
  return Object.hasOwn(gardenerKindPolicies, type) ? gardenerKindPolicies[type]! : null;
}

/**
 * What a work does under an autonomy level (table 3.2): `runs` (no change-set to review, or
 * suggestions only), `applies` (with undo), `proposes` (a pending review), `provisional` (runs
 * without its generative calls, which are refused, and writes its deterministic fallback: naming
 * under Off writes TF-IDF provisional names), `waits` (held, nothing lost: typing falls back to
 * untyped meanwhile) or `none` (held).
 */
export type AutonomyEffect = "runs" | "applies" | "proposes" | "provisional" | "waits" | "none";

const always: Record<GardenerAutonomy, AutonomyEffect> = {
  off: "runs",
  suggest: "runs",
  auto: "runs"
};

export const autonomyMatrix: Readonly<
  Record<GardenerWork, Readonly<Record<GardenerAutonomy, AutonomyEffect>>>
> = Object.freeze({
  place: always,
  gate: always,
  structure: always,
  lint: always,
  decide: always,
  derived: always,
  housekeeping: always,
  rebalance_soft: { off: "proposes", suggest: "proposes", auto: "applies" },
  naming: { off: "provisional", suggest: "proposes", auto: "applies" },
  areas: { off: "none", suggest: "proposes", auto: "applies" },
  refresh: { off: "none", suggest: "proposes", auto: "applies" },
  backfill: { off: "none", suggest: "runs", auto: "runs" },
  typing: { off: "waits", suggest: "runs", auto: "runs" }
});

export function autonomyEffect(work: GardenerWork, autonomy: GardenerAutonomy): AutonomyEffect {
  return autonomyMatrix[work][autonomy];
}

/**
 * Whether autonomy holds every row of a kind now: under Off, the kinds whose work does nothing
 * there and the kinds whose own calls are generative (D12; a catalog header needs its graph call),
 * except a kind that runs provisionally (naming writes TF-IDF names; its model calls are refused at
 * admission). Mixed kinds are never held at claim: their background calls are.
 */
export function autonomyHoldsKind(type: string, autonomy: GardenerAutonomy): boolean {
  const policy = gardenerKindPolicy(type);
  if (!policy || policy.budget !== "background") return false;
  const effect = autonomyEffect(policy.work, autonomy);
  if (effect === "provisional") return false;
  if (autonomy === "off" && policy.ai === "generative") return true;
  return effect === "none" || effect === "waits";
}

/**
 * Whether a kind runs provisionally under Off: its generative calls are refused at admission and it
 * ends with its deterministic fallback, so a refusal under Off is its normal outcome, not a blocker
 * that sets the task aside (D12: names stay provisional).
 */
export function autonomyRunsProvisionally(type: string): boolean {
  const policy = gardenerKindPolicy(type);
  return (
    policy !== null &&
    policy.budget === "background" &&
    autonomyEffect(policy.work, "off") === "provisional"
  );
}

/**
 * Whether autonomy refuses one background model call: under Off, every generative call and every
 * remote call (D12: "no generative or remote background work"); local embeddings and local
 * deciding still run, so placement and suggestions continue.
 */
export function autonomyRefusesCall(
  autonomy: GardenerAutonomy,
  call: { generative: boolean; remote: boolean }
): boolean {
  return autonomy === "off" && (call.generative || call.remote);
}

/** Risk levels of a change-set (D11): `high` is always reviewed, whatever the autonomy. */
export type ChangeSetRiskLevel = "low" | "medium" | "high";

/**
 * Whether a change a task would make is applied (with undo) or becomes a pending review, by its
 * work, the autonomy and its risk (D11, D12). Works that do not run under the level are proposed,
 * never applied; local deciding and placement apply in every mode, and a provisional fallback
 * (naming's TF-IDF names under Off) is written as it is.
 */
export function changeDisposition(input: {
  work: GardenerWork;
  autonomy: GardenerAutonomy;
  risk: ChangeSetRiskLevel;
}): "applied" | "pending_review" {
  if (input.risk === "high") return "pending_review";
  const effect = autonomyEffect(input.work, input.autonomy);
  return effect === "applies" || effect === "runs" || effect === "provisional"
    ? "applied"
    : "pending_review";
}
