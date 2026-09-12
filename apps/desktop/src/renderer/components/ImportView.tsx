import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  BookOpen, Check, ChevronLeft, ChevronRight, FileText, FileUp, Film, Globe2,
  Clock3, LibraryBig, LoaderCircle, NotebookPen, Search, Sparkles, StickyNote,
  Upload, X
} from "lucide-react";
import { getLanguageDisplayName, type MessageKey, type Translator } from "@app/i18n";
import {
  SourceDescriptorSchema,
  validateDivisionTree,
  type DocumentDivisionCandidate,
  SourceItemTypes,
  type ProcessingPlanRequest,
  type MetadataFieldProvenance,
  type Creator,
  type SourceDescriptor,
  type SourceItemType
} from "@app/domain";

import type {
  DocumentStructureView, DuplicateCandidate, DuplicatePolicy, EnrichmentCandidate,
  FileImportProgress, FileMetadataExtractionResult, FileStructurePreview, SourceSuggestion, SourceDetail
} from "../../shared/ipc";
import { cn } from "../lib/cn";
import { defaultProcessingPlan, ProcessingPlanPicker } from "./ProcessingPlanPicker";
import { StructureReview } from "./StructureReview";
import { SourceMetadataPreview } from "./SourceMetadataPreview";
import { CreatorFields } from "./CreatorFields";
import {
  compileManualSubitems, createManualSubitem, ManualContentComposer,
  validateManualSubitems, type ManualContentMode, type ManualSubitemDraft
} from "./ManualContentComposer";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { TagInput, normalizeTags } from "./ui/tag-input";
import { Label } from "./ui/label";
import { CoverImage } from "./ui/cover-image";
import { coverAssetIdFromMetadata } from "../lib/cover-cache";

type ImportOrigin = "manual" | "file";
type FormValues = Record<string, string>;
type WizardStepName = "origin" | "file" | "content" | "confirm" | "structure";
const wizardStepDefinitions = [
  { name: "origin", step: 0 }, { name: "file", step: 1 },
  { name: "content", step: 2 }, { name: "confirm", step: 4 }, { name: "structure", step: 5 }
] as const;

export function wizardStepAvailability({ busy, canChooseOrigin, studioReady, descriptorReady, contentReady, structureReady = false }: {
  busy: boolean; canChooseOrigin: boolean; studioReady: boolean; descriptorReady: boolean; contentReady: boolean; structureReady?: boolean;
}): Record<WizardStepName, boolean> {
  return { origin: !busy && canChooseOrigin, file: !busy && canChooseOrigin,
    content: !busy && studioReady, confirm: !busy && descriptorReady && contentReady,
    structure: !busy && structureReady };
}

