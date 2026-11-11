import type { ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { SolidTriangle } from "../components/activity/solid-glyphs";
import { ObjectKindGlyph } from "../components/glyphs";
import { Button } from "../components/ui/button";
import { EmptyState } from "../components/ui/empty-state";
import { LoadingState, Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import type { NavigatorTree, Read } from "./shell-stores";

export interface NavigatorHostProps {
  t: Translator;
  /** The top level of the topic tree, with its four states (loading, empty, error, success). */
  tree: Read<NavigatorTree> & { retry: () => void };
  /**
   * The destination's own navigator, drawn in place of the top-level list once its card lands (T141:
   * Explore's `TopicNavigator`, with fixed items, recents, the fitted labels and hoist). The host
   * keeps the frame, the width and the states around it.
   */
  children?: ReactNode;
  /** Opens a topic beside the focused panel; without it the rows only read. */
  onOpenTopic?: (topicId: string) => void;
  /** The compact tier (960-1179 px): counts show only on hover, focus and the open row (§5.3). */
  compact?: boolean;
}

/** Whether the library has nothing to show in the tree yet: no topic and no item. */
export function navigatorIsEmpty(tree: NavigatorTree): boolean {
  return tree.topics.length === 0 && tree.total === 0 && tree.unsorted === 0;
}

const count = (t: Translator, value: number) => new Intl.NumberFormat(t.locale).format(value);

/**
 * The navigator's frame (design record §5.3): a column of `--nav-w` on the desk colour, shown on by
 * default in Explore only (Cmd-\ toggles it). It owns the four states of the tree it hosts: eight
 * skeleton rows while it loads, a teaching box ("Topics grow on their own") while the library has no
 * topics, a plain sentence with Try again when the read failed, and the list otherwise. The navigator
 * never collapses by itself.
 */
export function NavigatorHost({
  t,
  tree,
  children,
  onOpenTopic,
  compact = false
}: NavigatorHostProps) {
  return (
    <aside
      aria-label={t("workspace.navigator.label")}
      data-region="navigator"
      className="flex h-full w-(--nav-w) shrink-0 flex-col border-r border-border bg-background"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 pl-3 pr-2 [scrollbar-gutter:stable]">
        {children ?? <TreeList t={t} tree={tree} onOpenTopic={onOpenTopic} compact={compact} />}
      </div>
    </aside>
  );
}

/** "Tree · 412 items": kept above the list and above the empty box, as in the design's shot. */
function TreeHeader({ t, total }: { t: Translator; total?: number }) {
  return (
    <div className="mb-1 flex items-baseline justify-between px-2 text-xs font-semibold text-secondary-foreground">
      <h2 className="m-0 text-xs font-semibold">{t("workspace.navigator.title")}</h2>
      {total === undefined ? null : (
        <span className="font-normal tabular-nums text-muted-foreground">
          {t("workspace.navigator.total", { values: { count: count(t, total) } })}
        </span>
      )}
    </div>
  );
}

/**
 * The failed read, in place (design record §5.12): a plain sentence with a solid state glyph, what
 * is kept, and Try again as a link. Not a card: the column keeps its header and its width.
 */
function TreeError({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <div role="alert" className="mt-3 grid gap-1 px-2 text-sm">
      <p className="m-0 flex items-start gap-2 text-foreground">
        <SolidTriangle className="mt-0.5 text-danger" />
        <span className="min-w-0">{t("workspace.navigator.error")}</span>
      </p>
      <p className="m-0 pl-6 text-xs text-secondary-foreground">
        {t("workspace.navigator.errorKept")}
      </p>
      {/* The link's text starts under the sentence's: the glyph (16 px) and its gap (8 px), less the button's 13 px. */}
      <Button variant="link" className="ml-[11px] justify-self-start" onClick={onRetry}>
        {t("workspace.navigator.retry")}
      </Button>
    </div>
  );
}

const skeletonTitles = ["w-3/5", "w-2/5", "w-1/2", "w-2/3", "w-1/3"] as const;

/**
 * Eight rows in the size of the real ones (`--row-h`, a glyph-sized lead block, the title, and the
 * count only when the count shows), so the column does not jump when the tree arrives.
 */
function TreeSkeleton({ compact }: { compact: boolean }) {
  return (
    <div className="grid gap-px">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex h-(--row-h) items-center gap-2 px-2">
          <Skeleton className="size-4 shrink-0" />
          <Skeleton className={skeletonTitles[index % skeletonTitles.length]} />
          {compact ? null : <Skeleton className="ml-auto h-3 w-6 shrink-0" />}
        </div>
      ))}
    </div>
  );
}

function TreeList({
  t,
  tree,
  onOpenTopic,
  compact
}: {
  t: Translator;
  tree: NavigatorHostProps["tree"];
  onOpenTopic: NavigatorHostProps["onOpenTopic"];
  compact: boolean;
}) {
  if (tree.status === "loading")
    return (
      <>
        <TreeHeader t={t} />
        <LoadingState t={t}>
          <TreeSkeleton compact={compact} />
        </LoadingState>
      </>
    );
  if (tree.status === "error")
    return (
      <>
        <TreeHeader t={t} />
        <TreeError t={t} onRetry={tree.retry} />
      </>
    );
  const value = tree.value;
  if (navigatorIsEmpty(value))
    return (
      <>
        {/* No total above the teaching box: "0 items" would say what the box says, quieter. */}
        <TreeHeader t={t} />
        <div className="px-2">
          <EmptyState
            variant="compact"
            icon={<ObjectKindGlyph kind="topic" size={16} className="text-object-topic" />}
            headline={t("workspace.navigator.emptyHeadline")}
          >
            {t("workspace.navigator.emptyBody")}
          </EmptyState>
        </div>
      </>
    );
  return (
    <>
      <TreeHeader t={t} total={value.total} />
      <ul className="m-0 grid list-none gap-px p-0">
        {value.topics.map((topic) => {
          const title = topic.title ?? t("topics.unnamed");
          const row = (
            <>
              <ObjectKindGlyph kind="topic" size={16} className="text-object-topic" />
              <span className="min-w-0 flex-1 truncate text-left">{title}</span>
              <span
                className={cn(
                  "shrink-0 text-xs tabular-nums text-muted-foreground",
                  // Compact: the count gives its room to the name until the row is hovered or focused.
                  compact && "hidden group-hover:block group-focus-visible:block"
                )}
              >
                {count(t, topic.items)}
              </span>
            </>
          );
          const rowClass = cn(
            "group flex h-(--row-h) w-full items-center gap-2 rounded-md px-2 text-sm text-foreground"
          );
          const label = t("workspace.navigator.rowLabel", {
            values: { title, count: count(t, topic.items) }
          });
          return (
            <li key={topic.id}>
              {onOpenTopic ? (
                <button
                  type="button"
                  aria-label={label}
                  title={title}
                  className={cn(
                    rowClass,
                    "transition-colors hover:bg-surface-hover focus-visible:outline-2",
                    "focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  )}
                  onClick={() => onOpenTopic(topic.id)}
                >
                  {row}
                </button>
              ) : (
                <div className={rowClass} title={title} aria-label={label} role="group">
                  {row}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {value.unsorted > 0 ? (
        <p className="mx-2 mt-4 border-t border-border pt-3 text-xs text-muted-foreground">
          {t(
            new Intl.PluralRules(t.locale).select(value.unsorted) === "one"
              ? "workspace.navigator.unsortedOne"
              : "workspace.navigator.unsortedMany",
            { values: { count: count(t, value.unsorted) } }
          )}
        </p>
      ) : null}
    </>
  );
}
