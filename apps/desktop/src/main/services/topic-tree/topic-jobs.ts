// The light-lane job types of the Topic Tree Engine (spec 3.5, D33), their persisted payloads and
// their dedupe keys, and the executor registry the job supervisor runs them from. Each type
// declares whether it calls a model: `compute` runs the ones that do not (PLACE never waits for AI,
// D10), `model` the ones that do. Later tasks add their executors to the registry in `index.ts`.
import type { JobRecord, JsonObject } from "@app/db";
import { z } from "zod";

import type { LightJobExecutor, LightJobRegistry } from "../job-lanes.js";

export const topicJobTypes = {
  place: "topic-place",
  sweep: "topic-sweep",
  gate: "topic-gate",
  rebalance: "topic-rebalance",
  build: "topic-build",
  audit: "topic-audit",
  name: "topic-name",
  areas: "topic-areas",
  labelEmbed: "topic-label-embed"
} as const;

export type TopicJobType = (typeof topicJobTypes)[keyof typeof topicJobTypes];

/** Topic jobs that call a model (the light lane's `model` worker, D33). */
export const topicModelJobTypes: ReadonlySet<string> = new Set([
  topicJobTypes.gate,
  topicJobTypes.name,
  topicJobTypes.areas,
  topicJobTypes.labelEmbed
]);

const uuid = z.string().uuid();

/**
 * The work of one place or gate job: every item of one root source, or one note that has no root
 * source (a knowledge-owned note).
 */
export type TopicScope = { rootSourceId: string } | { noteId: string };

/** `sourceItemId` repeats the root so that cancelling a source's jobs also cancels its topic jobs. */
export const TopicScopedPayloadSchema = z
  .object({
    treeId: uuid,
    rootSourceId: uuid.optional(),
    sourceItemId: uuid.optional(),
    noteId: uuid.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    const root = payload.rootSourceId !== undefined;
    const note = payload.noteId !== undefined;
    if (root === note) {
      context.addIssue({ code: "custom", message: "A topic job names a root source or a note" });
    }
    if (root && payload.sourceItemId !== payload.rootSourceId) {
      context.addIssue({ code: "custom", message: "sourceItemId repeats the root source" });
    }
  });
export type TopicScopedPayload = z.output<typeof TopicScopedPayloadSchema>;

export const topicSweepReasons = ["startup", "requested", "continue", "dirty_stats"] as const;
export type TopicSweepReason = (typeof topicSweepReasons)[number];

/** A sweep before any tree exists names none: it creates the tree first (D39). */
export const TopicSweepPayloadSchema = z
  .object({ treeId: uuid.nullable(), reason: z.enum(topicSweepReasons) })
  .strict();
export type TopicSweepPayload = z.output<typeof TopicSweepPayloadSchema>;

/** A tree-wide job (build, rebalance, audit, naming, Areas, labels). */
export const TopicTreePayloadSchema = z.object({ treeId: uuid }).strict();

export function scopePayload(treeId: string, scope: TopicScope): TopicScopedPayload {
  return "rootSourceId" in scope
    ? { treeId, rootSourceId: scope.rootSourceId, sourceItemId: scope.rootSourceId }
    : { treeId, noteId: scope.noteId };
}

export function scopeOfPayload(payload: TopicScopedPayload): TopicScope {
  return payload.rootSourceId !== undefined
    ? { rootSourceId: payload.rootSourceId }
    : { noteId: payload.noteId as string };
}

/** `<root>` or `note:<id>`: the scope part of a dedupe key. */
export function scopeKey(scope: TopicScope): string {
  return "rootSourceId" in scope ? scope.rootSourceId : `note:${scope.noteId}`;
}

/**
 * Dedupe keys (spec 3.5): `topic-place:<tree>:<root>` or `topic-place:<tree>:note:<id>`, the same
 * for the gate, `topic-label:<tree>` for label vectors and `<type>:<tree>` for the other tree-wide
 * jobs. A sweep before any tree exists is `topic-sweep:none`.
 */
export function topicDedupeKey(
  type: TopicJobType,
  treeId: string | null,
  scope?: TopicScope
): string {
  if (type === topicJobTypes.place || type === topicJobTypes.gate) {
    if (!treeId || !scope) throw new Error(`topic_job_scope_required:${type}`);
    return `${type}:${treeId}:${scopeKey(scope)}`;
  }
  if (type === topicJobTypes.sweep) return `${type}:${treeId ?? "none"}`;
  if (!treeId) throw new Error(`topic_job_tree_required:${type}`);
  if (type === topicJobTypes.labelEmbed) return `topic-label:${treeId}`;
  return `${type}:${treeId}`;
}

/** A topic job executor; `needsModel` picks the light worker (D33). */
export interface TopicJobExecutor {
  needsModel: boolean;
  execute: (job: JobRecord, signal: AbortSignal) => Promise<JsonObject>;
}

/**
 * The light registry of the topic jobs: each executor keeps its `needsModel`, and every type is
 * held while the topic barrier is on (D23): held jobs stay queued and nothing is dropped.
 */
export function createTopicJobRegistry(
  executors: Readonly<Record<string, TopicJobExecutor>>,
  held: () => boolean
): LightJobRegistry {
  const registry: Record<string, LightJobExecutor> = {};
  for (const [type, executor] of Object.entries(executors)) {
    if (topicModelJobTypes.has(type) !== executor.needsModel) {
      throw new Error(`topic_job_worker_mismatch:${type}`);
    }
    registry[type] = { needsModel: executor.needsModel, held, execute: executor.execute };
  }
  return registry;
}
