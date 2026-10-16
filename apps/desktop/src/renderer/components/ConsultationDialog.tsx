import { subscribeWindowNavigation } from "../lib/window-navigation";
import { useEffect, useRef, useState } from "react";
import { BookOpen, LoaderCircle, MessageCircle, Quote, X } from "lucide-react";
import { ConsultationInputSchema, type ConsultationResult } from "@app/domain";
import type { Translator, MessageKey } from "@app/i18n";
import type { AiProfile } from "../../shared/ipc";
import { citationTarget, type PassageAnchor } from "../lib/object-navigation";
import { MarkdownPreview } from "./MarkdownEditor";
import { EvidenceScopePicker } from "./ask/EvidenceScopePicker";
import { ProfilePicker } from "./ask/ProfilePicker";

const control =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900";
/** Replaces each `[e1]` run handle with the paragraph's displayed citation number. */
const citationMarkdown = (section: { markdown: string; citations: string[] }) =>
  section.markdown.replace(/\[(e\d{1,3})\]/g, (marker, handle: string) => {
    const index = [...new Set(section.citations)].indexOf(handle);
    return index >= 0 ? `[${index + 1}]` : marker;
  });
const errorKey = (e: unknown): MessageKey =>
  (String(e).match(/consultation\.errors\.[A-Za-z]+/)?.[0] as MessageKey | undefined) ??
  "consultation.errors.failed";

/** The answer being prepared, or why there is none. */
export function ConsultationStatus({
  t,
  error,
  busy,
  onCancel
}: {
  t: Translator;
  error: MessageKey | null;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {t(error)}
        </p>
      )}
      {busy && (
        <div
          role="status"
          className="flex items-center gap-3 rounded-xl bg-cyan-500/10 p-4 text-sm"
        >
          <LoaderCircle className="animate-spin motion-reduce:animate-none" size={18} />
          <span className="mr-auto">{t("consultation.answering")}</span>
          <button className={control} onClick={onCancel}>
            {t("organization.cancel")}
          </button>
        </div>
      )}
    </>
  );
}

/** A cited answer with its coverage, the passage behind each citation and the usage it cost. */
export function ConsultationAnswer({
  t,
  result,
  onOpenSource,
  active = true,
  initialHandle = null
}: {
  t: Translator;
  result: ConsultationResult;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
  active?: boolean;
  initialHandle?: string | null;
}) {
  const [handle, setHandle] = useState<string | null>(initialHandle),
    evidenceRef = useRef<HTMLElement>(null);
  const selected = result.evidence.find((e) => e.handle === handle);
  useEffect(() => {
    if (selected) {
      evidenceRef.current?.scrollIntoView({ block: "nearest" });
      evidenceRef.current?.focus({ preventScroll: true });
    }
  }, [selected]);
  // Back closes the passage before it closes the dialog.
  useEffect(() => {
    if (!active || !selected) return;
    return subscribeWindowNavigation((direction) => {
      if (direction !== "back") return false;
      setHandle(null);
    }, 11);
  }, [active, selected]);
  return (
    <div className={`grid gap-4 ${selected ? "lg:grid-cols-[minmax(0,1fr)_320px]" : ""}`}>
      <article className="rounded-2xl border border-slate-200 bg-white p-6 dark:border-slate-800 dark:bg-slate-900">
        <h3 className="mb-2 text-xl font-semibold">{result.question}</h3>
        <p className="mb-3 text-xs text-cyan-700 dark:text-cyan-300">
          {t(
            result.scope.topicId
              ? "consultation.topicScope"
              : result.scope.sourceIds.length
                ? "organization.sourceScope"
                : "consultation.libraryScope"
          )}{" "}
          · {t("consultation.sourceCount", { values: { count: result.coverage.sourceCount } })}
        </p>
        <p className="mb-5 text-xs text-slate-500">
          {t("consultation.coverage", {
            values: {
              selected: result.coverage.selected,
              total: result.coverage.retrieved,
              sources: result.coverage.sourceCount
            }
          })}
        </p>
        {result.coverage.limited && (
          <p className="mb-4 text-sm text-amber-700 dark:text-amber-300">
            {t("consultation.partial")}
          </p>
        )}
        {result.coverage.stale && (
          <p role="alert" className="mb-4 text-sm text-amber-700 dark:text-amber-300">
            {t("consultation.stale")}
          </p>
        )}
        {result.answer.paragraphs.map((p, i) => (
          <section key={i} className="mb-6">
            <MarkdownPreview markdown={citationMarkdown(p)} emptyLabel="" />
            <div className="mt-3 flex flex-wrap gap-2">
              {p.citations.map((h, index) => (
                <button
                  key={h}
                  className="rounded-lg bg-cyan-500/10 px-2 py-1 text-xs text-cyan-700 focus-visible:ring-2 dark:text-cyan-300"
                  onClick={() => setHandle(h)}
                >
                  <Quote size={12} className="mr-1 inline" />
                  {index + 1}. {result.evidence.find((e) => e.handle === h)?.sourceTitle}
                </button>
              ))}
            </div>
          </section>
        ))}
        {result.answer.gaps.length > 0 && (
          <aside className="rounded-xl bg-amber-500/10 p-4 text-sm">
            <h3 className="mb-2 font-medium">{t("consultation.gaps")}</h3>
            {result.answer.gaps.map((gap, i) => (
              <p key={i} className="mt-2">
                {gap}
              </p>
            ))}
          </aside>
        )}
      </article>
      {selected && (
        <aside
          ref={evidenceRef}
          tabIndex={-1}
          className="h-fit max-h-[65vh] overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 lg:sticky lg:top-0 rounded-2xl border border-cyan-500/30 bg-cyan-500/5 p-5"
        >
          <div className="flex items-center gap-2">
            <BookOpen size={17} />
            <h3 className="mr-auto font-semibold">{selected.sourceTitle}</h3>
            <button
              className={control}
              onClick={() => setHandle(null)}
              aria-label={t("organization.close")}
            >
              <X size={15} />
            </button>
          </div>
          <blockquote className="my-4 whitespace-pre-wrap text-sm leading-6">
            {selected.excerpt}
          </blockquote>
          <p className="text-xs text-slate-500">
            {selected.documentCreatedAt} · {selected.locator} · {selected.documentId.slice(0, 8)}
          </p>
          <button
            className={`${control} mt-3`}
            onClick={() =>
              onOpenSource(selected.sourceItemId, undefined, citationTarget(selected).passage)
            }
          >
            {t("objects.citation.openPassage")}
          </button>
        </aside>
      )}
      <details className="lg:col-span-full rounded-xl border border-slate-200 p-4 text-xs text-slate-500 dark:border-slate-800">
        <summary className="cursor-pointer">{t("organization.usage")}</summary>
        <p className="mt-3">
          {result.model} · {result.promptFingerprint.slice(0, 12)}
        </p>
        <p>
          {t(
            result.coverage.vector === "available"
              ? "consultation.vectorAvailable"
              : result.coverage.vector === "unavailable"
                ? "consultation.vectorUnavailable"
                : "consultation.textOnly"
          )}
        </p>
        <p>
          {t("organization.inputTokens")}: {result.inputTokens ?? t("organization.unavailable")} ·{" "}
          {t("organization.outputTokens")}: {result.outputTokens ?? t("organization.unavailable")} ·{" "}
          {t("organization.estimatedCost")}: {result.costEstimate ?? t("organization.unavailable")}
        </p>
      </details>
    </div>
  );
}

