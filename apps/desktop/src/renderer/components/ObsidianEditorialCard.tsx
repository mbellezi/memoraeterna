import { useEffect, useRef, useState } from 'react';
import { FileWarning, X } from 'lucide-react';
import type { MessageKey, Translator } from '@app/i18n';
import { Button } from './ui/button';
import { MarkdownEditor } from './MarkdownEditor';
type Conflict = Awaited<ReturnType<typeof window.app.obsidian.editorialConflicts>>[number];
export function ObsidianEditorialCard({ t }: {
    t: (key: MessageKey) => string;
}) {
    const [rows, setRows] = useState<Conflict[] | null>(null), [selected, setSelected] = useState<Conflict | null>(null), [error, setError] = useState(false);
    const refresh = () => window.app.obsidian.editorialConflicts().then(setRows).catch(() => setError(true));
    useEffect(() => { void refresh(); const timer = setInterval(() => void refresh(), 3000); return () => clearInterval(timer); }, []);
    return <section className="grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-800"><h4 className="flex items-center gap-2 font-medium"><FileWarning size={16}/>{t('obsidianEditing.review')}</h4>{error && <p role="alert" className="text-sm text-red-600">{t('obsidianEditing.deliveryError')}</p>}{rows === null ? <p>{t('obsidianWiki.loading')}</p> : rows.length ? rows.map(row => <div key={row.id} className="flex items-center gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-950"><span className="min-w-0 flex-1 break-words text-sm">{row.path}{row.receipt.status==='deleted'&&<span className="ml-2 text-amber-700 dark:text-amber-300">{t('obsidianEditing.deleted')}</span>}</span><Button onClick={() => { setError(false); void window.app.obsidian.editorialComparison(row.id).then(receipt => setSelected({ ...row, receipt })).catch(() => setError(true)); }}>{t('obsidianWiki.review')}</Button></div>) : <p className="text-sm text-slate-500">{t('obsidianEditing.empty')}</p>}{selected && <EditorialComparison t={t} row={selected} close={() => setSelected(null)} complete={() => { setSelected(null); void refresh(); }}/>}</section>;
}
function EditorialComparison({ row, t, close, complete }: {
    row: Conflict;
    t: (key: MessageKey) => string;
    close: () => void;
    complete: () => void;
}) {
    const ref = useRef<HTMLDialogElement>(null), [text, setText] = useState(row.receipt.comparison?.local ?? ''), [busy, setBusy] = useState(false), [error, setError] = useState(false);
    useEffect(() => { const focus = document.activeElement; ref.current?.showModal(); return () => { ref.current?.close(); if (focus instanceof HTMLElement)
        focus.focus(); }; }, []);
    async function resolve(choice: 'local' | 'app' | 'manual') { setBusy(true); setError(false); try {
        await window.app.obsidian.resolveEditorial({ id: row.id, choice, content: text, currentRevision: row.receipt.revision, expectedLocal: row.receipt.status === 'deleted' ? null : row.receipt.comparison?.local ?? '' });
        complete();
    }
    catch {
        setError(true);
    }
    finally {
        setBusy(false);
    } }
    return <dialog ref={ref} aria-labelledby="editorial-comparison-title" onCancel={e => { e.preventDefault(); if (!busy)
        close(); }} onKeyDown={e => { if (e.key === 'Escape')
        e.stopPropagation(); }} className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl overflow-auto rounded-2xl bg-slate-50 p-5 text-slate-950 backdrop:bg-slate-950/60 dark:bg-slate-950 dark:text-slate-50"><header className="mb-4 flex gap-3"><h2 id="editorial-comparison-title" className="min-w-0 flex-1 break-words font-semibold">{row.path}</h2><Button autoFocus disabled={busy} onClick={close} aria-label={t('organization.close')}><X size={18}/></Button></header>{error && <p role="alert" className="mb-3 text-sm text-red-600">{t('obsidianEditing.stale')}</p>}<div className="grid gap-3 lg:grid-cols-3">{(['base', 'local', 'app'] as const).map(kind => <section key={kind}><h3 className="mb-2 text-sm font-semibold">{t(`obsidianEditing.${kind}`)}</h3><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-slate-200 bg-white p-3 text-xs dark:border-slate-800 dark:bg-slate-900">{row.receipt.comparison?.[kind]}</pre></section>)}</div><fieldset disabled={busy} className="mt-4"><MarkdownEditor id="obsidian-manual-merge" label={t('obsidianEditing.manual')} t={t as Translator} value={text} onChange={setText} minHeightClass="min-h-48"/></fieldset><div className="mt-4 flex flex-wrap gap-2">{(['local', 'app', 'manual'] as const).map(choice => <Button key={choice} disabled={busy} onClick={() => void resolve(choice)}>{t(choice === 'local' ? 'obsidianEditing.keepLocal' : choice === 'app' ? 'obsidianEditing.keepApp' : 'obsidianEditing.manual')}</Button>)}</div></dialog>;
}
