import { createSimilarityDebugRepository, type PgPool } from "@app/db";

export class SimilarityDebugService {
  public constructor(private readonly getPool: () => PgPool | null) {}

  public async list(limit = 30) {
    return (await createSimilarityDebugRepository(this.requirePool()).list(limit)).map((run) => ({
      ...run,
      createdAt: run.createdAt.toISOString(),
      results: run.results.map((result) => ({
        ...result,
        createdAt: result.createdAt.toISOString()
      }))
    }));
  }

  public async clear(): Promise<{ deletedCount: number }> {
    return { deletedCount: await createSimilarityDebugRepository(this.requirePool()).clear() };
  }

  private requirePool(): PgPool {
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}
