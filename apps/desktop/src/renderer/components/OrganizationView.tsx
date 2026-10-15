import { MaintenanceView } from "./MaintenanceView";
import { EvidenceScopePicker } from "./ask/EvidenceScopePicker";
import { SourceRelationReferenceText } from "./SourceRelationReferenceText";
import { SourceRelationsList } from "./SourceRelationsList";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  BookOpen,
  Check,
  ChevronDown,
  FlaskConical,
  History,
  LoaderCircle,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { z } from "zod";
import {
  organizationCitationMarkdown,
  OrganizationSettingsSchema,
  OrganizationRunSchema,
  OrganizationRunSummarySchema,
  OrganizationConfigurationSchema,
  OrganizationStartSchema,
  defaultOrganizationConfiguration,
  resolveOrganizationInstructions,
  type OrganizationConfiguration,
  type OrganizationRun,
  type OrganizationRunSummary,
  type OrganizationCommand,
  type WikiPage
} from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";
import type { AiProfile } from "../../shared/ipc";
import { MarkdownEditor, MarkdownPreview } from "./MarkdownEditor";
/** Ask owns the pickers; these re-exports serve the legacy views until they are deleted. */
export { EvidenceScopePicker } from "./ask/EvidenceScopePicker";
export { ProfilePicker } from "./ask/ProfilePicker";
const card =
  "rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-900";
const control =
  "rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-cyan-500 disabled:opacity-40 dark:border-slate-700 dark:bg-slate-900";
const primary = `${control} inline-flex items-center justify-center gap-2 border-cyan-700 bg-cyan-700 text-white dark:bg-cyan-700`;
const command = (input: OrganizationCommand) => window.app.organization.command(input);
const errorKey = (e: unknown): MessageKey =>
  (String(e).match(/organization\.errors\.[A-Za-z]+/)?.[0] as MessageKey) ??
  "organization.errors.failed";
