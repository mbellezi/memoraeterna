import { createDocumentRepository, createSourceEditingRepository, createSourceItemRepository, type PgClient, type PgPool } from "@app/db";
import { sha256 } from "@app/conversion";
import { normalizeProjectionText } from "@app/integration-contracts";
import type { SourceEditInput } from "../../shared/ipc.js";
/** The same no-inference editorial boundary serves the Library and integrations. */
export class SourceEditorialService {
    public constructor(private readonly pool: PgPool) { }
    public async save(input: SourceEditInput, transaction?: PgClient) {
        const source = await createSourceItemRepository(transaction ?? this.pool).findById(input.sourceItemId);
        if (!source || source.type !== input.descriptor.type || source.parentSourceItemId !== ('parentSourceItemId' in input.descriptor ? input.descriptor.parentSourceItemId ?? null : null))
            throw new Error('errors.common.validationFailed');
        const markdown = input.content ? normalizeProjectionText(input.content.markdown) : undefined;
        if (markdown !== undefined && !markdown.trim())
            throw new Error('errors.common.validationFailed');
        return createSourceEditingRepository(this.pool).save({ sourceItemId: source.id, expectedUpdatedAt: input.expectedUpdatedAt,
            title: input.descriptor.title, subtitle: input.descriptor.subtitle ?? null, language: input.descriptor.language,
            sourceUri: ['WebArticle', 'Video'].includes(source.type) && 'url' in input.descriptor ? input.descriptor.url ?? null : source.sourceUri, descriptor: input.descriptor,
            ...(input.content && markdown !== undefined ? { content: { documentId: input.content.documentId, markdown, hash: sha256(markdown) } } : {}) }, transaction);
    }
    public async saveProjected(sourceId: string, expectedUpdatedAt: string, markdown: string, transaction?: PgClient) {
        const db = transaction ?? this.pool, source = await createSourceItemRepository(db).findById(sourceId);
        if (!source)
            throw new Error('sourceWorkspace.conflict');
        const document = (await createDocumentRepository(db).listBySourceItem(sourceId))[0];
        const content = normalizeProjectionText(markdown);
        if (!content.trim())
            throw new Error('errors.common.validationFailed');
        return createSourceEditingRepository(this.pool).save({ sourceItemId: source.id, expectedUpdatedAt, title: source.title,
            subtitle: source.subtitle, language: source.language, sourceUri: source.sourceUri, descriptor: (source.metadata.descriptor ?? {}) as Record<string, unknown>,
            contentOnly: true, content: { documentId: document?.id ?? null, markdown: content, hash: sha256(content) } }, transaction);
    }
}
