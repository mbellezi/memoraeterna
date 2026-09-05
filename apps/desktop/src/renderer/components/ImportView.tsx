import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  BookOpen, Check, ChevronLeft, ChevronRight, FileText, FileUp, Film, Globe2,
  Clock3, LibraryBig, LoaderCircle, NotebookPen, Search, Sparkles, StickyNote,
  Upload, X
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
  FileImportProgress, FileMetadataExtractionResult, SourceSuggestion, SourceDetail
} from "../../shared/ipc";
import { cn } from "../lib/cn";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";
import { StructureReview } from "./StructureReview";
import {
  compileManualSubitems, createManualSubitem, ManualContentComposer,
  validateManualSubitems, type ManualContentMode, type ManualSubitemDraft
} from "./ManualContentComposer";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { CoverImage } from "./ui/cover-image";
import { coverAssetIdFromMetadata } from "../lib/cover-cache";

type ImportOrigin = "manual" | "file";
type FormValues = Record<string, string>;
type WizardStepName = "type" | "metadata" | "content" | "confirm" | "structure";

const wizardStepDefinitions = [
  { name: "type", step: 0 },
  { name: "metadata", step: 2 },
  { name: "content", step: 3 },
  { name: "confirm", step: 4 },
  { name: "structure", step: 5 }
] as const satisfies ReadonlyArray<{ name: WizardStepName; step: number }>;

export function wizardStepAvailability({
  busy,
  canChooseType,
  metadataReady,
  descriptorReady,
  contentReady,
  structureReady = false
}: {
  busy: boolean;
  canChooseType: boolean;
  metadataReady: boolean;
  descriptorReady: boolean;
  contentReady: boolean;
  structureReady?: boolean;
}): Record<WizardStepName, boolean> {
  if (busy) return { type: false, metadata: false, content: false, confirm: false, structure: false };
  return {
    type: canChooseType,
    metadata: metadataReady,
    content: descriptorReady,
    confirm: descriptorReady && contentReady,
    structure: structureReady
  };
}

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

const fileProgressStageKeys = {
  selecting_file: "import.progress.stages.selectingFile",
  inspecting_file: "import.progress.stages.inspectingFile",
  loading_engine: "import.progress.stages.loadingEngine",
  converting_document: "import.progress.stages.convertingDocument",
  processing_pages: "import.progress.stages.processingPages",
  serializing: "import.progress.stages.serializing",
  extracting_metadata: "import.progress.stages.extractingMetadata",
  storing_cover: "import.progress.stages.storingCover",
  completed: "import.progress.stages.completed"
} satisfies Record<FileImportProgress["stage"], MessageKey>;

