import type { RefObject } from "react";
import { RefreshCw, X } from "lucide-react";
import type { TopicPage } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../glyphs";
import { Button } from "../ui/button";
import { TopicHeader } from "./TopicHeader";
import { TopicMap } from "./TopicMap";
import { TopicOverviewSlot } from "./TopicOverviewSlot";
import { TopicSideColumn } from "./TopicSideColumn";
import type { TopicPageSnapshot } from "./topic-page-controller";
import { isRootPage, topicTitle, type TopicPageActions } from "./topic-page-model";

export interface TopicPageViewProps {
  t: Translator;
  snapshot: TopicPageSnapshot;
  /** False while the host view is hidden. */
  active: boolean;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  actions: TopicPageActions;
  /** An entry of the page could not be opened. */
  openFailed: boolean;
  /** When the host can close the page (Cmd-W does the same), the strip offers it. */
  onClose?: (() => void) | undefined;
  onRetry: () => void;
  onUndo: () => void;
  onShowAllNotes: () => void;
  onLoadMoreNotes: () => void;
  onRetryNotes: () => void;
}

/**
 * The Topic page: where the topic is, what it holds and what lies beside it, in one article and a
 * side column. Props in, callbacks out: the host decides where it lives; widths come from the
 * container, so the side column drops under the article when the space is narrow.
 */
export function TopicPageView(props: TopicPageViewProps) {
  const { t, snapshot } = props;
  const { load } = snapshot;
  return (
    <div className="@container flex min-w-0 flex-col gap-4">
      <div className="flex items-center gap-3">
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
      {load.status === "loading" ? (
        <div role="status" aria-busy="true" className="flex w-full max-w-190 flex-col gap-4">
          <span className="sr-only">{t("shell.states.loading")}</span>
          <div className="h-4 w-1/2 rounded-md bg-soft" />
          <div className="h-8 w-3/4 rounded-md bg-soft" />
          <div className="h-16 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
          <div className="h-12 rounded-md bg-soft" />
        </div>
      ) : null}
      {load.status === "error" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("topics.page.error")}</p>
          <Button type="button" onClick={props.onRetry}>
            <RefreshCw aria-hidden="true" />
            {t("shell.actions.retry")}
          </Button>
        </div>
      ) : null}
      {load.status === "missing" ? (
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
    </div>
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