export function suggestSourceTitle(content: string): string {
  return (content.split("\n").find((line) => line.trim()) ?? "").replace(/^\s{0,3}#{1,6}\s+/, "").trim().slice(0, 160);
}

export function suggestedFileType(file: FileMetadataExtractionResult): SourceItemType {
  const values = file.draft.values;
  if (file.mimeType === "application/epub+zip" || values.isbn13 || values.isbn10) return "Book";
  if (values.doi) return "AcademicPaper";
  return "GenericDocument";
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
  const [origin, setOrigin] = useState<ImportOrigin>("manual");
  const [values, setValues] = useState<FormValues>(formDefaults);
  const [fieldProvenance, setFieldProvenance] = useState<Record<string, MetadataFieldProvenance>>(() => expandProvenance((initialDescriptor.provenance ?? {}) as Record<string, MetadataFieldProvenance>));
  const [content, setContent] = useState(originalContent);
  const [contentMode, setContentMode] = useState<ManualContentMode>("document");
  const [manualSubitems, setManualSubitems] = useState<ManualSubitemDraft[]>(() => [createManualSubitem()]);
  const [file, setFile] = useState<FileMetadataExtractionResult | null>(null);
  const [coverAssetId, setCoverAssetId] = useState<string | null>(editing ? coverAssetIdFromMetadata(editing.metadata) : null);
  const [processingPlan, setProcessingPlan] = useState<ProcessingPlanRequest>(() => defaultProcessingPlan("import_only"));
  const [duplicatePolicy, setDuplicatePolicy] = useState<DuplicatePolicy>("ignore");
  const [duplicate, setDuplicate] = useState<DuplicateCandidate | null>(null);
  const [enrichmentState, setEnrichmentState] = useState<"idle" | "loading" | "empty" | "error" | "success">("idle");
  const [candidates, setCandidates] = useState<EnrichmentCandidate[]>([]);
  const [fileView, setFileView] = useState<"source" | "subitems">("source");
  const [fileStructure, setFileStructure] = useState<{ key: string; data: FileStructurePreview; draft: DocumentDivisionCandidate[]; reviewed: boolean } | null>(null);
  const [fileStructureError, setFileStructureError] = useState("");
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [pendingStructureId, setPendingStructureId] = useState<string | null>(null);
  const pendingReviewedDivisions = useRef<DocumentDivisionCandidate[] | null>(null);
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
  const requiresParent = ["BookChapter", "DocumentSection"].includes(sourceType);
  const parentReady = !requiresParent || Boolean(values.parentSourceItemId);
  const contentReady = parentReady && (origin === "file"
    ? Boolean(file)
    : contentMode === "subitems"
      ? validateManualSubitems(manualSubitems)
      : isContainerType(sourceType) || Boolean(effectiveContent.trim()));
  const fileHasHierarchy = origin === "file" && Boolean(file) && isContainerType(sourceType);
  const fileStructureKey = fileHasHierarchy ? `${file!.fileToken}:${sourceType}` : null;
  const currentFileStructure = fileStructure?.key === fileStructureKey ? fileStructure : null;
  const availableWizardSteps = wizardStepAvailability({
    busy,
    canChooseOrigin: !editing && !parent,
    studioReady: origin === "manual" || Boolean(file),
    descriptorReady: descriptor.success,
    contentReady: contentReady && (!fileHasHierarchy || Boolean(currentFileStructure?.reviewed)),
    structureReady: fileHasHierarchy
  });

  useEffect(() => { setFileView("source"); }, [fileStructureKey]);
  useEffect(() => {
    if (!file || !fileStructureKey || !isContainerType(sourceType)) { setFileStructure(null); return; }
    let active = true;
    setFileStructureError("");
    const input = { fileToken: file.fileToken, sourceType };
    void Promise.resolve().then(() => window.app.ingestion.previewFileStructure(input))
      .then((data) => { if (active) setFileStructure((current) => current?.key === fileStructureKey ? current : { key: fileStructureKey, data, draft: data.divisions, reviewed: false }); })
      .catch((error) => { if (active) setFileStructureError(t(errorMessageKey(error))); });
    return () => { active = false; };
  }, [fileStructureKey, previewAttempt]);

  async function reviewFileSelection(divisions: DocumentDivisionCandidate[]) {
    if (!currentFileStructure) return;
    if (validateDivisionTree(divisions).some((issue) => issue.code !== "empty_range")) { setValidationError(t("errors.common.validationFailed")); return; }
    setFileStructure({ ...currentFileStructure, draft: divisions, reviewed: true });
    if (!descriptor.success) { setFileView("source"); setValidationError(t("errors.common.validationFailed")); return; }
    setValidationError(""); setStep(4);
  }

  async function recoverStructure() {
    if (!pendingStructureId) return;
    setBusy(true); setValidationError("");
    try {
      const result = await window.app.ingestion.getStructure(pendingStructureId);
      if (!result) throw new Error("errors.common.unknown");
      setStructure(pendingReviewedDivisions.current ? { ...result, divisions: pendingReviewedDivisions.current.map((division) => ({ ...division, childSourceItemId: null, childDocumentId: null })) } : result);
      setPendingStructureId(null); pendingReviewedDivisions.current = null;
    } catch (error) { setValidationError(t(errorMessageKey(error))); } finally { setBusy(false); }
  }

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
    setValues((current) => ({ ...initialValues(type), ...current, ...(compatibleParents[type]?.join() !== compatibleParents[sourceType]?.join() ? { parentSourceItemId: "", parentTitle: "" } : {}) }));
    if (!isContainerType(type)) setContentMode("document");
    setValidationError("");
  }

  function setField(name: string, value: string) {
    setValues((current) => ({ ...current, [name]: value }));
    setFieldProvenance((current) => ({ ...current, [name]: { source: "manual" } }));
  }

  function suggestTitle() {
    if (!values.title?.trim() && effectiveContent.trim()) {
      setField("title", suggestSourceTitle(effectiveContent));
    }
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
        { sourceType: sourceType === "PersonalNote" ? "GenericDocument" : sourceType, requestId },
        setFileProgress
      );
      if (!extracted) {
        setStatus("import.status.canceled");
        return;
      }
      setFile(extracted);
      setValues((current) => ({ ...current, ...Object.fromEntries(Object.entries(draftToValues(extracted.draft.values)).filter(([key]) => fieldProvenance[key]?.source !== "manual")) }));
      setFieldProvenance((current) => ({ ...expandProvenance(extracted.draft.provenance), ...Object.fromEntries(Object.entries(current).filter(([, item]) => item.source === "manual")) }));
      if (sourceType === "PersonalNote") setSourceType(suggestedFileType(extracted));
      const cover = extracted.draft.values.cover;
      if (isRecord(cover) && typeof cover.assetId === "string") setCoverAssetId(cover.assetId);
      setStatus("import.status.metadataExtracted");
      setStep(2);
    } catch (error) {
      setStatus(errorMessageKey(error));
      setValidationError(t(errorMessageKey(error)));
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
    if (step === 0) { setStep(origin === "file" ? 1 : 2); return; }
    if (step === 1) { if (file) setStep(2); else void chooseFile(); return; }
    if (step === 2) {
      if (!parentReady) { setValidationError(t("intake.parentFirst")); return; }
      if (!descriptor.success) { setValidationError(t("errors.common.validationFailed")); return; }
      if (!contentReady) { setValidationError(t(origin === "file" ? "import.validation.chooseFile" : contentMode === "subitems" ? "import.validation.subitemsIncomplete" : "import.validation.contentRequired")); return; }
      if (fileHasHierarchy) {
        if (fileView !== "subitems") { setFileView("subitems"); return; }
        if (!currentFileStructure || fileStructureError) return;
        void reviewFileSelection(currentFileStructure.draft); return;
      }
      setStep(4);
    }
  }

  function navigateToWizardStep(target: number) {
    if (target === 3 && availableWizardSteps.structure) { setStep(2); setFileView("subitems"); return; }
    if (target === 2) setFileView("source");
    const targetDefinition = wizardStepDefinitions.find(({ step: targetStep }) => targetStep === target);
    if (!targetDefinition || !availableWizardSteps[targetDefinition.name]) return;
    setValidationError("");
    setStep(target);
  }

  async function submit() {
    if (!descriptor.success) return;
    if (fileHasHierarchy && !currentFileStructure?.reviewed) { setStep(2); setFileView("subitems"); return; }
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
        setPendingStructureId(result.structureId);
        pendingReviewedDivisions.current = currentFileStructure?.reviewed && !(result.duplicate && duplicatePolicy === "ignore") ? currentFileStructure.draft : null;
        const savedStructure = await window.app.ingestion.getStructure(result.structureId);
        if (!savedStructure) throw new Error("errors.common.unknown");
        const applyPreview = currentFileStructure?.reviewed && !(result.duplicate && duplicatePolicy === "ignore");
        setStructure(applyPreview ? { ...savedStructure, divisions: currentFileStructure.draft.map((division) => ({ ...division, childSourceItemId: null, childDocumentId: null })) } : savedStructure);
        setPendingStructureId(null);
        pendingReviewedDivisions.current = null;
        if (applyPreview) {
          const confirmed = await window.app.ingestion.confirmStructure({ structureId: result.structureId, divisions: currentFileStructure.draft, plan: processingPlan });
          setStructure(null);
          if (onSaved) onSaved(result.sourceItemId); else resetWizard();
          setStatus(confirmed.queued.some((item) => item.jobId) ? "import.status.queuedChildren" : "import.status.savedChildren");
        } else setStatus("import.status.reviewStructure");
      } else {
        setStatus(result.duplicate ? "import.status.duplicateHandled" : result.jobId ? "import.status.queued" : "import.status.saved");
        if (onSaved) onSaved(result.sourceItemId); else resetWizard();
      }
    } catch (error) {
      setStatus(errorMessageKey(error));
      setValidationError(t(errorMessageKey(error)));
    } finally {
      setBusy(false);
    }
  }

  function resetWizard() {
    setStep(0);
    pendingReviewedDivisions.current = null;
    setFileView("source"); setFileStructure(null); setFileStructureError(""); setPendingStructureId(null);
    setValues(initialValues(sourceType));
    setFieldProvenance({});
    setContent("");
    setContentMode("document");
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
    } catch (error) { setValidationError(t(errorMessageKey(error))); } finally { setBusy(false); }
  }

  async function confirmStructure(divisions: Parameters<typeof window.app.ingestion.confirmStructure>[0]["divisions"]) {
    if (!structure) return;
    setBusy(true);
    try {
      const result = await window.app.ingestion.confirmStructure({ structureId: structure.id, divisions, plan: processingPlan });
      setStructure(null);
      if (onSaved) onSaved(structure.rootSourceItemId); else resetWizard();
      setStatus(result.queued.some((item) => item.jobId) ? "import.status.queuedChildren" : "import.status.savedChildren");
    } catch (error) { setValidationError(t(errorMessageKey(error))); } finally { setBusy(false); }
  }

  if (pendingStructureId && !structure) return <section className="grid gap-4"><p role="status">{t(busy ? "shell.states.loading" : "intake.structureLoadFailed")}</p>{validationError ? <p role="alert" className="text-sm text-rose-600">{validationError}</p> : null}<Button disabled={busy} onClick={() => void recoverStructure()}>{t("intake.retryStructure")}</Button></section>;

  if (structure) return <div className="grid gap-4">
    <WizardSteps active={5} origin={origin} hierarchical t={t} />
    <StructureReview structure={structure} allowEmpty={origin === "file"} t={t} busy={busy} onSave={saveStructure} onConfirm={confirmStructure} />
    {validationError ? <p role="alert" className="text-sm text-rose-600">{validationError}</p> : null}
    <details className="rounded-xl border border-slate-200 p-3 dark:border-slate-800"><summary className="cursor-pointer text-sm">{t("intake.processing")}</summary><PlanCard plan={processingPlan} setPlan={setProcessingPlan} t={t} /></details>
  </div>;

  return <section className="grid min-w-0 gap-4">
    {parent ? <header><p className="text-xs text-slate-500">{parent.title}</p><h2 className="text-lg font-semibold">{t("sourceWorkspace.addChild")}</h2></header> : null}
    <WizardSteps active={step === 2 && fileHasHierarchy && fileView === "subitems" ? 3 : step} origin={origin} hierarchical={isContainerType(sourceType) && !editing} available={availableWizardSteps} onNavigate={navigateToWizardStep} t={t} />
    {busy && fileProgress ? <FileImportProgressCard progress={fileProgress} elapsedSeconds={elapsedSeconds} t={t} /> : null}
    <fieldset disabled={busy} className="grid min-w-0 gap-4 disabled:opacity-70">
    {step === 0 ? <><header><h2 className="text-xl font-semibold">{t("intake.originTitle")}</h2><p className="mt-1 text-sm text-slate-500">{t("intake.originHint")}</p></header><OriginStep t={t} value={origin} onChange={setOrigin} /></> : null}
    {step === 1 ? <ContentStep t={t} sourceType={sourceType} origin="file" file={file} content={content} onContent={setContent} onChooseFile={chooseFile} busy={busy} mode={contentMode} onMode={setContentMode} subitems={manualSubitems} onSubitems={setManualSubitems} editing={false} /> : null}
    {step === 2 ? <>
      <header className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold">{t(origin === "manual" ? "intake.studio" : fileHasHierarchy && fileView === "subitems" ? "intake.subitemsTitle" : "intake.metadataTitle")}</h2><p className="text-xs text-slate-500">{origin === "file" ? file?.fileName : t("intake.titleHint")}</p></div></header>
      {editing ? <p className="text-xs text-slate-500">{t("sourceWorkspace.editHint")}</p> : null}
          <div className="grid min-w-0 gap-1 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950 sm:grid-cols-[10rem_minmax(0,1fr)] sm:items-center"><Label htmlFor="source-type">{t("import.fields.sourceType")}</Label><select id="source-type" disabled={Boolean(editing || parent)} value={sourceType} onChange={(event) => chooseType(event.target.value as SourceItemType)} className="h-9 min-w-0 rounded-md border border-slate-300 bg-white px-2 text-sm dark:border-slate-700 dark:bg-slate-950">{sourceCards.map(({ type }) => <option key={type} value={type}>{t(`import.sourceTypes.${type}` as MessageKey)}</option>)}</select><p className="text-xs leading-5 text-slate-500 sm:col-start-2">{t(`import.sourceDescriptions.${sourceType}` as MessageKey)}</p></div>
      {!editing && !parent && compatibleParents[sourceType] ? <ParentPicker key={sourceType} t={t} sourceType={sourceType} values={values} onChange={setValues} /> : parent || (editing && requiresParent) ? <p className="rounded-lg border border-cyan-200 bg-cyan-50 p-3 text-sm dark:border-cyan-900 dark:bg-cyan-950">{t("import.parent.label")}: {parent?.title ?? values.parentTitle ?? t("intake.fixedParent")}</p> : null}
      {!parentReady ? <p role="status" className="text-sm text-slate-500">{t("intake.parentFirst")}</p> : null}
      {fileHasHierarchy ? <div role="group" aria-label={t("intake.viewLabel")} className="flex flex-wrap items-center gap-2">{(["source", "subitems"] as const).map((view) => <Button key={view} type="button" aria-pressed={fileView === view} className={cn(fileView !== view && "opacity-60")} onClick={() => setFileView(view)}>{t(view === "source" ? "intake.sourceView" : "intake.subitemsView")}</Button>)}<span className="text-xs text-slate-500">{t("intake.fileReviewHint")}</span></div> : origin === "file" && sourceType === "GenericDocument" ? <p className="text-xs text-slate-500">{t("intake.fileTypeHint")}</p> : null}
      <div hidden={!parentReady || (fileHasHierarchy && fileView === "subitems")} className="grid min-w-0 gap-4">
        <section id="source-properties" aria-label={t("intake.properties")} className="grid min-w-0 gap-3">
          {metadataEnrichmentEnabled && (sourceType === "WebArticle" || sourceType === "Video") ? <div className="grid gap-2"><Input aria-label={t("import.metadataFields.url")} placeholder={t("import.metadataFields.url")} value={values.url ?? ""} onChange={(event) => setField("url", event.target.value)} /><Button type="button" disabled={busy || !values.url} onClick={() => void previewUrl()}>{t("sourceWorkspace.fetchUrl")}</Button></div> : null}
          {coverAssetId ? <div className="h-24 w-16 overflow-hidden rounded-lg"><CoverImage assetId={coverAssetId} alt={values.title ?? ""} fallback={<BookOpen />} /></div> : null}
          <DescriptorFields t={t} sourceType={sourceType} values={values} onChange={setValues} onFieldChange={(name) => setFieldProvenance((current) => ({ ...current, [name]: { source: "manual" } }))} suggestions={metadataEnrichmentEnabled && supportsEnrichment(sourceType) ? <EnrichmentResults t={t} candidates={candidates} busy={busy} state={enrichmentState} onApply={applyCandidate} /> : null} />
        </section>
        <div className="grid min-w-0 gap-3">
          {origin === "manual" ? <div onBlur={suggestTitle}><ContentStep t={t} sourceType={sourceType} origin={origin} file={file} content={content} onContent={setContent} onChooseFile={chooseFile} busy={busy} mode={contentMode} onMode={setContentMode} subitems={manualSubitems} onSubitems={setManualSubitems} editing={Boolean(editing)} /></div>
            : <SourceMetadataPreview key={file?.fileToken} text={file?.preview?.text ?? ""} truncated={file?.preview?.truncated ?? false} values={values} t={t} onApply={(name, value, start, end) => { setField(name, value); setFieldProvenance((current) => ({ ...current, [name]: { source: "manual", evidence: `document-start:${start}-${end}` } })); }} />}
        </div>
      </div>
      {fileHasHierarchy ? <div hidden={fileView !== "subitems"}>
        {fileStructureError ? <div role="alert" className="grid gap-3 rounded-xl border border-rose-200 p-4 dark:border-rose-900"><p>{fileStructureError}</p><Button onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>{t("intake.retryStructure")}</Button></div>
          : currentFileStructure ? <StructureReview key={currentFileStructure.key} previewOnly structure={currentFileStructure.data} initialDivisions={currentFileStructure.draft} onDraftChange={(draft) => setFileStructure((current) => current?.key === fileStructureKey ? { ...current, draft, reviewed: false } : current)} t={t} busy={busy} onSave={async () => {}} onConfirm={reviewFileSelection} />
            : <p role="status" className="flex items-center gap-2 rounded-xl border border-slate-200 p-4 text-sm dark:border-slate-800"><LoaderCircle className="h-4 w-4 animate-spin" />{t("intake.detectingStructure")}</p>}
      </div> : null}
    </> : null}
    {step === 4 && editing ? <div className="rounded-xl border border-slate-200 p-4 dark:border-slate-800"><h2 className="font-semibold">{values.title}</h2><p className="mt-2 text-sm text-slate-500">{t("sourceWorkspace.editHint")}</p></div> : step === 4 && descriptor.success ? <ConfirmationStep t={t} descriptor={descriptor.data} origin={origin} file={file} duplicate={duplicate} policy={duplicatePolicy} onPolicy={setDuplicatePolicy} plan={processingPlan} onPlan={setProcessingPlan} /> : null}
    </fieldset>
    {validationError ? <p role="alert" className="rounded-lg bg-rose-50 px-4 py-3 text-sm text-rose-800 dark:bg-rose-950 dark:text-rose-200">{validationError}</p> : null}
    <footer className="sticky bottom-0 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950">
      <p role="status" className="min-w-0 text-xs text-slate-500">{t(status)}</p>
      <div className="flex flex-wrap gap-2">
        {onCancel ? <Button type="button" disabled={busy} onClick={onCancel}>{t("shell.actions.cancel")}</Button> : null}
        {step > (editing || parent ? 2 : 0) ? <Button type="button" disabled={busy} onClick={() => setStep(step === 4 ? 2 : step === 2 && origin === "file" ? 1 : 0)}><ChevronLeft className="h-4 w-4" />{t("import.actions.back")}</Button> : null}
        {step < 4 ? <Button variant="primary" type="button" disabled={busy} onClick={next}><ChevronRight className="h-4 w-4" />{t(step === 1 && !file ? "import.actions.chooseFile" : "import.actions.continue")}</Button> : <Button variant="primary" type="button" disabled={busy} onClick={() => void submit()}><Upload className="h-4 w-4" />{t(editing ? "sourceWorkspace.save" : "import.actions.import")}</Button>}
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

