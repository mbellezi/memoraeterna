import { useState, type FormEvent, type ReactNode } from "react";
import { Check, FileUp, Keyboard, Layers3, Upload } from "lucide-react";
import type { Translator, MessageKey } from "@app/i18n";
import { SourceItemTypes, type ProcessingPlanRequest, type SourceItemType } from "@app/domain";

import type { DocumentStructureView, ManualIngestionInput, SourceSuggestion } from "../../shared/ipc";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";
import { StructureReview } from "./StructureReview";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

export function ImportView({ t }: { t: Translator }) {
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
  const [processingPlan, setProcessingPlan] = useState<ProcessingPlanRequest>(() => defaultProcessingPlan("full_knowledge"));
  const [structure, setStructure] = useState<DocumentStructureView | null>(null);
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
        sourceType, title, content, language: "und", duplicatePolicy: "ignore", metadata: {}, processingPlan,
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
      const result = await window.app.ingestion.importFile({ sourceType, duplicatePolicy: "ignore", processingPlan });
      if (!result) {
        setStatus("import.status.canceled");
      } else if (result.requiresStructureReview && result.structureId) {
        const detected = await window.app.ingestion.getStructure(result.structureId);
        setStructure(detected);
        setStatus("import.status.reviewStructure");
      } else {
        setStatus(result.jobId ? "import.status.queued" : "import.status.saved");
      }
    } catch (error) {
      setStatus(error instanceof Error && error.message.startsWith("errors.")
        ? error.message as MessageKey
        : "errors.common.unknown");
    } finally {
      setBusy(false);
    }
  }

  async function saveStructure(divisions: Parameters<typeof window.app.ingestion.saveStructure>[0]["divisions"]) {
    if (!structure) return;
    setBusy(true);
    try {
      setStructure(await window.app.ingestion.saveStructure({ structureId: structure.id, divisions }));
      setStatus("import.status.draftSaved");
    } finally {
      setBusy(false);
    }
  }

  async function confirmStructure(divisions: Parameters<typeof window.app.ingestion.confirmStructure>[0]["divisions"]) {
    if (!structure) return;
    setBusy(true);
    try {
      const result = await window.app.ingestion.confirmStructure({ structureId: structure.id, divisions, plan: processingPlan });
      setStructure(null);
      setStatus(result.queued.some((item) => item.jobId) ? "import.status.queuedChildren" : "import.status.savedChildren");
    } finally {
      setBusy(false);
    }
  }

  if (structure) {
    return <div className="grid gap-5">
      <ImportSteps active={2} t={t} />
      <StructureReview structure={structure} t={t} busy={busy} onSave={saveStructure} onConfirm={confirmStructure} />
      <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
        <ProcessingPlanPicker value={processingPlan} onChange={setProcessingPlan} t={t} compact />
      </div>
    </div>;
  }

  return <section className="grid gap-5">
    <ImportSteps active={1} t={t} />
    <div className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-300 bg-white p-1 dark:border-slate-700 dark:bg-slate-950">
      {(["manual", "file"] as const).map((value) => (
        <button key={value} type="button" onClick={() => setMode(value)} aria-pressed={mode === value}
          className={mode === value
            ? "flex h-11 items-center justify-center gap-2 rounded-lg bg-cyan-700 text-sm font-medium text-white shadow-sm"
            : "flex h-11 items-center justify-center gap-2 rounded-lg text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-300 dark:hover:bg-slate-900"}>
          {value === "manual" ? <Keyboard className="h-4 w-4" aria-hidden="true" /> : <FileUp className="h-4 w-4" aria-hidden="true" />}
          {t(value === "manual" ? "import.modes.manual" : "import.modes.file")}
        </button>
      ))}
    </div>

    <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
      <Label htmlFor="sourceType">{t("import.fields.sourceType")}</Label>
      <select id="sourceType" value={sourceType} onChange={(event) => setSourceType(event.target.value as SourceItemType)}
        className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
        {SourceItemTypes.map((type) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}
      </select>
      {isHierarchical(sourceType) ? <p className="flex items-center gap-2 text-xs text-cyan-700 dark:text-cyan-300"><Layers3 className="h-4 w-4" />{t("import.hierarchyHint")}</p> : null}
    </div>

    {mode === "manual" ? <form className="grid gap-5" onSubmit={submitManual}>
      <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-950">
        <div className="grid gap-2"><Label htmlFor="title">{t("import.fields.title")}</Label><Input id="title" required value={title} onChange={(event) => setTitle(event.target.value)} /></div>
        {(sourceType === "WebArticle" || sourceType === "Video") ? <div className="grid gap-2"><Label htmlFor="originalUri">{t("import.fields.originalUri")}</Label><Input id="originalUri" type="url" value={originalUri} onChange={(event) => setOriginalUri(event.target.value)} /></div> : null}
        {(sourceType === "Book" || sourceType === "BookChapter" || sourceType === "StandaloneArticle") ? <BibliographicFields t={t} sourceType={sourceType} workTitle={workTitle} identifier={identifier} pages={pages} suggestions={suggestions}
          onWorkTitle={(value) => { setWorkTitle(value); setParentSourceItemId(null); if (value.trim().length >= 2) void window.app.ingestion.lookupSources(value).then(setSuggestions); else setSuggestions([]); }}
          onIdentifier={setIdentifier} onPages={setPages} onSuggestion={(suggestion) => { setWorkTitle(suggestion.title); setParentSourceItemId(suggestion.id); setSuggestions([]); }} /> : null}
        <div className="grid gap-2"><Label htmlFor="content">{t("import.fields.content")}</Label><textarea id="content" required value={content} onChange={(event) => setContent(event.target.value)} className="min-h-64 rounded-lg border border-slate-300 bg-white p-3 font-mono text-sm dark:border-slate-700 dark:bg-slate-950" /></div>
      </div>
      <PlanCard plan={processingPlan} setPlan={setProcessingPlan} t={t} />
      <ImportFooter busy={busy} status={status} t={t} action="import.actions.queue" icon={<Upload className="h-4 w-4" />} />
    </form> : <div className="grid gap-5">
      <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-900">
        <div className="grid max-w-md justify-items-center gap-3"><div className="grid h-14 w-14 place-items-center rounded-2xl bg-cyan-50 text-cyan-700 dark:bg-cyan-950"><FileUp className="h-7 w-7" /></div><h2 className="font-semibold">{t("import.file.title")}</h2><p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{t("import.file.description")}</p><Button disabled={busy} onClick={() => void importFile()}>{t("import.actions.chooseFile")}</Button><p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p></div>
      </div>
      <PlanCard plan={processingPlan} setPlan={setProcessingPlan} t={t} />
    </div>}
  </section>;
}

