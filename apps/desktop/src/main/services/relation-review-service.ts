import type { PgPool } from "@app/db";
import {
  RelationReviewInputSchema,
  RelationReviewResultSchema,
  type RelationReviewInput,
  type RelationReviewResult
} from "@app/domain";

import { reviewNoteRelation, type ReviewedRelation } from "./relation-review-writer.js";

export interface RelationReviewServiceOptions {
  getPool: () => PgPool | null;
  /** After a verdict was written: the notes whose relations changed, so open pages read them again. */
  relationsChanged?: (noteIds: string[]) => void;
  /** The writer of the verdict; tests inject theirs. */
  review?: (pool: PgPool, input: RelationReviewInput) => Promise<ReviewedRelation | null>;
}

/**
 * `relations.review` (F3 D15): the owner keeps or removes a suggested or withdrawn note relation
 * until the Inbox of F4 takes over. The verdict is the owner's only; nothing here calls AI. It is
 * final in both directions (I-R2, I-R3), written with its event, and promotes the source relations
 * of both roots again, so a second request for the same relation answers the verdict that stands
 * and writes nothing.
 */
export class RelationReviewService {
  constructor(private readonly options: RelationReviewServiceOptions) {}

  /** The verdict that stands for the relation; null when the relation is gone. */
  async review(input: unknown): Promise<RelationReviewResult | null> {
    const parsed = RelationReviewInputSchema.parse(input);
    const pool = this.options.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    const reviewed = await (this.options.review ?? reviewNoteRelation)(pool, parsed);
    if (!reviewed) return null;
    if (reviewed.result.changed && reviewed.noteIds.length > 0)
      this.options.relationsChanged?.(reviewed.noteIds);
    return RelationReviewResultSchema.parse(reviewed.result);
  }
}
