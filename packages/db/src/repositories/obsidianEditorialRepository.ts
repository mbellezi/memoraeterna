import type { Queryable } from './types.js';
import type { PgPool, PgClient } from '../client.js';
import { createObsidianSyncRepository } from './obsidianSyncRepository.js';
// Shared by the review list and manifest so the plugin retires exactly the
// attempts hidden by the database, never a later attempt or another family.
const supersededConflict = `r.binding_hash=o.binding_hash and r.client_id=o.client_id
    and r.target_id=o.target_id and r.created_at>=o.created_at
    and r.receipt->>'status' in ('synced','ignored')
    and (r.request->'resolution'->>'operationId'=o.id::text
      or r.request->'resolution'->>'operationId'=o.request->'resolution'->>'operationId')`;
export function createObsidianEditorialRepository(pool: PgPool) {
    return {
        async documentRevision(client:Queryable,id:string){return (await client.query('select id from document_revisions where document_id=$1 and is_current=true order by revision desc limit 1',[id])).rows[0]?.id as string|undefined;},
    async invalidate(client:PgClient){await client.query("update obsidian_projection_clock set generation=generation+1 where id=1");},
    async bindClient(id: string, value: unknown) { await pool.query("insert into settings(key,value) values($1,$2) on conflict(key) do nothing", ['obsidian.editorial.client.' + id, value]); return (await pool.query('select value from settings where key=$1', ['obsidian.editorial.client.' + id])).rows[0].value; },
        async transaction<T>(targetId: string, operationId: string, apply: (client: PgClient) => Promise<T>): Promise<T> {
            const client = await pool.connect();
            try {
                await client.query('begin');
                await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['obsidian-operation:' + operationId]);
                await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ['obsidian-editorial:' + targetId]);
                const result = await apply(client);
                await client.query('commit');
                return result;
            }
            catch (error) {
                await client.query('rollback');
                throw error;
            }
            finally {
                client.release();
            }
        },
        async lockClient(client: PgClient, id: string) { const row = (await client.query("select status,scopes from integration_clients where id=$1 for share", [id])).rows[0]; if (!row || row.status !== 'paired' || !row.scopes.includes('obsidian-editorial-v1'))
            throw new Error('obsidianWiki.errors.binding'); },
        async relationAllowed(id: string, sourceIds: string[]) { return (await pool.query('select id from source_relations where id=$1 and source_item_id=any($2::uuid[]) and target_source_item_id=any($2::uuid[])', [id, sourceIds])).rowCount === 1; },
        async receipt(client: PgClient, id: string) { return (await client.query('select * from obsidian_editorial_operations where id=$1', [id])).rows[0]; },
        async record(client: PgClient, input: {
            id: string;
            clientId: string;
            vaultId: string;
            binding: string;
            targetId: string;
            requestHash: string;
            request: unknown;
            receipt: unknown;
        }) {
            await client.query('insert into obsidian_editorial_operations(id,client_id,vault_id,binding_hash,target_id,request_hash,request,receipt) values($1,$2,$3,$4,$5,$6,$7,$8)', [input.id, input.clientId, input.vaultId, input.binding, input.targetId, input.requestHash, input.request, input.receipt]);
        },
        async lockFile(client: PgClient, targetId: string) {
            await client.query('select id from obsidian_sync_files where memora_id=$1 for update', [targetId]);
            return createObsidianSyncRepository(client).findByMemoraId(targetId);
        },
        async lockCanonical(client: PgClient, type: string, id: string) {
            if (type === 'wiki_page')
                await client.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
            const table = type === 'wiki_page' ? 'wiki_pages' : type === 'atomic_note' ? 'atomic_notes' : 'source_items';
            await client.query(`select id from ${table} where id=$1 for update`, [id]);
        },
        async page(client: PgClient, id: string) { return (await client.query('select p.current_revision_id as revision,r.content from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where p.id=$1', [id])).rows[0]; },
        async conflicts(binding: string) { return (await pool.query(`select o.id,o.client_id,o.request,o.receipt from obsidian_editorial_operations o where o.binding_hash=$1 and o.receipt->>'status' in('conflict','deleted') and not exists(select 1 from obsidian_editorial_operations r where ${supersededConflict}) order by o.created_at desc limit 100`, [binding])).rows; },
        async resolutions(clientId: string, binding: string, offset = 0, pendingOperationIds?: string[]) { return (await pool.query(`select r.request,r.receipt,
            array(select o.id::text from obsidian_editorial_operations o
              where o.receipt->>'status' in('conflict','deleted') and ${supersededConflict}
                and ($4::uuid[] is null or o.id=any($4::uuid[]))
              order by o.created_at desc,o.id limit 1000) as superseded_operation_ids
            from obsidian_editorial_operations r where r.client_id=$1 and r.binding_hash=$2 and r.request->'resolution' is not null and r.receipt->>'status' in('synced','ignored')
              and ($4::uuid[] is null or exists(select 1 from obsidian_editorial_operations o where o.id=any($4::uuid[]) and o.receipt->>'status' in('conflict','deleted') and ${supersededConflict}))
            order by r.created_at desc,r.id offset $3 limit 25`, [clientId, binding, offset, pendingOperationIds ?? null])).rows; },
        async retainedBase(targetId: string, hash: string, binding: string) {
            const original = (await pool.query("select request->'acknowledgedBase' as base from obsidian_editorial_operations where target_id=$1 and request->'acknowledgedBase'->>'hash'=$2 and binding_hash=$3 limit 1", [targetId, hash, binding])).rows[0];
            if (original)
                return original.base;
            const operation = (await pool.query("select receipt from obsidian_editorial_operations where target_id=$1 and receipt->>'contentHash'=$2 and binding_hash=$3 and receipt->>'status'='synced' limit 1", [targetId, hash, binding])).rows[0];
            if (operation)
                return { content: operation.receipt.content, revision: operation.receipt.revision, hash };
            return (await pool.query("select content,revision_id as revision,rendered_hash as hash from obsidian_projection_revisions where memora_id=$1 and rendered_hash=$2 and binding_hash=$3 and status='written' limit 1", [targetId, hash, binding])).rows[0] ?? null;
        },
        async list(offset: number) { return (await pool.query('select memora_id as id from obsidian_sync_files order by memora_id offset $1 limit 25', [offset])).rows.map(r => String(r.id)); }
    };
}
