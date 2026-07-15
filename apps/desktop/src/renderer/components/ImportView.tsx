import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpen, Check, ChevronLeft, ChevronRight, FileText, FileUp, Film, Globe2,
  LibraryBig, NotebookPen, Search, Sparkles, StickyNote, Upload, X
} from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import {
  SourceDescriptorSchema,
  SourceItemTypes,
  type ProcessingPlanRequest,
  type MetadataFieldProvenance,
  type Creator,
  type SourceDescriptor,
  type SourceItemType
} from "@app/domain";

import type {
  DocumentStructureView, DuplicateCandidate, DuplicatePolicy, EnrichmentCandidate,
  FileMetadataExtractionResult, SourceSuggestion
} from "../../shared/ipc";
import { cn } from "../lib/cn";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";
import { StructureReview } from "./StructureReview";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";

type ImportOrigin = "manual" | "file";
type FormValues = Record<string, string>;

const sourceCards: Array<{ type: SourceItemType; icon: typeof BookOpen; group: "notes" | "publications" | "media" }> = [
  { type: "PersonalNote", icon: StickyNote, group: "notes" },
  { type: "DailyNote", icon: NotebookPen, group: "notes" },
  { type: "Book", icon: BookOpen, group: "publications" },
  { type: "BookChapter", icon: FileText, group: "publications" },
  { type: "PeriodicalIssue", icon: LibraryBig, group: "publications" },
  { type: "AcademicPaper", icon: FileText, group: "publications" },
  { type: "DocumentSection", icon: FileText, group: "publications" },
  { type: "StandaloneArticle", icon: FileText, group: "publications" },
  { type: "WebArticle", icon: Globe2, group: "media" },
  { type: "Video", icon: Film, group: "media" },
  { type: "GenericDocument", icon: FileText, group: "media" }
];

const compatibleParents: Partial<Record<SourceItemType, SourceItemType[]>> = {
  BookChapter: ["Book"],
  DocumentSection: ["AcademicPaper"],
  StandaloneArticle: ["PeriodicalIssue"]
};

