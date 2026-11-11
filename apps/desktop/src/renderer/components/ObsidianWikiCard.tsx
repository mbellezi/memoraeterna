import { ObsidianLayoutCard } from "./ObsidianLayoutCard";
import { ObsidianEditorialCard } from "./ObsidianEditorialCard";
import { useEffect, useRef, useState } from "react";
import { BookOpen, FileWarning, X } from "lucide-react";
import type { MessageKey, TranslateOptions } from "@app/i18n";
import { EvidenceScopePicker } from "./ask/EvidenceScopePicker";
import { ObsidianRetiredReport } from "./ObsidianRetiredReport";
import { followWikiStatus } from "./obsidian-followers";
import { Button } from "./ui/button";
type Translator = (key: MessageKey, options?: TranslateOptions) => string;
type Status = Awaited<ReturnType<typeof window.app.obsidian.wikiStatus>>;
type Diff = Awaited<ReturnType<typeof window.app.obsidian.wikiDiff>>;
type Conflict = Status["conflicts"][number];
const errorKeys = ["conflict", "binding", "paused", "limit", "format", "write"] as const;
/** The message of a failed job or file, from the error key it carries. */
const errorMessage = (error: string | null): MessageKey =>
  `obsidianWiki.errors.${errorKeys.find((key) => error?.includes(key)) ?? "write"}`;
/** A file the projection could not write and that has nothing to review (too large, invalid). */
export const isFailedFile = (row: Conflict) =>
  row.status === "error" && /errors\.(limit|format|binding)/.test(row.error ?? "");
