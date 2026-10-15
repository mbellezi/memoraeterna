import type { RefObject } from "react";
import {
  ChevronRight,
  CircleCheck,
  FolderInput,
  FolderPlus,
  ListTree,
  OctagonAlert,
  Pencil,
  Pin,
  PinOff,
  TriangleAlert,
  Undo2
} from "lucide-react";
import type { TopicPage } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { InlineTitleEditor } from "../topics/ops/InlineTitleEditor";
import { opsErrorText } from "../topics/ops/topic-ops";
import { Button } from "../ui/button";
import type { UndoState } from "./topic-page-controller";
import {
  breadcrumb,
  changeBannerText,
  countLabel,
  healthViews,
  isRootPage,
  topicTitle,
  type HealthTone,
  type TopicPageActions
} from "./topic-page-model";

const toneClass: Record<HealthTone, string> = {
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger"
};

const toneIcon: Record<HealthTone, typeof CircleCheck> = {
  success: CircleCheck,
  warning: TriangleAlert,
  danger: OctagonAlert
};

/** What the header needs to change the topic it shows (T26); absent, the header is read-only. */
export interface HeaderOps {
  /** The heading is being renamed in place. */
  renaming: boolean;
  busy: boolean;
  /** The last operation was refused. */
  error: MessageKey | null;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onCancelRename: () => void;
  onCreate: () => void;
  onMove: () => void;
  onTogglePin: () => void;
}

export interface TopicHeaderProps {
  t: Translator;
  page: TopicPage;
  /** When the page was read: "today" in the banner is measured against it. */
  readAt: number;
  undo: UndoState;
  headingRef?: RefObject<HTMLHeadingElement | null> | undefined;
  actions: TopicPageActions;
  ops?: HeaderOps | undefined;
  onUndo: () => void;
}

/** Path, name, description, counts, health, other names, the redirect notice and the last change. */
export function TopicHeader({
  t,
  page,
  readAt,
  undo,
  headingRef,
  actions,
  ops,
  onUndo
}: TopicHeaderProps) {
  const { topic } = page;
  const title = topicTitle(t, topic, isRootPage(page));
  const crumbs = breadcrumb(t, page.path);
  const health = healthViews[topic.health];
  const HealthIcon = toneIcon[health.tone];
  const lang = topic.nameLanguage ?? undefined;
  const root = isRootPage(page);
  const pinned = topic.management === "pinned";
  return (
    <header className="flex flex-col gap-3">
      {page.redirectedFrom ? (
        <p role="status" className="rounded-md bg-info-soft px-3 py-2 text-sm text-foreground">
          {t("topics.page.redirected")}
        </p>
      ) : null}
      {crumbs.length > 1 ? (
        <nav aria-label={t("topics.page.pathLabel")} className="min-w-0">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
            {crumbs.map((crumb) => (
              <li key={crumb.id} className="flex min-w-0 items-center gap-1">
                {crumb.current ? (
                  <span
                    aria-current="page"
                    className="font-medium text-foreground [overflow-wrap:anywhere]"
                  >
                    {crumb.label}
                  </span>
                ) : (
                  <>
                    <button
                      type="button"
                      className="rounded-sm text-left text-secondary-foreground [overflow-wrap:anywhere] hover:text-accent hover:underline"
                      onClick={() => actions.openTopic(crumb.id)}
                    >
                      {crumb.label}
                    </button>
                    <ChevronRight
                      className="size-3.5 shrink-0 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <h1
        ref={headingRef}
        tabIndex={-1}
        lang={topic.title !== null ? lang : undefined}
        className="font-reading text-2xl font-semibold text-foreground [overflow-wrap:anywhere] outline-none"
      >
        {ops?.renaming ? (
          <InlineTitleEditor
            initial={topic.title ?? ""}
            label={t("topics.ops.rename.label")}
            invalid={ops.error !== null}
            busy={ops.busy}
            lang={lang}
            className="h-10 text-xl font-semibold"
            onCommit={ops.onCommitRename}
            onCancel={ops.onCancelRename}
          />
        ) : (
          title
        )}
      </h1>
      {ops ? (
        <div
          role="group"
          aria-label={t("topics.ops.actions.label")}
          className="flex flex-wrap gap-2"
        >
          {root ? null : (
            <Button type="button" disabled={ops.busy || ops.renaming} onClick={ops.onStartRename}>
              <Pencil aria-hidden="true" />
              {t("topics.ops.actions.rename")}
            </Button>
          )}
          <Button type="button" aria-haspopup="dialog" disabled={ops.busy} onClick={ops.onCreate}>
            <FolderPlus aria-hidden="true" />
            {t(root ? "topics.ops.actions.createTop" : "topics.ops.actions.create")}
          </Button>
          {root ? null : (
            <>
              <Button type="button" aria-haspopup="dialog" disabled={ops.busy} onClick={ops.onMove}>
                <FolderInput aria-hidden="true" />
                {t("topics.ops.actions.move")}
              </Button>
              <Button
                type="button"
                aria-pressed={pinned}
                disabled={ops.busy}
                onClick={ops.onTogglePin}
              >
                {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
                {t(pinned ? "topics.ops.actions.unpin" : "topics.ops.actions.pin")}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {ops?.error ? (
        <p role="alert" className="text-sm text-danger">
          {opsErrorText(t, ops.error)}
        </p>
      ) : null}
      {topic.nameState === "provisional" ? (
        <p className="text-xs text-muted-foreground">{t("topics.page.provisionalName")}</p>
      ) : null}
      {topic.description ? (
        <p lang={lang} className="text-lg text-secondary-foreground text-pretty">
          {topic.description}
        </p>
      ) : null}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-secondary-foreground">
        <span>{countLabel(t, "notes", page.counts.notes)}</span>
        {page.counts.sources > 0 ? (
          <span>{countLabel(t, "sources", page.counts.sources)}</span>
        ) : null}
        {page.counts.subtopics > 0 ? (
          <span>{countLabel(t, "subtopics", page.counts.subtopics)}</span>
        ) : null}
        <span
          className={cn(
            "inline-flex items-center gap-1 text-xs font-medium whitespace-nowrap",
            toneClass[health.tone]
          )}
        >
          <HealthIcon className="size-3.5" aria-hidden="true" />
          {t(health.key)}
        </span>
        {topic.aliases.length > 0 ? (
          <span lang={lang}>
            {t("topics.page.aliases", { values: { names: topic.aliases.join(", ") } })}
          </span>
        ) : null}
      </p>
      {page.lastChange ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-soft px-3 py-2 text-sm text-secondary-foreground">
          <ListTree className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <p className="min-w-60 flex-1">
            {changeBannerText(page.lastChange, new Date(readAt), t)}
          </p>
          {page.lastChange.undo === "available" ? (
            <Button type="button" disabled={undo.status === "pending"} onClick={onUndo}>
              <Undo2 aria-hidden="true" />
              {undo.status === "pending"
                ? t("topics.page.banner.undoing")
                : t("topics.page.banner.undo")}
            </Button>
          ) : null}
          {undo.status === "blocked" ||
          (page.lastChange.undo === "blocked" && undo.status === "idle") ? (
            <p className="w-full text-xs text-muted-foreground">
              {t("topics.page.banner.blocked")}
            </p>
          ) : null}
          {undo.status === "failed" ? (
            <p role="alert" className="w-full text-xs text-danger">
              {t("topics.page.banner.failed")}
            </p>
          ) : null}
        </div>
      ) : null}
    </header>
  );
}
