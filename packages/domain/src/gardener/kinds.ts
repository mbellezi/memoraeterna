import type { AiClassId } from "../ai-presets.js";

/**
 * The Gardener's kind table (F4 D6, D8, spec 3.1): one row per job type string the code queues.
 * A row names the task, the worker, the scope key (claim-time exclusion: two running jobs of one
 * scope never exist), the subject key (the outcome cache's key with the kind) and what the
 * content-only fingerprint covers. Scope keys go on claimable kinds only: the inline stages of an
 * ingestion run beside their scoped parent with a null scope. A static test fails on a job type
 * string with no row.
 */

/** Job types F4 adds; their executors arrive with later tasks (MATCH, REFRESH, retention). */
export const relationMatchJobType = "relation-match";
export const topicOverviewJobType = "topic-overview";
export const relationExplainBackfillJobType = "relation-explain-backfill";
export const gardenerRetentionJobType = "gardener-retention";

export type GardenerTask =
  | "place"
  | "rebalance"
  | "audit"
  | "match"
  | "refresh"
  | "derived"
  | "ingestion"
  | "ingestion_stage"
  | "other";

/** Where a kind runs: a light worker, the heavy lane, inside an ingestion job, or its own driver. */
export type GardenerWorker = "compute" | "model" | "relations" | "heavy" | "inline" | "self";

/** Who pays for its AI calls (D14, D15): background work, an import the user started, or none. */
export type GardenerBudgetClass = "background" | "user" | "none";

type Payload = Readonly<Record<string, unknown>>;

/** The keys a job carries; `rootOf` asks the repository for the hierarchy root of that source. */
export interface GardenerJobKeys {
  scopeKey: string | null;
  subjectKey: string | null;
  /** The source whose hierarchy root names the scope and subject (`root:<rootId>`). */
  rootOf: string | null;
}

export interface GardenerTaskKind {
  type: string;
  task: GardenerTask;
  worker: GardenerWorker;
  /**
   * A Gardener task: its result status maps to an outcome, a blocker or a failed attempt (3.1b),
   * its subject has an outcome cache and it can be quarantined (D8) and retried by hand.
   */
  gardener: boolean;
  generative: boolean;
  remote: boolean;
  budgetClass: GardenerBudgetClass;
  /** The AI class a missing route names (`no_model.no_route` {routeClass}). */
  routeClass: AiClassId | null;
  /** What the content-only input fingerprint covers (D9); never a model, prompt or setting. */
  fingerprint: string;
  keys: (payload: Payload) => GardenerJobKeys;
}

const segmentPattern = /^[0-9A-Za-z][0-9A-Za-z._-]{0,79}$/u;

/** A key segment from a payload field: a short id-like string, else null (no key at all). */
function segment(payload: Payload, field: string): string | null {
  const value = payload[field];
  return typeof value === "string" && segmentPattern.test(value) ? value : null;
}

const none: GardenerJobKeys = Object.freeze({ scopeKey: null, subjectKey: null, rootOf: null });

const keys = (scopeKey: string | null, subjectKey: string | null): GardenerJobKeys => ({
  scopeKey,
  subjectKey,
  rootOf: null
});

/** A topic job on a tree: `tree:<id>:<part>` scope, its subject by the job's own work. */
function treeKeys(part: "structure" | "gate" | "names", subject: "tree" | "item") {
  return (payload: Payload): GardenerJobKeys => {
    const treeId = segment(payload, "treeId");
    if (!treeId) return none;
    const root = segment(payload, "rootSourceId");
    const note = segment(payload, "noteId");
    const itemSubject = root ? `root:${root}` : note ? `note:${note}` : null;
    return keys(`tree:${treeId}:${part}`, subject === "item" ? itemSubject : `tree:${treeId}`);
  };
}

/** A relation job of one root: `root:<rootId>` scope and subject. */
function rootKeys(payload: Payload): GardenerJobKeys {
  const rootId = segment(payload, "rootId");
  return rootId ? keys(`root:${rootId}`, `root:${rootId}`) : none;
}

