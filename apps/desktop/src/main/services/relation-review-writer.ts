import {
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
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
 * rejects it. A Keep may carry the owner's direction, written in the same statement as the
 * owner's (decision 31b). The verdict and its `kept` or `removed` event are one statement in a run
 * of their own (D14), and the verdict is final in both directions (I-R2, I-R3): a relation that already has a
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
      const relations = createAtomicNoteRelationRepository(client);
      // The row first: the statement below then reads its newest committed version, so the before
      // image of the event and the verdict answered when nothing is written are the stored ones
      // even when another writer touched the row at the same moment (D14, I-R8).
      if (!(await relations.lockForReview(input.relationId))) throw new NothingToReview(null);
      const runs = createRelationMatchRunRepository(client);
      const run = await runs.start({ kind: "review" });
      // Keep may carry the owner's direction (decision 31b); the note must be one of the pair's.
      const written = await relations.review(
        input.relationId,
        input.verdict,
        run.id,
        input.subjectNoteId === undefined ? undefined : { subjectAtomicNoteId: input.subjectNoteId }
      );
      if (!written) throw new NothingToReview(null);
      // The run and its event are kept only when the verdict was written.
      if (written.change !== "updated") {
        // A row that is locked and has no human verdict is always written: anything else would
        // answer a verdict that does not stand.
        if (written.relation.status === "pending_review")
          throw new Error("The relation changed while it was reviewed.");
        throw new NothingToReview({
          relationId: input.relationId,
          outcome: written.relation.status === "accepted" ? "kept" : "removed",
          changed: false
        });
      }
      const outcome = written.relation.status === "accepted" ? "kept" : "removed";
      await runs.finish(run.id, { outcome: "succeeded", counts: { [outcome]: 1 } });
      const noteIds = [written.relation.sourceAtomicNoteId, written.relation.targetAtomicNoteId];
      if (written.relation.relationType !== null) {
        const notes = createAtomicNoteRepository(client);
        const homes = new Set<string>();
        for (const noteId of noteIds) {
          const home = (await notes.findById(noteId))?.createdFromSourceItemId;
          if (home) homes.add(home);
        }
        const roots = new Set<string>();
        for (const homeId of homes) roots.add(await linkRootOf(client, homeId));
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
