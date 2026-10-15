import {
  WikiPageListSchema,
  WikiQuerySchema,
  WikiResultsSchema,
  type WikiQuery
} from "@app/domain";
import { createWikiRepository, type PgPool } from "@app/db";

/**
 * The wiki reads that the Ask and Obsidian scope pickers still use: the page list and the source
 * search. The topic navigator and the topic projection (T20, T33) replace both.
 */
export class WikiService {
  constructor(private readonly getPool: () => PgPool | null) {}
  private repository() {
    const pool = this.getPool();
    if (!pool) throw new Error("wiki.errors.unavailable");
    return createWikiRepository(pool);
  }
  async list() {
    return WikiPageListSchema.parse(await this.repository().list());
  }
  async search(input: WikiQuery) {
    return WikiResultsSchema.parse(await this.repository().search(WikiQuerySchema.parse(input)));
  }
}