/** A global singleton (payload `{}`, one dedupe key): the kind is its own scope and subject. */
const singleton = (type: string) => (): GardenerJobKeys => keys(type, type);

const kind = (
  type: string,
  row: Omit<GardenerTaskKind, "type" | "keys"> & { keys?: GardenerTaskKind["keys"] }
): GardenerTaskKind => ({ type, ...row, keys: row.keys ?? (() => none) });

const topicStructure = {
  task: "rebalance",
  worker: "compute",
  gardener: true,
  generative: false,
  remote: false,
  budgetClass: "none",
  routeClass: null,
  fingerprint: "dirty set and tree generation",
  keys: treeKeys("structure", "tree")
} as const;

const topicNames = {
  task: "rebalance",
  worker: "model",
  gardener: true,
  generative: true,
  remote: true,
  budgetClass: "background",
  routeClass: "write-fast",
  fingerprint: "member fingerprint",
  keys: treeKeys("names", "tree")
} as const;

const inlineStage = {
  task: "ingestion_stage",
  worker: "inline",
  gardener: false,
  generative: false,
  remote: false,
  budgetClass: "user",
  routeClass: null,
  fingerprint: "stage checkpoints"
} as const;

const plain = {
  task: "other",
  gardener: false,
  generative: false,
  remote: false,
  budgetClass: "none",
  routeClass: null,
  fingerprint: "none (no outcome cache)"
} as const;

const rows: readonly GardenerTaskKind[] = [
  kind("topic-place", {
    ...topicStructure,
    task: "place",
    fingerprint: "item fingerprints (note content hash, composite)",
    keys: treeKeys("structure", "item")
  }),
  kind("topic-sweep", {
    ...topicStructure,
    task: "place",
    fingerprint: "item fingerprints (note content hash, composite)"
  }),
  kind("topic-gate", {
    ...topicStructure,
    task: "place",
    worker: "model",
    generative: false,
    budgetClass: "background",
    routeClass: "decide",
    fingerprint: "item fingerprint and candidate topic set",
    keys: treeKeys("gate", "item")
  }),
  kind("topic-rebalance", topicStructure),
  kind("topic-build", topicStructure),
  kind("topic-audit", { ...topicStructure, task: "audit" }),
  kind("topic-name", topicNames),
  kind("topic-areas", topicNames),
  kind("topic-label-embed", {
    ...topicNames,
    generative: false,
    routeClass: "embed",
    fingerprint: "label texts"
  }),
  kind(relationMatchJobType, {
    task: "match",
    worker: "relations",
    gardener: true,
    generative: true,
    remote: true,
    budgetClass: "background",
    routeClass: "decide",
    fingerprint: "note_match_state.input_hash and space key",
    keys: (payload) => {
      const rootId = segment(payload, "rootId");
      const noteId = segment(payload, "noteId");
      return rootId && noteId ? keys(`root:${rootId}`, `note:${noteId}`) : none;
    }
  }),
  kind("relation-link", {
    task: "match",
    worker: "relations",
    gardener: true,
    generative: true,
    remote: true,
    // An import's own link job is the user's; the backfill and re-match ones are background.
    budgetClass: "background",
    routeClass: "write-fast",
    fingerprint: "existing state keys",
    keys: rootKeys
  }),
  kind("relation-promote", {
    task: "match",
    worker: "relations",
    gardener: true,
    generative: false,
    remote: false,
    budgetClass: "none",
    routeClass: null,
    fingerprint: "existing state keys",
    keys: rootKeys
  }),
  kind("relation-retype", {
    task: "match",
    worker: "relations",
    gardener: true,
    generative: true,
    remote: true,
    budgetClass: "background",
    routeClass: "write-fast",
    fingerprint: "untyped set",
    keys: () => keys(null, "relation-retype")
  }),
  kind("relation-composite", {
    task: "derived",
    worker: "relations",
    gardener: true,
    generative: false,
    remote: false,
    budgetClass: "background",
    routeClass: "embed",
    fingerprint: "space key",
    keys: singleton("relation-composite")
  }),
  kind("catalog-header", {
    task: "derived",
    worker: "relations",
    gardener: true,
    generative: true,
    remote: true,
    budgetClass: "background",
    routeClass: "write-fast",
    fingerprint: "stale header set",
    keys: singleton("catalog-header")
  }),
  kind(topicOverviewJobType, {
    task: "refresh",
    worker: "model",
    gardener: true,
    generative: true,
    remote: true,
    budgetClass: "background",
    routeClass: "write-fast",
    fingerprint: "member fingerprint and cited evidence hashes",
    keys: (payload) => {
      const topicId = segment(payload, "topicId");
      return topicId ? keys(`topic:${topicId}`, `topic:${topicId}`) : none;
    }
  }),
  kind(relationExplainBackfillJobType, {
    task: "refresh",
    worker: "relations",
    gardener: true,
    generative: true,
    remote: true,
    budgetClass: "background",
    routeClass: "write-fast",
    fingerprint: "relation input hash",
    keys: (payload) => {
      const relationId = segment(payload, "relationId");
      return relationId ? keys(null, `relation:${relationId}`) : none;
    }
  }),
  kind(gardenerRetentionJobType, {
    task: "audit",
    worker: "compute",
    gardener: true,
    generative: false,
    remote: false,
    budgetClass: "none",
    routeClass: null,
    fingerprint: "local day",
    keys: () => keys("retention", gardenerRetentionJobType)
  }),
  kind("ingestion", {
    task: "ingestion",
    worker: "heavy",
    // User-started work, never a Gardener task: no outcome cache, no quarantine.
    gardener: false,
    generative: true,
    remote: true,
    budgetClass: "user",
    routeClass: null,
    fingerprint: "document hash",
    keys: (payload) => {
      const sourceItemId = segment(payload, "sourceItemId");
      return sourceItemId ? { scopeKey: null, subjectKey: null, rootOf: sourceItemId } : none;
    }
  }),
  ...(
    [
      "markdown-conversion",
      "chunking",
      "embedding",
      "summarization",
      "atomic-note-generation",
      "atomic-note-matching",
      "knowledge-graph-generation",
      "obsidian-sync",
      "asset-storage"
    ] as const
  ).map((type) => kind(type, inlineStage)),
  kind("note-embedding", { ...plain, worker: "heavy" }),
  kind("relation-labels", { ...plain, worker: "heavy", budgetClass: "user" }),
  kind("obsidian-wiki", { ...plain, worker: "compute" }),
  kind("local-model-download", { ...plain, worker: "self" }),
  kind("relation-rematch", { ...plain, worker: "heavy" })
];

