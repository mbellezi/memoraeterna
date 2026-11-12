import type { ReactNode, RefObject } from "react";
import { RefreshCw, X } from "lucide-react";
import { formatObjectAddress, type TopicPage } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { ObjectKindGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { EmptyState } from "../ui/empty-state";
import { ErrorState } from "../ui/error-state";
import { LoadingState, Skeleton, SkeletonLines } from "../ui/skeleton";
import { TopicHeader, type HeaderOps } from "./TopicHeader";
import { TopicMap } from "./TopicMap";
import { TopicOverviewSlot } from "./TopicOverviewSlot";
import { TopicSideColumn } from "./TopicSideColumn";
import type { TopicPageSnapshot } from "./topic-page-controller";
import { countLabel, isRootPage, topicTitle, type TopicPageActions } from "./topic-page-model";

export interface TopicPageViewProps {
  t: Translator;
  snapshot: TopicPageSnapshot;
  /** False while the host view is hidden. */
  active: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  actions: TopicPageActions;
  /** Renaming, moving, creating and pinning the topic (T26); absent, the page is read-only. */
  ops?: HeaderOps | undefined;
  /** The notice with Undo and the open dialog of those operations. */
  overlay?: ReactNode;
  /** An entry of the page could not be opened. */
  openFailed: boolean;
  /** When the host can close the page (Cmd-W does the same), the strip offers it. */
  onClose?: (() => void) | undefined;
  onRetry: () => void;
  onUndo: () => void;
  onShowAllNotes: () => void;
  onLoadMoreNotes: () => void;
  onRetryNotes: () => void;
  /**
   * The page is a panel of the workspace: the frame draws the kind, the close control and the path
   * ribbon, and the states use the shared primitives.
   */
  embedded?: boolean;
  /** The previous panel's compact form (design record 6.1): title, counts, overview and notes. */
  compact?: boolean;
  /** For the compact form: the address of the panel that was opened from this one. */
  current?: string | undefined;
  /** Opens a note of the compact list beside this panel. */
  onOpenNoteAddress?: (address: string) => void;
}

/**
 * The Topic page: where the topic is, what it holds and what lies beside it, in one article and a
 * side column. Props in, callbacks out: the host decides where it lives; widths come from the
 * container, so the side column drops under the article when the space is narrow.
 */
export function TopicPageView(props: TopicPageViewProps) {
  const { t, snapshot, embedded = false } = props;
  const { load } = snapshot;
  if (embedded && props.compact && load.status === "ready")
    return <TopicCompact {...props} page={load.page} />;
  return (
    <div
      className={cn(
        "@container flex min-w-0 flex-col gap-4",
        // The page's column is capped so focus mode can centre it.
        embedded && "mx-auto w-full max-w-264"
      )}
    >
      {embedded ? <EmbeddedStates {...props} /> : null}
      <div className={cn("flex items-center gap-3", embedded && "hidden")}>
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
          <ObjectKindGlyph kind="topic" className="text-object-topic" />
          {t("topics.page.kind")}
        </span>
        <span className="flex-1" />
        {props.onClose ? (
          <Button
            type="button"
            variant="ghost"
            aria-label={t("topics.page.close")}
            title={t("topics.page.close")}
            onClick={props.onClose}
          >
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {snapshot.announcement}
      </p>
      {!embedded && load.status === "loading" ? (
        <div role="status" aria-busy="true" className="flex w-full max-w-190 flex-col gap-4">
          <span className="sr-only">{t("shell.states.loading")}</span>
          <div className="h-4 w-1/2 rounded-md bg-soft" />
          <div className="h-8 w-3/4 rounded-md bg-soft" />
          <div className="h-16 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
        </div>
      ) : null}
      {!embedded && load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("topics.page.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {!embedded && load.status === "missing" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("topics.page.missing")}
        </p>
      ) : null}
      {props.openFailed ? (
        <p role="alert" className="text-sm text-danger">
          {t("objects.whereIsThis.openFailed")}
        </p>
      ) : null}
      {load.status === "ready" ? (
        <div className="grid min-w-0 gap-8 @4xl:grid-cols-[minmax(0,47.5rem)_16rem]">
          <TopicArticle {...props} page={load.page} />
          <TopicSideColumn t={t} page={load.page} active={props.active} actions={props.actions} />
        </div>
      ) : null}
      {props.overlay}
    </div>
  );
}

/**
 * The three states of a topic in a panel (design record 5.12, 6): a skeleton in the shape of the
 * page, no wider than the reading measure; one plain sentence in place with what is kept and one
 * retry; and what a topic that is gone says (merged or removed). The page is the success state.
 */
function EmbeddedStates({ t, snapshot, onRetry }: TopicPageViewProps) {
  const { load } = snapshot;
  if (load.status === "loading")
    return (
      <LoadingState t={t} className="max-w-(--measure) gap-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-7 w-3/5" />
        <Skeleton className="w-1/2" />
        <SkeletonLines lines={3} className="mt-3" />
      </LoadingState>
    );
  if (load.status === "error")
    return (
      <ErrorState
        t={t}
        className="max-w-(--measure)"
        message={t("explore.topic.error")}
        kept={t("explore.topic.errorKept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={onRetry}
      />
    );
  if (load.status === "missing")
    return (
      <EmptyState className="max-w-(--measure)" headline={t("explore.topic.goneHeadline")}>
        {t("explore.topic.goneBody")}
      </EmptyState>
    );
  return null;
}

/**
 * The previous panel's form (design record 6.1): the title at lead size, the counts, the first
 * lines of the overview and the notes of the topic, with the one that was opened marked by the
 * accent colour and a bar (`aria-current`).
 */
function TopicCompact(props: TopicPageViewProps & { page: TopicPage }) {
  const { t, page, current } = props;
  const title = topicTitle(t, page.topic, isRootPage(page));
  const overview = page.overview.status === "ready" ? page.overview.paragraphs[0]?.text : null;
  return (
    <article aria-label={t("topics.page.articleLabel", { values: { title } })} className="min-w-0">
      <h2
        lang={page.topic.nameLanguage ?? undefined}
        className="m-0 mb-1 font-reading text-lg leading-snug font-semibold text-foreground [text-wrap:balance]"
      >
        {title}
      </h2>
      <p className="m-0 mb-3 text-xs text-secondary-foreground">
        {countLabel(t, "notes", page.counts.notes)}
        {page.counts.sources > 0 ? ` · ${countLabel(t, "sources", page.counts.sources)}` : ""}
      </p>
      {overview ? (
        <p className="m-0 mb-3 line-clamp-4 font-reading text-sm leading-6 text-secondary-foreground">
          {overview.replace(/\s*\[[\d,\s]+\]/gu, "")}
        </p>
      ) : null}
      {page.centralNotes.length > 0 ? (
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {page.centralNotes.map((note) => {
            const address = formatObjectAddress({ kind: "note", id: note.id });
            const isCurrent = address === current;
            return (
              <li key={note.id}>
                <button
                  type="button"
                  aria-current={isCurrent ? "true" : undefined}
                  onClick={() => props.onOpenNoteAddress?.(address)}
                  className={cn(
                    "relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover",
                    "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                    isCurrent &&
                      "bg-surface-selected before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                  )}
                >
                  <ObjectKindGlyph kind="note" size={14} className="mt-[3px] text-object-note" />
                  <span className="min-w-0 [text-wrap:pretty]">{note.title}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="m-0 text-sm text-muted-foreground">{t("explore.topic.noDirectNotes")}</p>
      )}
    </article>
  );
}

function TopicArticle(props: TopicPageViewProps & { page: TopicPage }) {
  const { t, page, snapshot } = props;
  const title = topicTitle(t, page.topic, isRootPage(page));
  return (
    <article
      aria-label={t("topics.page.articleLabel", { values: { title } })}
      className="flex min-w-0 flex-col gap-8 pb-12"
    >
      <TopicHeader
        t={t}
        page={page}
        readAt={snapshot.readAt}
        undo={snapshot.undo}
        headingRef={props.headingRef}
        actions={props.actions}
        ops={props.ops}
        ribbon={props.embedded === true}
        onUndo={props.onUndo}
      />
      <TopicOverviewSlot
        t={t}
        topic={{ id: page.topic.id, title }}
        overview={page.overview}
        active={props.active}
        actions={props.actions}
      />
      <TopicMap
        t={t}
        page={page}
        notes={snapshot.notes}
        actions={props.actions}
        onShowAllNotes={props.onShowAllNotes}
        onLoadMoreNotes={props.onLoadMoreNotes}
        onRetryNotes={props.onRetryNotes}
      />
    </article>
  );
}
