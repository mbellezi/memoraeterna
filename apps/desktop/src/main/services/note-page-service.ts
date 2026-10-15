import { createNotePageRepository, type PgPool } from "@app/db";
import {
  NotePageInputSchema,
  NotePageRelationsSchema,
  NotePageSchema,
  NoteRelationsInputSchema,
  type NotePage,
  type NotePageRelations
} from "@app/domain";

/**
 * Note pages (docs/plan.md F1b): everything a page shows in one read-only read, and further pages
 * of a note's relations. Nothing here calls AI or writes. The content language decides which written
 * explanations are current: one written in another language reads as none, so opening the relation
 * writes it again.
 */
export class NotePageService {
  constructor(
    private readonly getPool: () => PgPool | null,
    private readonly getContentLanguage: () => Promise<string>
  ) {}

  /** The note, its evidence, where it is and its first relations; null when it does not exist. */
  async page(input: unknown): Promise<NotePage | null> {
    const { noteId, relationLimit } = NotePageInputSchema.parse(input);
    const page = await this.repository().readPage(noteId, {
      relationLimit,
      contentLanguage: await this.getContentLanguage()
    });
    return NotePageSchema.nullable().parse(page);
  }

  /** A further page of the note's relations, with the exact total. */
  async relations(input: unknown): Promise<NotePageRelations> {
    const { noteId, offset, limit } = NoteRelationsInputSchema.parse(input);
    return NotePageRelationsSchema.parse(
      await this.repository().listRelations(noteId, {
        offset,
        limit,
        contentLanguage: await this.getContentLanguage()
      })
    );
  }

  private repository() {
    const pool = this.getPool();
    if (!pool) throw new Error("objects.errors.unavailable");
    return createNotePageRepository(pool);
  }
}