export function ImportView({ t, metadataEnrichmentEnabled = true }: { t: Translator; metadataEnrichmentEnabled?: boolean }) {
  const [step, setStep] = useState(0);
  const [sourceType, setSourceType] = useState<SourceItemType>("PersonalNote");
  const [sourceSearch, setSourceSearch] = useState("");
  const [origin, setOrigin] = useState<ImportOrigin>("manual");
  const [values, setValues] = useState<FormValues>(() => initialValues("PersonalNote"));
  const [fieldProvenance, setFieldProvenance] = useState<Record<string, MetadataFieldProvenance>>({});
  const [content, setContent] = useState("");
  const [file, setFile] = useState<FileMetadataExtractionResult | null>(null);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(null);
  const [processingPlan, setProcessingPlan] = useState<ProcessingPlanRequest>(() => defaultProcessingPlan("full_knowledge"));
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("ignore");
  const [duplicate, setDuplicate] = useState<DuplicateCandidate | null>(null);
  const [candidates, setCandidates] = useState<EnrichmentCandidate[]>([]);
  const [structure, setStructure] = useState<DocumentStructureView | null>(null);
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [validationError, setValidationError] = useState("");
  const [busy, setBusy] = useState(false);

  const descriptor = useMemo(() => buildDescriptor(sourceType, values, coverAssetId, fieldProvenance), [coverAssetId, fieldProvenance, sourceType, values]);

  useEffect(() => {
    if (step !== 2 || !metadataEnrichmentEnabled || !supportsEnrichment(sourceType)) {
      setCandidates([]);
      return;
    }
    const isbn = values.isbn13 || values.isbn10;
    const doi = values.doi;
    const title = values.title?.trim();
    if (!isbn && !doi && (!title || title.length < 2)) return;
    const timer = window.setTimeout(() => {
      void window.app.ingestion.enrichMetadata({
        sourceType,
        ...(isbn ? { isbn } : {}),
        ...(doi ? { doi } : {}),
        ...(title ? { title } : {}),
        ...(parseCreators(values.creators ?? "")[0]?.name ? { author: parseCreators(values.creators ?? "")[0]!.name } : {})
      }).then(setCandidates).catch(() => setCandidates([]));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [metadataEnrichmentEnabled, sourceType, step, values.creators, values.doi, values.isbn10, values.isbn13, values.title]);

  useEffect(() => {
    if (step !== 4 || !descriptor.success) {
      setDuplicate(null);
      return;
    }
    void window.app.ingestion.findDuplicate({
      descriptor: descriptor.data,
      ...(origin === "file" && file ? { fileToken: file.fileToken } : { content })
    }).then(setDuplicate).catch(() => setDuplicate(null));
  }, [content, descriptor, file, origin, step]);

  function chooseType(type: SourceItemType) {
    setSourceType(type);
    setValues(initialValues(type));
    setFieldProvenance({});
    setContent("");
    setFile(null);
    setCoverAssetId(null);
    setValidationError("");
  }

  async function chooseFile() {
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      const extracted = await window.app.ingestion.extractFileMetadata({ sourceType });
      if (!extracted) {
        setStatus("import.status.canceled");
        return;
      }
      setFile(extracted);
      setValues((current) => ({ ...current, ...draftToValues(extracted.draft.values) }));
      setFieldProvenance(expandProvenance(extracted.draft.provenance));
      const cover = extracted.draft.values.cover;
      if (isRecord(cover) && typeof cover.assetId === "string") setCoverAssetId(cover.assetId);
      setStatus("import.status.metadataExtracted");
      setStep(2);
    } catch (error) {
      setStatus(errorMessageKey(error));
    } finally {
      setBusy(false);
    }
  }

  async function applyCandidate(candidate: EnrichmentCandidate) {
    setBusy(true);
    try {
      const incoming = draftToValues(candidate.values);
      setValues((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(incoming).filter(([key]) => fieldProvenance[key]?.source !== "manual"))
      }));
      setFieldProvenance((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(expandProvenance(candidate.provenance)).filter(([key]) => current[key]?.source !== "manual"))
      }));
      if (candidate.coverUrl) {
        const cover = await window.app.ingestion.applyEnrichmentCover(candidate.coverUrl);
        setCoverAssetId(cover.assetId);
        setFieldProvenance((current) => ({ ...current, cover: { source: "enriched", provider: candidate.provider } }));
      }
      setCandidates([]);
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setValidationError("");
    if (step === 0) return setStep(1);
    if (step === 1) {
      if (origin === "file") void chooseFile();
      else setStep(2);
      return;
    }
    if (step === 2) {
      if (!descriptor.success) {
        setValidationError(descriptor.error.issues[0]?.message ?? t("errors.common.validationFailed"));
        return;
      }
      setStep(3);
      return;
    }
    if (step === 3) {
      if (origin === "file" && !file) {
        setValidationError(t("import.validation.chooseFile"));
        return;
      }
      if (origin === "manual" && !isContainerType(sourceType) && !content.trim()) {
        setValidationError(t("import.validation.contentRequired"));
        return;
      }
      setStep(4);
    }
  }

  async function submit() {
    if (!descriptor.success) return;
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      const result = origin === "file" && file
        ? await window.app.ingestion.importFile({
            fileToken: file.fileToken, descriptor: descriptor.data, duplicatePolicy, processingPlan
          })
        : isContainerType(sourceType) && !content.trim()
          ? await window.app.ingestion.createContainerSource({ descriptor: descriptor.data, duplicatePolicy })
          : await window.app.ingestion.createManual({
              descriptor: descriptor.data, content, duplicatePolicy, processingPlan
            });
      if (!result) {
        setStatus("import.status.canceled");
      } else if (result.requiresStructureReview && result.structureId) {
        setStructure(await window.app.ingestion.getStructure(result.structureId));
        setStatus("import.status.reviewStructure");
      } else {
        setStatus(result.duplicate ? "import.status.duplicateHandled" : result.jobId ? "import.status.queued" : "import.status.saved");
        resetWizard();
      }
    } catch (error) {
      setStatus(errorMessageKey(error));
    } finally {
      setBusy(false);
    }
  }

  function resetWizard() {
    setStep(0);
    setValues(initialValues(sourceType));
    setFieldProvenance({});
    setContent("");
    setFile(null);
    setCoverAssetId(null);
    setDuplicate(null);
    setCandidates([]);
  }

  async function saveStructure(divisions: Parameters<typeof window.app.ingestion.saveStructure>[0]["divisions"]) {
    if (!structure) return;
    setBusy(true);
    try {
      setStructure(await window.app.ingestion.saveStructure({ structureId: structure.id, divisions }));
      setStatus("import.status.draftSaved");
    } finally { setBusy(false); }
  }

  async function confirmStructure(divisions: Parameters<typeof window.app.ingestion.confirmStructure>[0]["divisions"]) {
    if (!structure) return;
    setBusy(true);
    try {
      const result = await window.app.ingestion.confirmStructure({ structureId: structure.id, divisions, plan: processingPlan });
      setStructure(null);
      resetWizard();
      setStatus(result.queued.some((item) => item.jobId) ? "import.status.queuedChildren" : "import.status.savedChildren");
    } finally { setBusy(false); }
  }

  if (structure) return <div className="grid gap-5">
    <WizardSteps active={5} t={t} />
    <StructureReview structure={structure} t={t} busy={busy} onSave={saveStructure} onConfirm={confirmStructure} />
    <PlanCard plan={processingPlan} setPlan={setProcessingPlan} t={t} />
  </div>;

  return <section className="grid gap-5">
    <WizardSteps active={step} t={t} />
    {step === 0 ? <SourceTypeStep t={t} value={sourceType} search={sourceSearch} onSearch={setSourceSearch} onChoose={chooseType} /> : null}
    {step === 1 ? <OriginStep t={t} value={origin} onChange={setOrigin} /> : null}
    {step === 2 ? <section className="grid gap-5">
      <DescriptorFields t={t} sourceType={sourceType} values={values} onChange={setValues} onFieldChange={(name) => setFieldProvenance((current) => ({ ...current, [name]: { source: "manual" } }))} />
      {compatibleParents[sourceType] ? <ParentPicker t={t} sourceType={sourceType} values={values} onChange={setValues} /> : null}
      {metadataEnrichmentEnabled && supportsEnrichment(sourceType) ? <EnrichmentResults t={t} candidates={candidates} busy={busy} onApply={applyCandidate} /> : null}
    </section> : null}
    {step === 3 ? <ContentStep t={t} sourceType={sourceType} origin={origin} file={file} content={content} onContent={setContent} onChooseFile={chooseFile} busy={busy} /> : null}
    {step === 4 && descriptor.success ? <ConfirmationStep t={t} descriptor={descriptor.data} origin={origin} file={file} duplicate={duplicate} policy={duplicatePolicy} onPolicy={setDuplicatePolicy} plan={processingPlan} onPlan={setProcessingPlan} /> : null}
    {validationError ? <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">{validationError}</p> : null}
    <footer className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="min-w-0"><p className="truncate text-sm text-slate-600 dark:text-slate-300">{t(status)}</p></div>
      <div className="flex gap-2">
        {step > 0 ? <Button type="button" disabled={busy} onClick={() => setStep((current) => Math.max(0, current - 1))}><ChevronLeft className="h-4 w-4" />{t("import.actions.back")}</Button> : null}
        {step < 4 ? <Button type="button" disabled={busy} onClick={next}>{step === 1 && origin === "file" ? <FileUp className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{t(step === 1 && origin === "file" ? "import.actions.chooseFile" : "import.actions.continue")}</Button>
          : <Button type="button" disabled={busy} onClick={() => void submit()}><Upload className="h-4 w-4" />{t("import.actions.import")}</Button>}
      </div>
    </footer>
  </section>;
}

function SourceTypeStep({ t, value, search, onSearch, onChoose }: { t: Translator; value: SourceItemType; search: string; onSearch: (value: string) => void; onChoose: (value: SourceItemType) => void }) {
  const needle = search.trim().toLocaleLowerCase();
  const matches = sourceCards.filter(({ type }) => !needle || t(`import.sourceTypes.${type}` as MessageKey).toLocaleLowerCase().includes(needle) || t(`import.sourceDescriptions.${type}` as MessageKey).toLocaleLowerCase().includes(needle));
  return <section className="grid gap-5">
    <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><Input aria-label={t("import.searchTypes")} className="pl-9" value={search} onChange={(event) => onSearch(event.target.value)} placeholder={t("import.searchTypes")} /></div>
    {(["notes", "publications", "media"] as const).map((group) => {
      const cards = matches.filter((card) => card.group === group);
      return cards.length ? <div key={group} className="grid gap-3"><h2 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">{t(`import.groups.${group}` as MessageKey)}</h2><div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{cards.map(({ type, icon: Icon }) => <button key={type} type="button" aria-pressed={value === type} onClick={() => onChoose(type)} className={cn("grid min-h-36 gap-3 rounded-xl border p-4 text-left transition", value === type ? "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-500/15 dark:bg-cyan-950/40" : "border-slate-200 bg-white hover:border-cyan-300 dark:border-slate-800 dark:bg-slate-950")}><div className="flex items-start justify-between"><span className="grid h-9 w-9 place-items-center rounded-lg bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-200"><Icon className="h-4 w-4" /></span>{isContainerType(type) ? <span className="rounded-full bg-violet-100 px-2 py-1 text-[10px] font-bold text-violet-800 dark:bg-violet-950 dark:text-violet-200">{t("import.badges.container")}</span> : compatibleParents[type] ? <span className="rounded-full bg-cyan-100 px-2 py-1 text-[10px] font-bold text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">{t("import.badges.child")}</span> : null}</div><div><h3 className="font-semibold">{t(`import.sourceTypes.${type}` as MessageKey)}</h3><p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">{t(`import.sourceDescriptions.${type}` as MessageKey)}</p></div></button>)}</div></div> : null;
    })}
  </section>;
}

