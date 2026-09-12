import { legacyPromptEntryHashes } from "./prompt-legacy-fingerprints.js";
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { OrganizationConfigurationSchema, promptDefinitions, promptDefinition, renderPromptTemplate, validatePromptGraph, PromptPinSchema, type PromptPin, type PromptCompositionSnapshot } from '@app/domain';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const context = new AsyncLocalStorage<{
    pin: PromptPin;
    provenance: Map<string, PromptCompositionSnapshot[]>;
}>();
let active: PromptPin | null = null;
let domains: Record<string, PromptPin> = {};
const provenance = new Map<string, PromptCompositionSnapshot[]>();
export function defaultPromptPin(domainId: string | null = null): PromptPin {
    return { version: 'prompt-catalog-v1', domainId, entries: promptDefinitions.map(d => ({ id: d.id, fields: Object.fromEntries(d.fields.map(f => [f.id, f.template])), revisions: [{ id: d.id, revisionId: `shipped-${d.defaultVersion}` }], origin: 'default' })) };
}
export function installPromptPin(pin: PromptPin, scoped: Record<string, PromptPin> = {}) { active = PromptPinSchema.parse(pin); domains = structuredClone(scoped); }
export function capturePromptPin(domainId?: string | null): PromptPin { return structuredClone(context.getStore()?.pin ?? (domainId ? domains[domainId] : null) ?? active ?? defaultPromptPin()); }
export function withPromptPin<T>(pin: PromptPin | null | undefined, fn: () => T): T { if (pin && context.getStore()?.pin === pin)
    return fn(); return context.run({ pin: pin ?? defaultPromptPin(), provenance: new Map() }, fn); }
