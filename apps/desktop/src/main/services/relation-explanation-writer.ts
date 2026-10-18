import { createHash } from "node:crypto";

import {
  aiRouteKeys,
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createJobRepository,
  createRelationMatchRunRepository,
  immediateJobDebounce,
  withTransaction,
  type PgPool,
  type RelationExplanationWriter
} from "@app/db";

import { relationExplanationOperation } from "./ai-task-parameters.js";
import { capturePromptPin, promptFingerprint } from "./prompt-runtime.js";
import {
  linkRootOf,
  relationPromoteDedupeKey,
  relationPromoteJobType
} from "./relations/relation-link.js";

const explanationPrompts = ["relations.explain", "relations.explain.repair"] as const;

/** The instruction the AI service adds to every call of an OpenAI Codex model. */
const codexInstruction = "shared.codex_adapter_instruction";

/**
 * The identity of the prompt an explanation is written with: its effective text (as shipped or as
 * the owner edited it) and the revisions behind it, so a new shipped revision or an edit writes the
 * explanations of relations that are opened afterwards again (F3 D22). For a provider, the
 * fragments it adds are part of it (the Codex adapter instruction).
 */
export function relationExplanationPromptRevision(provider?: string): string {
  const pin = capturePromptPin();
  const ids = [...explanationPrompts, ...(provider === "openai-codex" ? [codexInstruction] : [])];
  return createHash("sha256")
    .update(
      JSON.stringify([
        promptFingerprint(ids, pin, provider ?? false),
        ids.map((id) => pin.entries.find((entry) => entry.id === id)?.revisions ?? null)
      ])
    )
    .digest("hex");
}

/**
 * Who writes an explanation now: the effective prompt and the model its writer route resolves to
 * (the operation's route, then `class:write-fast`, then the text-generation route). Null without a
 * writer model. The model identity is the model and, for a local one, its artifact; parameters are
 * not part of it.
 */
export function createRelationExplanationWriterResolver(
  getPool: () => PgPool | null
): () => Promise<RelationExplanationWriter | null> {
  return async () => {
    const pool = getPool();
    if (!pool) return null;
    const selection = await createAiConfigRepository(pool).getDefaultTask(
      "text-generation",
      undefined,
      aiRouteKeys("text-generation", {
        operation: relationExplanationOperation,
        workloadClass: "write-fast"
      })
    );
    if (!selection) return null;
    return {
      promptRevision: relationExplanationPromptRevision(selection.provider),
      model: JSON.stringify([
        selection.provider,
        selection.modelId,
        selection.runtime,
        selection.repository,
        selection.revision,
        selection.quantization
      ])
    };
  };
}

/** The relation could not be withdrawn: it is gone, reviewed by a human, or already withdrawn. */
class NothingToWithdraw extends Error {}

/**
 * Withdraws a relation the explanation found unrelated (F3 D22): `vetoed_at` and `veto_source =
 * explainer`, with a `vetoed` event in a run of its own (D14). A typed relation fed the source
 * relations promoted from it, so the roots of its two notes (`homeSourceIds`) are promoted again in
 * the same transaction (R14). A relation with a human verdict, or one that is already withdrawn, is
 * left as it is. Resolves to the two notes whose pages changed, or null when nothing was written.
 */
export async function withdrawRelationAsExplainer(
  pool: PgPool,
  relationId: string,
  homeSourceIds: readonly string[] = []
): Promise<{ noteIds: [string, string] } | null> {
  try {
    return await withTransaction(pool, async (client) => {
      const runs = createRelationMatchRunRepository(client);
      const run = await runs.start({ kind: "veto" });
      const written = await createAtomicNoteRelationRepository(client).veto(
        relationId,
        "explainer",
        run.id
      );
      // The run and its events are kept only when the veto was written.
      if (!written) throw new NothingToWithdraw();
      await runs.finish(run.id, { outcome: "succeeded", counts: { vetoed: 1 } });
      if (written.relation.relationType !== null) {
        const jobs = createJobRepository(client);
        const roots = new Set<string>();
        for (const sourceItemId of homeSourceIds) roots.add(await linkRootOf(client, sourceItemId));
        for (const rootId of [...roots].sort())
          await jobs.enqueueDeduped({
            type: relationPromoteJobType,
            lane: "light",
            dedupeKey: relationPromoteDedupeKey(rootId),
            payload: { rootId },
            debounce: immediateJobDebounce
          });
      }
      return {
        noteIds: [written.relation.sourceAtomicNoteId, written.relation.targetAtomicNoteId]
      };
    });
  } catch (error) {
    if (error instanceof NothingToWithdraw) return null;
    throw error;
  }
}
