import { useRef, useState, type KeyboardEvent } from "react";
import { X } from "lucide-react";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.flatMap((tag) => tag.split(/[,\n]/)).map((tag) => tag.trim().normalize("NFC").toLowerCase()).filter(Boolean))];
}

const colors = [
  "bg-cyan-100 text-cyan-900 dark:bg-cyan-950 dark:text-cyan-200",
  "bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200",
  "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
  "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  "bg-rose-100 text-rose-900 dark:bg-rose-950 dark:text-rose-200"
];

export function TagBadges({ tags, t, onRemove, disabled = false }: {
  tags: readonly string[]; t: Translator; onRemove?: (tag: string) => void; disabled?: boolean;
}) {
  return <>{normalizeTags(tags).map((tag) => {
    const hash = Array.from(tag).reduce((value, char) => (value * 31 + char.codePointAt(0)!) >>> 0, 0);
    return <span key={tag} className={cn("inline-flex max-w-full items-center gap-1 rounded-full px-2 py-1 text-xs font-medium", colors[hash % colors.length])}>
      <span className="min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere]">{tag}</span>
      {onRemove ? <button type="button" disabled={disabled} aria-label={t("tagInput.remove", { values: { tag } })} onClick={() => onRemove(tag)} className="shrink-0 rounded-full p-0.5 hover:bg-black/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current disabled:opacity-50"><X className="h-3 w-3" aria-hidden="true" /></button> : null}
    </span>;
  })}</>;
}

export function TagInput({ id, value, onChange, t, disabled = false }: {
  id: string; value: readonly string[]; onChange: (tags: string[]) => void; t: Translator; disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const tags = normalizeTags(value);
  const commit = () => {
    if (!draft.trim()) return;
    onChange(normalizeTags([...tags, draft]));
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" || (event.key === "Tab" && !event.shiftKey && draft.trim())) {
      event.preventDefault();
      commit();
    }
  };
  return <div className="min-w-0">
    <div className={cn("flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white p-2 focus-within:ring-2 focus-within:ring-cyan-500 dark:border-slate-700 dark:bg-slate-950", disabled && "opacity-50")}>
      <TagBadges tags={tags} t={t} disabled={disabled} onRemove={(tag) => { onChange(tags.filter((item) => item !== tag)); input.current?.focus(); }} />
      <input ref={input} id={id} disabled={disabled} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} onBlur={commit} aria-describedby={`${id}-hint`} placeholder={t("tagInput.placeholder")} className="min-w-0 flex-[1_1_8rem] bg-transparent px-1 py-0.5 text-sm outline-none" />
    </div>
    <p id={`${id}-hint`} className="mt-1 text-xs text-slate-500 dark:text-slate-400">{t("tagInput.hint")}</p>
  </div>;
}
