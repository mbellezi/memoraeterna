import type { ReactNode } from "react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../components/glyphs";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { LoadingState, SkeletonRows } from "../components/ui/skeleton";
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
export function NavigatorHost({ t, tree, children, onOpenTopic }: NavigatorHostProps) {
  return (
    <aside
      aria-label={t("workspace.navigator.label")}
      data-region="navigator"
      className="flex h-full w-(--nav-w) shrink-0 flex-col border-r border-border bg-background"
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain py-3 pl-3 pr-2 [scrollbar-gutter:stable]">
        {children ?? <TreeList t={t} tree={tree} onOpenTopic={onOpenTopic} />}
      </div>
    </aside>
  );
}

/** "Tree · 412 items": kept above the list and above the empty box, as in the design's shot. */
function TreeHeader({ t, total }: { t: Translator; total: number }) {
  return (
    <div className="mx-1 mb-1 flex items-baseline justify-between text-xs font-semibold text-secondary-foreground">
      <h2 className="m-0 text-xs font-semibold">{t("workspace.navigator.title")}</h2>
      <span className="font-normal tabular-nums text-muted-foreground">
        {t("workspace.navigator.total", { values: { count: count(t, total) } })}
      </span>
    </div>
  );
}

function TreeList({
  t,
  tree,
  onOpenTopic
}: {
  t: Translator;
  tree: NavigatorHostProps["tree"];
  onOpenTopic: NavigatorHostProps["onOpenTopic"];
}) {
  if (tree.status === "loading")
    return (
      <LoadingState t={t}>
        <SkeletonRows rows={8} />
      </LoadingState>
    );
  if (tree.status === "error")
    return (
      <ErrorState
        t={t}
        message={t("workspace.navigator.error")}
        kept={t("workspace.navigator.errorKept")}
        retryLabel={t("workspace.navigator.retry")}
        onRetry={tree.retry}
        className="p-3"
      />
    );
  const value = tree.value;
  if (navigatorIsEmpty(value))
    return (
      <>
        <TreeHeader t={t} total={0} />
        <EmptyState
          variant="compact"
          icon={<ObjectKindGlyph kind="topic" size={16} className="text-object-topic" />}
          headline={t("workspace.navigator.emptyHeadline")}
        >
          {t("workspace.navigator.emptyBody")}
        </EmptyState>
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
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                {count(t, topic.items)}
              </span>
            </>
          );
          const rowClass = cn(
            "flex h-(--row-h) w-full items-center gap-2 rounded-md px-2 text-sm text-foreground"
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
        <p className="mx-1 mt-4 border-t border-border px-1 pt-3 text-xs text-muted-foreground">
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