function OriginStep({ t, value, onChange }: { t: Translator; value: ImportOrigin; onChange: (value: ImportOrigin) => void }) {
  return <div className="grid gap-4 md:grid-cols-2">{(["manual", "file"] as const).map((origin) => <button key={origin} type="button" aria-pressed={value === origin} onClick={() => onChange(origin)} className={cn("flex items-center gap-4 rounded-xl border p-4 text-left", value === origin ? "border-cyan-500 bg-cyan-50 ring-2 ring-cyan-500/15 dark:bg-cyan-950/40" : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950")}><span className="grid h-14 w-14 place-items-center rounded-2xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">{origin === "manual" ? <StickyNote className="h-6 w-6" /> : <FileUp className="h-6 w-6" />}</span><span><span className="block font-semibold">{t(`import.modes.${origin}` as MessageKey)}</span><span className="mt-2 block text-sm leading-6 text-slate-500">{t(`import.originDescriptions.${origin}` as MessageKey)}</span></span></button>)}</div>;
}

function DescriptorFields({ t, sourceType, values, onChange, onFieldChange, suggestions, compact = false, showTitle = true, idPrefix = "source" }: { t: Translator; sourceType: SourceItemType; values: FormValues; onChange: (values: FormValues) => void; onFieldChange?: (name: string) => void; suggestions?: ReactNode; compact?: boolean; showTitle?: boolean; idPrefix?: string }) {
  const set = (name: string, value: string) => { onChange({ ...values, [name]: value }); onFieldChange?.(name); };
  return <div className={cn("grid min-w-0 gap-4 rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950", compact ? "p-3" : "p-5")}>
    {showTitle ? <Field idPrefix={idPrefix} required name="title" t={t} values={values} set={set} /> : null}
    {suggestions}
    <div className={cn("grid items-start gap-4", !compact && "md:grid-cols-2")}><CreatorFields value={values.creators ?? ""} onChange={(value) => set("creators", value)} t={t} /><LanguageField id={`${idPrefix}-language`} t={t} value={values.language ?? "und"} onChange={(value) => set("language", value)} /></div>
    {sourceType === "DailyNote" ? <Field idPrefix={idPrefix} required name="noteDate" t={t} values={values} set={set} /> : null}
    {sourceType === "PeriodicalIssue" ? <Field idPrefix={idPrefix} required name="publicationTitle" t={t} values={values} set={set} /> : null}
    {sourceType === "Book" ? <Field idPrefix={idPrefix} name="isbn13" t={t} values={values} set={set} /> : null}
    {sourceType === "AcademicPaper" || sourceType === "StandaloneArticle" ? <Field idPrefix={idPrefix} name="doi" t={t} values={values} set={set} /> : null}
    {sourceType === "AcademicPaper" ? <Field idPrefix={idPrefix} name="abstract" multiline t={t} values={values} set={set} /> : null}
    <details className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-semibold">{t("sourceWorkspace.moreMetadata")}</summary><div className="mt-4 grid gap-4"><Field idPrefix={idPrefix} name="subtitle" t={t} values={values} set={set} /><TypeSpecificFields idPrefix={idPrefix} compact={compact} sourceType={sourceType} t={t} values={values} set={set} /></div></details>
    <details className="rounded-lg border border-slate-200 p-4 dark:border-slate-800"><summary className="cursor-pointer text-sm font-semibold">{t("import.metadataFields.description")} · {t("import.metadataFields.tags")}</summary><div className={cn("mt-4 grid gap-4", !compact && "md:grid-cols-2")}><Field idPrefix={idPrefix} name="description" multiline t={t} values={values} set={set} /><Field idPrefix={idPrefix} name="tags" t={t} values={values} set={set} /></div></details>
  </div>;
}

function TypeSpecificFields({ sourceType, t, values, set, compact = false, idPrefix = "source" }: { idPrefix?: string; compact?: boolean; sourceType: SourceItemType; t: Translator; values: FormValues; set: (name: string, value: string) => void }) {
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
  return <div className={cn("grid gap-4", !compact && "md:grid-cols-2")}>{names.filter((name) => !["noteDate", "publicationTitle", "isbn13", "doi", "abstract"].includes(name)).map((name) => <Field idPrefix={idPrefix} key={name} name={name} t={t} values={values} set={set} />)}</div>;
}

function Field({ name, t, values, set, required = false, multiline = false, idPrefix = "source" }: { idPrefix?: string; name: string; t: Translator; values: FormValues; set: (name: string, value: string) => void; required?: boolean; multiline?: boolean }) {
  const id = `${idPrefix}-${name}`;
  return <div className="grid gap-2"><Label htmlFor={id}>{t(`import.metadataFields.${name}` as MessageKey)}{required ? " *" : ""}</Label>{name === "tags" ? <TagInput id={id} value={(values[name] ?? "").split(/[,\n]/)} onChange={(tags) => set(name, tags.join(", "))} t={t} /> : multiline ? <textarea id={id} value={values[name] ?? ""} onChange={(event) => set(name, event.target.value)} className="min-h-24 rounded-lg border border-slate-300 bg-white p-3 text-sm dark:border-slate-700 dark:bg-slate-950" /> : <Input id={id} value={values[name] ?? ""} onChange={(event) => set(name, event.target.value)} />}</div>;
}

function LanguageField({ t, value, onChange, id = "source-language" }: { id?: string; t: Translator; value: string; onChange: (value: string) => void }) {
  const languages = ["und", "en", "pt-BR", "it", "fr", "es", "de", "ja", "zh", "ar"];
  const options = languages.includes(value) ? languages : [value, ...languages];
  return <div className="grid gap-2"><Label htmlFor={id}>{t("import.metadataFields.language")}</Label><select id={id} value={value} onChange={(event) => onChange(event.target.value)} className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">{options.map((language) => <option key={language} value={language}>{getLanguageDisplayName(t.locale, language)}</option>)}</select></div>;
}

export function ParentPicker({ t, sourceType, values, onChange }: { t: Translator; sourceType: SourceItemType; values: FormValues; onChange: (values: FormValues) => void }) {
  const types = compatibleParents[sourceType] ?? [];
  const [query, setQuery] = useState(values.parentTitle ?? "");
  const [suggestions, setSuggestions] = useState<SourceSuggestion[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "empty" | "error" | "success">("idle");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const dialog = useRef<HTMLDialogElement>(null);
  const [parentValues, setParentValues] = useState<FormValues>(() => initialValues(types[0] ?? "Book"));

  useEffect(() => {
    if (creating) dialog.current?.showModal(); else dialog.current?.close();
  }, [creating]);
  useEffect(() => {
    if (query.trim().length < 2 || values.parentSourceItemId) { setSuggestions([]); setState("idle"); return; }
    let active = true;
    setState("loading");
    const timer = window.setTimeout(() => void window.app.ingestion.lookupSources(query, types)
      .then((results) => { if (active) { setSuggestions(results); setState(results.length ? "success" : "empty"); } })
      .catch(() => { if (active) { setSuggestions([]); setState("error"); } }), 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [query, types.join("|"), values.parentSourceItemId]);

  async function createParent() {
    const type = types[0];
    if (!type || saving) return;
    const descriptor = buildDescriptor(type, parentValues, null);
    if (!descriptor.success) { setError(t("errors.common.validationFailed")); return; }
    setSaving(true); setError("");
    try {
      const result = await window.app.ingestion.createContainerSource({ descriptor: descriptor.data, duplicatePolicy: "ignore" });
      onChange({ ...values, parentSourceItemId: result.sourceItemId, parentTitle: descriptor.data.title });
      setQuery(descriptor.data.title); setCreating(false);
    } catch { setError(t("errors.common.unknown")); } finally { setSaving(false); }
  }

  return <section className="grid min-w-0 gap-2 rounded-xl border border-cyan-200 bg-cyan-50/50 p-4 dark:border-cyan-900 dark:bg-cyan-950/20">
    <Label htmlFor="parent-source">{t("import.parent.label")} · {t(`import.sourceTypes.${types[0] ?? "Book"}` as MessageKey)}{["BookChapter", "DocumentSection"].includes(sourceType) ? " *" : ""}</Label>
    <div className="flex flex-wrap gap-2"><Input id="parent-source" className="min-w-0 flex-[1_1_16rem]" placeholder={t("intake.parentSearch")} value={query} onChange={(event) => { setQuery(event.target.value); onChange({ ...values, parentSourceItemId: "", parentTitle: event.target.value }); }} /><Button type="button" onClick={() => { setError(""); setCreating(true); }}>{t("import.parent.create")}</Button></div>
    {values.parentSourceItemId ? <p role="status" className="text-xs text-cyan-800 dark:text-cyan-200">{t("intake.parentSelected", { values: { title: values.parentTitle ?? query } })}</p> : state !== "success" ? <p role="status" className="text-xs text-slate-500">{t(state === "loading" ? "shell.states.loading" : state === "empty" ? "intake.parentEmpty" : state === "error" ? "intake.parentError" : "intake.parentSearch")}</p> : null}
    {suggestions.length ? <ul aria-label={t("import.parent.label")} className="grid gap-1 rounded-lg border border-slate-200 bg-white p-1 dark:border-slate-700 dark:bg-slate-950">{suggestions.map((suggestion) => <li key={suggestion.id}><button type="button" className="w-full break-words rounded px-3 py-2 text-left text-sm hover:bg-slate-100 dark:hover:bg-slate-900" onClick={() => { onChange({ ...values, parentSourceItemId: suggestion.id, parentTitle: suggestion.title }); setQuery(suggestion.title); setSuggestions([]); }}>{suggestion.title}</button></li>)}</ul> : null}
    {creating ? <dialog ref={dialog} onCancel={(event) => { if (saving) event.preventDefault(); else setCreating(false); }} aria-label={t("import.parent.createTitle")} className="m-auto max-h-[85vh] w-full max-w-3xl overflow-auto rounded-2xl bg-white p-5 text-slate-950 shadow-2xl backdrop:bg-slate-950/55 dark:bg-slate-950 dark:text-slate-100">
      <header className="mb-4 flex items-start justify-between gap-3"><h2 className="font-semibold">{t("import.parent.createTitle")}</h2><button type="button" disabled={saving} aria-label={t("shell.actions.close")} onClick={() => setCreating(false)}><X className="h-5 w-5" /></button></header>
      <fieldset disabled={saving} className="grid min-w-0 gap-3"><DescriptorFields idPrefix="parent" t={t} sourceType={types[0] ?? "Book"} values={parentValues} onChange={setParentValues} />{error ? <p role="alert" className="text-sm text-rose-600">{error}</p> : null}<Button type="button" onClick={() => void createParent()}>{t(saving ? "shell.states.loading" : "import.parent.create")}</Button></fieldset>
    </dialog> : null}
  </section>;
}

function EnrichmentResults({ t, candidates, busy, state, onApply }: { t: Translator; candidates: EnrichmentCandidate[]; busy: boolean; state: "idle" | "loading" | "empty" | "error" | "success"; onApply: (candidate: EnrichmentCandidate) => Promise<void> }) {
  const status = t(state === "idle" ? "import.enrichment.waiting" : state === "loading" ? "shell.states.loading" : state === "error" ? "sourceWorkspace.enrichmentError" : "sourceWorkspace.enrichmentEmpty");
  return <details className="group/enrichment min-w-0 rounded-xl border border-violet-200 bg-violet-50/50 dark:border-violet-900 dark:bg-violet-950/20">
    <summary className="flex cursor-pointer list-none items-center gap-2 p-3 text-sm [&::-webkit-details-marker]:hidden">
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open/enrichment:rotate-90" aria-hidden="true" />
      <Sparkles className="h-4 w-4 shrink-0 text-violet-700 dark:text-violet-300" aria-hidden="true" />
      <span className="min-w-0 flex-1"><span className="font-medium">{t("import.enrichment.title")}</span>{!candidates.length ? <span role="status" className="mt-0.5 block text-xs text-muted-foreground">{status}</span> : null}</span>
      {state === "loading" ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-violet-600 dark:text-violet-300" aria-hidden="true" /> : candidates.length ? <span className="rounded-md bg-violet-100 px-2 py-0.5 text-xs text-violet-800 dark:bg-violet-900/50 dark:text-violet-200">{candidates.length}</span> : null}
    </summary>
    <div className="grid gap-2 border-t border-violet-200 p-3 dark:border-violet-900">
      {candidates.length ? candidates.map((candidate) => <div key={`${candidate.provider}-${candidate.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface p-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {candidate.coverPreviewDataUrl ? <img src={candidate.coverPreviewDataUrl} alt="" className="h-14 w-10 shrink-0 rounded object-cover" /> : <span className="grid h-14 w-10 shrink-0 place-items-center rounded bg-soft text-muted-foreground"><BookOpen className="h-4 w-4" /></span>}
          <div className="min-w-0"><p className="break-words text-sm font-medium">{candidate.title}</p><p className="text-xs text-muted-foreground">{candidate.creators.map((creator) => creator.name).join(", ")}{candidate.year ? ` · ${candidate.year}` : ""}{candidate.edition ? ` · ${candidate.edition}` : ""} · {candidate.provider}</p></div>
        </div>
        <Button type="button" disabled={busy} onClick={() => void onApply(candidate)}>{t("import.enrichment.apply")}</Button>
      </div>) : <p className="text-xs text-muted-foreground">{status}</p>}
    </div>
  </details>;
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

function WizardSteps({ active, available, onNavigate, t, origin, hierarchical = false }: { active: number; available?: Record<WizardStepName, boolean>; onNavigate?: (step: number) => void; t: Translator; origin: ImportOrigin; hierarchical?: boolean }) {
  const definitions = wizardStepDefinitions.filter(({ name }) => (name !== "file" || origin === "file") && (name !== "structure" || hierarchical))
    .map((definition) => ({ ...definition, step: definition.name === "structure" && origin === "file" && active !== 5 ? 3 : definition.step }))
    .sort((left, right) => left.step - right.step);
  const activeIndex = definitions.findIndex(({ step }) => step === active);
  return <ol aria-label={t("intake.steps")} className="flex flex-wrap items-center gap-y-1 border-b border-border pb-3">{definitions.map(({ name, step }, index) => {
    const enabled = Boolean(onNavigate && available?.[name]);
    const label = name === "content" ? origin === "file" ? "import.steps.metadata" : "import.steps.content" : name === "file" ? "intake.fileStep" : `import.steps.${name}`;
    return <li key={name} className="flex min-w-0 items-center after:mx-2 after:h-px after:w-7 after:bg-border last:after:hidden"><button type="button" disabled={!enabled} aria-current={index === activeIndex ? "step" : undefined} onClick={() => onNavigate?.(step)} className={cn("flex min-h-8 min-w-0 items-center gap-2 rounded-md px-1 py-1.5 text-left text-xs transition disabled:cursor-default", index === activeIndex ? "text-accent" : "text-muted-foreground", enabled && "hover:bg-soft")}><span className={cn("grid h-[21px] w-[21px] shrink-0 place-items-center rounded-full border", index === activeIndex ? "border-accent bg-accent text-accent-foreground" : "border-border text-muted-foreground")}>{index < activeIndex ? <Check className="h-3.5 w-3.5" /> : index + 1}</span><span>{t(label as MessageKey)}</span></button></li>;
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
  const base = { type, title: values.title?.trim() ?? "", language: optional("language") ?? "und", creators, tags: normalizeTags(list("tags")), provenance, ...(optional("subtitle") ? { subtitle: optional("subtitle") } : {}), ...(optional("publicationDate") ? { publicationDate: optional("publicationDate") } : {}), ...(optional("description") ? { description: optional("description") } : {}), ...(coverAssetId ? { cover: { assetId: coverAssetId } } : {}) };
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
    const roleMatch = trimmed.match(/^([a-z]+):\s*(.*)$/i);
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
