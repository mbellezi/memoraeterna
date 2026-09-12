import { useRef, useState } from "react";
import type { MessageKey, Translator } from "@app/i18n";
import { Button } from "./ui/button";

export const metadataSelectionFields = ["title", "creators", "abstract", "doi", "description"] as const;
export type MetadataSelectionField = typeof metadataSelectionFields[number];

export function SourceMetadataPreview({ text, truncated = false, values, t, onApply }: {
  text: string; truncated?: boolean; values: Record<string, string>; t: Translator;
  onApply: (field: MetadataSelectionField, value: string, start: number, end: number) => void;
}) {
  const preview = useRef<HTMLTextAreaElement>(null);
  const [field, setField] = useState<MetadataSelectionField>("title");
  const [selection, setSelection] = useState({ start: 0, end: 0 });
  const selectedText = text.slice(selection.start, selection.end).trim();
  function selectOrigin(value: string) {
    const start = text.toLocaleLowerCase().indexOf(value.toLocaleLowerCase());
    if (start < 0) return;
    preview.current?.focus();
    preview.current?.setSelectionRange(start, start + value.length);
    setSelection({ start, end: start + value.length });
  }
  return <section className="grid min-w-0 content-start gap-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
    <div><h2 className="text-sm font-semibold">{t("intake.metadataTitle")}</h2><p className="mt-1 text-xs leading-5 text-slate-500">{t("intake.metadataHint")}</p></div>
    {text ? <>
      <label className="grid gap-2 text-xs font-medium">{t("intake.previewTitle")}
        <textarea ref={preview} readOnly value={text} onSelect={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onMouseUp={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} onKeyUp={(event) => setSelection({ start: event.currentTarget.selectionStart, end: event.currentTarget.selectionEnd })} className="min-h-80 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm font-normal leading-6 selection:bg-cyan-200 selection:text-slate-950 dark:border-slate-700 dark:bg-slate-900" />
      </label>
      {truncated ? <p className="text-xs text-slate-500">{t("intake.previewTruncated")}</p> : null}
      <div className="flex flex-wrap gap-2">{metadataSelectionFields.flatMap((key) => {
        const value = values[key]?.trim();
        return value && text.toLocaleLowerCase().includes(value.toLocaleLowerCase()) ? [<button key={key} type="button" className="rounded-md px-2 py-1 text-xs text-cyan-700 hover:bg-cyan-50 dark:text-cyan-300 dark:hover:bg-cyan-950" onClick={() => selectOrigin(value)}>{t("intake.viewOrigin", { values: { field: t(`import.metadataFields.${key}` as MessageKey) } })}</button>] : [];
      })}</div>
      <p className="text-xs leading-5 text-slate-500">{t("intake.captureHint")}</p>
      <div className="flex flex-wrap items-end gap-2"><label className="grid min-w-0 flex-1 gap-1 text-xs">{t("intake.captureField")}<select value={field} onChange={(event) => setField(event.target.value as MetadataSelectionField)} className="h-9 rounded-md border border-slate-300 bg-white px-2 dark:border-slate-700 dark:bg-slate-950">{metadataSelectionFields.map((key) => <option key={key} value={key}>{t(`import.metadataFields.${key}` as MessageKey)}</option>)}</select></label><Button type="button" disabled={!selectedText} onClick={() => onApply(field, selectedText, selection.start, selection.end)}>{t("intake.captureApply")}</Button></div>
    </> : <p className="rounded-lg bg-slate-50 p-4 text-sm text-slate-500 dark:bg-slate-900">{t("intake.previewEmpty")}</p>}
  </section>;
}
