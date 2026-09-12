import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { ChevronDown, ChevronRight, FileText, Search, RotateCcw } from 'lucide-react';
import { PromptOverviewSchema, PromptDetailSchema, PromptPreviewSchema, promptVariablesUsed, parsePromptTemplate, promptCategoryLabels, promptLabel, type PromptDefinition, type PromptCommand } from '@app/domain';
import type { LanguageCode, MessageKey, Translator } from '@app/i18n';
const control = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-950';
const card = 'min-w-0 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900';
const command = (input: PromptCommand) => window.app.prompts.command(input);
const errorKey = (error: unknown) => (String(error).match(/prompts\.errors\.[a-z_]+/)?.[0] ?? 'prompts.errors.invalid') as MessageKey;
type Detail = z.infer<typeof PromptDetailSchema>;
type Filter = 'all' | 'customized' | 'inherited' | 'invalid' | 'active' | 'drafts';
export function fieldVariableKeys(text: string) { try {
    return promptVariablesUsed(text);
}
catch {
    return [...new Set([...text.matchAll(/%([^%\s]+)%/g)].map(m => m[1]!))];
} }
export function insertPromptVariable(text: string, key: string, start: number, end: number) { return { text: text.slice(0, start) + `%${key}%` + text.slice(end), cursor: start + key.length + 2 }; }
export function filterPromptDefinitions(definitions: PromptDefinition[], query: string, filter: Filter, active: Set<string>, drafts: Set<string>, invalid: Set<string>, language: LanguageCode) {
    const term = query.toLocaleLowerCase();
    return definitions.filter(d => [d.id, d.caller, d.title[language], d.purpose[language], ...d.category, ...d.variables.map(v => v.key), ...d.variables.map(v => v.description[language])].join(' ').toLocaleLowerCase().includes(term) && (filter === 'all' || filter === 'active' || filter === 'customized' && active.has(d.id) || filter === 'inherited' && !active.has(d.id) || filter === 'drafts' && drafts.has(d.id) || filter === 'invalid' && invalid.has(d.id)));
}
export interface PromptTreeItem {
    key: string;
    parent: string | null;
    expanded: boolean | null;
}
export function promptTreeNavigation(items: PromptTreeItem[], current: string, key: string): {
    focus: string;
    toggle?: string;
} | null {
    const index = items.findIndex(item => item.key === current), item = items[index];
    if (!item)
        return null;
    if (key === 'ArrowDown')
        return { focus: items[Math.min(index + 1, items.length - 1)]!.key };
    if (key === 'ArrowUp')
        return { focus: items[Math.max(0, index - 1)]!.key };
    if (key === 'Home')
        return { focus: items[0]!.key };
    if (key === 'End')
        return { focus: items.at(-1)!.key };
    if (key === 'ArrowRight') {
        if (item.expanded === false)
            return { focus: current, toggle: current };
        if (item.expanded === true && items[index + 1]?.parent === current)
            return { focus: items[index + 1]!.key };
        return { focus: current };
    }
    if (key === 'ArrowLeft') {
        if (item.expanded === true)
            return { focus: current, toggle: current };
        return { focus: item.parent ?? current };
    }
    return null;
}
export type PromptTreeNode = {
    key: string;
    label: string;
    children: Map<string, PromptTreeNode>;
    definition?: PromptDefinition;
};
export function buildPromptTree(visible: PromptDefinition[], language: LanguageCode) { const root: PromptTreeNode = { key: '', label: '', children: new Map() }; for (const d of visible) {
    let node = root;
    for (const [i, part] of d.category.entries()) {
        const key = 'category:' + d.category.slice(0, i + 1).join('.');
        if (!node.children.has(part))
            node.children.set(part, { key, label: (i === 0 ? promptCategoryLabels[part] : promptLabel(part))?.[language] ?? part, children: new Map() });
        node = node.children.get(part)!;
    }
    node.children.set(d.id, { key: 'prompt:' + d.id, label: d.title[language], children: new Map(), definition: d });
} return root; }
export function highlightPromptTokens(text: string, known: readonly string[]): Array<{
    text: string;
    variable: boolean;
    known: boolean;
}> {
    try {
        const variables = parsePromptTemplate(text).filter(t => t.kind === 'variable'), parts: Array<{
            text: string;
            variable: boolean;
            known: boolean;
        }> = [];
        let cursor = 0;
        for (const token of variables) {
            if (token.start > cursor)
                parts.push({ text: text.slice(cursor, token.start), variable: false, known: false });
            parts.push({ text: text.slice(token.start, token.end), variable: true, known: known.includes(token.text) });
            cursor = token.end;
        }
        parts.push({ text: text.slice(cursor), variable: false, known: false });
        return parts;
    }
    catch {
        return [{ text, variable: false, known: false }];
    }
}
export function PromptField({ definition, field, text, onChange, language, t, errors }: {
    definition: PromptDefinition;
    field: PromptDefinition['fields'][number];
    text: string;
    onChange: (text: string) => void;
    language: LanguageCode;
    t: Translator;
    errors: Array<{
        code: string;
        variable: string;
    }>;
}) {
    const input = useRef<HTMLTextAreaElement>(null), highlight = useRef<HTMLPreElement>(null);
    const used = fieldVariableKeys(text), variables = used.map(key => ({ key, definition: definition.variables.find(v => v.key === key) }));
    function insert(key: string) { const el = input.current; if (!el)
        return; const next = insertPromptVariable(text, key, el.selectionStart, el.selectionEnd); onChange(next.text); requestAnimationFrame(() => { el.focus(); el.setSelectionRange(next.cursor, next.cursor); }); }
    const parts = highlightPromptTokens(text, definition.variables.map(v => v.key));
    return <section className={card} aria-labelledby={`label-${field.id}`}>
  <label id={`label-${field.id}`} htmlFor={`prompt-${field.id}`} className="mb-2 block font-semibold">{t(field.editable ? 'prompts.body' : 'prompts.contract')}</label>
  {field.editable ? <><div className="relative overflow-hidden rounded-lg border border-slate-300 dark:border-slate-700">
   <pre ref={highlight} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words p-3 font-mono text-sm leading-6 text-transparent">{parts.map((part, i) => part.variable ? <mark key={i} className={`rounded text-transparent ${part.known ? 'bg-cyan-500/20' : 'bg-red-500/25'}`}>{part.text}</mark> : part.text)}{'\n'}</pre>
   <textarea ref={input} id={`prompt-${field.id}`} aria-describedby={`variables-${field.id}`} aria-invalid={!!errors.length} spellCheck={false} className="relative block min-h-64 w-full resize-y bg-transparent p-3 font-mono text-sm leading-6 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500" value={text} onChange={e => onChange(e.target.value)} onScroll={e => { if (highlight.current) {
            highlight.current.scrollTop = e.currentTarget.scrollTop;
            highlight.current.scrollLeft = e.currentTarget.scrollLeft;
        } }}/>
  </div><p className="mt-2 text-xs leading-5 text-slate-500">{t('prompts.syntax')}</p></> : <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{text}</pre>}
  {errors.map((error, i) => <p key={i} role="alert" className="mt-2 break-words text-sm text-red-700 dark:text-red-300">{t(errorKey(error.code))} {error.variable && `%${error.variable}%`}</p>)}
  <div id={`variables-${field.id}`} className="mt-4"><h4 className="text-sm font-semibold">{t('prompts.variables')}</h4>{!variables.length ? <p className="mt-2 text-xs text-slate-500">{t('prompts.none')}</p> : <dl className="mt-2 divide-y divide-slate-200 dark:divide-slate-800">{variables.map(({ key, definition: v }) => <div key={key} className="grid min-w-0 gap-1 py-3"><dt className="break-words font-mono text-xs text-cyan-700 dark:text-cyan-300">%{key}%</dt><dd className="text-sm">{v?.description[language] ?? t('prompts.unknown')}</dd>{v && <><dd className="break-words text-xs text-slate-500">{t('prompts.type')}: {v.valueType} · {t(v.required ? 'prompts.required' : 'prompts.optional')} · {t('prompts.origin')}: {t('prompts.backend')} ({v.originResolver}) · {v.serialization}</dd><dd className="break-words text-xs text-slate-500">{t('prompts.example')}: <code>{typeof v.example === 'string' ? v.example : JSON.stringify(v.example)}</code></dd></>}</div>)}</dl>}</div>
  {field.editable && <details className="mt-3 border-t border-slate-200 pt-3 dark:border-slate-800"><summary className="cursor-pointer text-sm font-medium">{t('prompts.available')}</summary><div className="mt-2 flex flex-wrap gap-2">{definition.variables.map(v => <button key={v.key} className={control} title={v.description[language]} onClick={() => insert(v.key)} aria-label={`${t('prompts.insert')}: %${v.key}%`}>%{v.key}%</button>)}</div></details>}
 </section>;
}
export function PromptsSettingsView({ t, language, initialId = "summary.short", initialDomainId = null }: {
    t: Translator;
    language: LanguageCode;
    initialId?: string;
    initialDomainId?: string | null;
}) {
    const [overview, setOverview] = useState<z.infer<typeof PromptOverviewSchema> | null>(null), [detail, setDetail] = useState<Detail | null>(null), [selected, setSelected] = useState(initialId);
    const [query, setQuery] = useState(''), [filter, setFilter] = useState<Filter>('all'), [collapsed, setCollapsed] = useState(new Set<string>()), [domainId, setDomainId] = useState<string | null>(initialDomainId), [level, setLevel] = useState<'global' | 'function' | 'domain' | 'domain_function'>(initialDomainId ? 'domain_function' : 'function');
    const [fields, setFields] = useState<Record<string, string>>({}), [revisionId, setRevisionId] = useState<string | null>(null), [preview, setPreview] = useState<z.infer<typeof PromptPreviewSchema> | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState<MessageKey | null>(null), [notice, setNotice] = useState<MessageKey | null>(null), [loading, setLoading] = useState(true), [sampleProgress, setSampleProgress] = useState<z.infer<typeof PromptPreviewSchema>['sampleProgress']>(), [retry, setRetry] = useState(0);
    const request = useRef(0), [treeFocus, setTreeFocus] = useState('prompt:' + initialId);
    const reload = useCallback(async () => { setOverview(PromptOverviewSchema.parse(await command({ command: 'list' }))); }, []);
    useEffect(() => { let live = true; void command({ command: 'list' }).then(v => { if (live)
        setOverview(PromptOverviewSchema.parse(v)); }).catch(e => { if (live)
        setError(errorKey(e)); }); return () => { live = false; }; }, [retry]);
    useEffect(() => { let live = true; request.current++; setLoading(true); setError(null); setNotice(null); setRevisionId(null); setSampleProgress(undefined); void command({ command: 'get', promptId: selected, domainId }).then(v => { if (!live)
        return; const d = PromptDetailSchema.parse(v); setDetail(d); setFields(d.effective.fields); setPreview(d.preview); }).catch(e => { if (live)
        setError(errorKey(e)); }).finally(() => { if (live)
        setLoading(false); }); return () => { live = false; }; }, [selected, domainId, retry]);
    useEffect(() => { if (!detail || loading)
        return; const sequence = ++request.current; const timer = setTimeout(() => void command({ command: 'preview', promptId: selected, domainId, fields }).then(v => { if (sequence === request.current)
        setPreview(PromptPreviewSchema.parse(v)); }).catch(e => { if (sequence === request.current)
        setError(errorKey(e)); }), 180); return () => clearTimeout(timer); }, [fields, detail, loading, selected, domainId]);
    const customized = useMemo(() => new Set(overview?.active.filter(r => r.origin !== 'reset').map(r => r.promptId) ?? []), [overview]);
    const drafts = new Set(overview?.states.filter(s => s.draft).map(s => s.id) ?? []), invalid = new Set([...(overview?.states.filter(s => s.invalid).map(s => s.id) ?? []), ...(preview?.errors.length ? [selected] : [])]);
    const visible = filterPromptDefinitions(overview?.definitions ?? [], query, filter, customized, drafts, invalid, language);
    const tree = useMemo(() => buildPromptTree(visible, language), [visible, language]);
    const treeItems: PromptTreeItem[] = [];
    function flatten(node: typeof tree) { for (const child of node.children.values()) {
        const expanded = child.definition ? null : !(collapsed.has(child.key) && !query);
        treeItems.push({ key: child.key, parent: node.key || null, expanded });
        if (expanded)
            flatten(child);
    } }
    flatten(tree);
    const focusKey = treeItems.some(i => i.key === treeFocus) ? treeFocus : treeItems.find(i => i.key === 'prompt:' + selected)?.key ?? treeItems[0]?.key;
    function choose(id: string) { if (busy)
        return; if (!overview?.definitions.find(d => d.id === id)?.supportsDomain) {
        setDomainId(null);
        setLevel('function');
    } setSelected(id); setRevisionId(null); }
    function nodes(node: typeof tree, depth = 0): React.ReactNode { return [...node.children.values()].map(child => { const leaf = child.definition, closed = collapsed.has(child.key) && !query; return <div role="none" key={child.key}><button role="treeitem" aria-level={depth + 1} aria-selected={leaf ? selected === leaf?.id : undefined} aria-expanded={leaf ? undefined : !closed} data-prompt-id={leaf?.id} data-tree-key={child.key} tabIndex={focusKey === child.key ? 0 : -1} onFocus={() => setTreeFocus(child.key)} className={`flex w-full min-w-0 items-start gap-2 rounded-lg py-2 pr-2 text-left text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 ${selected === child.key ? 'bg-cyan-500/15 text-cyan-800 dark:text-cyan-200' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`} style={{ paddingLeft: 8 + depth * 12 }} onClick={() => leaf ? choose(leaf.id) : setCollapsed(old => { const next = new Set(old); if (next.has(child.key))
        next.delete(child.key);
    else
        next.add(child.key); return next; })}>{leaf ? <FileText size={15} className="mt-0.5 shrink-0"/> : closed ? <ChevronRight size={16} className="shrink-0"/> : <ChevronDown size={16} className="shrink-0"/>}<span className="break-words">{child.label}{leaf && customized.has(leaf.id) && <span className="ml-1 text-cyan-600">•</span>}</span></button>{!leaf && !closed && <div role="group">{nodes(child, depth + 1)}</div>}</div>; }); }
    const selectedRevision = detail?.revisions.find(r => r.id === revisionId);
    const canActivate = !!selectedRevision?.validationHash && (detail?.definition.task === 'embedding' || selected.endsWith('.guidance') || selectedRevision.samplePassed);
    const activeRevision = overview?.active.find(r => r.promptId === selected && r.scope.level === level && r.scope.domainId === domainId)?.id ?? null;
    const route = overview?.routes.find(r => r.task === detail?.definition.task), model = overview?.profiles.find(p => p.id === route?.profileId) ?? overview?.profiles.find(p => p.isDefault);
    async function act(operation: () => Promise<void>) { request.current++; setBusy(true); setError(null); setNotice(null); try {
        await operation();
        await reload();
        const d = PromptDetailSchema.parse(await command({ command: 'get', promptId: selected, domainId }));
        setDetail(d);
    }
    catch (e) {
        setError(errorKey(e));
    }
    finally {
        setBusy(false);
    } }
    async function save() { const id = z.string().uuid().parse(await command({ command: 'save', promptId: selected, scope: { level, domainId }, fields: Object.fromEntries(detail!.definition.fields.filter(f => f.editable).map(f => [f.id, fields[f.id] ?? f.template])) })); setRevisionId(id); setNotice('prompts.saved'); return id; }
    return <div className="grid min-w-0 gap-4"><header><h2 className="text-2xl font-semibold">{t('prompts.title')}</h2><p className="mt-2 max-w-3xl text-sm leading-6 text-slate-500">{t('prompts.description')}</p></header>
 {error && <div role="alert" className={`${card} text-red-700 dark:text-red-300`}>{t(error)} <button className={control} onClick={() => setRetry(v => v + 1)}>{t('organization.refresh')}</button></div>}{notice && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-300">{t(notice)}</p>}
 <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(220px,280px)_minmax(0,1fr)]"><aside className={`${card} grid gap-3 xl:sticky xl:top-0`}><label className="relative"><Search className="pointer-events-none absolute left-3 top-3 text-slate-400" size={16}/><input className={`${control} w-full pl-9`} value={query} onChange={e => setQuery(e.target.value)} aria-label={t('prompts.search')} placeholder={t('prompts.search')}/></label><select className={`${control} w-full`} aria-label={t('prompts.all')} value={filter} onChange={e => setFilter(e.target.value as Filter)}>{(['all', 'customized', 'inherited', 'invalid', 'active', 'drafts'] as const).map(v => <option key={v} value={v}>{t(`prompts.${v}`)}</option>)}</select><div role="tree" aria-label={t('prompts.title')} className="max-h-72 overflow-auto xl:max-h-[65vh]" onKeyDown={e => { const current = (e.target as HTMLElement).closest<HTMLElement>('[data-tree-key]')?.dataset.treeKey; if (!current)
        return; const next = promptTreeNavigation(treeItems, current, e.key); if (!next)
        return; e.preventDefault(); if (next.toggle)
        setCollapsed(old => { const value = new Set(old); if (value.has(next.toggle!))
            value.delete(next.toggle!);
        else
            value.add(next.toggle!); return value; }); setTreeFocus(next.focus); Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[data-tree-key]')).find(item => item.dataset.treeKey === next.focus)?.focus(); }}>{nodes(tree)}{!visible.length && <p className="py-4 text-sm text-slate-500">{t('prompts.empty')}</p>}</div></aside>
 <main className="grid min-w-0 gap-4"><fieldset disabled={busy} className="contents">{loading || !detail ? <p role="status">{t('organization.loading')}</p> : <>
 <header className={card}><p className="mb-2 break-words text-xs text-slate-500">{detail.definition.category.map(k => (promptCategoryLabels[k] ?? promptLabel(k))[language]).join(' / ')}</p><h3 className="text-xl font-semibold">{detail.definition.title[language]}</h3><p className="mt-2 text-sm leading-6 text-slate-500">{detail.definition.purpose[language]}</p><p className="mt-3 break-words text-xs text-slate-500">{detail.definition.id} · {t('prompts.origin')}: {t(`organization.${detail.effective.origin === 'default' ? 'built_in' : detail.effective.origin}` as MessageKey)}</p><p className="mt-2 text-xs">{t('prompts.route')}: {detail.definition.task} · {detail.definition.task === 'fragment' ? t('prompts.callerModel') : model?.modelId ?? t('organization.noModel')}</p>
 <div className="mt-3 flex flex-wrap gap-2"><select className={control} aria-label={t('organization.domains')} value={domainId ?? ''} disabled={busy || !detail.definition.supportsDomain} onChange={e => { setDomainId(e.target.value || null); setLevel(e.target.value ? 'domain_function' : 'function'); }}><option value="">{t('organization.global')}</option>{overview?.domains.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select><select className={control} disabled={busy} aria-label={t('prompts.origin')} value={level} onChange={e => { setLevel(e.target.value as typeof level); setRevisionId(null); }}>{(domainId ? ['domain', 'domain_function'] : ['global', 'function']).map(l => <option key={l} value={l}>{t(`organization.${l}` as MessageKey)}</option>)}</select></div></header>
 {detail.definition.fields.map(field => <PromptField key={`${selected}:${field.id}`} definition={detail.definition} field={field} text={fields[field.id] ?? field.template} onChange={value => { setFields(old => ({ ...old, [field.id]: value })); setRevisionId(null); setNotice(null); }} language={language} t={t} errors={preview?.errors.filter(e => e.field === field.id) ?? []}/>)}
 <p className="text-xs leading-5 text-slate-500">{t("prompts.sampleBounds")}</p>{sampleProgress && <p role="status" className="text-xs text-slate-500">{t("prompts.sampleProgress", { values: { completed: sampleProgress.completedKeys.length, total: sampleProgress.requiredKeys.length, calls: sampleProgress.calls } })}</p>}
 <div className={`${card} flex flex-wrap gap-2`}><button disabled={busy} className={control} onClick={() => void act(async () => { await save(); })}>{t('prompts.save')}</button><button disabled={busy} className={control} onClick={() => void act(async () => { const id = revisionId ?? await save(); const result = PromptPreviewSchema.parse(await command({ command: 'validate', revisionId: id, sample: false })); setPreview(result); setNotice(result.errors.length ? null : 'prompts.validated'); })}>{t('prompts.validate')}</button><button disabled={busy || !!preview?.errors.length} className={control} onClick={() => void act(async () => { const id = revisionId ?? await save(); const result = PromptPreviewSchema.parse(await command({ command: 'validate', revisionId: id, sample: true })); setPreview(result); setSampleProgress(result.sampleProgress); setNotice(result.samplePassed ? 'prompts.samplePassed' : result.sampleProgress?.error === 'prompts.errors.partial' ? 'prompts.partial' : null); if (result.sampleProgress?.error && result.sampleProgress.error !== 'prompts.errors.partial')
            setError(errorKey(result.sampleProgress.error)); })}>{t('prompts.sample')}</button><button disabled={busy || !canActivate || !!preview?.errors.length} className={`${control} border-cyan-700 bg-cyan-700 text-white dark:bg-cyan-700`} onClick={() => void act(async () => { await command({ command: 'activate', revisionId: revisionId!, expectedActiveId: activeRevision }); setNotice('prompts.activated'); })}>{t('prompts.activate')}</button><button disabled={busy} className={control} onClick={() => void act(async () => { const id = z.string().uuid().parse(await command({ command: 'reset', promptId: selected, scope: { level, domainId }, expectedActiveId: activeRevision })); const d = PromptDetailSchema.parse(await command({ command: 'get', promptId: selected, revisionId: id, domainId })), list = PromptOverviewSchema.parse(await command({ command: 'list' })), active = list.active.some(r => r.id === id); setFields(d.effective.fields); setRevisionId(active ? null : id); setNotice(active ? 'prompts.activated' : 'prompts.saved'); })}><RotateCcw className="mr-1 inline" size={14}/>{t('prompts.reset')}</button></div>
 <details className={card} open><summary className="cursor-pointer font-semibold">{t('prompts.preview')}</summary><pre className="mt-3 max-h-96 overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-5">{preview?.text}</pre>{preview?.fragments.map(fragment => <section key={fragment.id} className="mt-4 border-t border-slate-200 pt-3 dark:border-slate-800"><h4 className="text-sm font-medium">{overview?.definitions.find(d => d.id === fragment.id)?.title[language] ?? fragment.id} · {fragment.provider}</h4><pre className="mt-2 whitespace-pre-wrap break-words font-mono text-xs">{fragment.text}</pre></section>)}<p className="mt-2 break-all font-mono text-xs text-slate-500">{preview?.compositionHash}</p></details>
 <details className={card}><summary className="cursor-pointer font-semibold">{t('prompts.compare')}</summary><pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs">{detail.effective.fields.body}</pre></details>
 <details className={card}><summary className="cursor-pointer font-semibold">{t('prompts.dependencies')}</summary><div className="mt-3 flex flex-wrap gap-2">{[...new Set([...detail.definition.fragmentIds, ...detail.definition.providerFragments.map(f => f.id), ...detail.affected])].map(id => <button key={id} className={`${control} break-all`} onClick={() => choose(id)}>{overview?.definitions.find(d => d.id === id)?.title[language] ?? id}</button>)}</div><p className="mt-3 break-words text-xs text-slate-500">{detail.definition.caller}</p></details>
 <details className={card}><summary className="cursor-pointer font-semibold">{t('prompts.history')} ({detail.revisions.length})</summary>{detail.revisions.filter(r => r.scope.domainId === domainId).map(r => <div key={r.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-slate-200 pt-3 text-xs dark:border-slate-800"><span>{new Date(r.createdAt).toLocaleString(language)} · {r.id.slice(0, 8)} · {t(`organization.${r.scope.level}` as MessageKey)}{overview?.active.some(a => a.id === r.id) && ` · ${t('organization.active')}`}</span><button disabled={busy} className={control} onClick={() => void act(async () => { const id = z.string().uuid().parse(await command({ command: 'restore', revisionId: r.id })); setFields({ ...detail.effective.fields, ...r.fields }); setLevel(r.scope.level); setRevisionId(id); setNotice('prompts.saved'); })}>{t('prompts.restore')}</button>{r.legacy && <details className="w-full"><summary className="cursor-pointer">{t('organization.versions')}</summary><pre className="max-h-36 overflow-auto whitespace-pre-wrap break-words">{typeof r.legacy.text === 'string' ? r.legacy.text : JSON.stringify(r.legacy)}</pre></details>}</div>)}{detail.activations.map(a => <p key={a.id} className="mt-2 break-words text-xs text-slate-500">{new Date(a.createdAt).toLocaleString(language)} · {a.revisionId}</p>)}</details>
 </>}</fieldset></main></div></div>;
}