function PlanCard({ plan, setPlan, t }: { plan: ProcessingPlanRequest; setPlan: (plan: ProcessingPlanRequest) => void; t: Translator }) {
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><ProcessingPlanPicker value={plan} onChange={setPlan} t={t} /></div>;
}

function ImportSteps({ active, t }: { active: 1 | 2; t: Translator }) {
  return <ol className="grid grid-cols-2 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950">
    {[1, 2].map((step) => <li key={step} className={`flex items-center gap-3 px-4 py-3 text-sm ${step === active ? "bg-cyan-50 font-semibold text-cyan-900 dark:bg-cyan-950 dark:text-cyan-100" : "text-slate-500"}`}>
      <span className={`grid h-6 w-6 place-items-center rounded-full text-xs ${step < active ? "bg-emerald-600 text-white" : step === active ? "bg-cyan-700 text-white" : "bg-slate-100 dark:bg-slate-800"}`}>{step < active ? <Check className="h-3.5 w-3.5" /> : step}</span>
      {t(step === 1 ? "import.steps.source" : "import.steps.structure")}
    </li>)}
  </ol>;
}

function ImportFooter({ busy, status, t, action, icon }: { busy: boolean; status: MessageKey; t: Translator; action: MessageKey; icon: ReactNode }) {
  return <div className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-950/95"><p className="text-sm text-slate-600 dark:text-slate-300">{t(status)}</p><Button disabled={busy} type="submit">{icon}{t(action)}</Button></div>;
}

function BibliographicFields({ t, sourceType, workTitle, identifier, pages, suggestions, onWorkTitle, onIdentifier, onPages, onSuggestion }: {
  t: Translator; sourceType: SourceItemType; workTitle: string; identifier: string; pages: string; suggestions: SourceSuggestion[];
  onWorkTitle: (value: string) => void; onIdentifier: (value: string) => void; onPages: (value: string) => void; onSuggestion: (value: SourceSuggestion) => void;
}) {
  return <div className="grid gap-4 md:grid-cols-3">
    <div className="relative grid gap-2"><Label htmlFor="workTitle">{t("import.fields.workTitle")}</Label><Input id="workTitle" value={workTitle} onChange={(event) => onWorkTitle(event.target.value)} />{suggestions.length > 0 ? <div className="absolute top-full z-10 mt-1 grid w-full rounded-md border border-slate-200 bg-white p-1 shadow-lg dark:border-slate-700 dark:bg-slate-950">{suggestions.map((suggestion) => <button key={suggestion.id} type="button" className="rounded px-2 py-1 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-900" onClick={() => onSuggestion(suggestion)}>{suggestion.title}</button>)}</div> : null}</div>
    <div className="grid gap-2"><Label htmlFor="identifier">{t(sourceType === "StandaloneArticle" ? "import.fields.doi" : "import.fields.isbn")}</Label><Input id="identifier" value={identifier} onChange={(event) => onIdentifier(event.target.value)} /></div>
    <div className="grid gap-2"><Label htmlFor="pages">{t("import.fields.pages")}</Label><Input id="pages" value={pages} onChange={(event) => onPages(event.target.value)} /></div>
  </div>;
}

function isHierarchical(type: SourceItemType) {
  return type === "Book" || type === "PeriodicalIssue" || type === "AcademicPaper";
}
