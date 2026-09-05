import type { PgPool } from "../client.js";
import { createDocumentRepository } from "./documentRepository.js";
import { createSourceItemRepository, markAncestorSummariesStale } from "./sourceItemRepository.js";
import type { JsonObject } from "./types.js";

/** Save an editorial revision without replacing chunks or their reviewed evidence. */
export function createSourceEditingRepository(pool: PgPool) {
  return {
    async save(input: {
      sourceItemId: string; expectedUpdatedAt: string; title: string; subtitle: string | null;
      language: string; sourceUri: string | null; descriptor: JsonObject;
      content?: { documentId: string | null; markdown: string; hash: string };
    }) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const locked = await client.query<{ updatedAt: Date }>(
          'select updated_at as "updatedAt" from source_items where id = $1 for update', [input.sourceItemId]
        );
        if (locked.rows[0]?.updatedAt.toISOString() !== input.expectedUpdatedAt) throw new Error("sourceWorkspace.conflict");
        const active = await client.query(
          "select id from ingestion_runs where source_item_id = $1 and status::text in ('pending', 'running') limit 1", [input.sourceItemId]
        );
        if (active.rows.length) throw new Error("sourceWorkspace.processing");
        const sources = createSourceItemRepository(client);
        const documents = createDocumentRepository(client);
        const source = await sources.findById(input.sourceItemId);
        if (!source) throw new Error("errors.common.validationFailed");
        let documentId: string | null = null;
        let contentChanged = false;
        if (input.content) {
          if (!input.content.documentId && (await documents.listBySourceItem(source.id)).length) throw new Error("sourceWorkspace.conflict");
          const previous = input.content.documentId ? await documents.findById(input.content.documentId) : null;
          if (input.content.documentId && (!previous || previous.sourceItemId !== source.id || previous.metadata.supersededByDocumentId)) {
            throw new Error("sourceWorkspace.conflict");
          }
          contentChanged = !previous || previous.contentHash !== input.content.hash;
          documentId = previous?.id ?? null;
          if (contentChanged) {
            const next = await documents.create({ sourceItemId: source.id, title: input.title,
              language: input.language, canonicalMarkdown: input.content.markdown, contentHash: input.content.hash,
              metadata: { ...previous?.metadata, editorialRevision: true, supersedesDocumentId: previous?.id ?? null } });
            documentId = next.id;
            if (previous) {
              await documents.update(previous.id, { metadata: { ...previous.metadata, supersededByDocumentId: next.id } });
              await client.query("update document_revisions set is_current = false where document_id = $1", [previous.id]);
            }
            await client.query(
              "insert into document_revisions (document_id, revision, is_current, content_hash, reason, metadata) values ($1, 1, true, $2, 'editorial', $3)",
              [next.id, next.contentHash, { supersedesDocumentId: previous?.id ?? null }]
            );
            await client.query("update source_summaries set is_current = false where source_item_id = $1", [source.id]);
          }
        }
        await sources.update(source.id, { title: input.title, subtitle: input.subtitle, language: input.language,
          sourceUri: input.sourceUri, ...(contentChanged ? { contentHash: input.content!.hash } : {}),
          metadata: { ...source.metadata, descriptor: input.descriptor,
            ...(contentChanged ? { contentChangedAt: new Date().toISOString(), summaryStale: true } : {}) } });
        for (const document of await documents.listBySourceItem(source.id)) {
          if (document.title !== input.title || document.language !== input.language) {
            await documents.update(document.id, { title: input.title, language: input.language });
          }
        }
        // Child links refer to the parent's work: never rename that work when editing a child.
        const descriptor = input.descriptor;
        if (!source.parentSourceItemId) {
          await client.query(
            `update bibliographic_works work set title = $2, subtitle = $3, language = $4,
               creators = $5::jsonb, updated_at = now()
             from source_item_bibliographic_links link where link.source_item_id = $1 and work.id = link.work_id`,
            [source.id, input.descriptor.publicationTitle ?? input.title, input.subtitle, input.language, JSON.stringify(input.descriptor.creators ?? [])]
          );
          const identifiers = Object.fromEntries(["isbn10", "isbn13", "doi", "issn"].flatMap((key) =>
            typeof descriptor[key] === "string" ? [[key, descriptor[key]]] : []));
          await client.query(`update bibliographic_works work set identifiers = $2::jsonb
            from source_item_bibliographic_links link where link.source_item_id = $1 and work.id = link.work_id`, [source.id, identifiers]);
          await client.query(`update bibliographic_instances instance set edition = $2, volume = $3, issue = $4,
            publication_date = $5, publisher = $6, isbn = $7, issn = $8, doi = $9,
            creators = $10::jsonb, page_count = $11, series = $12, updated_at = now()
            from source_item_bibliographic_links link where link.source_item_id = $1 and instance.id = link.instance_id`,
          [source.id, descriptor.edition ?? null, descriptor.volume ?? null, descriptor.issue ?? null,
            descriptor.publicationDate ?? null, descriptor.publisher ?? null, descriptor.isbn13 ?? descriptor.isbn10 ?? null,
            descriptor.issn ?? null, descriptor.doi ?? null, JSON.stringify(descriptor.creators ?? []), descriptor.pageCount ?? null, descriptor.series ?? null]);
        }
        const pages = descriptor.pages as { start?: string; end?: string } | undefined;
        await client.query("update source_item_bibliographic_links set pages = $2 where source_item_id = $1",
          [source.id, pages?.start ? `${pages.start}${pages.end ? `-${pages.end}` : ""}` : null]);
        const cover = descriptor.cover as { assetId?: string } | undefined;
        if (cover?.assetId) {
          const asset = await client.query(`update document_assets set source_item_id = $1, role = 'cover'
            where id = $2 and (source_item_id is null or source_item_id = $1) returning id`, [source.id, cover.assetId]);
          if (!asset.rows.length) throw new Error("errors.common.validationFailed");
        }
        if (contentChanged && source.parentSourceItemId) {
          await markAncestorSummariesStale(client, source.parentSourceItemId);
        }
        await client.query("commit");
        return { sourceItemId: source.id, documentId, contentChanged };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally { client.release(); }
    }
  };
}