/** Every kind by its job type. */
export const gardenerTaskKinds: Readonly<Record<string, GardenerTaskKind>> = Object.freeze(
  Object.fromEntries(rows.map((row) => [row.type, row]))
);

/** The types of the inline ingestion stages: rows of a running ingestion job, never scoped. */
export const inlineIngestionStageTypes: readonly string[] = rows
  .filter((row) => row.worker === "inline")
  .map((row) => row.type);

export function gardenerTaskKind(type: string): GardenerTaskKind | null {
  return gardenerTaskKinds[type] ?? null;
}

/** The scope and subject keys of a job of `type` with `payload` (none for an unknown type). */
export function gardenerJobKeys(type: string, payload: Payload): GardenerJobKeys {
  return gardenerTaskKind(type)?.keys(payload) ?? none;
}

/** The scope key of a root: the hierarchy root a source belongs to. */
export function rootScopeKey(rootId: string): string {
  return `root:${rootId}`;
}

/**
 * The payload a job of `type` is stored with: a root-scoped relation job names its root as
 * `sourceItemId` too, so cancelling or deleting the source reaches it (D6).
 */
export function gardenerJobPayload<T extends Payload>(type: string, payload: T): T {
  const row = gardenerTaskKind(type);
  if (!row || row.worker !== "relations" || typeof payload.sourceItemId === "string")
    return payload;
  const rootId = segment(payload, "rootId");
  return rootId ? { ...payload, sourceItemId: rootId } : payload;
}