type Settings = z.infer<typeof OrganizationSettingsSchema>;
type PageSummary = Omit<WikiPage, "sections" | "evidence" | "breadcrumbs">;
export function RunCard({
  summary,
  t,
  refresh,
  initialOpen = false
}: {
  summary: OrganizationRunSummary;
  t: Translator;
  refresh: () => Promise<void>;
  initialOpen?: boolean;
}) {
  const [run, setRun] = useState<OrganizationRun | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<MessageKey | null>(null),
    [open, setOpen] = useState(initialOpen);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void command({ command: "get", id: summary.id })
      .then((value) => {
        if (active) setRun(OrganizationRunSchema.parse(value));
      })
      .catch((e) => {
        if (active) setError(errorKey(e));
      });
    return () => {
      active = false;
    };
  }, [open, summary.id, summary.updatedAt]);
  async function act(input: OrganizationCommand) {
    setBusy(true);
    setError(null);
    try {
      await command(input);
      await refresh();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  }
  if (!run)
    return (
      <article className={card}>
        <button
          className="flex w-full items-center justify-between gap-3 text-left"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <span>
            <strong className="block">{summary.title}</strong>
            <span className="text-xs text-slate-500">
              {t(
                `organization.${summary.receiptRevisionId ? "applied" : summary.status === "analyzing" && summary.modelState === "waiting" ? "waitingModel" : summary.status}`
              )}{" "}
              · {new Date(summary.createdAt).toLocaleString()}
            </span>
          </span>
          {open ? <LoaderCircle size={18} className="animate-spin" /> : <ChevronDown size={18} />}
        </button>
        {error && (
          <p role="alert" className="mt-3 text-sm text-red-600">
            {t(error)}
          </p>
        )}
      </article>
    );
  const proposal = run.proposal?.tool === "proposePageChange" ? run.proposal : null;
  return (
    <article className={card}>
      <button
        className="flex w-full items-start gap-3 text-left"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="rounded-xl bg-cyan-50 p-2 text-cyan-700 dark:bg-cyan-950">
          <Sparkles size={18} />
        </span>
        <span className="min-w-0 flex-1">
          <strong className="block truncate">{run.snapshot.baseContent.title}</strong>
          <span className="text-xs text-slate-500">
            {t(`organization.${summary.receiptRevisionId ? "applied" : summary.status}`)} ·{" "}
            {new Date(run.createdAt).toLocaleString()}
          </span>
        </span>
        {["queued", "analyzing"].includes(run.status) ? (
          <LoaderCircle size={18} className="animate-spin" />
        ) : (
          <ChevronDown size={18} />
        )}
      </button>
      {open && (
        <div className="mt-4 grid gap-4">
          {run.checkpoint.error && (
            <p role="status" className="text-sm text-amber-700 dark:text-amber-300">
              {t(errorKey(run.checkpoint.error))}
            </p>
          )}
          {proposal && (
            <>
              <p className="text-sm text-slate-600 dark:text-slate-300">{proposal.explanation}</p>
              {proposal.sections.map((op, i) => (
                <section
                  key={i}
                  className={`grid gap-3 border-t border-slate-200 pt-4 dark:border-slate-800 ${op.sectionId ? "lg:grid-cols-2" : ""}`}
                >
                  {op.sectionId && (
                    <div className="rounded-xl bg-slate-50 p-4 dark:bg-slate-950">
                      <p className="mb-2 text-xs font-semibold uppercase text-slate-500">
                        {t("organization.before")} ·{" "}
                        {
                          run.snapshot.baseContent.sections.find((s) => s.id === op.sectionId)
                            ?.title
                        }
                      </p>
                      <MarkdownPreview
                        emptyLabel={t("organization.newSection")}
                        markdown={
                          run.snapshot.baseContent.sections.find((s) => s.id === op.sectionId)
                            ?.markdown ?? t("organization.newSection")
                        }
                      />
                    </div>
                  )}
                  <div className="rounded-xl bg-cyan-50/60 p-4 dark:bg-cyan-950/20">
                    <p className="mb-2 text-xs font-semibold uppercase text-cyan-700 dark:text-cyan-300">
                      {t(op.sectionId ? "organization.after" : "organization.newSection")} ·{" "}
                      {op.title}
                    </p>
                    <MarkdownPreview
                      emptyLabel={t("organization.newSection")}
                      markdown={organizationCitationMarkdown(op)}
                    />
                    <div className="mt-3 grid gap-2">
                      {op.citations.map((h, citationIndex) => {
                        const e = run.snapshot.evidence.find((e) => e.handle === h);
                        return (
                          e && (
                            <details key={h} className="text-xs">
                              <summary className="cursor-pointer font-medium">
                                [{citationIndex + 1}] {e.sourceTitle}
                              </summary>
                              <blockquote className="mt-2 whitespace-pre-wrap border-l-2 border-cyan-300 pl-3 text-slate-600 dark:text-slate-300">
                                {e.excerpt}
                              </blockquote>
                              <span className="text-slate-500">
                                {e.documentCreatedAt} · {e.locator}
                              </span>
                            </details>
                          )
                        );
                      })}
                    </div>
                  </div>
                </section>
              ))}
            </>
          )}
          {!!run.snapshot.relations.length && (
            <details className="text-sm">
              <summary className="cursor-pointer">
                {t("organization.relations")} ({run.snapshot.relations.length})
              </summary>
              <p className="my-2 text-xs text-slate-500">{t("organization.relationHint")}</p>
              {run.snapshot.relations.map((r) => (
                <div
                  key={r.id}
                  className="my-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
                >
                  <span className="text-xs">{t(`sourceRelations.${r.review}` as MessageKey)}</span>
                  <p>
                    <SourceRelationReferenceText
                      text={r.sourceIdea + " → " + r.targetIdea}
                      relation={{
                        ...r,
                        sourceTitle:
                          run.snapshot.evidence.find((e) => e.handle === r.sourceHandle)
                            ?.sourceTitle ?? "",
                        targetTitle:
                          run.snapshot.evidence.find((e) => e.handle === r.targetHandle)
                            ?.sourceTitle ?? ""
                      }}
                    />
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    <SourceRelationReferenceText
                      text={r.explanation}
                      relation={{
                        ...r,
                        sourceTitle:
                          run.snapshot.evidence.find((e) => e.handle === r.sourceHandle)
                            ?.sourceTitle ?? "",
                        targetTitle:
                          run.snapshot.evidence.find((e) => e.handle === r.targetHandle)
                            ?.sourceTitle ?? ""
                      }}
                    />
                  </p>
                  <SourceRelationsList
                    sourceItemId={r.sourceItemId}
                    targetSourceItemId={r.targetSourceItemId}
                    relationId={r.id}
                    t={t}
                  />
                </div>
              ))}
            </details>
          )}
          {run.snapshot.contextCoverage &&
            run.snapshot.contextCoverage.included < run.snapshot.contextCoverage.available && (
              <p className="rounded-lg bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
                {t("consultation.contextCoverage", { values: run.snapshot.contextCoverage })}
              </p>
            )}
          {run.snapshot.participation && (
            <details className="rounded-lg bg-amber-500/10 p-3 text-sm">
              <summary>
                {t(
                  run.snapshot.participation.omissions.length
                    ? "consultation.partial"
                    : "consultation.complete"
                )}
              </summary>
              {run.snapshot.participation.omissions.map((o, i) => (
                <p key={i}>
                  {t(`jobs.stages.${o.stage}` as MessageKey)} · {o.status} ·{" "}
                  {o.sourceItemId?.slice(0, 8)}
                </p>
              ))}
            </details>
          )}
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">{t("organization.usage")}</summary>
            <dl className="mt-2 grid gap-1">
              <div>
                {run.snapshot.profile.modelId} · {run.snapshot.profile.runtime}
              </div>
              <div>
                {t("organization.modelCalls")}: {run.checkpoint.calls}/
                {run.snapshot.functionName === "consultation" ? 2 : run.snapshot.limits.modelCalls}{" "}
                · {t("organization.toolCalls")}: {run.checkpoint.tools}/
                {run.snapshot.functionName === "consultation" ? 1 : run.snapshot.limits.tools}
              </div>
              <div>
                {t("organization.inputTokens")}:{" "}
                {run.checkpoint.usageCounts.input
                  ? run.checkpoint.reportedInputTokens
                  : t("organization.unavailable")}{" "}
                · {t("organization.outputTokens")}:{" "}
                {run.checkpoint.usageCounts.output
                  ? run.checkpoint.reportedOutputTokens
                  : t("organization.unavailable")}
              </div>
              <div>
                {t("organization.estimatedCost")}:{" "}
                {run.checkpoint.usageCounts.cost
                  ? run.checkpoint.costEstimate.toFixed(4)
                  : t("organization.unavailable")}
              </div>
              <div>
                {run.snapshot.contentLanguage} · {run.snapshot.configurationHash.slice(0, 12)}
              </div>
            </dl>
            {run.checkpoint.usageIncomplete && (
              <p className="mt-2">{t("organization.usageIncomplete")}</p>
            )}
            <pre className="mt-3 max-h-52 overflow-auto whitespace-pre-wrap">
              {JSON.stringify(run.snapshot.instructions, null, 2)}
            </pre>
          </details>
          {error && (
            <p role="alert" className="text-sm text-red-600">
              {t(error)}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {run.status === "awaiting_review" && !run.receiptRevisionId && (
              <>
                <button
                  disabled={busy}
                  className={primary}
                  onClick={() => void act({ command: "review", id: run.id, decision: "accept" })}
                >
                  <Check size={16} />
                  {t("organization.accept")}
                </button>
                <button
                  disabled={busy}
                  className={control}
                  onClick={() => void act({ command: "review", id: run.id, decision: "reject" })}
                >
                  {t("organization.reject")}
                </button>
              </>
            )}
            {["queued", "analyzing", "awaiting_review"].includes(run.status) &&
              !run.receiptRevisionId && (
                <button
                  disabled={busy}
                  className={control}
                  onClick={() => void act({ command: "cancel", id: run.id })}
                >
                  {t("organization.cancel")}
                </button>
              )}
            {(run.status === "canceled" ||
              (run.status === "failed" &&
                ["organization.errors.failed", "organization.errors.uncertain"].includes(
                  run.checkpoint.error ?? ""
                ))) && (
              <button
                disabled={busy}
                className={control}
                onClick={() => void act({ command: "retry", id: run.id })}
              >
                {t("organization.retry")}
              </button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
export function OrganizationRuns({
  t,
  refreshKey = 0,
  onRefresh
}: {
  t: Translator;
  refreshKey?: number;
  onRefresh?: () => void;
}) {
  const [runs, setRuns] = useState<OrganizationRunSummary[]>([]),
    [error, setError] = useState<MessageKey | null>(null),
    [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      setRuns(z.array(OrganizationRunSummarySchema).parse(await command({ command: "list" })));
      setError(null);
      onRefresh?.();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setLoading(false);
    }
  }, [onRefresh]);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh, refreshKey]);
  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{t("organization.runs")}</h3>
        <button className={control} onClick={() => void refresh()}>
          {t("organization.refresh")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-red-600">
          {t(error)}
        </p>
      )}
      {loading ? (
        <p role="status">{t("organization.loading")}</p>
      ) : !runs.length ? (
        <p className={`${card} text-sm text-slate-500`}>{t("organization.empty")}</p>
      ) : (
        runs.map((run) => <RunCard key={run.id} summary={run} t={t} refresh={refresh} />)
      )}
    </div>
  );
}
export function OrganizationSettingsView({
  t,
  onPrompts
}: {
  t: Translator;
  contentLanguage: string;
  onPrompts?: (id?: string, domainId?: string | null) => void;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [profiles, setProfiles] = useState<AiProfile[]>([]),
    [pages, setPages] = useState<PageSummary[]>([]),
    [error, setError] = useState<MessageKey | null>(null),
    [busy, setBusy] = useState(false);
  const [domains, setDomains] = useState<OrganizationConfiguration["domains"]>([]),
    [domainId, setDomainId] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const [value, profiles, pages] = await Promise.all([
        command({ command: "settings" }),
        window.app.ai.listProfiles(),
        window.app.wiki.list()
      ]);
      const parsed = OrganizationSettingsSchema.parse(value);
      setSettings(parsed);
      setDomains(
        parsed.revisions.find((r) => r.id === parsed.activeId)?.configuration.domains ?? []
      );
      setProfiles(profiles);
      setPages(pages);
    } catch (e) {
      setError(errorKey(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const domain = domains.find((d) => d.id === domainId);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await command({
        command: "saveDomains",
        domains: domains.map(({ id, name, sourceIds, pageIds }) => ({
          id,
          name,
          sourceIds,
          pageIds
        }))
      });
      await load();
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="grid min-w-0 gap-5">
      <header>
        <h2 className="text-2xl font-semibold">{t("organization.title")}</h2>
        <p className="mt-2 text-sm text-slate-500">{t("organization.description")}</p>
      </header>
      <div className={card}>
        <p className="mb-3 text-sm">{t("prompts.moved")}</p>
        <button className={primary} onClick={() => onPrompts?.("organization.curator", domainId)}>
          {t("prompts.open")}
        </button>
      </div>
      {error && (
        <p role="alert" className="text-red-600">
          {t(error)}{" "}
          <button className={control} onClick={() => void load()}>
            {t("organization.refresh")}
          </button>
        </p>
      )}
      {!settings ? (
        <p role="status">{t("organization.loading")}</p>
      ) : (
        <>
          <details className={card}>
            <summary className="cursor-pointer font-semibold">{t("organization.domains")}</summary>
            <div className="mt-3 flex flex-wrap gap-2">
              <select
                className={control}
                aria-label={t("organization.domains")}
                value={domainId ?? ""}
                onChange={(e) => setDomainId(e.target.value || null)}
              >
                <option value="">{t("organization.global")}</option>
                {domains.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <button
                className={control}
                disabled={busy || domains.length >= 30}
                onClick={() => {
                  const id = crypto.randomUUID();
                  setDomains((old) => [
                    ...old,
                    {
                      id,
                      name: t("organization.name"),
                      sourceIds: [],
                      pageIds: [],
                      slots: {},
                      pageSynthesis: {}
                    }
                  ]);
                  setDomainId(id);
                }}
              >
                {t("organization.addDomain")}
              </button>
            </div>
            {domain && (
              <div className="mt-3 grid gap-3">
                <label className="grid gap-1 text-sm">
                  {t("organization.name")}
                  <input
                    className={control}
                    value={domain.name}
                    onChange={(e) =>
                      setDomains((old) =>
                        old.map((d) => (d.id === domain.id ? { ...d, name: e.target.value } : d))
                      )
                    }
                  />
                </label>
                <EvidenceScopePicker
                  selected={domain.sourceIds}
                  onChange={(sourceIds) =>
                    setDomains((old) =>
                      old.map((d) => (d.id === domain.id ? { ...d, sourceIds } : d))
                    )
                  }
                  t={t}
                />
                <label className="grid gap-1 text-sm">
                  {t("wiki.pages")}
                  <select
                    multiple
                    className={control}
                    value={domain.pageIds}
                    onChange={(e) => {
                      const pageIds = Array.from(e.target.selectedOptions, (o) => o.value);
                      setDomains((old) =>
                        old.map((d) => (d.id === domain.id ? { ...d, pageIds } : d))
                      );
                    }}
                  >
                    {pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            <button className={control + " mt-3"} disabled={busy} onClick={() => void save()}>
              {t("wiki.save")}
            </button>
          </details>
        </>
      )}
      <OrganizationRuns t={t} />
    </div>
  );
}
