import { promptSampleCall, promptSampleSnapshot, promptSampleCheckpoint } from './prompt-samples.js';
import { organizationPrompt } from './organization-service.js';
import { createHash } from "node:crypto";
import { z } from 'zod';
import { createPromptRepository, createSettingsRepository, type PgPool } from '@app/db';
import { PromptCommandSchema, PromptSampleProgressSchema, type PromptSampleProgress, PromptRevisionSchema, promptDefinitions, promptDefinition, renderPromptTemplate, promptVariablesUsed, organizationPromptFunctions, type PromptPin, type PromptRevision, type PromptCommand } from '@app/domain';
import { defaultPromptPin, installPromptPin, withPromptPin, renderPrompt, promptFingerprint, changedPromptIdentity } from './prompt-runtime.js';
import type { AiService } from './ai-service.js';
export function resolvePromptLayers(rows: PromptRevision[], domainId: string | null = null): PromptPin {
    const pin = defaultPromptPin(domainId);
    for (const entry of pin.entries) {
        const definition = promptDefinition(entry.id);
        const selected = rows.filter(r => r.promptId === entry.id && (r.scope.domainId === null || definition.supportsDomain && r.scope.domainId === domainId));
        for (const level of ['global', 'function', 'domain', 'domain_function'] as const) {
            const layer = selected.find(r => r.scope.level === level);
            if (!layer || layer.origin === 'reset' || !Object.keys(layer.fields).length)
                continue;
            entry.fields = { ...entry.fields, ...layer.fields };
            entry.revisions.push({ id: entry.id, revisionId: layer.id });
            entry.origin = level;
        }
    }
    return pin;
}
export function legacyPromptText(text: string): string { return text.replaceAll('%', '%%').replaceAll('{{title}}', '%page_title%').replaceAll('{{language}}', '%content_language%'); }
function requiresSample(id: string) { const d = promptDefinition(id); return d.task !== 'embedding' && !id.endsWith('.guidance'); }
export class PromptService {
    private rows: PromptRevision[] = [];
    private sampling = new Set<string>();
    constructor(private readonly options: {
        getPool: () => PgPool | null;
        ai?: Pick<AiService, 'runDefaultTask' | 'listTaskRoutes' | 'listProfiles'>;
        sample?: (contexts: Array<{
            pin: PromptPin;
            ids: string[];
        }>, options: {
            progress: PromptSampleProgress;
            onProgress: (value: PromptSampleProgress) => Promise<void>;
        }) => Promise<PromptSampleProgress>;
    }) { }
    private repo() { const pool = this.options.getPool(); if (!pool)
        throw new Error('wiki.errors.unavailable'); return createPromptRepository(pool); }
    private bundle(rows = this.rows) { const domainIds = [...new Set(rows.flatMap(r => r.scope.domainId ? [r.scope.domainId] : []))]; return { default: resolvePromptLayers(rows), domains: Object.fromEntries(domainIds.map(id => [id, resolvePromptLayers(rows, id)])) }; }
    async initialize() { await this.migrateLegacy(); const rows = await this.repo().publish(rows => this.bundle(z.array(PromptRevisionSchema).parse(rows))); this.rows = z.array(PromptRevisionSchema).parse(rows); const bundle = this.bundle(); installPromptPin(bundle.default, bundle.domains); }
    async migrateLegacy() {
        const settings = createSettingsRepository(this.options.getPool()!);
        if (await settings.get('prompts.legacyMigrated'))
            return;
        const legacy = await this.repo().legacy(), mapping = new Map<string, string[]>();
        for (const revision of legacy.revisions) {
            const configuration = revision.configuration as Record<string, any>, ids: string[] = [];
            const allDomainIds = [...new Set(legacy.revisions.flatMap(r => (r.configuration.domains ?? []).map((d: {
                    id: string;
                }) => d.id)))] as string[];
            for (const functionName of Object.keys(organizationPromptFunctions) as Array<keyof typeof organizationPromptFunctions>) {
                const layers = [{ level: 'global' as const, domainId: null, slots: configuration.global ?? {} }, { level: 'function' as const, domainId: null, slots: configuration[functionName] ?? {} }, ...allDomainIds.flatMap(domainId => { const d = configuration.domains?.find((d: {
                        id: string;
                    }) => d.id === domainId); return [{ level: 'domain' as const, domainId, slots: d?.slots ?? {} }, { level: 'domain_function' as const, domainId, slots: d?.[functionName] ?? {} }]; })];
                for (const layer of layers)
                    for (const slot of ['guidance', 'advanced']) {
                        const text = layer.slots[slot];
                        const unsupported = slot === 'advanced' && (functionName === 'consultation' && (configuration.functionsVersion ?? 0) < 2 || ['weekly', 'monthly', 'cleanup'].includes(functionName) && (configuration.functionsVersion ?? 0) < 3);
                        const promptId = organizationPromptFunctions[functionName] + '.' + slot;
                        const hasValue = typeof text === 'string' && !unsupported, ambiguous = hasValue && /\{\{|\}\}/.test(text.replace(/\{\{(?:title|language)\}\}/g, ''));
                        const fields = hasValue ? { body: legacyPromptText(text) } : {};
                        const legacyKey = [revision.id, layer.level, layer.domainId ?? '', functionName, slot].join(':');
                        const id = await this.repo().save({ promptId, scope: { level: layer.level, domainId: layer.domainId }, fields, origin: hasValue ? 'legacy' : 'reset', legacy: { revisionId: revision.id, functionName, slot, text: typeof text === 'string' ? text : null, unsupported, ambiguous, ...(ambiguous ? { compatibilityReader: "literal-legacy-braces-v1" } : {}) }, legacyKey, createdAt: revision.createdAt });
                        // Unknown legacy braces remain literal, exactly as the old reader; only known title/language tokens are translated.
                        // Importing an existing activation preserves that behavior. Unactivated ambiguous rows remain drafts.
                        // Full configurations replace every slot, including reset rows for removed overrides/domains.
                        ids.push(id);
                    }
            }
            mapping.set(revision.id, ids);
        }
        // History mappings retain each original activation timestamp. No existing run is rewritten.
        await this.repo().importActivations(legacy.activations.flatMap(a => (mapping.get(a.revisionId) ?? []).map(revisionId => ({ revisionId, createdAt: a.createdAt }))));
        // Explicit active pointer wins over historical ordering, exactly as the legacy reader does.
        if (legacy.activeId)
            await this.repo().importActivations((mapping.get(legacy.activeId) ?? []).map(revisionId => ({ revisionId, createdAt: new Date().toISOString() })));
        await settings.set('prompts.legacyMigrated', { version: 1 });
    }
    private candidate(revision: PromptRevision, rows = this.rows, domainId = revision.scope.domainId) { const remaining = rows.filter(r => !(r.promptId === revision.promptId && r.scope.level === revision.scope.level && r.scope.domainId === revision.scope.domainId)); return resolvePromptLayers([...remaining, revision], domainId); }
    private validationPlan(revision: PromptRevision, rows = this.rows) {
        const domains = revision.scope.domainId ? [revision.scope.domainId] : [null, ...new Set(rows.flatMap(r => r.scope.domainId ? [r.scope.domainId] : []))];
        const ids = this.affected(revision.promptId), unique = new Map<string, {
            pin: PromptPin;
            ids: string[];
        }>();
        for (const domainId of domains) {
            const pin = this.candidate(revision, rows, domainId), key = promptFingerprint(ids, pin);
            if (!unique.has(key))
                unique.set(key, { pin, ids });
            // Also validate a lower-layer replacement while shadowed, before a future reset can reveal it.
            if (revision.origin !== 'reset') {
                const direct = structuredClone(pin), entry = direct.entries.find(e => e.id === revision.promptId)!;
                entry.fields = { ...entry.fields, ...revision.fields };
                const directKey = promptFingerprint(ids, direct);
                if (!unique.has(directKey))
                    unique.set(directKey, { pin: direct, ids });
            }
        }
        const contexts = [...unique.values()];
        return { contexts, hash: createHash('sha256').update(JSON.stringify([...unique.keys()].sort())).digest('hex') };
    }
    private affected(id: string) { const seen = new Set([id]); let changed = true; while (changed) {
        changed = false;
        for (const d of promptDefinitions)
            if ([...d.fragmentIds, ...d.providerFragments.map(f => f.id)].some(f => seen.has(f)) && !seen.has(d.id)) {
                seen.add(d.id);
                changed = true;
            }
    } return [...seen]; }
    private preview(id: string, fields: Record<string, string>, pin: PromptPin) {
        const definition = promptDefinition(id);
        const known = new Set(definition.fields.map(f => f.id));
        if (Object.keys(fields).some(k => !known.has(k) || definition.fields.some(f => f.id === k && !f.editable && fields[k] !== f.template)))
            throw new Error('prompts.errors.unknown');
        const values = Object.fromEntries(definition.variables.map(v => [v.key, v.example]));
        const effective = structuredClone(pin), entry = effective.entries.find(e => e.id === id)!;
        entry.fields = { ...entry.fields, ...fields };
        const errors: Array<{
            field: string;
            code: string;
            variable: string;
        }> = [];
        for (const field of definition.fields) {
            try {
                renderPromptTemplate(entry.fields[field.id] ?? field.template, definition.variables, values, field.requiredContractIds);
            }
            catch (e) {
                errors.push({ field: field.id, code: e instanceof Error ? e.message : 'prompts.errors.invalid', variable: (e as {
                        variable?: string;
                    }).variable ?? '' });
            }
        }
        let text = '';
        const fragments: Array<{
            id: string;
            text: string;
            provider: string | null;
        }> = [];
        if (!errors.length)
            withPromptPin(effective, () => {
                const sample = promptSampleCall(id, effective);
                text = sample?.input ?? (id === 'organization.legacy_synthesis' ? organizationPrompt(promptSampleSnapshot(effective), promptSampleCheckpoint()) : renderPrompt(id, values));
                if (definition.fragmentIds.includes('shared.output_language'))
                    text += '\n\n' + renderPrompt('shared.output_language', { content_language: 'English' });
                const seen = new Set<string>();
                const collect = (key: string, provider: string | null) => { if (seen.has(key))
                    return; seen.add(key); const d = promptDefinition(key); fragments.push({ id: key, text: renderPrompt(key, Object.fromEntries(d.variables.map(v => [v.key, v.example]))), provider }); };
                for (const fragment of definition.providerFragments)
                    collect(fragment.id, fragment.provider);
            });
        return { text, fragments, errors, compositionHash: promptFingerprint(this.affected(id), effective), affected: this.affected(id), variables: definition.fields.map(f => ({ field: f.id, keys: (() => { try {
                    return promptVariablesUsed(entry.fields[f.id] ?? f.template);
                }
                catch {
                    return [];
                } })() })) };
    }
    async command(raw: PromptCommand): Promise<unknown> {
        const c = PromptCommandSchema.parse(raw), repo = this.repo();
        if (c.command === 'list') {
            const [routes, profiles] = await Promise.all([this.options.ai?.listTaskRoutes() ?? [], this.options.ai?.listProfiles() ?? []]);
            const legacy = await repo.legacy(), config = legacy.revisions.find(r => r.id === legacy.activeId)?.configuration;
            const revisions = z.array(PromptRevisionSchema).parse(await repo.revisions());
            const activated = new Set((await repo.history()).map(row => row.revisionId));
            const states = promptDefinitions.map(d => { const drafts = revisions.filter(r => r.promptId === d.id && !activated.has(r.id)); return { id: d.id, draft: drafts.some(r => r.origin !== 'reset'), invalid: drafts.some(r => this.preview(d.id, r.fields, this.candidate(r)).errors.length > 0) }; });
            return { definitions: promptDefinitions, active: this.rows, domains: (config?.domains ?? []).map((d: {
                    id: string;
                    name: string;
                }) => ({ id: d.id, name: d.name })), states, routes, profiles: profiles.map(p => ({ id: p.id, name: p.name, modelId: p.modelId, status: p.status, isDefault: p.isDefault })) };
        }
        if (c.command === 'get') {
            const definition = promptDefinition(c.promptId), revisions = z.array(PromptRevisionSchema).parse(await repo.revisions(c.promptId)), revision = c.revisionId ? revisions.find(r => r.id === c.revisionId) : undefined;
            if (c.revisionId && !revision)
                throw new Error('prompts.errors.unknown');
            const pin = revision ? this.candidate(revision) : resolvePromptLayers(this.rows, c.domainId);
            return { definition, effective: pin.entries.find(e => e.id === c.promptId), revisions, activations: await repo.history(c.promptId), preview: this.preview(c.promptId, {}, pin), affected: this.affected(c.promptId) };
        }
        if (c.command === 'preview')
            return this.preview(c.promptId, c.fields, resolvePromptLayers(this.rows, c.domainId));
        if (c.command === 'save' || c.command === 'reset') {
            const definition = promptDefinition(c.promptId);
            if (c.scope.domainId && !definition.supportsDomain)
                throw new Error('prompts.errors.scope');
            if (c.command === 'save') {
                // Invalid template text is recoverable; invented or read-only field mutations are not a valid draft shape.
                if (Object.keys(c.fields).some(key => !definition.fields.some(field => field.id === key && field.editable)))
                    throw new Error('prompts.errors.unknown');
                return repo.save({ ...c, origin: 'draft' });
            }
            const id = await repo.save({ promptId: c.promptId, scope: c.scope, fields: {}, origin: 'reset' });
            const revision = PromptRevisionSchema.parse((await repo.revisions(c.promptId)).find(r => r.id === id));
            const pin = this.candidate(revision), preview = this.preview(c.promptId, {}, pin);
            if (preview.errors.length)
                throw new Error(preview.errors[0]!.code);
            const plan = this.validationPlan(revision), shipped = plan.contexts.every(c => changedPromptIdentity(c.ids, c.pin) === null);
            await repo.validate(id, plan.hash, shipped || !requiresSample(c.promptId));
            if (shipped || !requiresSample(c.promptId))
                await this.activate(revision, c.expectedActiveId, false);
            return id;
        }
        const revision = z.array(PromptRevisionSchema).parse(await repo.revisions()).find(r => r.id === c.revisionId);
        if (!revision)
            throw new Error('prompts.errors.unknown');
        if (c.command === 'restore')
            return repo.save({ promptId: revision.promptId, scope: revision.scope, fields: revision.fields, origin: 'restore', legacy: { restoredFrom: revision.id } });
        if (c.command === 'activate') {
            await this.activate(revision, c.expectedActiveId, requiresSample(revision.promptId));
            return null;
        }
        const pin = this.candidate(revision), preview = this.preview(revision.promptId, revision.fields, pin);
        if (preview.errors.length)
            return preview;
        const plan = this.validationPlan(revision), key = revision.id + ':' + plan.hash;
        let sampleProgress = PromptSampleProgressSchema.parse(await repo.sampleProgress(revision.id, plan.hash) ?? {});
        if (c.sample) {
            if (!this.options.sample)
                throw new Error('prompts.errors.model');
            if (this.sampling.has(key))
                throw new Error('prompts.errors.conflict');
            this.sampling.add(key);
            try {
                sampleProgress = await this.options.sample(plan.contexts, { progress: sampleProgress, onProgress: value => repo.saveSampleProgress(revision.id, plan.hash, value) });
            }
            finally {
                this.sampling.delete(key);
            }
        }
        const passed = !sampleProgress.error && sampleProgress.requiredKeys.length > 0 && sampleProgress.requiredKeys.every(key => sampleProgress.completedKeys.includes(key) || sampleProgress.inapplicable[key]);
        await repo.validate(revision.id, plan.hash, passed || !requiresSample(revision.promptId), sampleProgress.auditIds);
        return { ...preview, samplePassed: passed || !requiresSample(revision.promptId), sampleProgress };
    }
    private async activate(revision: PromptRevision, expected: string | null, sampleRequired: boolean) {
        const pin = this.candidate(revision), preview = this.preview(revision.promptId, revision.fields, pin);
        if (preview.errors.length)
            throw new Error(preview.errors[0]!.code);
        const rows = await this.repo().activate(revision.id, expected, rows => this.validationPlan(revision, z.array(PromptRevisionSchema).parse(rows)).hash, sampleRequired, rows => this.bundle(z.array(PromptRevisionSchema).parse(rows)));
        this.rows = z.array(PromptRevisionSchema).parse(rows);
        const bundle = this.bundle();
        installPromptPin(bundle.default, bundle.domains);
    }
}
