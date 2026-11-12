import { useEffect } from "react";
import { Plus } from "lucide-react";
import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Button } from "../../../components/ui/button";
import { ErrorState } from "../../../components/ui/error-state";
import { Kbd } from "../../../components/ui/kbd";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { destinationRoots } from "../../destinations";
import { navigatorIsEmpty } from "../../NavigatorHost";
import type { PanelProps } from "../../PanelStack";
import type { NavigatorTree } from "../../shell-stores";
import { useNavigatorTree } from "../../use-shell-data";
import { useAddSource } from "../../workspace-bridge";
import { WrappedLabel } from "./FittedLabel";

/**
 * Explore's root surface (design record 7.2, 8 rule 7): what the stack shows when no panel is open.
 * It replaces the Wiki screen. In an empty library it says "Nothing open yet" and teaches the three
 * keys; otherwise it shows the areas overview, the top level of the tree as cards that open beside.
 * It reads the same top level the navigator host reads (one shared store) and frames itself with
 * the four states, since the stack's frame draws only panels.
 */

export const kind = "destination-explore";

export function match(address: string): boolean {
  return address === destinationRoots.explore;
}

/** The stack names a root by its destination. */
export function title(): string {
  return "";
}

/** Explore's root has no compact form: where it would be the previous panel it is a spine. */
export const compact = false;

const count = (t: Translator, value: number) => new Intl.NumberFormat(t.locale).format(value);

/** The words under an area's name: its items and its subtopics. */
export function areaFacts(t: Translator, area: { items: number; children: number }): string[] {
  const parts = [
    area.items === 1
      ? t("topics.page.counts.itemsOne")
      : t("topics.page.counts.items", { values: { count: count(t, area.items) } })
  ];
  if (area.children > 0)
    parts.push(
      area.children === 1
        ? t("topics.page.counts.subtopicsOne")
        : t("topics.page.counts.subtopics", { values: { count: count(t, area.children) } })
    );
  return parts;
}

function Keys({ t }: { t: Translator }) {
  const rows: [string, string][] = [
    ["↵", t("explore.root.keyOpen")],
    [t("explore.root.keySpace"), t("explore.root.keyPeek")],
    ["⌘W", t("explore.root.keyClose")]
  ];
  return (
    <ul
      aria-label={t("explore.root.keysLabel")}
      className="m-0 grid max-w-(--measure) list-none gap-0 p-0 text-sm text-secondary-foreground"
    >
      {rows.map(([key, what]) => (
        <li key={key} className="flex items-center gap-3 border-t border-border py-2 last:border-b">
          <span className="w-16 shrink-0">
            {/* One size for the three caps: a symbol (↵, ⌘W) draws small at 12 px, so all three step up to 14 px. */}
            <Kbd className="h-6 min-w-8 px-1.5 text-sm">{key}</Kbd>
          </span>
          <span>{what}</span>
        </li>
      ))}
    </ul>
  );
}

function Nothing({ t }: { t: Translator }) {
  const onAddSource = useAddSource();
  return (
    <div className="grid max-w-(--measure) gap-5">
      <h2 className="m-0 font-reading text-2xl font-semibold text-foreground [text-wrap:balance]">
        {t("explore.root.emptyHeadline")}
      </h2>
      <p className="m-0 text-sm leading-6 text-secondary-foreground [text-wrap:pretty]">
        {t("explore.root.emptyBody")}
      </p>
      <Keys t={t} />
      {onAddSource ? (
        <div>
          <Button variant="primary" onClick={onAddSource}>
            <Plus aria-hidden="true" />
            {t("explore.root.addFirst")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Areas({
  t,
  tree,
  onOpen
}: {
  t: Translator;
  tree: NavigatorTree;
  onOpen: PanelProps["onOpen"];
}) {
  return (
    <section aria-labelledby="explore-areas" className="grid gap-5">
      <header className="grid max-w-(--measure) gap-1">
        <h2
          id="explore-areas"
          className="m-0 font-reading text-2xl font-semibold text-foreground [text-wrap:balance]"
        >
          {t("explore.root.areasTitle")}
        </h2>
        <p className="m-0 text-sm leading-6 text-secondary-foreground [text-wrap:pretty]">
          {t("explore.root.areasLead")}
        </p>
      </header>
      <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 p-0">
        {tree.topics.map((area) => {
          const name = area.title ?? t("topics.navigator.unnamed");
          return (
            <li key={area.id} className="min-w-0">
              <button
                type="button"
                title={name}
                aria-label={t("workspace.navigator.rowLabel", {
                  values: { title: name, count: count(t, area.items) }
                })}
                onClick={() => onOpen(formatObjectAddress({ kind: "topic", id: area.id }))}
                className={cn(
                  "grid h-full w-full min-w-0 content-start gap-2 rounded-lg border border-border bg-surface p-4 text-left",
                  "transition-colors hover:border-border-strong hover:bg-surface-hover",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                )}
              >
                <span className="flex items-start gap-2">
                  <ObjectKindGlyph
                    kind="topic"
                    size={16}
                    className={cn("mt-1", objectKindTextClass.topic)}
                  />
                  {/* Whole words on up to three lines: a long name never ends inside a word. */}
                  <WrappedLabel
                    text={name}
                    maxLines={3}
                    className={cn(
                      "text-base font-semibold text-foreground",
                      area.title === null && "text-muted-foreground italic"
                    )}
                  />
                </span>
                <span className="pl-6 text-xs text-secondary-foreground tabular-nums">
                  {areaFacts(t, area).join(" · ")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {tree.unsorted > 0 ? (
        <p className="m-0 text-xs text-muted-foreground">
          {t(
            tree.unsorted === 1
              ? "workspace.navigator.unsortedOne"
              : "workspace.navigator.unsortedMany",
            { values: { count: count(t, tree.unsorted) } }
          )}
        </p>
      ) : null}
    </section>
  );
}

function Loading({ t }: { t: Translator }) {
  return (
    // The same container and grid as the areas, so the cards do not jump wider when they arrive.
    <LoadingState t={t} className="gap-5">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="w-2/3 max-w-(--measure)" />
      <div className="m-0 grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-3 p-0">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="grid gap-3 rounded-lg border border-border p-4">
            <Skeleton className="h-4 w-3/4" />
            <Skeleton className="w-1/2" />
          </div>
        ))}
      </div>
    </LoadingState>
  );
}

export function Component({ t, active, onState, onOpen }: PanelProps) {
  const tree = useNavigatorTree(active);
  const state =
    tree.status === "loading"
      ? "loading"
      : tree.status === "error"
        ? "error"
        : navigatorIsEmpty(tree.value)
          ? "empty"
          : "success";
  useEffect(() => onState(state), [onState, state]);
  return (
    <div
      data-surface={kind}
      data-state={state}
      data-root=""
      className="h-full min-h-0 overflow-auto bg-surface px-8 pt-8 pb-12"
    >
      <div className="mx-auto max-w-4xl">
        {tree.status === "loading" ? <Loading t={t} /> : null}
        {tree.status === "error" ? (
          <ErrorState
            t={t}
            className="max-w-(--measure)"
            message={t("explore.root.error")}
            kept={t("explore.root.errorKept")}
            retryLabel={t("shell.actions.retry")}
            onRetry={tree.retry}
          />
        ) : null}
        {tree.status === "ready" && state === "empty" ? <Nothing t={t} /> : null}
        {tree.status === "ready" && state === "success" ? (
          <Areas t={t} tree={tree.value} onOpen={onOpen} />
        ) : null}
      </div>
    </div>
  );
}
