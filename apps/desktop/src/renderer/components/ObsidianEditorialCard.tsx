import { useEffect, useRef, useState } from "react";
import { FileWarning, X } from "lucide-react";
import type { MessageKey, Translator } from "@app/i18n";
import { Button } from "./ui/button";
import { MarkdownEditor } from "./MarkdownEditor";
import { followEditorialConflicts } from "./obsidian-followers";
type Conflict = Awaited<ReturnType<typeof window.app.obsidian.editorialConflicts>>[number];
/** Rows a parent already follows (Settings › Integrations counts them while the card is closed). */
export interface EditorialFeed {
  rows: Conflict[] | null;
  failed: boolean;
  refresh: () => void;
}

/**
 * `heading` is the embedded use (Settings › Integrations): the card sits under a title of its own,
 * takes the quiet heading, has no icon or divider, and draws nothing while no edit waits.
 */
export function ObsidianEditorialCard({
  t,
  feed,
  heading
}: {
  t: (key: MessageKey) => string;
  feed?: EditorialFeed;
  heading?: string;
}) {
  const [ownRows, setOwnRows] = useState<Conflict[] | null>(null),
    [selected, setSelected] = useState<Conflict | null>(null),
    [ownError, setError] = useState(false);
  const rows = feed ? feed.rows : ownRows;
  const error = ownError || Boolean(feed?.failed);
  const refresh = () =>
    feed
      ? feed.refresh()
      : window.app.obsidian
          .editorialConflicts()
          .then(setOwnRows)
          .catch(() => setError(true));
  // One read now, and one after each editorial projection or end of a sync (D16); no timer.
  const followed = feed === undefined;
  useEffect(
    () =>
      followed
        ? followEditorialConflicts(
            () => window.app,
            setOwnRows,
            () => setError(true)
          )
        : undefined,
    [followed]
  );
  if (heading !== undefined && !error && !rows?.length && !selected) return null;
  return (
    <section
      className={heading === undefined ? "grid gap-3 border-t border-border pt-4" : "grid gap-2"}
    >
      {heading === undefined ? (
        <h4 className="flex items-center gap-2 font-medium">
          <FileWarning size={16} />
          {t("obsidianEditing.review")}
        </h4>
      ) : (
        <h4 className="m-0 text-sm font-medium text-foreground">{heading}</h4>
      )}
      {error && (
        <p role="status" className="text-sm text-muted-foreground">
          {t("obsidianEditing.deliveryError")}
        </p>
      )}
      {rows === null ? (
        <p>{t("obsidianWiki.loading")}</p>
      ) : rows.length ? (
        rows.map((row) => (
          <div key={row.id} className="flex items-center gap-3 rounded-xl bg-soft p-3">
            <span className="min-w-0 flex-1 break-words text-sm">
              {row.path}
              {row.receipt.status === "deleted" && (
                <span className="ml-2 text-warning">{t("obsidianEditing.deleted")}</span>
              )}
            </span>
            <Button
              onClick={() => {
                setError(false);
                void window.app.obsidian
                  .editorialComparison(row.id)
                  .then((receipt) => setSelected({ ...row, receipt }))
                  .catch(() => setError(true));
              }}
            >
              {t("obsidianWiki.review")}
            </Button>
          </div>
        ))
      ) : (
        <p className="text-sm text-muted-foreground">{t("obsidianEditing.empty")}</p>
      )}
      {selected && (
        <EditorialComparison
          t={t}
          row={selected}
          close={() => setSelected(null)}
          complete={() => {
            setSelected(null);
            void refresh();
          }}
        />
      )}
    </section>
  );
}
function EditorialComparison({
  row,
  t,
  close,
  complete
}: {
  row: Conflict;
  t: (key: MessageKey) => string;
  close: () => void;
  complete: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    [text, setText] = useState(row.receipt.comparison?.local ?? ""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(false);
  useEffect(() => {
    const focus = document.activeElement;
    ref.current?.showModal();
    return () => {
      ref.current?.close();
      if (focus instanceof HTMLElement) focus.focus();
    };
  }, []);
  async function resolve(choice: "local" | "app" | "manual") {
    setBusy(true);
    setError(false);
    try {
      await window.app.obsidian.resolveEditorial({
        id: row.id,
        choice,
        content: text,
        currentRevision: row.receipt.revision,
        expectedLocal:
          row.receipt.status === "deleted" ? null : (row.receipt.comparison?.local ?? "")
      });
      complete();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={ref}
      aria-labelledby="editorial-comparison-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) close();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.stopPropagation();
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-6xl overflow-auto rounded-2xl bg-surface p-5 text-foreground backdrop:bg-black/60"
    >
      <header className="mb-4 flex gap-3">
        <h2 id="editorial-comparison-title" className="min-w-0 flex-1 break-words font-semibold">
          {row.path}
        </h2>
        <Button autoFocus disabled={busy} onClick={close} aria-label={t("organization.close")}>
          <X size={18} />
        </Button>
      </header>
      {error && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {t("obsidianEditing.stale")}
        </p>
      )}
      <div className="grid gap-3 lg:grid-cols-3">
        {(["base", "local", "app"] as const).map((kind) => (
          <section key={kind}>
            <h3 className="mb-2 text-sm font-semibold">{t(`obsidianEditing.${kind}`)}</h3>
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-soft p-3 text-xs">
              {row.receipt.comparison?.[kind]}
            </pre>
          </section>
        ))}
      </div>
      <fieldset disabled={busy} className="mt-4">
        <MarkdownEditor
          id="obsidian-manual-merge"
          label={t("obsidianEditing.manual")}
          t={t as Translator}
          value={text}
          onChange={setText}
          minHeightClass="min-h-48"
        />
      </fieldset>
      <div className="mt-4 flex flex-wrap gap-2">
        {(["local", "app", "manual"] as const).map((choice) => (
          <Button key={choice} disabled={busy} onClick={() => void resolve(choice)}>
            {t(
              choice === "local"
                ? "obsidianEditing.keepLocal"
                : choice === "app"
                  ? "obsidianEditing.keepApp"
                  : "obsidianEditing.manual"
            )}
          </Button>
        ))}
      </div>
    </dialog>
  );
}
