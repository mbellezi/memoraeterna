import { useId, type MouseEvent, type ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { ErrorState } from "../../../components/ui/error-state";
import { LoadingState, Skeleton, SkeletonLines } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { EntityPage } from "../../../../shared/ipc-entities";
import {
  addressOf,
  entityTypeLabel,
  groupMentions,
  hiddenTopicCount,
  otherNames,
  remainingMentions,
  sourcesArePartial,
  sourcesOf,
  topicChips,
  type EntityLoad,
  type MentionGroup
} from "./entity-model";

/**
 * The Entity page (design record §6.5): the name and kind of the entity, what it is called
 * elsewhere, the notes that mention it under their topics, the entities that appear with it, its
 * topics and its sources. It draws the four states of the panel contract: the skeleton of the page,
 * what to do when nothing mentions the entity yet, one quiet failure in place, and the page.
 * `compact` is the previous panel's form: the title, the meta, a short description and the list of
 * notes with the one that was opened marked.
 */

export interface EntityPageViewProps {
  t: Translator;
  load: EntityLoad;
  mode: "full" | "compact";
  /** For the compact form: the address of the panel that was opened from this one. */
  current?: string | undefined;
  /** Opens an address beside this panel, or in it with the Option key. */
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

const rowClass = cn(
  "relative flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-2 text-left text-sm text-foreground",
  "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
);
/** The current row of a list is marked by the accent: a 2 px bar and the selected fill. */
const currentRowClass =
  "bg-surface-selected before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent";
const sectionHeading =
  "m-0 flex flex-wrap items-baseline gap-x-2 text-sm font-semibold text-foreground";
const sectionNote = "text-xs font-normal text-muted-foreground tabular-nums";

const plural = (
  t: Translator,
  count: number,
  one: Parameters<Translator>[0],
  many: Parameters<Translator>[0]
) => t(count === 1 ? one : many, { values: { count } });

export function EntityPageView(props: EntityPageViewProps) {
  const { t, load, mode } = props;
  const compact = mode === "compact";

  if (load.status === "loading")
    return (
      <LoadingState t={t} className="max-w-(--measure)">
        <Skeleton className={cn("h-6", compact ? "w-4/5" : "w-3/5")} />
        <Skeleton className="w-2/5" />
        <SkeletonLines lines={compact ? 3 : 2} className="mt-2 max-w-(--measure)" />
        {compact ? null : (
          <div className="mt-6 grid gap-4">
            <Skeleton className="w-1/4" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-5/6" />
          </div>
        )}
      </LoadingState>
    );

  if (load.status === "error")
    return (
      <ErrorState
        t={t}
        className="max-w-(--measure)"
        message={t("entityPage.error.message")}
        kept={t("entityPage.error.kept")}
        retryLabel={t("shell.actions.retry")}
        onRetry={props.onRetry}
      />
    );

  if (load.status === "missing")
    return (
      <EmptyState
        variant={compact ? "compact" : "inline"}
        className="max-w-(--measure)"
        headline={t("entityPage.missing.headline")}
      >
        {t("entityPage.missing.body")}
      </EmptyState>
    );

  return <LoadedPage {...props} page={load.page} more={load.more} />;
}

function LoadedPage({
  t,
  page,
  more,
  mode,
  current,
  onOpen,
  onLoadMore
}: EntityPageViewProps & { page: EntityPage; more: "idle" | "loading" | "error" }) {
  const compact = mode === "compact";
  const { entity } = page;
  const open = (kind: Parameters<typeof addressOf>[0], id: string) => (event: MouseEvent) =>
    onOpen(addressOf(kind, id), event.altKey ? { replace: true } : undefined);
  const empty = page.counts.notes === 0 && page.mentions.items.length === 0;
  const mentionsId = useId();
  const withId = useId();
  const topicsId = useId();
  const sourcesId = useId();

  const meta = [
    entityTypeLabel(t, entity.type),
    plural(t, page.counts.notes, "entityPage.meta.mentionsOne", "entityPage.meta.mentionsMany"),
    plural(t, page.counts.sources, "entityPage.meta.sourcesOne", "entityPage.meta.sourcesMany")
  ].filter((part, index) => index === 0 || (!empty && part !== ""));

  const header = (
    <header className="grid min-w-0 gap-1.5">
      <h1
        className={cn(
          "m-0 flex min-w-0 items-start gap-2 font-reading font-semibold text-foreground [text-wrap:balance]",
          compact ? "text-lg leading-snug" : "text-xl"
        )}
      >
        <ObjectKindGlyph
          kind="entity"
          size={compact ? 16 : 20}
          className={cn(compact ? "mt-1" : "mt-[5px]", objectKindTextClass.entity)}
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{entity.canonicalName}</span>
      </h1>
      <p
        className={cn(
          "m-0 min-w-0 text-secondary-foreground [text-wrap:pretty]",
          compact ? "text-xs" : "text-sm"
        )}
      >
        {meta.map((part, index) => (
          <span key={part}>
            {index > 0 ? " " : null}
            <span className="whitespace-nowrap">
              {part}
              {index < meta.length - 1 ? " ·" : null}
            </span>
          </span>
        ))}
      </p>
      {entity.description ? (
        <p
          className={cn(
            "m-0 max-w-(--measure) font-reading text-secondary-foreground [text-wrap:pretty]",
            compact ? "line-clamp-3 text-sm leading-6" : "mt-1 text-reading leading-[1.75]"
          )}
        >
          {entity.description}
        </p>
      ) : null}
      {compact ? null : <Aliases t={t} names={otherNames(entity)} />}
    </header>
  );

  if (compact)
    return (
      <article className="grid min-w-0 gap-4">
        {header}
        {empty ? (
          <EmptyState variant="compact" headline={t("entityPage.empty.headline")} />
        ) : (
          <ul
            aria-label={t("entityPage.mentions.listLabel")}
            className="m-0 grid list-none gap-0.5 p-0"
          >
            {page.mentions.items.map((mention) => {
              const address = addressOf("note", mention.noteId);
              const isCurrent = current !== undefined && current.startsWith(address);
              return (
                <li key={mention.noteId}>
                  <button
                    type="button"
                    aria-current={isCurrent ? "true" : undefined}
                    title={mention.title}
                    onClick={open("note", mention.noteId)}
                    className={cn(rowClass, isCurrent && currentRowClass)}
                  >
                    <ObjectKindGlyph
                      kind="note"
                      size={14}
                      className={cn("mt-[3px]", objectKindTextClass.note)}
                    />
                    <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
                      {mention.title}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </article>
    );

  const groups = groupMentions(page.mentions.items);
  const chips = topicChips(page.topics);
  const hiddenTopics = hiddenTopicCount(page.topics);
  const together = page.coMentioned ?? [];
  const sources = sourcesOf(page.mentions.items);
  const remaining = remainingMentions(page);

  return (
    <article
      aria-label={t("entityPage.articleLabel", { values: { name: entity.canonicalName } })}
      className="grid max-w-2xl min-w-0 gap-8"
    >
      {header}

      {empty ? (
        <EmptyState className="max-w-(--measure)" headline={t("entityPage.empty.headline")}>
          {t("entityPage.empty.body")}
        </EmptyState>
      ) : (
        <section aria-labelledby={mentionsId} className="grid min-w-0 gap-1">
          <h2 id={mentionsId} className={sectionHeading}>
            {t("entityPage.mentions.heading")}
            <span className={sectionNote}>
              {plural(
                t,
                page.counts.notes,
                "entityPage.mentions.summaryOne",
                "entityPage.mentions.summaryMany"
              )}
            </span>
          </h2>
          {groups.map((group) => (
            <MentionGroupView
              key={group.key}
              t={t}
              group={group}
              loadedAll={page.mentions.next === undefined}
              open={open}
            />
          ))}
          {remaining > 0 && page.mentions.next !== undefined ? (
            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
              {more === "error" ? (
                <p role="status" className="m-0 text-sm text-secondary-foreground">
                  {t("entityPage.mentions.moreFailed")}
                </p>
              ) : null}
              <Button
                variant="secondary"
                disabled={more === "loading"}
                aria-busy={more === "loading"}
                onClick={onLoadMore}
              >
                {more === "loading"
                  ? t("entityPage.mentions.moreLoading")
                  : more === "error"
                    ? t("shell.actions.retry")
                    : plural(
                        t,
                        remaining,
                        "entityPage.mentions.moreOne",
                        "entityPage.mentions.moreMany"
                      )}
              </Button>
            </div>
          ) : null}
        </section>
      )}

      {together.length > 0 ? (
        <section aria-labelledby={withId} className="grid min-w-0 gap-1">
          <h2 id={withId} className={sectionHeading}>
            {t("entityPage.coMentioned.heading")}
          </h2>
          <ul className="m-0 -mx-2 grid list-none p-0">
            {together.map((other) => (
              <li key={other.id}>
                <button
                  type="button"
                  onClick={open("entity", other.id)}
                  title={other.canonicalName}
                  className={rowClass}
                >
                  <ObjectKindGlyph
                    kind="entity"
                    size={14}
                    className={cn("mt-[3px]", objectKindTextClass.entity)}
                  />
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                    <span className="line-clamp-2">{other.canonicalName}</span>
                    <span className="block text-xs text-muted-foreground">
                      {entityTypeLabel(t, other.type)}
                    </span>
                  </span>
                  <span className="shrink-0 pt-0.5 text-xs text-muted-foreground tabular-nums">
                    {plural(
                      t,
                      other.sharedNotes,
                      "entityPage.coMentioned.sharedOne",
                      "entityPage.coMentioned.sharedMany"
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {chips.length > 0 ? (
        <section aria-labelledby={topicsId} className="grid min-w-0 gap-2">
          <h2 id={topicsId} className={sectionHeading}>
            {t("entityPage.topics.heading")}
          </h2>
          <ul className="m-0 flex list-none flex-wrap items-center gap-2 p-0">
            {chips.map((chip) => (
              <li key={chip.id} className="min-w-0 max-w-full">
                <button
                  type="button"
                  onClick={open("topic", chip.id)}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-strong px-2.5 py-1 text-xs text-foreground",
                    "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  )}
                >
                  <ObjectKindGlyph kind="topic" size={12} className={objectKindTextClass.topic} />
                  <span
                    className={cn(
                      "min-w-0 [overflow-wrap:anywhere]",
                      chip.title === "" && "italic"
                    )}
                  >
                    {chip.title === "" ? t("entityPage.mentions.untitledTopic") : chip.title}
                  </span>
                  {chip.densest ? (
                    <span className="text-muted-foreground">
                      · {t("entityPage.topics.mostCited")}
                    </span>
                  ) : null}
                </button>
              </li>
            ))}
            {hiddenTopics > 0 ? (
              <li className="text-xs text-muted-foreground">
                {t("entityPage.topics.more", { values: { count: hiddenTopics } })}
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {sources.length > 0 ? (
        <section aria-labelledby={sourcesId} className="grid min-w-0 gap-1">
          <h2 id={sourcesId} className={sectionHeading}>
            {t("entityPage.sources.heading")}
            <span className={sectionNote}>{page.counts.sources}</span>
          </h2>
          <ul className="m-0 -mx-2 grid list-none p-0">
            {sources.map((source) => (
              <li key={source.id}>
                <button
                  type="button"
                  title={source.title}
                  onClick={open("source", source.id)}
                  className={rowClass}
                >
                  <ObjectKindGlyph
                    kind="source"
                    size={14}
                    className={cn("mt-[3px]", objectKindTextClass.source)}
                  />
                  <span className="line-clamp-2 min-w-0 [overflow-wrap:anywhere]">
                    {source.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {sourcesArePartial(page) ? (
            <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
              {t("entityPage.sources.partial")}
            </p>
          ) : null}
        </section>
      ) : null}
    </article>
  );
}

function Aliases({ t, names }: { t: Translator; names: string[] }): ReactNode {
  if (names.length === 0) return null;
  return (
    <p className="m-0 text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
      {t("entityPage.aliases")}{" "}
      <span className="text-secondary-foreground [overflow-wrap:anywhere]">{names.join(", ")}</span>
    </p>
  );
}

function MentionGroupView({
  t,
  group,
  loadedAll,
  open
}: {
  t: Translator;
  group: MentionGroup;
  loadedAll: boolean;
  open: (kind: "note" | "source" | "topic" | "entity", id: string) => (event: MouseEvent) => void;
}) {
  const label =
    group.topicId === null
      ? t("entityPage.mentions.unplaced")
      : group.title === ""
        ? t("entityPage.mentions.untitledTopic")
        : group.title;
  const count = group.topicId === null ? (loadedAll ? group.notes.length : null) : group.total;
  return (
    <div className="mt-4 grid gap-0.5">
      <h3 className="m-0 flex min-w-0 items-center gap-1.5 text-xs font-semibold text-secondary-foreground">
        <ObjectKindGlyph kind="topic" size={12} className={objectKindTextClass.topic} />
        {group.topicId === null ? (
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
        ) : (
          <button
            type="button"
            onClick={open("topic", group.topicId)}
            className={cn(
              "min-w-0 rounded-sm text-left font-semibold [overflow-wrap:anywhere] underline-offset-[3px]",
              "hover:text-accent hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              group.title === "" && "italic"
            )}
          >
            {label}
          </button>
        )}
        {count !== null && count > 0 ? (
          <span className="font-normal text-muted-foreground tabular-nums">· {count}</span>
        ) : null}
      </h3>
      <ul className="m-0 -mx-2 grid list-none p-0">
        {group.notes.map((mention) => (
          <li key={mention.noteId}>
            <button
              type="button"
              title={mention.title}
              onClick={open("note", mention.noteId)}
              className={rowClass}
            >
              <ObjectKindGlyph
                kind="note"
                size={14}
                className={cn("mt-[3px]", objectKindTextClass.note)}
              />
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 [overflow-wrap:anywhere]">{mention.title}</span>
                {mention.sourceTitle ? (
                  <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                    {mention.sourceTitle}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