export function ImportView({ t, metadataEnrichmentEnabled = true, editing, parent, onSaved, onCancel }: {
  t: Translator; metadataEnrichmentEnabled?: boolean; editing?: SourceDetail;
  parent?: { id: string; title: string; type: SourceItemType; language: string; metadata?: Record<string, unknown> };
  onSaved?: (sourceItemId: string) => void; onCancel?: () => void;
}) {
  const initialType = editing?.type ?? (parent ? childSourceType(parent.type) : null) ?? "PersonalNote";
  const initialDescriptor = editing && isRecord(editing.metadata.descriptor) ? editing.metadata.descriptor : {};
  const originalContent = editing?.documents[0]?.canonicalMarkdown ?? "";
  const formDefaults = () => editing ? { ...initialValues(initialType), ...draftToValues(initialDescriptor), title: editing.title,
    language: editing.language, ...(editing.parentSourceItemId ? { parentSourceItemId: editing.parentSourceItemId } : {}) }
    : { ...initialValues(initialType), ...(parent ? { parentSourceItemId: parent.id, parentTitle: parent.title, language: parent.language, ...inheritedParentValues(parent.metadata) } : {}) };
  const [step, setStep] = useState(editing || parent ? 2 : 0);
  const [sourceType, setSourceType] = useState<SourceItemType>(initialType);
  const [sourceSearch, setSourceSearch] = useState("");
  const [origin, setOrigin] = useState<ImportOrigin>("manual");
  const [values, setValues] = useState<FormValues>(formDefaults);
  const [fieldProvenance, setFieldProvenance] = useState<Record<string, MetadataFieldProvenance>>(() => expandProvenance((initialDescriptor.provenance ?? {}) as Record<string, MetadataFieldProvenance>));
  const [content, setContent] = useState(originalContent);
  const [contentMode, setContentMode] = useState<ManualContentMode>(editing ? "document" : isContainerType(initialType) ? "subitems" : "document");
  const [manualSubitems, setManualSubitems] = useState<ManualSubitemDraft[]>(() => [createManualSubitem()]);
  const [file, setFile] = useState<FileMetadataExtractionResult | null>(null);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(editing ? coverAssetIdFromMetadata(editing.metadata) : null);
  const [processingPlan, setProcessingPlan] = useState<ProcessingPlanRequest>(() => defaultProcessingPlan("import_only"));
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("ignore");
  const [duplicate, setDuplicate] = useState<DuplicateCandidate | null>(null);
  const [enrichmentState, setEnrichmentState] = useState<"idle" | "loading" | "empty" | "error" | "success">("idle");
  const [candidates, setCandidates] = useState<EnrichmentCandidate[]>([]);
  const [structure, setStructure] = useState<DocumentStructureView | null>(null);
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [validationError, setValidationError] = useState("");
  const [busy, setBusy] = useState(false);
  const [fileProgress, setFileProgress] = useState<FileImportProgress | null>(null);
  const [progressStartedAt, setProgressStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const descriptor = useMemo(() => buildDescriptor(sourceType, values, coverAssetId, fieldProvenance), [coverAssetId, fieldProvenance, sourceType, values]);
  const effectiveContent = useMemo(() => contentMode === "subitems" && isContainerType(sourceType)
    ? compileManualSubitems(manualSubitems)
    : content, [content, contentMode, manualSubitems, sourceType]);
  const contentReady = origin === "file"
    ? Boolean(file)
    : contentMode === "subitems"
      ? validateManualSubitems(manualSubitems)
      : isContainerType(sourceType) || Boolean(effectiveContent.trim());
  const availableWizardSteps = wizardStepAvailability({
    busy,
    canChooseType: !editing && !parent,
    metadataReady: origin === "manual" || Boolean(file),
    descriptorReady: descriptor.success,
    contentReady
  });

  useEffect(() => {
    if (step !== 2 || !metadataEnrichmentEnabled || !supportsEnrichment(sourceType)) {
      setCandidates([]);
      return;
    }
    const isbn = values.isbn13 || values.isbn10;
    const doi = values.doi;
    const title = values.title?.trim();
    setCandidates([]);
    if (!isbn && !doi && (!title || title.length < 2)) { setEnrichmentState("idle"); return; }
    let active = true;
    setEnrichmentState("loading");
    const timer = window.setTimeout(() => {
      void window.app.ingestion.enrichMetadata({
        sourceType,
        ...(isbn ? { isbn } : {}),
        ...(doi ? { doi } : {}),
        ...(title ? { title } : {}),
        ...(parseCreators(values.creators ?? "")[0]?.name ? { author: parseCreators(values.creators ?? "")[0]!.name } : {})
      }).then((results) => { if (active) { setCandidates(results); setEnrichmentState(results.length ? "success" : "empty"); } })
        .catch(() => { if (active) setEnrichmentState("error"); });
    }, 900);
    return () => { active = false; window.clearTimeout(timer); };
  }, [metadataEnrichmentEnabled, sourceType, step, values.creators, values.doi, values.isbn10, values.isbn13, values.title]);

  useEffect(() => {
    if (editing || step !== 4 || !descriptor.success) {
      setDuplicate(null);
      return;
    }
    let active = true;
    void window.app.ingestion.findDuplicate({
      descriptor: descriptor.data,
      ...(origin === "file" && file ? { fileToken: file.fileToken } : { content: effectiveContent })
    }).then((result) => { if (active) setDuplicate(result); }).catch(() => { if (active) setDuplicate(null); });
    return () => { active = false; };
  }, [descriptor, effectiveContent, file, origin, step]);

  useEffect(() => {
    if (!busy || progressStartedAt === null) return;
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - progressStartedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [busy, progressStartedAt]);

  function chooseType(type: SourceItemType) {
    setSourceType(type);
    setValues(initialValues(type));
    setFieldProvenance({});
    setContent("");
    setContentMode(isContainerType(type) ? "subitems" : "document");
    setManualSubitems([createManualSubitem()]);
    setFile(null);
    setCoverAssetId(null);
    setValidationError("");
    setFileProgress(null);
  }

  async function previewUrl() {
    if (sourceType !== "WebArticle" && sourceType !== "Video") return;
    setValidationError("");
    setBusy(true);
    try {
      const preview = await window.app.ingestion.previewUrl({ type: sourceType, url: values.url ?? "" });
      setValues((current) => ({ ...current, ...Object.fromEntries(Object.entries(draftToValues(preview.draft.values))
        .filter(([key]) => !current[key]?.trim() || fieldProvenance[key]?.source !== "manual")) }));
      setFieldProvenance((current) => ({ ...expandProvenance(preview.draft.provenance), ...current }));
      if (!content.trim()) setContent(preview.markdown);
      setStatus("import.status.metadataExtracted");
    } catch (error) {
      const key = errorMessageKey(error);
      setStatus(key);
      setValidationError(t(key));
    } finally { setBusy(false); }
  }

  async function chooseFile() {
    const requestId = window.crypto.randomUUID();
    setFileProgress({ requestId, stage: "selecting_file", progress: 0.01 });
    setProgressStartedAt(Date.now());
    setElapsedSeconds(0);
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      const extracted = await window.app.ingestion.extractFileMetadata(
        { sourceType, requestId },
        setFileProgress
      );
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
      setFileProgress(null);
      setProgressStartedAt(null);
    }
  }

  async function applyCandidate(candidate: EnrichmentCandidate) {
    setBusy(true);
    try {
      const incoming = draftToValues(candidate.values);
      setValues((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(incoming).filter(([key]) => key === "title" || fieldProvenance[key]?.source !== "manual"))
      }));
      setFieldProvenance((current) => ({
        ...current,
        ...Object.fromEntries(Object.entries(expandProvenance(candidate.provenance)).filter(([key]) => key === "title" || current[key]?.source !== "manual"))
      }));
      if (candidate.coverUrl) {
        const cover = await window.app.ingestion.applyEnrichmentCover(candidate.coverUrl);
        setCoverAssetId(cover.assetId);
        setFieldProvenance((current) => ({ ...current, cover: { source: "enriched", provider: candidate.provider } }));
      }
      setCandidates([]);
      setStatus("import.status.metadataExtracted");
    } catch {
      setStatus("errors.common.unknown");
    } finally {
      setBusy(false);
    }
  }

  function next() {
    setValidationError("");
    if (step === 0) { if (origin === "file") void chooseFile(); else setStep(2); return; }
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
      if (origin === "manual" && contentMode === "subitems" && !validateManualSubitems(manualSubitems)) {
        setValidationError(t("import.validation.subitemsIncomplete"));
        return;
      }
      if (origin === "manual" && !isContainerType(sourceType) && !effectiveContent.trim()) {
        setValidationError(t("import.validation.contentRequired"));
        return;
      }
      setStep(4);
    }
  }

  function navigateToWizardStep(target: number) {
    const targetDefinition = wizardStepDefinitions.find(({ step: targetStep }) => targetStep === target);
    if (!targetDefinition || !availableWizardSteps[targetDefinition.name]) return;
    setValidationError("");
    setStep(target);
  }

  async function submit() {
    if (!descriptor.success) return;
    setBusy(true);
    setStatus("shell.states.loading");
    try {
      if (editing) {
        const result = await window.app.ingestion.editSource({
          sourceItemId: editing.id, expectedUpdatedAt: editing.updatedAt, descriptor: preserveDescriptorDetails(descriptor.data, initialDescriptor, values),
          ...(effectiveContent !== originalContent ? { content: { documentId: editing.documents[0]?.id ?? null, markdown: effectiveContent } } : {})
        });
        onSaved?.(result.sourceItemId);
        return;
      }
      const result = origin === "file" && file
        ? await window.app.ingestion.importFile({
            fileToken: file.fileToken, descriptor: descriptor.data, duplicatePolicy, processingPlan
          })
        : isContainerType(sourceType) && !effectiveContent.trim()
          ? await window.app.ingestion.createContainerSource({ descriptor: descriptor.data, duplicatePolicy })
          : await window.app.ingestion.createManual({
              descriptor: descriptor.data, content: effectiveContent, duplicatePolicy, processingPlan
            });
      if (!result) {
        setStatus("import.status.canceled");
      } else if (result.requiresStructureReview && result.structureId) {
        setStructure(await window.app.ingestion.getStructure(result.structureId));
        setStatus("import.status.reviewStructure");
      } else {
        setStatus(result.duplicate ? "import.status.duplicateHandled" : result.jobId ? "import.status.queued" : "import.status.saved");
        if (onSaved) onSaved(result.sourceItemId); else resetWizard();
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
    setContentMode(isContainerType(sourceType) ? "subitems" : "document");
    setManualSubitems([createManualSubitem()]);
    setFile(null);
    setCoverAssetId(null);
    setDuplicate(null);
    setCandidates([]);
    setFileProgress(null);
    setProgressStartedAt(null);
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
    {parent ? <header><p className="text-sm text-slate-500">{parent.title}</p><h2 className="mt-1 text-xl font-semibold">{t("sourceWorkspace.addChild")} · {t(`import.sourceTypes.${sourceType}` as MessageKey)}</h2></header> : null}
    <WizardSteps active={step} available={availableWizardSteps} onNavigate={navigateToWizardStep} t={t} />
    {busy && fileProgress ? <FileImportProgressCard progress={fileProgress} elapsedSeconds={elapsedSeconds} t={t} /> : null}
    {step === 0 ? <><OriginStep t={t} value={origin} onChange={setOrigin} /><SourceTypeStep t={t} value={sourceType} search={sourceSearch} onSearch={setSourceSearch} onChoose={chooseType} /></> : null}
    {step === 1 ? <OriginStep t={t} value={origin} onChange={setOrigin} /> : null}
    {step === 2 ? <section className="grid gap-5">
      {editing ? <p className="rounded-xl bg-cyan-50 p-4 text-sm text-cyan-900 dark:bg-cyan-950 dark:text-cyan-100">{t("sourceWorkspace.editHint")}</p> : null}
      {coverAssetId ? <div className="h-36 w-24 overflow-hidden rounded-lg"><CoverImage assetId={coverAssetId} alt={values.title ?? ""} fallback={<BookOpen />} /></div> : null}
      {metadataEnrichmentEnabled && (sourceType === "WebArticle" || sourceType === "Video") ? <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"><Input className="min-w-0" aria-label={t("import.metadataFields.url")} placeholder={t("import.metadataFields.url")} value={values.url ?? ""} onChange={(event) => { setValues({ ...values, url: event.target.value }); setFieldProvenance({ ...fieldProvenance, url: { source: "manual" } }); }} /><Button className="whitespace-nowrap sm:min-w-max" type="button" disabled={busy || !values.url} onClick={() => void previewUrl()}>{t("sourceWorkspace.fetchUrl")}</Button></div> : null}
      <DescriptorFields t={t} sourceType={sourceType} suggestions={metadataEnrichmentEnabled && supportsEnrichment(sourceType) ? <EnrichmentResults t={t} candidates={candidates} busy={busy} state={enrichmentState} onApply={applyCandidate} /> : null} values={values} onChange={setValues} onFieldChange={(name) => setFieldProvenance((current) => ({ ...current, [name]: { source: "manual" } }))} />
      {!editing && !parent && compatibleParents[sourceType] ? <ParentPicker t={t} sourceType={sourceType} values={values} onChange={setValues} /> : null}
      {parent ? <p className="text-sm text-slate-500">{t("import.parent.label")}: {parent.title}</p> : null}
    </section> : null}
    {step === 3 ? <ContentStep t={t} sourceType={sourceType} origin={origin} file={file} content={content} onContent={setContent} onChooseFile={chooseFile} busy={busy} mode={contentMode} onMode={setContentMode} subitems={manualSubitems} onSubitems={setManualSubitems} editing={Boolean(editing)} /> : null}
    {step === 4 && editing ? <div className="rounded-xl border border-slate-200 p-5 dark:border-slate-800"><h2 className="font-semibold">{values.title}</h2><p className="mt-2 text-sm text-slate-500">{t("sourceWorkspace.editHint")}</p></div> : step === 4 && descriptor.success ? <ConfirmationStep t={t} descriptor={descriptor.data} origin={origin} file={file} duplicate={duplicate} policy={duplicatePolicy} onPolicy={setDuplicatePolicy} plan={processingPlan} onPlan={setProcessingPlan} /> : null}
    {validationError ? <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">{validationError}</p> : null}
    <footer className="sticky bottom-4 flex items-center justify-between gap-4 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-lg backdrop-blur dark:border-slate-800 dark:bg-slate-950/95">
      <div className="min-w-0"><p className="truncate text-sm text-slate-600 dark:text-slate-300">{t(status)}</p></div>
      <div className="flex gap-2">
        {onCancel ? <Button type="button" disabled={busy} onClick={onCancel}>{t("shell.actions.cancel")}</Button> : null}
        {step > (editing || parent ? 2 : 0) ? <Button type="button" disabled={busy} onClick={() => setStep((current) => current === 2 ? 0 : Math.max(0, current - 1))}><ChevronLeft className="h-4 w-4" />{t("import.actions.back")}</Button> : null}
        {step < 4 ? <Button type="button" disabled={busy} onClick={next}>{step === 1 && origin === "file" ? <FileUp className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{t(step === 1 && origin === "file" ? "import.actions.chooseFile" : "import.actions.continue")}</Button>
          : <Button type="button" disabled={busy} onClick={() => void submit()}><Upload className="h-4 w-4" />{t(editing ? "sourceWorkspace.save" : "import.actions.import")}</Button>}
      </div>
    </footer>
  </section>;
}

export function FileImportProgressCard({
  progress,
  elapsedSeconds,
  t
}: {
  progress: FileImportProgress;
  elapsedSeconds: number;
  t: Translator;
}) {
  const percent = Math.round(progress.progress * 100);
  const pageStatus = progress.totalPages !== undefined
    ? progress.completedPages !== undefined
      ? t("import.progress.pagesProcessed", {
          values: { completed: progress.completedPages, total: progress.totalPages }
        })
      : t("import.progress.pagesFound", { values: { total: progress.totalPages } })
    : null;
  const complete = progress.stage === "completed";
  return <section
    aria-label={t("import.progress.title")}
    aria-live="polite"
    className="relative overflow-hidden rounded-2xl border border-cyan-300 bg-gradient-to-br from-cyan-50 via-white to-violet-50 p-5 shadow-sm dark:border-cyan-900 dark:from-cyan-950/40 dark:via-slate-950 dark:to-violet-950/30"
  >
    <div className="absolute inset-x-0 top-0 h-1 animate-pulse bg-gradient-to-r from-cyan-500 via-violet-500 to-cyan-500" />
    <div className="flex items-start justify-between gap-4">
      <div className="flex min-w-0 items-center gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">
          {complete ? <Check className="h-5 w-5" aria-hidden="true" /> : <LoaderCircle className="h-5 w-5 animate-spin" aria-hidden="true" />}
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-slate-950 dark:text-white">{t("import.progress.title")}</h2>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{t(fileProgressStageKeys[progress.stage])}</p>
        </div>
      </div>
      <span className="shrink-0 font-mono text-lg font-bold tabular-nums text-cyan-800 dark:text-cyan-200">
        {t("import.progress.percent", { values: { percent } })}
      </span>
    </div>
    <div
      role="progressbar"
      aria-label={t(fileProgressStageKeys[progress.stage])}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className="relative mt-5 h-3 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800"
    >
      <div
        className="relative h-full min-w-1 overflow-hidden rounded-full bg-gradient-to-r from-cyan-600 via-sky-500 to-violet-500 transition-[width] duration-500 ease-out"
        style={{ width: `${percent}%` }}
      >
        {!complete ? <span className="absolute inset-0 animate-pulse bg-gradient-to-r from-transparent via-white/45 to-transparent" /> : null}
      </div>
    </div>
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 dark:text-slate-300">
      <span>{pageStatus ?? t("import.progress.keepOpen")}</span>
      <span className="flex items-center gap-1.5 font-medium tabular-nums">
        <Clock3 className="h-3.5 w-3.5" aria-hidden="true" />
        {t("import.progress.elapsed", { values: { time: formatElapsedTime(elapsedSeconds) } })}
      </span>
    </div>
    {pageStatus ? <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">{t("import.progress.keepOpen")}</p> : null}
  </section>;
}

function formatElapsedTime(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.max(0, totalSeconds % 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
  return <div className="grid gap-4 md:grid-cols-2">{(["manual", "file"] as const).map((origin) => <button key={origin} type="button" aria-pressed={value === origin} onClick={() => onChange(origin)} className={cn("flex items-center gap-4 rounded-xl border p-4 text-left", value === origin ? "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-500/15 dark:bg-cyan-950/40" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950")}><span className="grid h-14 w-14 place-items-center rounded-2xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">{origin === "manual" ? <StickyNote className="h-6 w-6" /> : <FileUp className="h-6 w-6" />}</span><span><span className="block font-semibold">{t(`import.modes.${origin}` as MessageKey)}</span><span className="mt-2 block text-sm leading-6 text-slate-500">{t(`import.originDescriptions.${origin}` as MessageKey)}</span></span></button>)}</div>;
}

function DescriptorFields({ t, sourceType, values, onChange, onFieldChange, suggestions }: { t: Translator; sourceType: SourceItemType; values: FormValues; onChange: (values: FormValues) => void; onFieldChange?: (name: string) => void; suggestions?: ReactNode }) {
  const set = (name: string, value: string) => { onChange({ ...values, [name]: value }); onFieldChange?.(name); };
  return <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950">
    <Field required name="title" t={t} values={values} set={set} />
    {suggestions}
    <div className="grid gap-4 md:grid-cols-2"><Field name="creators" multiline t={t} values={values} set={set} /><LanguageField t={t} value={values.language ?? "und"} onChange={(value) => set("language", value)} /></div>
    {sourceType === "DailyNote" ? <Field required name="noteDate" t={t} values={values} set={set} /> : null}
    {sourceType === "PeriodicalIssue" ? <Field required name="publicationTitle" t={t} values={values} set={set} /> : null}
    <details className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-semibold">{t("sourceWorkspace.moreMetadata")}</summary><div className="mt-4 grid gap-4"><Field name="subtitle" t={t} values={values} set={set} /><TypeSpecificFields sourceType={sourceType} t={t} values={values} set={set} /></div></details>
    <details className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-semibold">{t("import.metadataFields.description")} · {t("import.metadataFields.tags")}</summary><div className="mt-4 grid gap-4 md:grid-cols-2"><Field name="description" multiline t={t} values={values} set={set} /><Field name="tags" t={t} values={values} set={set} /></div></details>
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
  return <div className="grid gap-4 md:grid-cols-2">{names.filter((name) => !["noteDate", "publicationTitle"].includes(name)).map((name) => <Field key={name} name={name} required={(sourceType === "DailyNote" && name === "noteDate") || (sourceType === "PeriodicalIssue" && name === "publicationTitle")} multiline={["abstract"].includes(name)} t={t} values={values} set={set} />)}</div>;
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
    if (query.trim().length < 2 || values.parentSourceItemId) return setSuggestions([]);
    let active = true;
    const timer = window.setTimeout(() => void window.app.ingestion.lookupSources(query, types)
      .then((results) => { if (active) setSuggestions(results); }).catch(() => { if (active) setSuggestions([]); }), 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, types.join("|"), values.parentSourceItemId]);

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

function EnrichmentResults({ t, candidates, busy, state, onApply }: { t: Translator; candidates: EnrichmentCandidate[]; busy: boolean; state: "idle" | "loading" | "empty" | "error" | "success"; onApply: (candidate: EnrichmentCandidate) => Promise<void> }) {
  return <section className="grid gap-3 rounded-xl border border-violet-200 bg-violet-50/50 p-4 dark:border-violet-900 dark:bg-violet-950/20"><div className="flex items-center gap-2"><Sparkles className="h-4 w-4 text-violet-700" /><h3 className="font-semibold">{t("import.enrichment.title")}</h3></div>{candidates.length ? <div className="grid gap-2">{candidates.map((candidate) => <div key={`${candidate.provider}-${candidate.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-violet-200 bg-white p-3 dark:border-violet-900 dark:bg-slate-950"><div className="flex min-w-0 items-center gap-3">{candidate.coverPreviewDataUrl ? <img src={candidate.coverPreviewDataUrl} alt="" className="h-16 w-11 shrink-0 rounded object-cover" /> : <span className="grid h-16 w-11 shrink-0 place-items-center rounded bg-slate-100 text-slate-400 dark:bg-slate-900"><BookOpen className="h-4 w-4" /></span>}<div className="min-w-0"><p className="font-medium">{candidate.title}</p><p className="text-xs text-slate-500">{candidate.creators.map((creator) => creator.name).join(", ")}{candidate.year ? ` · ${candidate.year}` : ""}{candidate.edition ? ` · ${candidate.edition}` : ""} · {candidate.provider}</p></div></div><Button type="button" disabled={busy} onClick={() => void onApply(candidate)}>{t("import.enrichment.apply")}</Button></div>)}</div> : <p className="text-sm text-slate-500">{t(state === "idle" ? "import.enrichment.waiting" : state === "loading" ? "shell.states.loading" : state === "error" ? "sourceWorkspace.enrichmentError" : "sourceWorkspace.enrichmentEmpty")}</p>}</section>;
}

function ContentStep({ t, sourceType, origin, file, content, onContent, onChooseFile, busy, mode, onMode, subitems, onSubitems, editing }: { t: Translator; sourceType: SourceItemType; origin: ImportOrigin; file: FileMetadataExtractionResult | null; content: string; onContent: (value: string) => void; onChooseFile: () => Promise<void>; busy: boolean; mode: ManualContentMode; onMode: (mode: ManualContentMode) => void; subitems: ManualSubitemDraft[]; onSubitems: (items: ManualSubitemDraft[]) => void; editing: boolean }) {
  if (origin === "file") return <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center dark:border-slate-700 dark:bg-slate-950"><div className="grid justify-items-center gap-3"><FileUp className="h-9 w-9 text-cyan-700" /><h2 className="font-semibold">{file?.fileName ?? t("import.file.title")}</h2><p className="text-sm text-slate-500">{file ? file.mimeType : t("import.file.description")}</p><Button type="button" disabled={busy} onClick={() => void onChooseFile()}>{t(file ? "import.actions.changeFile" : "import.actions.chooseFile")}</Button></div></div>;
  return <ManualContentComposer t={t} sourceType={sourceType} content={content} onContent={onContent} mode={mode} onMode={onMode} subitems={subitems} onSubitems={onSubitems} editing={editing} />;
}

function ConfirmationStep({ t, descriptor, origin, file, duplicate, policy, onPolicy, plan, onPlan }: { t: Translator; descriptor: SourceDescriptor; origin: ImportOrigin; file: FileMetadataExtractionResult | null; duplicate: DuplicateCandidate | null; policy: DuplicatePolicy; onPolicy: (value: DuplicatePolicy) => void; plan: ProcessingPlanRequest; onPlan: (value: ProcessingPlanRequest) => void }) {
  return <div className="grid gap-5"><div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><h2 className="font-semibold">{descriptor.title}</h2><dl className="grid gap-2 text-sm md:grid-cols-3"><Summary label={t("import.fields.sourceType")} value={t(`import.sourceTypes.${descriptor.type}` as MessageKey)} /><Summary label={t("import.confirmation.origin")} value={t(`import.modes.${origin}` as MessageKey)} /><Summary label={t("import.confirmation.content")} value={file?.fileName ?? t(isContainerType(descriptor.type) ? "import.confirmation.container" : "import.modes.manual")} /></dl></div>{duplicate ? <div className="grid gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950/30"><p className="font-semibold">{t("import.duplicate.found", { values: { title: duplicate.title } })}</p><div className="grid gap-2 md:grid-cols-3">{(["ignore", "update", "version"] as const).map((value) => <label key={value} className={cn("cursor-pointer rounded-lg border p-3", policy === value ? "border-amber-600 bg-white dark:bg-slate-950" : "border-amber-200")}><input type="radio" className="mr-2 accent-amber-600" checked={policy === value} onChange={() => onPolicy(value)} />{t(`import.duplicate.${value}` as MessageKey)}</label>)}</div></div> : <p className="rounded-lg bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">{t("import.duplicate.none")}</p>}<PlanCard plan={plan} setPlan={onPlan} t={t} /></div>;
}

function Summary({ label, value }: { label: string; value: string }) { return <div><dt className="text-xs font-semibold text-slate-500">{label}</dt><dd className="mt-1">{value}</dd></div>; }

function PlanCard({ plan, setPlan, t }: { plan: ProcessingPlanRequest; setPlan: (plan: ProcessingPlanRequest) => void; t: Translator }) { return <div className="rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-950"><ProcessingPlanPicker value={plan} onChange={setPlan} t={t} /></div>; }

function WizardSteps({ active, available, onNavigate, t }: { active: number; available?: Record<WizardStepName, boolean>; onNavigate?: (step: number) => void; t: Translator }) {
  const activeIndex = active > 0 ? active - 1 : 0;
  return <ol className="grid grid-cols-3 overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950 md:grid-cols-5">{wizardStepDefinitions.map(({ name, step }, index) => {
    const enabled = Boolean(onNavigate && available?.[name]);
    return <li key={name} className={cn(index === activeIndex ? "bg-cyan-50 font-semibold text-cyan-900 dark:bg-cyan-950 dark:text-cyan-100" : "text-slate-500")}><button type="button" disabled={!enabled} aria-current={index === activeIndex ? "step" : undefined} onClick={() => onNavigate?.(step)} className={cn("flex w-full items-center gap-2 px-3 py-3 text-left text-xs transition", enabled ? "cursor-pointer hover:bg-cyan-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-600 dark:hover:bg-cyan-950/60" : "cursor-not-allowed opacity-60")}><span className={cn("grid h-6 w-6 shrink-0 place-items-center rounded-full", index < activeIndex ? "bg-emerald-600 text-white" : index === activeIndex ? "bg-cyan-700 text-white" : "bg-slate-100 dark:bg-slate-800")}>{index < activeIndex ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><span className="truncate">{t(`import.steps.${name}` as MessageKey)}</span></button></li>;
  })}</ol>;
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
function supportsEnrichment(type: SourceItemType) { return ["Book", "AcademicPaper", "StandaloneArticle"].includes(type); }
function errorMessageKey(error: unknown): MessageKey { return error instanceof Error && (error.message.startsWith("errors.") || error.message.startsWith("sourceWorkspace.")) ? error.message as MessageKey : "errors.common.unknown"; }

export function childSourceType(type: SourceItemType): SourceItemType | null {
  return type === "Book" ? "BookChapter" : type === "AcademicPaper" ? "DocumentSection" : type === "PeriodicalIssue" ? "StandaloneArticle" : null;
}

// Preserve structured creator identifiers that the text editor does not expose.
export function preserveDescriptorDetails(descriptor: SourceDescriptor, original: Record<string, unknown>, values: FormValues): SourceDescriptor {
  const previousValues = draftToValues(original);
  return SourceDescriptorSchema.parse({ ...descriptor,
    ...(values.creators === previousValues.creators && original.creators ? { creators: original.creators } : {})
  });
}

function inheritedParentValues(metadata?: Record<string, unknown>): FormValues {
  const descriptor = metadata?.descriptor;
  if (!isRecord(descriptor)) return {};
  return draftToValues({ creators: Array.isArray(descriptor.creators) ? descriptor.creators.filter((creator) => isRecord(creator) && creator.role === "author") : [], publicationDate: descriptor.publicationDate });
}
