import { useState } from "react";
import { ArrowDown, ArrowUp, FileText, Layers3, Plus, Trash2 } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import type { SourceItemType } from "@app/domain";

import { cn } from "../lib/cn";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { MarkdownEditor } from "./MarkdownEditor";

export interface ManualSubitemDraft {
  id: string;
  title: string;
  content: string;
}

export type ManualContentMode = "document" | "subitems";

export function createManualSubitem(): ManualSubitemDraft {
  return { id: crypto.randomUUID(), title: "", content: "" };
}

export function compileManualSubitems(items: ManualSubitemDraft[]): string {
  return items
    .filter((item) => item.title.trim() || item.content.trim())
    .map((item) => `# ${item.title.trim()}\n\n${item.content.trim()}`.trim())
    .join("\n\n");
}

export function validateManualSubitems(items: ManualSubitemDraft[]): boolean {
  const present = items.filter((item) => item.title.trim() || item.content.trim());
  return present.length === 0 || present.every((item) => item.title.trim() && item.content.trim());
}

export function ManualContentComposer({
  t,
  sourceType,
  content,
  onContent,
  mode,
  onMode,
  subitems,
  onSubitems,
  editing = false
}: {
  t: Translator;
  sourceType: SourceItemType;
  content: string;
  onContent: (value: string) => void;
  mode: ManualContentMode;
  onMode: (mode: ManualContentMode) => void;
  subitems: ManualSubitemDraft[];
  onSubitems: (items: ManualSubitemDraft[]) => void;
  editing?: boolean;
}) {
  const hierarchical = isHierarchicalRoot(sourceType);
  const [selectedId, setSelectedId] = useState<string | null>(() => subitems[0]?.id ?? null);
  const selected = subitems.find((item) => item.id === selectedId) ?? subitems[0] ?? null;

  function addItem() {
    const item = createManualSubitem();
    onSubitems([...subitems, item]);
    setSelectedId(item.id);
  }

  function updateItem(patch: Partial<ManualSubitemDraft>) {
    if (!selected) return;
    onSubitems(subitems.map((item) => item.id === selected.id ? { ...item, ...patch } : item));
  }

  function removeItem() {
    if (!selected) return;
    const index = subitems.findIndex((item) => item.id === selected.id);
    const next = subitems.filter((item) => item.id !== selected.id);
    onSubitems(next);
    setSelectedId(next[Math.min(index, next.length - 1)]?.id ?? null);
  }

  function moveItem(direction: -1 | 1) {
    if (!selected) return;
    const index = subitems.findIndex((item) => item.id === selected.id);
    const destination = index + direction;
    if (destination < 0 || destination >= subitems.length) return;
    const next = [...subitems];
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    onSubitems(next);
  }

  return <div className="grid gap-4">
    {hierarchical && !editing ? <div className="grid gap-3 rounded-2xl border border-slate-200 bg-slate-50/70 p-2 dark:border-slate-800 dark:bg-slate-900/40">
      <div className="grid grid-cols-2 gap-2" role="tablist" aria-label={t("import.content.modeLabel")}>
        {(["subitems", "document"] as const).map((item) => {
          const Icon = item === "subitems" ? Layers3 : FileText;
          return <button key={item} type="button" role="tab" aria-selected={mode === item} onClick={() => onMode(item)} className={cn("flex items-start gap-3 rounded-xl border p-3 text-left transition", mode === item ? "border-cyan-500 bg-white shadow-sm ring-2 ring-cyan-500/10 dark:bg-slate-950" : "border-transparent text-slate-500 hover:bg-white/70 dark:hover:bg-slate-950/70")}>
            <Icon className={cn("mt-0.5 h-5 w-5 shrink-0", mode === item && "text-cyan-700 dark:text-cyan-300")} aria-hidden="true" />
            <span><span className="block text-sm font-semibold text-slate-900 dark:text-slate-100">{t(`import.content.modes.${item}` as MessageKey)}</span><span className="mt-1 block text-xs leading-5">{t(`import.content.modeDescriptions.${item}` as MessageKey)}</span></span>
          </button>;
        })}
      </div>
    </div> : null}

    {mode === "subitems" && hierarchical && !editing ? <div className="grid min-h-[34rem] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-950 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <aside className="flex min-h-0 flex-col border-b border-slate-200 bg-slate-50/70 dark:border-slate-800 dark:bg-slate-900/50 lg:border-b-0 lg:border-r">
        <div className="border-b border-slate-200 p-3 dark:border-slate-800">
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-500">{t(subitemListKey(sourceType))}</p>
          <p className="mt-1 text-xs text-slate-500">{t("import.content.subitemsCount", { values: { count: subitems.length } })}</p>
        </div>
        <ol className="grid max-h-64 gap-1 overflow-auto p-2 lg:max-h-none lg:flex-1">
          {subitems.map((item, index) => <li key={item.id}><button type="button" onClick={() => setSelectedId(item.id)} className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left text-sm transition", selected?.id === item.id ? "bg-cyan-100 font-medium text-cyan-950 dark:bg-cyan-950 dark:text-cyan-100" : "hover:bg-white dark:hover:bg-slate-800")}>
            <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-white text-xs font-semibold text-slate-500 shadow-sm dark:bg-slate-950">{index + 1}</span>
            <span className="truncate">{item.title.trim() || t("import.content.untitledSubitem")}</span>
          </button></li>)}
        </ol>
        <div className="border-t border-slate-200 p-3 dark:border-slate-800"><Button type="button" className="w-full" onClick={addItem}><Plus className="h-4 w-4" />{t("import.content.addSubitem")}</Button></div>
      </aside>
      <div className="grid content-start gap-4 p-4 lg:p-5">
        {selected ? <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1 grid gap-2"><Label htmlFor={`subitem-title-${selected.id}`}>{t("import.content.subitemTitle")} *</Label><Input id={`subitem-title-${selected.id}`} value={selected.title} onChange={(event) => updateItem({ title: event.target.value })} placeholder={t(subitemPlaceholderKey(sourceType))} /></div>
            <div className="flex gap-1">
              <button type="button" disabled={subitems.indexOf(selected) === 0} onClick={() => moveItem(-1)} aria-label={t("import.content.moveUp")} title={t("import.content.moveUp")} className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-slate-500 disabled:opacity-35 dark:border-slate-700"><ArrowUp className="h-4 w-4" /></button>
              <button type="button" disabled={subitems.indexOf(selected) === subitems.length - 1} onClick={() => moveItem(1)} aria-label={t("import.content.moveDown")} title={t("import.content.moveDown")} className="grid h-9 w-9 place-items-center rounded-md border border-slate-200 text-slate-500 disabled:opacity-35 dark:border-slate-700"><ArrowDown className="h-4 w-4" /></button>
              <button type="button" onClick={removeItem} aria-label={t("import.content.removeSubitem")} title={t("import.content.removeSubitem")} className="grid h-9 w-9 place-items-center rounded-md border border-rose-200 text-rose-600 hover:bg-rose-50 dark:border-rose-900 dark:hover:bg-rose-950"><Trash2 className="h-4 w-4" /></button>
            </div>
          </div>
          <MarkdownEditor id={`subitem-content-${selected.id}`} value={selected.content} onChange={(value) => updateItem({ content: value })} t={t} label={t("import.content.subitemContent")} required minHeightClass="min-h-72" />
        </> : <div className="grid min-h-80 place-items-center text-center"><div><Layers3 className="mx-auto h-8 w-8 text-slate-400" /><p className="mt-3 text-sm text-slate-500">{t("import.content.noSubitems")}</p><Button type="button" className="mt-4" onClick={addItem}><Plus className="h-4 w-4" />{t("import.content.addSubitem")}</Button></div></div>}
      </div>
    </div> : <MarkdownEditor id="source-content" value={content} onChange={onContent} t={t} label={t("import.fields.content")} required={!hierarchical} />}

    <p className="text-xs leading-5 text-slate-500">{t(editing && hierarchical ? "import.content.editingHierarchyHint" : hierarchical ? "import.content.containerHint" : "import.content.hint")}</p>
  </div>;
}

function isHierarchicalRoot(type: SourceItemType) {
  return type === "Book" || type === "PeriodicalIssue" || type === "AcademicPaper";
}

function subitemListKey(type: SourceItemType): MessageKey {
  return type === "Book" ? "import.content.labels.chapters" : type === "PeriodicalIssue" ? "import.content.labels.articles" : "import.content.labels.sections";
}

function subitemPlaceholderKey(type: SourceItemType): MessageKey {
  return type === "Book" ? "import.content.placeholders.chapter" : type === "PeriodicalIssue" ? "import.content.placeholders.article" : "import.content.placeholders.section";
}
