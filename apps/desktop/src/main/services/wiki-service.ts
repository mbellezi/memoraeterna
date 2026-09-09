import { createWikiRepository, type PgPool } from "@app/db";
import { WikiPageSchema, WikiPageListSchema, WikiHistorySchema, WikiResultsSchema, WikiQuerySchema, WikiSaveInputSchema, type WikiQuery, type WikiSaveInput } from "@app/domain";

/** Manual editorial operations deliberately have no model, matching or job dependency. */
export class WikiService {
  constructor(private readonly getPool: () => PgPool | null) { }
  private repository() {
    const pool = this.getPool();
    if (!pool) throw new Error("wiki.errors.unavailable");
    return createWikiRepository(pool);
  }
  async list() { return WikiPageListSchema.parse(await this.repository().list()); }
  async get(id: string, revisionId?: string) { return WikiPageSchema.nullable().parse(await this.repository().get(id, revisionId)); }
  async history(id: string) { return WikiHistorySchema.parse(await this.repository().history(id)); }
  async search(input: WikiQuery) { return WikiResultsSchema.parse(await this.repository().search(WikiQuerySchema.parse(input))); }
  async save(input: WikiSaveInput) {
    const id = await this.repository().save(WikiSaveInputSchema.parse(input));
    return WikiPageSchema.parse(await this.repository().get(id));
  }
}
