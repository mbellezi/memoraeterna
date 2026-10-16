import { WikiQuerySchema, WikiResultsSchema, type WikiQuery } from "@app/domain";
import { createSourceScopeRepository, type PgPool } from "@app/db";

/** The source search the scope pickers (Ask and Obsidian) use. The topic navigator replaces nothing here. */
export class WikiService {
  constructor(private readonly getPool: () => PgPool | null) {}
  async search(input: WikiQuery) {
    const pool = this.getPool();
    if (!pool) throw new Error("wiki.errors.unavailable");
    return WikiResultsSchema.parse(
      await createSourceScopeRepository(pool).search(WikiQuerySchema.parse(input))
    );
  }
}