function OriginStep({ t, value, onChange }: { t: Translator; value: ImportOrigin; onChange: (value: ImportOrigin) => void }) {
  return <div className="grid gap-4 md:grid-cols-2">{(["manual", "file"] as const).map((origin) => <button key={origin} type="button" aria-pressed={value === origin} onClick={() => onChange(origin)} className={cn("grid min-h-52 place-items-center gap-3 rounded-2xl border p-7 text-center", value === origin ? "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-500/15 dark:bg-cyan-950/40" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950")}><span className="grid h-14 w-14 place-items-center rounded-2xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">{origin === "manual" ? <StickyNote className="h-6 w-6" /> : <FileUp className="h-6 w-6" />}</span><span><span className="block font-semibold">{t(`import.modes.${origin}` as MessageKey)}</span><span className="mt-2 block text-sm leading-6 text-slate-500">{t(`import.originDescriptions.${origin}` as MessageKey)}</span></span></button>)}</div>;
}

function DescriptorFields({ t, sourceType, values, onChange, onFieldChange }: { t: Translator; sourceType: SourceItemType; values: FormValues; onChange: (values: FormValues) => void; onFieldChange?: (name: string) => void }) {
  const set = (name: string, value: string) => { onChange({ ...values, [name]: value }); onFieldChange?.(name); };
  return <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
    <div className="grid gap-4 md:grid-cols-2"><Field required name="title" t={t} values={values} set={set} /><Field name="subtitle" t={t} values={values} set={set} /></div>
    <div className="grid gap-4 md:grid-cols-2"><Field name="creators" multiline t={t} values={values} set={set} /><LanguageField t={t} value={values.language ?? "und"} onChange={(value) => set("language", value)} /></div>
    <TypeSpecificFields sourceType={sourceType} t={t} values={values} set={set} />
    <div className="grid gap-4 md:grid-cols-2"><Field name="description" multiline t={t} values={values} set={set} /><Field name="tags" t={t} values={values} set={set} /></div>
  </div>;
}

function TypeSpecificFields({ sourceType, t, values, set }: { sourceType: SourceItemType; t: Translator; values: FormValues; set: (name: string, value: string) => void }) {
  const names: string[] = sourceType === "PersonalNote" ? ["context"]
    : sourceType === "DailyNote" ? ["noteDate"]
      : sourceType === "WebArticle" ? ["url", "siteName", "publicationDate", "imageUrl"]
        : sourceType === "Book" ? ["edition", "publisher", "publicationDate", "isbn10", "isbn13", "series", "volume", "pageCount", "subjects"]
          : sourceType === "BookChapter" ? ["chapterNumber", "pageStart", "pageEnd", "publicationDate"]
            : sourceType === "PeriodicalIssue" ? ["publicationTitle", "issn", "volume", "issue", "publicationDate", "publisher", "pageCount"]
              : sourceType === "AcademicPaper" ? ["doi", "venue", "year", "publicationDate", "pageStart", "pageEnd", "abstract", "keywords"]
                : sourceType === "DocumentSection" ? ["sectionNumber", "pageStart", "pageEnd", "publicationDate"]
                  : sourceType === "StandaloneArticle" ? ["doi", "periodicalTitle", "volume", "issue", "publicationDate", "pageStart", "pageEnd"]
                    : sourceType === "Video" ? ["url", "channel", "durationSeconds", "platform", "videoId", "publicationDate", "thumbnailUrl"]
                      : ["creationDate", "mimeType"];
  return <div className="grid gap-4 md:grid-cols-2">{names.map((name) => <Field key={name} name={name} required={(sourceType === "DailyNote" && name === "noteDate") || (sourceType === "PeriodicalIssue" && name === "publicationTitle")} multiline={["abstract"].includes(name)} t={t} values={values} set={set} />)}</div>;
}

function Field({ name, t, values, set, required = false, multiline = false }: { name: string; t: Translator; values: FormValues; set: (name: string, value: string) => void; required?: boolean; multiline?: boolean }) {
  const id = `source-${name}`;
  return <div className="grid gap-2"><Label htmlFor={id}>{t(`import.metadataFields.${name}` as MessageKey)}{required ? " *" : ""}</Label>{multiline ? <textarea id={id} value={values[name] ?? ""} onChange={(event) => set(name, event.target.value)} className="min-h-24 rounded-lg border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950" /> : <Input id={id} value={values[name] ?? ""} onChange={(event) => set(name, event.target.value)} />}</div>;
}

function LanguageField({ t, value, onChange }: { t: Translator; value: string; onChange: (value: string) => void }) {
  const languages = ["und", "en", "pt-BR", "it", "fr", "es", "de", "ja", "zh", "ar"];
  const options = languages.includes(value) ? languages : [value, ...languages];
  return <div className="grid gap-2"><Label htmlFor="source-language">{t("import.metadataFields.language")}</Label><select id="source-language" value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">{options.map((language) => <option key={language} value={language}>{language}</option>)}</select></div>;
}

function ParentPicker({ t, sourceType, values, onChange }: { t: Translator; sourceType: SourceItemType; values: FormValues; onChange: (values: FormValues) => void }) {
  const types = compatibleParents[sourceType] ?? [];
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<SourceSuggestion[]>([]);
  const [creating, setCreating] = useState(false);
  const [parentValues, setParentValues] = useState<FormValues>(() => initialValues(types[0] ?? "Book"));

  useEffect(() => {
    if (query.trim().length < 2) return setSuggestions([]);
    const timer = window.setTimeout(() => void window.app.ingestion.lookupSources(query, types).then(setSuggestions), 250);
    return () => window.clearTimeout(timer);
  }, [query, types.join("|")]);

  async function createParent() {
    const type = types[0];
    if (!type) return;
    const descriptor = buildDescriptor(type, parentValues, null);
    if (!descriptor.success) return;
    const result = await window.app.ingestion.createContainerSource({ descriptor: descriptor.data, duplicatePolicy: "ignore" });
    onChange({ ...values, parentSourceItemId: result.sourceItemId, parentTitle: descriptor.data.title });
    setQuery(descriptor.data.title);
    setCreating(false);
  }

  return <div className="relative grid gap-2 rounded-xl border border-cyan-200 bg-cyan-50/50 p-4 dark:border-cyan-900 dark:bg-cyan-950/20"><Label htmlFor="parent-source">{t("import.parent.label")}</Label><div className="flex gap-2"><Input id="parent-source" value={query || values.parentTitle || ""} onChange={(event) => { setQuery(event.target.value); onChange({ ...values, parentSourceItemId: "", parentTitle: event.target.value }); }} /><Button type="button" onClick={() => setCreating(true)}>{t("import.parent.create")}</Button></div>{suggestions.length ? <div className="absolute left-4 right-4 top-20 z-10 grid rounded-lg border border-slate-200 bg-white p-1 shadow-xl dark:border-slate-700 dark:bg-slate-950">{suggestions.map((suggestion) => <button key={suggestion.id} type="button" className="rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-900" onClick={() => { onChange({ ...values, parentSourceItemId: suggestion.id, parentTitle: suggestion.title }); setQuery(suggestion.title); setSuggestions([]); }}>{suggestion.title}</button>)}</div> : null}{creating ? <div role="dialog" aria-modal="true" aria-label={t("import.parent.createTitle")} className="fixed inset-0 z-50 grid place-items-center bg-slate-950/55 p-5"><div className="grid max-h-[85vh] w-full max-w-3xl gap-4 overflow-auto rounded-2xl bg-white p-5 shadow-2xl dark:bg-slate-950"><header className="flex items-center justify-between"><h2 className="font-semibold">{t("import.parent.createTitle")}</h2><button type="button" aria-label={t("shell.actions.close")} onClick={() => setCreating(false)}><X className="h-5 w-5" aria-hidden="true" /></button></header><DescriptorFields t={t} sourceType={types[0] ?? "Book"} values={parentValues} onChange={setParentValues} /><Button type="button" onClick={() => void createParent()}>{t("import.parent.create")}</Button></div></div> : null}</div>;
}

function EnrichmentResults({ t, candidates, busy, onApply }: { t: Translator; candidates: EnrichmentCandidate[]; busy: boolean; onApply: (candidate: EnrichmentCandidate) => Promise<void> }) {
  return <section className="grid gap-3 rounded-xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-900 dark:bg-violet-950/20"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-700" /><h3 className="font-semibold">{t("import.enrichment.title")}</h3></div>{candidates.length ? <div className="grid gap-2">{candidates.map((candidate) => <div key={`${candidate.provider}-${candidate.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-white p-3 dark:border-violet-900 dark:bg-slate-950"><div className="flex min-w-0 items-center gap-3">{candidate.coverPreviewDataUrl ? <img src={candidate.coverPreviewDataUrl} alt="" className="h-16 w-11 shrink-0 rounded object-cover" /> : <span className="grid h-16 w-11 shrink-0 place-items-center rounded bg-slate-100 text-slate-400 dark:bg-slate-900"><BookOpen className="h-4 w-4" /></span>}<div className="min-w-0"><p className="font-medium">{candidate.title}</p><p className="text-xs text-slate-500">{candidate.creators.map((creator) => creator.name).join(", ")}{candidate.year ? ` · ${candidate.year}` : ""}{candidate.edition ? ` · ${candidate.edition}` : ""} · {candidate.provider}</p></div></div><Button type="button" disabled={busy} onClick={() => void onApply(candidate)}>{t("import.enrichment.apply")}</Button></div>)}</div> : <p className="text-sm text-slate-500">{t("import.enrichment.waiting")}</p>}</section>;
}

function ContentStep({ t, sourceType, origin, file, content, onContent, onChooseFile, busy }: { t: Translator; sourceType: SourceItemType; origin: ImportOrigin; file: FileMetadataExtractionResult | null; content: string; onContent: (value: string) => void; onChooseFile: () => Promise<void>; busy: boolean }) {
  if (origin === "file") return <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-950"><div className="grid justify-items-center gap-3"><FileUp className="h-9 w-9 text-cyan-700" /><h2 className="font-semibold">{file?.fileName ?? t("import.file.title")}</h2><p className="text-sm text-slate-500">{file ? file.mimeType : t("import.file.description")}</p><Button type="button" disabled={busy} onClick={() => void onChooseFile()}>{t(file ? "import.actions.changeFile" : "import.actions.chooseFile")}</Button></div></div>;
  return <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><Label htmlFor="source-content">{t("import.fields.content")}{!isContainerType(sourceType) ? " *" : ""}</Label><textarea id="source-content" value={content} onChange={(event) => onContent(event.target.value)} className="min-h-80 rounded-lg border border-slate-300 bg-white p-3 font-mono text-sm dark:border-slate-700 dark:bg-slate-950" /><p className="text-xs text-slate-500">{t(isContainerType(sourceType) ? "import.content.containerHint" : "import.content.hint")}</p></div>;
}

function ConfirmationStep({ t, descriptor, origin, file, duplicate, policy, onPolicy, plan, onPlan }: { t: Translator; descriptor: SourceDescriptor; origin: ImportOrigin; file: FileMetadataExtractionResult | null; duplicate: DuplicateCandidate | null; policy: DuplicatePolicy; onPolicy: (value: DuplicatePolicy) => void; plan: ProcessingPlanRequest; onPlan: (value: ProcessingPlanRequest) => void }) {
  return <div className="grid gap-5"><div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><h2 className="font-semibold">{descriptor.title}</h2><dl className="grid gap-2 text-sm md:grid-cols-3"><Summary label={t("import.fields.sourceType")} value={t(`import.sourceTypes.${descriptor.type}` as MessageKey)} /><Summary label={t("import.confirmation.origin")} value={t(`import.modes.${origin}` as MessageKey)} /><Summary label={t("import.confirmation.content")} value={file?.fileName ?? t(isContainerType(descriptor.type) ? "import.confirmation.container" : "import.modes.manual")} /></dl></div>{duplicate ? <div className="grid gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"><p className="font-semibold">{t("import.duplicate.found", { values: { title: duplicate.title } })}</p><div className="grid gap-2 md:grid-cols-3">{(["ignore", "update", "version"] as const).map((value) => <label key={value} className={cn("cursor-pointer rounded-lg border p-3", policy === value ? "border-amber-600 bg-white dark:bg-slate-950" : "border-amber-200")}><input type="radio" className="mr-2 accent-amber-600" checked={policy === value} onChange={() => onPolicy(value)} />{t(`import.duplicate.${value}` as MessageKey)}</label>)}</div></div> : <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{t("import.duplicate.none")}</p>}<PlanCard plan={plan} setPlan={onPlan} t={t} /></div>;
}

function Summary({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1">{value}</dd></div>; }

function PlanCard({ plan, setPlan, t }: { plan: ProcessingPlanRequest; setPlan: (plan: ProcessingPlanRequest) => void; t: Translator }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><ProcessingPlanPicker value={plan} onChange={setPlan} t={t} /></div>; }

function WizardSteps({ active, t }: { active: number; t: Translator }) {
  const labels = ["type", "origin", "metadata", "content", "confirm", "structure"] as const;
  return <ol className="grid grid-cols-3 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 md:grid-cols-6">{labels.map((label, index) => <li key={label} className={cn("flex items-center gap-2 px-3 py-3 text-xs", index === active ? "bg-cyan-50 font-semibold text-cyan-900 dark:bg-cyan-950 dark:text-cyan-100" : "text-slate-500")}><span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", index < active ? "bg-emerald-600 text-white" : index === active ? "bg-cyan-700 text-white" : "bg-slate-100 dark:bg-slate-800")}>{index < active ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><span className="truncate">{t(`import.steps.${label}` as MessageKey)}</span></li>)}</ol>;
}

function initialValues(type: SourceItemType): FormValues {
  return { language: "und", ...(type === "DailyNote" ? { noteDate: new Date().toISOString().slice(0, 10) } : {}), ...(type === "PeriodicalIssue" ? { publicationTitle: "" } : {}) };
}

function buildDescriptor(type: SourceItemType, values: FormValues, coverAssetId: string | null, fieldProvenance: Record<string, MetadataFieldProvenance> = {}) {
  const optional = (key: string) => values[key]?.trim() || undefined;
  const number = (key: string) => optional(key) ? Number(optional(key)) : undefined;
  const list = (key: string) => optional(key)?.split(/\n|,/).map((value) => value.trim()).filter(Boolean) ?? [];
  const creators = parseCreators(values.creators ?? "");
  const pages = optional("pageStart") ? { start: optional("pageStart")!, ...(optional("pageEnd") ? { end: optional("pageEnd")! } : {}) } : undefined;
  const provenance = {
    ...Object.fromEntries(Object.entries(values).filter(([, value]) => value?.trim()).map(([key]) => [key, fieldProvenance[key] ?? { source: "manual" as const }])),
    ...(coverAssetId ? { cover: fieldProvenance.cover ?? { source: "manual" as const } } : {})
  };
  const base = { type, title: values.title?.trim() ?? "", language: optional("language") ?? "und", creators, tags: list("tags"), provenance, ...(optional("subtitle") ? { subtitle: optional("subtitle") } : {}), ...(optional("publicationDate") ? { publicationDate: optional("publicationDate") } : {}), ...(optional("description") ? { description: optional("description") } : {}), ...(coverAssetId ? { cover: { assetId: coverAssetId } } : {}) };
  const specific = type === "PersonalNote" ? { context: optional("context") }
    : type === "DailyNote" ? { noteDate: optional("noteDate") }
      : type === "WebArticle" ? { url: optional("url"), siteName: optional("siteName"), imageUrl: optional("imageUrl") }
        : type === "Book" ? { edition: optional("edition"), publisher: optional("publisher"), isbn10: optional("isbn10"), isbn13: optional("isbn13"), series: optional("series"), volume: optional("volume"), pageCount: number("pageCount"), subjects: list("subjects") }
          : type === "BookChapter" ? { parentSourceItemId: optional("parentSourceItemId"), chapterNumber: optional("chapterNumber"), pages }
            : type === "PeriodicalIssue" ? { publicationTitle: optional("publicationTitle"), issn: optional("issn"), volume: optional("volume"), issue: optional("issue"), publisher: optional("publisher"), pageCount: number("pageCount") }
              : type === "AcademicPaper" ? { doi: optional("doi"), venue: optional("venue"), year: number("year"), abstract: optional("abstract"), keywords: list("keywords"), pages }
                : type === "DocumentSection" ? { parentSourceItemId: optional("parentSourceItemId"), sectionNumber: optional("sectionNumber"), pages }
                  : type === "StandaloneArticle" ? { parentSourceItemId: optional("parentSourceItemId"), doi: optional("doi"), periodicalTitle: optional("periodicalTitle"), volume: optional("volume"), issue: optional("issue"), pages }
                    : type === "Video" ? { url: optional("url"), channel: optional("channel"), durationSeconds: number("durationSeconds"), platform: optional("platform"), videoId: optional("videoId"), thumbnailUrl: optional("thumbnailUrl") }
                      : { creationDate: optional("creationDate"), mimeType: optional("mimeType") };
  return SourceDescriptorSchema.safeParse(removeUndefined({ ...base, ...specific }));
}

function draftToValues(values: Record<string, unknown>): FormValues {
  return Object.fromEntries(Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined || value === null || key === "cover") return [];
    if (key === "creators" && Array.isArray(value)) return [[key, value.map((item) => {
      if (!isRecord(item) || typeof item.name !== "string") return "";
      const role = typeof item.role === "string" ? item.role : "author";
      return `${role}: ${item.name}${typeof item.affiliation === "string" ? ` | ${item.affiliation}` : ""}`;
    }).filter(Boolean).join("\n")]];
    if (Array.isArray(value)) return [[key, value.join(", ")]];
    if (key === "pages" && isRecord(value)) return [["pageStart", String(value.start ?? "")], ["pageEnd", String(value.end ?? "")]];
    return [[key, String(value)]];
  }));
}

function expandProvenance(provenance: Record<string, MetadataFieldProvenance>): Record<string, MetadataFieldProvenance> {
  return {
    ...provenance,
    ...(provenance.pages ? { pageStart: provenance.pages, pageEnd: provenance.pages } : {})
  };
}

function parseCreators(value: string): Creator[] {
  const roles = new Set<Creator["role"]>(["author", "editor", "translator", "organizer", "channel", "host", "contributor"]);
  return value.split(/\n/).flatMap((line) => {
    const trimmed = line.trim();
    if (!trimmed) return [];
    const roleMatch = trimmed.match(/^([a-z]+):\s*(.+)$/i);
    const possibleRole = roleMatch?.[1]?.toLowerCase() as Creator["role"] | undefined;
    const role = possibleRole && roles.has(possibleRole) ? possibleRole : "author";
    const body = roleMatch && possibleRole && roles.has(possibleRole) ? roleMatch[2]! : trimmed;
    const [name, affiliation] = body.split("|", 2).map((part) => part.trim());
    return name ? [{ name, role, ...(affiliation ? { affiliation } : {}) }] : [];
  });
}

function removeUndefined(input: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isContainerType(type: SourceItemType): type is "Book" | "PeriodicalIssue" | "AcademicPaper" { return type === "Book" || type === "PeriodicalIssue" || type === "AcademicPaper"; }
function supportsEnrichment(type: SourceItemType) { return ["Book", "BookChapter", "AcademicPaper", "StandaloneArticle"].includes(type); }
function errorMessageKey(error: unknown): MessageKey { return error instanceof Error && error.message.startsWith("errors.") ? error.message as MessageKey : "errors.common.unknown"; }
