import {
  createAtomicNoteRelationRepository,
  createJobRepository,
  createRelationMatchRunRepository,
  immediateJobDebounce,
  withTransaction,
  type PgPool
} from "@app/db";
import type { RelationReviewInput, RelationReviewResult } from "@app/domain";

import {
  linkRootOf,
  relationPromoteDedupeKey,
  relationPromoteJobType
} from "./relations/relation-link.js";

/** The review changed nothing: roll the run back and answer the verdict that stands. */
class NothingToReview extends Error {
  constructor(readonly result: RelationReviewResult | null) {
    super("The relation has nothing to review.");
  }
}

/** What a review answered, and the two notes whose pages changed (none when nothing was written). */
export interface ReviewedRelation {
  result: RelationReviewResult;
  noteIds: string[];
}

/**
 * The owner's verdict on a note relation (F3 D15): Keep accepts it and clears any veto, Remove
 * rejects it. The verdict and its `kept` or `removed` event are one statement in a run of their own
 * (D14), and the verdict is final in both directions (I-R2, I-R3): a relation that already has a
 * human verdict is left as it is and the answer says which one stands, with `changed` false. A
 * typed relation fed the source relations promoted from it, so the roots of its two notes are
 * promoted again in the same transaction (R14); an untyped one never was promoted. Resolves to null
 * when the relation is gone.
 */
export async function reviewNoteRelation(
  pool: PgPool,
  input: RelationReviewInput
): Promise<ReviewedRelation | null> {
  try {
    return await withTransaction(pool, async (client) => {
      const runs = createRelationMatchRunRepository(client);
      const run = await runs.start({ kind: "review" });
      const written = await createAtomicNoteRelationRepository(client).review(
        input.relationId,
        input.verdict,
        run.id
      );
      if (!written) throw new NothingToReview(null);
      const outcome = written.relation.status === "accepted" ? "kept" : "removed";
      // The run and its event are kept only when the verdict was written.
      if (written.change !== "updated")
        throw new NothingToReview({ relationId: input.relationId, outcome, changed: false });
      await runs.finish(run.id, { outcome: "succeeded", counts: { [outcome]: 1 } });
      const noteIds = [written.relation.sourceAtomicNoteId, written.relation.targetAtomicNoteId];
      if (written.relation.relationType !== null) {
        const homes = await client.query<{ id: string }>(
          `select distinct created_from_source_item_id as id from atomic_notes
            where id = any($1::uuid[]) and created_from_source_item_id is not null`,
          [noteIds]
        );
        const roots = new Set<string>();
        for (const home of homes.rows) roots.add(await linkRootOf(client, home.id));
        const jobs = createJobRepository(client);
        for (const rootId of [...roots].sort())
          await jobs.enqueueDeduped({
            type: relationPromoteJobType,
            lane: "light",
            dedupeKey: relationPromoteDedupeKey(rootId),
            payload: { rootId },
            debounce: immediateJobDebounce
          });
      }
      return { result: { relationId: input.relationId, outcome, changed: true }, noteIds };
    });
  } catch (error) {
    if (error instanceof NothingToReview)
      return error.result ? { result: error.result, noteIds: [] } : null;
    throw error;
  }
}
