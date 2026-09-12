import { createAiConfigRepository, type PgPool } from '@app/db';
/** Read-only routing metadata for artifact reuse; this never loads a model or changes a route. */
export async function promptStageProviders(pool: PgPool): Promise<Record<string, string>> {
    const repo = createAiConfigRepository(pool), tasks = ['summarization', 'atomic-note-generation', 'knowledge-graph-generation', 'reranking', 'embedding'];
    const rows = await Promise.all(tasks.map(async (task) => [task, (await repo.getDefaultTask(task))?.provider ?? 'unavailable'] as const));
    return Object.fromEntries(rows);
}
