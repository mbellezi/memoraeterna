import type { PgPool, PgClient } from '../client.js';
const stamp = (value: unknown) => new Date(value as string).toISOString();
const selection = `r.id,r.prompt_id as "promptId",jsonb_build_object('level',r.scope,'domainId',r.domain_id) as scope,r.fields,r.origin,r.legacy,r.created_at as "createdAt",(select v.composition_hash from prompt_validations v where v.revision_id=r.id order by v.created_at desc limit 1) as "validationHash",coalesce((select v.sample_passed from prompt_validations v where v.revision_id=r.id order by v.created_at desc limit 1),false) as "samplePassed"`;
export function createPromptRepository(pool: PgPool) {
    const tx = async <T>(fn: (db: PgClient) => Promise<T>) => { const db = await pool.connect(); try {
        await db.query('begin');
        await db.query("select pg_advisory_xact_lock(hashtextextended('prompt-catalog',0))");
        const result = await fn(db);
        await db.query('commit');
        return result;
    }
    catch (e) {
        await db.query('rollback');
        throw e;
    }
    finally {
        db.release();
    } };
    return {
        async sampleProgress(revisionId: string, hash: string) { return (await pool.query("select value from settings where key=$1", ['prompts.sample:' + revisionId + ':' + hash])).rows[0]?.value ?? null; },
        async saveSampleProgress(revisionId: string, hash: string, progress: unknown) { await pool.query("insert into settings(key,value) values($1,$2) on conflict(key) do update set value=excluded.value,updated_at=now()", ['prompts.sample:' + revisionId + ':' + hash, progress]); },
        async revisions(promptId?: string) { return (await pool.query(`select ${selection} from prompt_revisions r ${promptId ? 'where r.prompt_id=$1' : ''} order by r.created_at desc,r.id desc`, promptId ? [promptId] : [])).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) })); },
        async active() { return (await pool.query(`select distinct on(r.prompt_id,r.scope,r.domain_id) ${selection},a.id as "activationId" from prompt_activations a join prompt_revisions r on r.id=a.revision_id order by r.prompt_id,r.scope,r.domain_id,a.created_at desc,a.id desc`)).rows.map(({ activationId, ...r }) => ({ ...r, createdAt: stamp(r.createdAt) })); },
        async history(promptId?: string) { return (await pool.query(`select a.id,a.revision_id as "revisionId",a.created_at as "createdAt" from prompt_activations a join prompt_revisions r on r.id=a.revision_id ${promptId ? 'where r.prompt_id=$1' : ''} order by a.created_at desc,a.id desc`, promptId ? [promptId] : [])).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) })); },
        async save(input: {
            promptId: string;
            scope: {
                level: string;
                domainId: string | null;
            };
            fields: Record<string, string>;
            origin: string;
            legacy?: unknown;
            legacyKey?: string;
            createdAt?: string;
        }) {
            const row = (await pool.query(`insert into prompt_revisions(prompt_id,scope,domain_id,fields,origin,legacy,legacy_key,created_at) values($1,$2,$3,$4,$5,$6,$7,coalesce($8::timestamptz,now())) on conflict(legacy_key) do update set legacy_key=excluded.legacy_key returning id`, [input.promptId, input.scope.level, input.scope.domainId, input.fields, input.origin, input.legacy ?? null, input.legacyKey ?? null, input.createdAt ?? null])).rows[0]!;
            return row.id as string;
        },
        async validate(id: string, compositionHash: string, samplePassed: boolean, auditIds: string[] = []) { await pool.query(`insert into prompt_validations(revision_id,composition_hash,sample_passed,audit_ids) values($1,$2,$3,$4) on conflict(revision_id,composition_hash) do update set sample_passed=prompt_validations.sample_passed or excluded.sample_passed,audit_ids=case when excluded.sample_passed then excluded.audit_ids else prompt_validations.audit_ids end,created_at=now()`, [id, compositionHash, samplePassed, JSON.stringify(auditIds)]); },
        async activate(id: string, expectedActiveId: string | null, validationHash: (rows: unknown[]) => string, sampleRequired: boolean, publish: (rows: unknown[]) => unknown) {
            return tx(async (db) => {
                const revision = (await db.query('select * from prompt_revisions where id=$1', [id])).rows[0];
                if (!revision)
                    throw new Error('prompts.errors.unknown');
                const current = (await db.query(`select r.id from prompt_activations a join prompt_revisions r on r.id=a.revision_id where r.prompt_id=$1 and r.scope=$2 and r.domain_id is not distinct from $3::uuid order by a.created_at desc,a.id desc limit 1`, [revision.prompt_id, revision.scope, revision.domain_id])).rows[0]?.id ?? null;
                if (current !== expectedActiveId)
                    throw new Error('prompts.errors.conflict');
                const currentRows = (await db.query(`select distinct on(r.prompt_id,r.scope,r.domain_id) ${selection} from prompt_activations a join prompt_revisions r on r.id=a.revision_id order by r.prompt_id,r.scope,r.domain_id,a.created_at desc,a.id desc`)).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) }));
                const hash = validationHash(currentRows);
                if (!(await db.query('select id from prompt_validations where revision_id=$1 and composition_hash=$2 and (not $3::boolean or sample_passed)', [id, hash, sampleRequired])).rows.length)
                    throw new Error('prompts.errors.sample');
                await db.query('insert into prompt_activations(revision_id,created_at) values($1,clock_timestamp())', [id]);
                const rows = (await db.query(`select distinct on(r.prompt_id,r.scope,r.domain_id) ${selection} from prompt_activations a join prompt_revisions r on r.id=a.revision_id order by r.prompt_id,r.scope,r.domain_id,a.created_at desc,a.id desc`)).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) }));
                await db.query("insert into settings(key,value) values('prompts.active',$1) on conflict(key) do update set value=excluded.value,updated_at=now()", [publish(rows)]);
                return rows;
            });
        },
        async legacy() { return { revisions: (await pool.query('select id,configuration,created_at as "createdAt" from organization_settings_revisions order by created_at,id')).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) })), activations: (await pool.query('select id,revision_id as "revisionId",created_at as "createdAt" from organization_settings_activations order by created_at,id')).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) })), activeId: (await pool.query("select coalesce((select value->>'revisionId' from settings where key='organization.active'),(select revision_id::text from organization_settings_activations order by created_at desc,id desc limit 1)) as id")).rows[0]?.id as string | null }; },
        async importActivations(entries: Array<{
            revisionId: string;
            createdAt: string;
        }>) { await tx(async (db) => { for (const row of entries)
            await db.query('insert into prompt_activations(revision_id,created_at) select $1,$2 where not exists(select 1 from prompt_activations where revision_id=$1 and created_at=$2)', [row.revisionId, row.createdAt]); }); },
        async publish(publish: (rows: unknown[]) => unknown) { return tx(async (db) => { const rows = (await db.query(`select distinct on(r.prompt_id,r.scope,r.domain_id) ${selection} from prompt_activations a join prompt_revisions r on r.id=a.revision_id order by r.prompt_id,r.scope,r.domain_id,a.created_at desc,a.id desc`)).rows.map(r => ({ ...r, createdAt: stamp(r.createdAt) })); await db.query("insert into settings(key,value) values('prompts.active',$1) on conflict(key) do update set value=excluded.value,updated_at=now()", [publish(rows)]); return rows; }); }
    };
}