/**
 * Ask over the whole library, chosen sources or one topic. It depends on no page and no host: the
 * caller may seed the question, the sources (or the topic, which replaces them) and the
 * reviewed-only filter, and open a cited passage.
 */
export function ConsultationDialog({
  t,
  initialQuestion,
  onClose,
  onOpenSource,
  active = true,
  initialSourceIds = [],
  initialReviewed = false,
  initialProfiles,
  topic
}: {
  initialSourceIds?: string[];
  /** Ask about this topic and its subtopics instead of the library or chosen sources. */
  topic?: { id: string; title: string };
  initialReviewed?: boolean;
  /** Profiles the caller already has; the dialog skips its own load. */
  initialProfiles?: AiProfile[];
  active?: boolean;
  t: Translator;
  initialQuestion: string;
  onClose: () => void;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    request = useRef<string | null>(null);
  const [expanded, setExpanded] = useState(true),
    [intent, setIntent] = useState<"answer" | "comparison">("answer");
  const [question, setQuestion] = useState(initialQuestion),
    [sources, setSources] = useState<string[]>(initialSourceIds),
    [descendants, setDescendants] = useState(false),
    [reviewed, setReviewed] = useState(initialReviewed),
    [hybrid, setHybrid] = useState(false);
  const [profiles, setProfiles] = useState<AiProfile[]>(initialProfiles ?? []),
    [profile, setProfile] = useState("");
  const [loading, setLoading] = useState(!initialProfiles),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<MessageKey | null>(null),
    [result, setResult] = useState<ConsultationResult | null>(null);
  useEffect(() => {
    const focus = document.activeElement as HTMLElement | null;
    if (!initialProfiles)
      void window.app.ai
        .listProfiles()
        .then(setProfiles)
        .catch(() => setError("consultation.errors.failed"))
        .finally(() => setLoading(false));
    return () => {
      dialog.current?.close();
      if (request.current) void window.app.consultation.cancel(request.current);
      focus?.focus();
    };
  }, [initialProfiles]);
  useEffect(() => {
    if (active) dialog.current?.showModal();
    else dialog.current?.close();
  }, [active]);
  useEffect(() => {
    if (!active) return;
    return subscribeWindowNavigation((direction) => {
      if (direction !== "back") return false;
      onClose();
    }, 10);
  }, [active, onClose]);
  async function ask() {
    const id = crypto.randomUUID();
    request.current = id;
    setBusy(true);
    setExpanded(false);
    setError(null);
    setResult(null);
    try {
      const answer = await window.app.consultation.ask(
        ConsultationInputSchema.parse({
          intent,
          requestId: id,
          question,
          sourceIds: topic ? [] : sources,
          ...(topic ? { topicId: topic.id } : {}),
          includeDescendants: topic ? false : descendants,
          profileId: profile || undefined,
          privacy: "allow_remote",
          reviewedOnly: reviewed,
          mode: hybrid ? "hybrid" : "text"
        })
      );
      if (request.current === id) setResult(answer);
    } catch (e) {
      if (request.current === id) setError(errorKey(e));
    } finally {
      if (request.current === id) {
        request.current = null;
        setBusy(false);
      }
    }
  }
  async function cancel() {
    if (request.current) {
      const id = request.current;
      request.current = null;
      await window.app.consultation.cancel(id);
      setBusy(false);
      setError("consultation.errors.canceled");
    }
  }
  return (
    <dialog
      ref={dialog}
      aria-labelledby="consultation-heading"
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-5xl overflow-hidden rounded-2xl bg-slate-50 p-0 text-slate-950 backdrop:bg-slate-950/60 dark:bg-slate-950 dark:text-slate-50"
    >
      <div className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <header className="flex items-center gap-3 border-b border-slate-200 p-5 dark:border-slate-800">
          <MessageCircle className="text-cyan-600" />
          <h2 id="consultation-heading" className="mr-auto text-xl font-semibold">
            {t("consultation.title")}
          </h2>
          <button
            autoFocus
            className={control}
            aria-label={t("organization.close")}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="grid gap-5 overflow-auto p-5">
          <p className="text-sm leading-6 text-slate-500">{t("consultation.readOnly")}</p>
          {loading ? (
            <p role="status">{t("organization.loading")}</p>
          ) : (
            <details open={expanded} onToggle={(e) => setExpanded(e.currentTarget.open)}>
              <summary className="cursor-pointer text-sm font-medium">
                {t("consultation.question")} ·{" "}
                {topic
                  ? t("consultation.topicScopeNamed", { values: { title: topic.title } })
                  : sources.length
                    ? `${t("organization.sourceScope")} (${sources.length})`
                    : t("consultation.libraryScope")}
              </summary>
              <fieldset
                disabled={busy}
                className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900"
              >
                <label className="grid gap-2 text-sm">
                  {t("consultation.question")}
                  <textarea
                    className={`${control} min-h-20`}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                </label>
                {topic ? (
                  <p className="text-sm text-secondary-foreground">
                    {t("consultation.topicScopeHint", { values: { title: topic.title } })}
                  </p>
                ) : (
                  <details>
                    <summary className="cursor-pointer text-sm">
                      {t("organization.sourceScope")} {sources.length ? `(${sources.length})` : ""}
                    </summary>
                    <div className="mt-3">
                      <EvidenceScopePicker selected={sources} onChange={setSources} t={t} />
                    </div>
                  </details>
                )}
                <div className="flex flex-wrap gap-4 text-sm">
                  {topic ? null : (
                    <label>
                      <input
                        type="checkbox"
                        checked={descendants}
                        onChange={(e) => setDescendants(e.target.checked)}
                      />{" "}
                      {t("consultation.descendants")}
                    </label>
                  )}
                  <label>
                    <input
                      type="checkbox"
                      checked={reviewed}
                      onChange={(e) => setReviewed(e.target.checked)}
                    />{" "}
                    {t("consultation.reviewedOnly")}
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={hybrid}
                      onChange={(e) => setHybrid(e.target.checked)}
                    />{" "}
                    {t("consultation.hybrid")}
                  </label>
                </div>
                <label className="grid gap-1 text-sm">
                  {t("consultation.function")}
                  <select
                    className={control}
                    value={intent}
                    onChange={(e) => setIntent(e.target.value as "answer" | "comparison")}
                  >
                    <option value="answer">{t("promptCatalogMetadata.labels.answer")}</option>
                    <option value="comparison">
                      {t("promptCatalogMetadata.labels.comparison")}
                    </option>
                  </select>
                </label>
                <ProfilePicker profiles={profiles} value={profile} onChange={setProfile} t={t} />
                <button
                  className={`${control} justify-self-start border-cyan-600 bg-cyan-700 text-white dark:bg-cyan-700`}
                  disabled={question.trim().length < 3}
                  onClick={() => void ask()}
                >
                  {t("consultation.ask")}
                </button>
              </fieldset>
            </details>
          )}
          <ConsultationStatus t={t} error={error} busy={busy} onCancel={() => void cancel()} />
          {result && (
            <ConsultationAnswer t={t} result={result} onOpenSource={onOpenSource} active={active} />
          )}
        </div>
      </div>
    </dialog>
  );
}