export function ObsidianWikiCard({ t }: { t: Translator }) {
  const [status, setStatus] = useState<Status | null>(null),
    [scope, setScope] = useState<Status["scope"] | null>(null),
    [error, setError] = useState<MessageKey | null>(null),
    [busy, setBusy] = useState(false),
    [diff, setDiff] = useState<Diff | null>(null);
  // One read now, and one after each wiki projection page, a sync that ended or a change of the
  // vault settings (D16); no timer. The scope is taken from the first read only: the one being
  // edited is never replaced by a later read.
  useEffect(
    () =>
      followWikiStatus(
        () => window.app,
        (value) => {
          setStatus(value);
          setScope((current) => current ?? value.scope);
        },
        () => setError("obsidianWiki.errors.load")
      ),
    []
  );
  async function action(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (error) {
      const message = String(error);
      setError(
        message.includes("conflict")
          ? "obsidianWiki.errors.conflict"
          : message.includes("paused")
            ? "obsidianWiki.errors.paused"
            : message.includes("unsafe_obsidian")
              ? "obsidianWiki.errors.retiredMove"
              : message.includes("binding")
                ? "obsidianWiki.errors.binding"
                : message.includes("write")
                  ? "obsidianWiki.errors.write"
                  : "obsidianWiki.errors.load"
      );
    } finally {
      setBusy(false);
    }
  }
  const failed = status?.conflicts.filter(isFailedFile) ?? [];
  const pending = status?.conflicts.filter((row) => !isFailedFile(row)) ?? [];
  return (
    <section className="grid gap-3 rounded-2xl border border-border bg-surface p-5">
      <h3 className="flex items-center gap-2 font-semibold">
        <BookOpen size={18} aria-hidden="true" />
        {t("obsidianWiki.title")}
      </h3>
      <p className="text-sm text-muted-foreground">
        {t("obsidianEditing.scopeHint")} {t("obsidianWiki.queued")}
      </p>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {t(error)}
        </p>
      )}
      {status?.job && (
        <p role="status" className="text-sm">
          {t(`jobs.status.${status.job.status}`)}
          {status.job.error && (
            <span className="ml-2 text-danger">{t(errorMessage(status.job.error))}</span>
          )}
        </p>
      )}
      {status?.delivery && status.delivery.total > 0 && (
        <DeliveryProgress t={t} delivery={status.delivery} />
      )}
      {!status ? (
        <p role="status">{t("obsidianWiki.loading")}</p>
      ) : (
        <>
          <details>
            <summary className="cursor-pointer text-sm font-medium">
              {t("obsidianWiki.scope")}
            </summary>
            {scope && (
              <fieldset disabled={busy} className="mt-4 grid gap-4">
                <EvidenceScopePicker
                  selected={scope.sourceIds}
                  onChange={(sourceIds) => setScope({ ...scope, sourceIds })}
                  t={t}
                  hint="obsidianWiki.allSources"
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={scope.includeDescendants}
                    onChange={(e) => setScope({ ...scope, includeDescendants: e.target.checked })}
                  />
                  {t("obsidianWiki.descendants")}
                </label>
                <p className="text-xs text-muted-foreground">{t("obsidianWiki.topicScope")}</p>
                <Button
                  className="justify-self-start"
                  onClick={() =>
                    void action(async () => {
                      setScope(await window.app.obsidian.saveWikiScope(scope));
                      setStatus(await window.app.obsidian.wikiStatus());
                    })
                  }
                >
                  {t("obsidianWiki.saveScope")}
                </Button>
              </fieldset>
            )}
          </details>
          <ObsidianFailedFiles t={t} failed={failed} />
          {pending.length ? (
            <div className="grid gap-2">
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <FileWarning size={16} aria-hidden="true" />
                {t("obsidianWiki.pending")}
              </h4>
              {pending.map((c) => (
                <div key={c.id} className="flex min-w-0 items-center gap-3 rounded-xl bg-soft p-3">
                  <span
                    id={`obsidian-pending-${c.id}`}
                    className="min-w-0 flex-1 break-words text-xs"
                  >
                    {c.relative_path}
                  </span>
                  <Button
                    disabled={busy}
                    aria-describedby={`obsidian-pending-${c.id}`}
                    onClick={() =>
                      void action(async () => setDiff(await window.app.obsidian.wikiDiff(c.id)))
                    }
                  >
                    {t("obsidianWiki.review")}
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            failed.length === 0 && (
              <p className="text-sm text-muted-foreground">{t("obsidianWiki.empty")}</p>
            )
          )}
          <ObsidianRetiredReport
            t={t}
            retired={status.retired}
            busy={busy}
            active={status.active}
            onMove={(id) =>
              void action(async () => {
                setStatus(await window.app.obsidian.moveRetiredWiki({ id }));
              })
            }
          />
        </>
      )}
      {diff && (
        <ProjectionDiff
          error={error}
          t={t}
          diff={diff}
          busy={busy}
          active={status?.active ?? false}
          onClose={() => setDiff(null)}
          onRecover={() =>
            void action(async () => {
              setStatus(
                await window.app.obsidian.recoverWiki({ id: diff.id, expectedHash: diff.localHash })
              );
              setDiff(null);
            })
          }
        />
      )}
      <ObsidianLayoutCard t={t} />
      <ObsidianEditorialCard t={t} />
    </section>
  );
}
/** Files the projection could not write, each by its vault path and why; nothing when none. */
export function ObsidianFailedFiles({ t, failed }: { t: Translator; failed: Conflict[] }) {
  if (!failed.length) return null;
  return (
    <section aria-labelledby="obsidian-failed-title" className="grid gap-2">
      <h4 id="obsidian-failed-title" className="flex items-center gap-2 text-sm font-medium">
        <FileWarning size={16} className="text-danger" aria-hidden="true" />
        {t("obsidianWiki.failedTitle")}
      </h4>
      <ul className="grid gap-2">
        {failed.map((row) => (
          <li key={row.id} className="grid min-w-0 gap-1 rounded-xl bg-soft p-3">
            <span className="break-words text-xs">{row.relative_path}</span>
            <span className="text-xs text-muted-foreground">
              {t(
                row.error?.includes("limit") ? "obsidianWiki.fileTooLarge" : errorMessage(row.error)
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
/** Where the paged delivery stands: files delivered of the pass's total, and any that failed. */
export function DeliveryProgress({
  t,
  delivery
}: {
  t: Translator;
  delivery: NonNullable<Status["delivery"]>;
}) {
  const values = {
    delivered: delivery.delivered,
    total: delivery.total,
    failed: delivery.failed
  };
  const key: MessageKey =
    delivery.state === "running"
      ? "obsidianWiki.deliveryRunning"
      : delivery.state === "done"
        ? "obsidianWiki.deliveryDone"
        : "obsidianWiki.deliveryStopped";
  return (
    <div className="grid gap-1" data-testid="obsidian-delivery">
      <p role="status" aria-live="polite" className="text-sm">
        {t(key, { values })}
        {delivery.failed > 0 && (
          <span className="ml-2 text-danger">{t("obsidianWiki.deliveryFailed", { values })}</span>
        )}
      </p>
      {delivery.state === "running" && (
        <div
          className="h-1.5 overflow-hidden rounded-full bg-soft"
          role="progressbar"
          aria-label={t("obsidianWiki.deliveryLabel")}
          aria-valuemin={0}
          aria-valuemax={delivery.total}
          aria-valuenow={Math.min(delivery.delivered, delivery.total)}
        >
          <div
            className="h-full rounded-full bg-accent"
            style={{
              width: `${(100 * Math.min(delivery.delivered, delivery.total)) / delivery.total}%`
            }}
          />
        </div>
      )}
    </div>
  );
}
function ProjectionDiff({
  t,
  diff,
  busy,
  active,
  error,
  onClose,
  onRecover
}: {
  error: MessageKey | null;
  t: Translator;
  diff: Diff;
  busy: boolean;
  active: boolean;
  onClose: () => void;
  onRecover: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const focus = document.activeElement;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (focus instanceof HTMLElement) focus.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby="projection-diff-title"
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl overflow-auto rounded-2xl bg-soft p-5 text-foreground backdrop:bg-background/70"
    >
      <header className="flex items-center gap-3">
        <h2 id="projection-diff-title" className="min-w-0 flex-1 break-words font-semibold">
          {diff.relativePath}
        </h2>
        <Button autoFocus aria-label={t("organization.close")} onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </Button>
      </header>
      <p className="my-4 text-sm text-muted-foreground">{t("obsidianWiki.recoveryHint")}</p>
      {error && (
        <p role="alert" className="mb-4 text-sm text-danger">
          {t(error)}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        {(["base", "local", "proposed"] as const).map((kind) => (
          <section key={kind} className="min-w-0">
            <h3 className="mb-2 text-sm font-semibold">{t(`obsidianWiki.${kind}`)}</h3>
            <pre className="max-h-[50vh] overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-surface p-3 text-xs">
              {diff[kind]}
            </pre>
          </section>
        ))}
      </div>
      <Button className="mt-4" disabled={busy || !active} onClick={onRecover}>
        {t("obsidianWiki.recover")}
      </Button>
    </dialog>
  );
}
