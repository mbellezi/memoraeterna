import { useState, type FormEvent } from "react";
import { FileUp, Keyboard, Upload } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import { SourceItemTypes, type SourceItemType } from "@app/domain";

import type { ManualIngestionInput, SourceSuggestion } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

interface ImportViewProps { t: (key: MessageKey) => string; }

export function ImportView({ t }: ImportViewProps) {
  const [mode, setMode] = useState<"manual" | "file">("manual");
  const [sourceType, setSourceType] = useState<SourceItemType>("PersonalNote");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [originalUri, setOriginalUri] = useState("");
  const [workTitle, setWorkTitle] = useState("");
  const [identifier, setIdentifier] = useState("");
  const [pages, setPages] = useState("");
  const [parentSourceItemId, setParentSourceItemId] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<SourceSuggestion[]>([]);
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [busy, setBusy] = useState(false);

  async function submitManual(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      const bibliographic = (sourceType === "Book" || sourceType === "BookChapter" || sourceType === "StandaloneArticle")
        && !(sourceType === "BookChapter" && parentSourceItemId)
        ? {
            ...(workTitle ? { workTitle, workType: sourceType === "Book" ? "book" : "article" } : {}),
            ...(identifier && sourceType === "Book" ? { isbn: identifier } : {}),
            ...(identifier && sourceType === "StandaloneArticle" ? { doi: identifier } : {}),
            ...(pages ? { pages } : {})
          }
        : undefined;
      const input: ManualIngestionInput = {
        sourceType, title, content, language: "und", duplicatePolicy: "ignore", metadata: {},
        ...(originalUri ? { originalUri } : {}),
        ...(bibliographic && Object.keys(bibliographic).length > 0 ? { bibliographic } : {}),
        ...(parentSourceItemId ? { parentSourceItemId } : {})
      };
      await window.app.ingestion.createManual(input);
      setTitle("");
      setContent("");
      setOriginalUri("");
      setStatus("import.status.queued");
    } catch {
      setStatus("errors.common.validationFailed");
    } finally {
      setBusy(false);
    }
  }

  async function importFile() {
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      const result = await window.app.ingestion.importFile({ sourceType, duplicatePolicy: "ignore" });
      setStatus(result ? "import.status.queued" : "import.status.canceled");
    } catch (error) {
      setStatus(error instanceof Error && error.message.startsWith("errors.")
        ? error.message as MessageKey
        : "errors.common.unknown");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-5">
      <div className="grid grid-cols-2 overflow-hidden rounded-md border border-slate-300 dark:border-slate-700">
        {(["manual", "file"] as const).map((value) => (
          <button key={value} type="button" onClick={() => setMode(value)}
            className={mode === value
              ? "flex h-10 items-center justify-center gap-2 bg-cyan-700 text-sm font-medium text-white"
              : "flex h-10 items-center justify-center gap-2 bg-white text-sm text-slate-700 dark:bg-slate-950 dark:text-slate-300"}>
            {value === "manual" ? <Keyboard className="h-4 w-4" aria-hidden="true" /> : <FileUp className="h-4 w-4" aria-hidden="true" />}
            {t(value === "manual" ? "import.modes.manual" : "import.modes.file")}
          </button>
        ))}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="sourceType">{t("import.fields.sourceType")}</Label>
        <select id="sourceType" value={sourceType} onChange={(event) => setSourceType(event.target.value as SourceItemType)}
          className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
          {SourceItemTypes.map((type) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}
        </select>
      </div>
      {mode === "manual" ? (
        <form className="grid gap-4" onSubmit={submitManual}>
          <div className="grid gap-2"><Label htmlFor="title">{t("import.fields.title")}</Label><Input id="title" required value={title} onChange={(event) => setTitle(event.target.value)} /></div>
          {(sourceType === "WebArticle" || sourceType === "Video") ? (
            <div className="grid gap-2"><Label htmlFor="originalUri">{t("import.fields.originalUri")}</Label><Input id="originalUri" type="url" value={originalUri} onChange={(event) => setOriginalUri(event.target.value)} /></div>
          ) : null}
          {(sourceType === "Book" || sourceType === "BookChapter" || sourceType === "StandaloneArticle") ? (
            <div className="grid gap-4 md:grid-cols-3">
              <div className="relative grid gap-2"><Label htmlFor="workTitle">{t("import.fields.workTitle")}</Label><Input id="workTitle" value={workTitle} onChange={(event) => { const value = event.target.value; setWorkTitle(value); setParentSourceItemId(null); if (value.trim().length >= 2) void window.app.ingestion.lookupSources(value).then(setSuggestions); else setSuggestions([]); }} />{suggestions.length > 0 ? <div className="absolute top-full z-10 mt-1 grid w-full rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-950">{suggestions.map((suggestion) => <button key={suggestion.id} type="button" className="rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-900" onClick={() => { setWorkTitle(suggestion.title); setParentSourceItemId(suggestion.id); setSuggestions([]); }}>{suggestion.title}</button>)}</div> : null}</div>
              <div className="grid gap-2"><Label htmlFor="identifier">{t(sourceType === "StandaloneArticle" ? "import.fields.doi" : "import.fields.isbn")}</Label><Input id="identifier" value={identifier} onChange={(event) => setIdentifier(event.target.value)} /></div>
              <div className="grid gap-2"><Label htmlFor="pages">{t("import.fields.pages")}</Label><Input id="pages" value={pages} onChange={(event) => setPages(event.target.value)} /></div>
            </div>
          ) : null}
          <div className="grid gap-2">
            <Label htmlFor="content">{t("import.fields.content")}</Label>
            <textarea id="content" required value={content} onChange={(event) => setContent(event.target.value)}
              className="min-h-64 rounded-md border border-slate-300 bg-white p-3 font-mono text-sm dark:border-slate-700 dark:bg-slate-950" />
          </div>
          <div className="flex items-center justify-between gap-4"><p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p><Button disabled={busy} type="submit"><Upload className="h-4 w-4" aria-hidden="true" />{t("import.actions.queue")}</Button></div>
        </form>
      ) : (
        <div className="grid min-h-64 place-items-center rounded-md border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
          <div className="grid justify-items-center gap-3"><FileUp className="h-8 w-8 text-cyan-700" aria-hidden="true" /><p className="text-sm text-slate-600 dark:text-slate-300">{t("import.file.description")}</p><Button disabled={busy} onClick={() => void importFile()}>{t("import.actions.chooseFile")}</Button><p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p></div>
        </div>
      )}
    </section>
  );
}
