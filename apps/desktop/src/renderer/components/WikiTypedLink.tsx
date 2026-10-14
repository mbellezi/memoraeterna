import { useContext, useEffect, useRef, useState } from "react";
import type { z } from "zod";
import type { WikiLinkedTargetSchema, WikiEvidence } from "@app/domain";
import type { Translator } from "@app/i18n";
import { AiNoteBadge } from "./AiNoteBadge";
import { MarkdownPreview } from "./MarkdownEditor";
import {
  WikiPageLinksContext,
  lookupWikiLink,
  wikiLinkFetchMode,
  wikiLinkValueToShow
} from "./wiki-page-sync";
/**
 * Links that belong to the page being read take their target from the page's single batched
 * resolution. Links the batch cannot know (successors of an opened note, links shown outside the
 * page) are requested individually, and an opened note card is always read again because the
 * batch cannot see edits made after the revision was resolved.
 */
export function WikiTypedLink({
  pageId,
  revisionId,
  target,
  t,
  active = true,
  onRefreshed,
  onOpenPage,
  onOpenSource,
  onEvidence,
  label,
  inline = false,
  onInlineOpen
}: {
  active?: boolean;
  onRefreshed?: ((value: z.infer<typeof WikiLinkedTargetSchema>) => void) | undefined;
  inline?: boolean | undefined;
  onInlineOpen?: ((value: z.infer<typeof WikiLinkedTargetSchema>) => void) | undefined;
  label?: string | undefined;
  pageId: string;
  revisionId?: string | undefined;
  target: { kind: "page" | "source" | "atomic_note" | "entity"; id: string };
  t: Translator;
  onOpenPage: (id: string) => void;
  onOpenSource: (id: string, noteId?: string) => void;
  onEvidence: (e: WikiEvidence) => void;
}) {
  const links = useContext(WikiPageLinksContext);
  const lookup = lookupWikiLink(links, pageId, revisionId, target);
  const [fetched, setFetched] = useState<
      z.infer<typeof WikiLinkedTargetSchema> | null | undefined
    >(),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(false),
    [retry, setRetry] = useState(0),
    [open, setOpen] = useState(false);
  const mode = wikiLinkFetchMode(lookup, target.kind, open);
  const fetchNeeded = mode === "individual";
  // Individually requested links of this page (successors) refresh with the page's batch.
  const pageBatch = links?.pageId === pageId ? links : null;
  const value = wikiLinkValueToShow(lookup, fetched, mode);
  const refreshed = useRef(onRefreshed);
  refreshed.current = onRefreshed;
  useEffect(() => {
    if (!active || mode === "none") return;
    let live = true;
    // An opened note card keeps showing the batch value until its own read arrives, and keeps it
    // if that read fails; a link only this read can supply shows loading and error states.
    if (mode === "individual") {
      setLoading(true);
      setError(false);
    } else setFetched(undefined);
    void window.app.wiki
      .linkedTarget({ pageId, ...(revisionId ? { revisionId } : {}), ...target })
      .then((v) => {
        if (live) {
          setFetched(v);
          if (v) refreshed.current?.(v);
        }
      })
      .catch(() => {
        if (live && mode === "individual") setError(true);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [pageId, revisionId, target.kind, target.id, retry, active, mode, pageBatch]);
  if (lookup.kind === "failed" || (fetchNeeded && error))
    return (
      <button
        className="text-xs text-rose-600"
        onClick={() => (lookup.kind === "failed" ? links?.retry?.() : setRetry((n) => n + 1))}
      >
        {t("wiki.errors.generic")} · {t("shell.actions.retry")}
      </button>
    );
  if (lookup.kind === "pending" || (fetchNeeded && loading && !value))
    return (
      <span role="status" className="text-xs text-slate-500">
        {t("shell.states.loading")}
      </span>
    );
  if (!value) return <span className="text-xs text-slate-500">{t("wiki.noResults")}</span>;
  if (inline)
    return (
      <span>
        <button
          role="link"
          className="inline text-accent underline decoration-accent/30 underline-offset-4 hover:decoration-current focus-visible:outline-2"
          onClick={() => {
            if (target.kind === "page") onOpenPage(target.id);
            else if (target.kind === "source" && value.sourceItemId)
              onOpenSource(value.sourceItemId);
            else onInlineOpen?.(value);
          }}
        >
          {label ?? value.title}
        </button>
      </span>
    );
  return (
    <div className="min-w-0">
      <button
        data-wiki-note-expanded={open ? "true" : undefined}
        aria-expanded={target.kind === "atomic_note" ? open : undefined}
        className="text-left text-sm text-cyan-700 underline decoration-cyan-500/30 underline-offset-4 hover:decoration-current focus-visible:outline-2 focus-visible:outline-accent dark:text-cyan-300"
        onClick={() => {
          if (target.kind === "page") onOpenPage(target.id);
          else if (target.kind === "source" && value.sourceItemId) onOpenSource(value.sourceItemId);
          else setOpen(!open);
        }}
      >
        {label ?? value.title}
        <span className="ml-1 text-[10px] text-muted-foreground">
          {t(`wiki.results.${target.kind}`)}
        </span>
      </button>
      {open && (
        <div className="mt-3 grid gap-3">
          {value.noteState && (
            <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <AiNoteBadge
                t={t}
                status={value.noteState.status}
                humanProtected={value.noteState.protected}
              />
              <span>
                {t(
                  ("knowledge.notes.status." +
                    value.noteState.status) as import("@app/i18n").MessageKey
                )}{" "}
                · {t(value.noteState.current ? "obsidianWiki.current" : "obsidianWiki.historical")}
                {value.noteState.protected ? " · " + t("obsidianWiki.protected") : ""}
              </span>
            </p>
          )}
          <MarkdownPreview
            markdown={value.markdown}
            emptyLabel={t("wiki.noResults")}
            reference={(token) => {
              const match = /^\[([1-9][0-9]{0,3})\]$/.exec(token),
                e = match ? value.evidence[Number(match[1]) - 1] : null;
              return e ? (
                <button className="inline text-accent underline" onClick={() => onEvidence(e)}>
                  {token}
                </button>
              ) : undefined;
            }}
          />
          {value.successors?.map((next) => (
            <WikiTypedLink
              active={active}
              onRefreshed={onRefreshed}
              key={next.id}
              pageId={pageId}
              revisionId={revisionId}
              target={{ kind: "atomic_note", id: next.id }}
              t={t}
              onOpenPage={onOpenPage}
              onOpenSource={onOpenSource}
              onEvidence={onEvidence}
              label={t("knowledgeEvolution.supersedes") + ": " + next.title}
            />
          ))}
          {value.evidence.map((e, i) => (
            <button
              key={e.id}
              className="text-left text-xs text-cyan-700 dark:text-cyan-300"
              onClick={() => onEvidence(e)}
            >
              [{i + 1}] {t("wiki.inspector")} · {e.sourceTitle}
            </button>
          ))}
          {value.sourceItemId && (
            <button
              className="text-left text-xs underline"
              onClick={() =>
                onOpenSource(
                  value.sourceItemId!,
                  target.kind === "atomic_note" ? target.id : undefined
                )
              }
            >
              {t("wiki.openSource")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