export function promptFingerprint(ids: readonly string[], pin = capturePromptPin(), includeProviderFragments: boolean | string | readonly string[] = true): string {
    const visited = new Set<string>();
    const collect = (id: string) => { if (visited.has(id))
        return; visited.add(id); const definition = promptDefinition(id); definition.fragmentIds.forEach(collect); definition.providerFragments.filter(f => includeProviderFragments === true || typeof includeProviderFragments === 'string' ? includeProviderFragments === true || f.provider === includeProviderFragments : Array.isArray(includeProviderFragments) && includeProviderFragments.includes(f.provider)).forEach(f => collect(f.id)); };
    ids.forEach(collect);
    return hash([...visited].sort().map(id => { const entry = pin.entries.find(e => e.id === id); const d = promptDefinition(id); return [id, hash({ fields: entry?.fields ?? Object.fromEntries(d.fields.map(f => [f.id, f.template])), variables: d.variables.map(v => [v.key, v.valueType, v.serialization, v.originResolver]), serializerVersion: "prompt-renderer-v1" })]; }));
}
/** Existing byte-equivalent embedding defaults retain their model space. Only effective embedding wording/serializers split it. */
export function embeddingPromptIdentity(pin = capturePromptPin()): string | null {
    const ids = promptDefinitions.filter(d => d.id.startsWith('embedding.')).map(d => d.id);
    const current = promptFingerprint(ids, pin);
    return current === legacyPromptFingerprint(ids) ? null : current;
}
export function promptAudit(input: string): PromptCompositionSnapshot[] { return structuredClone((context.getStore()?.provenance ?? provenance).get(hash(input)) ?? []); }
export function rememberPrompt(input: string, snapshots: PromptCompositionSnapshot[]): string {
    const merged = [...new Map(snapshots.map(s => [s.promptId + ':' + s.compositionHash, s])).values()];
    const records = context.getStore()?.provenance ?? provenance;
    records.set(hash(input), merged);
    if (records === provenance && provenance.size > 4096)
        provenance.delete(provenance.keys().next().value!);
    return input;
}
export function joinPrompts(...parts: string[]): string { return rememberPrompt(parts.join(''), parts.flatMap(promptAudit)); }
export function renderPrompt(id: string, values: Record<string, unknown> = {}, pin?: PromptPin, additionalFragmentIds:readonly string[]=[]): string {
    const resolved = pin ?? context.getStore()?.pin ?? active ?? defaultPromptPin(), definition = promptDefinition(id), entry = resolved.entries.find(e => e.id === id);
    validatePromptGraph(Object.fromEntries(promptDefinitions.map(d => [d.id, d.fragmentIds])));
    const fields = entry?.fields ?? Object.fromEntries(definition.fields.map(f => [f.id, f.template]));
    const inputs = { ...values, ...Object.fromEntries(definition.fields.filter(f => !f.editable).map(f => [f.id, f.template])) };
    const rendered = definition.fields.filter(f => f.editable).map(field => renderPromptTemplate(fields[field.id] ?? field.template, definition.variables, inputs, field.requiredContractIds));
    const dependencyIds = new Set<string>();
    const collect = (id: string) => { if (dependencyIds.has(id))
        return; dependencyIds.add(id); promptDefinition(id).fragmentIds.forEach(collect); };
    collect(id);additionalFragmentIds.forEach(collect);
    const revisions = [...dependencyIds].flatMap(key => resolved.entries.find(e => e.id === key)?.revisions ?? [{ id: key, revisionId: `shipped-${promptDefinition(key).defaultVersion}` }]);
    const snapshot: PromptCompositionSnapshot = { version: 'prompt-catalog-v1', promptId: id, revisions, compositionHash: promptFingerprint([id,...additionalFragmentIds], resolved, false), templateLanguage: 'en', origin: entry?.origin ?? 'default', outputContractVersion: definition.defaultVersion, embeddingStrategyIdentity: id.startsWith('embedding.') ? embeddingPromptIdentity(resolved) : null };
    return rememberPrompt(rendered.join('\n\n'), [snapshot, ...Object.values(values).flatMap(v => typeof v === 'string' ? promptAudit(v) : [])]);
}
export function catalogInstructions(legacy: ReturnType<typeof import('@app/domain').resolveOrganizationInstructions>, functionName: keyof typeof import('@app/domain').organizationPromptFunctions, title: string, language: string, pin: PromptPin): typeof legacy {
    if (!active)
        return legacy;
    const prefix = { pageSynthesis: 'organization', consultation: 'consultation', weekly: 'maintenance.weekly', monthly: 'maintenance.monthly', cleanup: 'maintenance.cleanup' }[functionName];
    return withPromptPin(pin, () => ({ slots: { guidance: renderPrompt(prefix + '.guidance', { page_title: title, content_language: language }), advanced: renderPrompt(prefix + '.advanced', { page_title: title, content_language: language }) }, origins: { guidance: pin.entries.find(e => e.id === prefix + '.guidance')?.origin ?? 'default', advanced: pin.entries.find(e => e.id === prefix + '.advanced')?.origin ?? 'default' }, domainId: legacy.domainId }));
}
export function changedPromptIdentity(ids: readonly string[], pin = capturePromptPin()): string | null { const current = promptFingerprint(ids, pin); return current === legacyPromptFingerprint(ids) ? null : current; }
export function stagePromptFingerprints(pin = capturePromptPin(), legacy = false, providers?: string | readonly string[] | Record<string, string>): Record<string, string> {
    const families: Record<string, string[]> = { summarization: ['summary.'], atomicNotes: ['notes.extract', 'notes.repair'], knowledgeGraph: ['graph.'], atomicNoteMatching: ['notes.match', 'embedding.content.note', 'embedding.query_instruction'], sourceMatching: ['sources.'], embedding: ['embedding.'] };
    const tasks: Record<string, string> = { summarization: 'summarization', atomicNotes: 'atomic-note-generation', knowledgeGraph: 'knowledge-graph-generation', atomicNoteMatching: 'reranking', sourceMatching: 'reranking', embedding: 'embedding' };
    return Object.fromEntries(Object.entries(families).map(([stage, prefixes]) => [stage, (legacy ? legacyPromptFingerprint : promptFingerprint)(promptDefinitions.filter(d => prefixes.some(prefix => d.id === prefix || prefix.endsWith('.') && d.id.startsWith(prefix))).map(d => d.id), pin, providers === undefined ? true : typeof providers === 'string' || Array.isArray(providers) ? providers : (providers as Record<string, string>)[tasks[stage]!] ?? false)]));
}
export function legacyPromptFingerprint(ids: readonly string[], _pin?: PromptPin, includeProviderFragments: boolean | string | readonly string[] = true): string { const visited = new Set<string>(); const collect = (id: string) => { if (visited.has(id))
    return; visited.add(id); const definition = promptDefinition(id); definition.fragmentIds.forEach(collect); definition.providerFragments.filter(f => includeProviderFragments === true || typeof includeProviderFragments === 'string' ? includeProviderFragments === true || f.provider === includeProviderFragments : Array.isArray(includeProviderFragments) && includeProviderFragments.includes(f.provider)).forEach(f => collect(f.id)); }; ids.forEach(collect); return hash([...visited].sort().map(id => [id, legacyPromptEntryHashes[id] ?? "unknown_legacy_format"])); }
export function legacyStagePromptFingerprints(providers?: Record<string, string>) { return stagePromptFingerprints(defaultPromptPin(), true, providers); }

/** Domain metadata stays readable after migration; legacy prose remains in catalog history, never a second live editor. */
export function organizationMetadataConfiguration(raw:unknown):import('@app/domain').OrganizationConfiguration {
    if(!active)return OrganizationConfigurationSchema.parse(raw);
    const record=raw as Record<string,unknown>;
    const slots={global:{},pageSynthesis:{},consultation:{},weekly:{},monthly:{},cleanup:{}};
    return OrganizationConfigurationSchema.parse({...record,...slots,domains:Array.isArray(record.domains)?record.domains.map(domain=>({...domain,...slots,global:undefined,slots:{}})).map(({global,...domain})=>domain):[]});
}
