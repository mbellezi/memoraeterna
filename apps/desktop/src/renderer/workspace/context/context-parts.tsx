import { useEffect, type MouseEvent, type ReactNode } from "react";
import type { ObjectKind, ObjectResolved } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../components/glyphs";
import { RelationStanceLabel } from "../../components/RelationStanceLabel";
import { Button } from "../../components/ui/button";
import { EmptyState } from "../../components/ui/empty-state";
import { ErrorState } from "../../components/ui/error-state";
import { LoadingState, Skeleton } from "../../components/ui/skeleton";
import { cn } from "../../lib/cn";
import { pathCrumbs } from "../context-model";
import type { PanelLoadState } from "../PanelFrame";
import type { Paged, Read } from "./context-reads";

/**
 * The pieces every tab of the context panel is made of (design record §5.6): the frame that writes
 * the surface's `data-surface` and `data-state`, the body heading, the row of an object with its
 * path line and meta, a group heading, the "Mostrar mais" foot and the three non-success states in
 * the shared primitives' words (a plain sentence for an error, a teaching sentence for empty, rows
 * shaped like the content for loading).
 */

/** What the host gives a tab. */
export interface ContextTabProps {
  t: Translator;
  /** The focused object: `memora://<kind>/<id>`, no anchor. */
  address: string;
  kind: ObjectKind;
  id: string;
  /** The tab is on screen; a hidden one reads nothing and listens to nothing. */
  active: boolean;
  /** The tab's own load state; its frame writes it as `data-state`. */
  onState?: (state: PanelLoadState) => void;
  /** A number for the strip ("Contexto · Conexões · 5"), or null while it is not known. */
  onCount?: (count: number | null) => void;
  /** Opens an address beside the focused panel, or in it (Option-click). */
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  /** Switches the panel to another tab ("Ver como lista"). */
  onTab?: (tab: "connections" | "graph") => void;
}

/** The tab's state from its read: loading, error, empty (nothing to list) or success. */
export function listState(read: Read<{ items: readonly unknown[] }>): PanelLoadState {
  if (read.status === "loading") return "loading";
  if (read.status === "error") return "error";
  return read.value.items.length === 0 ? "empty" : "success";
}

/** Tells the host what state the tab is in, whenever it changes. */
export function useReportedState(
  state: PanelLoadState,
  onState: ((state: PanelLoadState) => void) | undefined
): void {
  useEffect(() => {
    onState?.(state);
  }, [state, onState]);
}

/** Tells the host the strip's number, whenever it changes. */
export function useReportedCount(
  count: number | null,
  onCount: ((count: number | null) => void) | undefined
): void {
  useEffect(() => {
    onCount?.(count);
  }, [count, onCount]);
}

/** The tab's own frame: the surface id and the state, which the screens tool and the journeys read. */
export function ContextFrame({
  surface,
  state,
  children
}: {
  surface: string;
  state: PanelLoadState;
  children: ReactNode;
}) {
  return (
    <div data-surface={surface} data-state={state} className="min-w-0">
      {children}
    </div>
  );
}

/** A tab's title and its one-line description; `detail` (the counts) follows the description. */
export function ContextHeading({
  title,
  description,
  detail
}: {
  title: string;
  description: string;
  detail?: string | undefined;
}) {
  return (
    <header className="mb-3 grid gap-0">
      <h2 className="m-0 text-base font-semibold text-foreground [text-wrap:balance]">{title}</h2>
      <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
        {description}
        {detail ? <> {detail}</> : null}
      </p>
    </header>
  );
}

const rowFocus =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/** A row's line of crumbs: the topic glyph and the topics above the object; deep paths fold. */
export function PathLine({ titles, label }: { titles: readonly string[]; label: string }) {
  if (titles.length === 0) return null;
  const { folded, titles: shown } = pathCrumbs(titles);
  return (
    <span className="flex min-w-0 items-start gap-1 text-xs leading-5 text-secondary-foreground">
      <ObjectKindGlyph kind="topic" size={12} className="mt-[4px] text-object-topic" />
      <span
        className="min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty]"
        title={titles.join(" › ")}
      >
        <span className="sr-only">{label}: </span>
        {folded ? <span aria-hidden="true">… › </span> : null}
        {shown.join(" › ")}
      </span>
    </span>
  );
}

/** What the row shows of an object: the resolved summary, or the words it already had. */
export interface RowObject {
  address: string;
  kind: ObjectKind;
  /** The title the list itself knows (a relation names the other note); the summary wins when read. */
  title?: string | undefined;
}

/** A title for a row: the person's own text, whole, wrapping at word boundaries. */
export function rowTitle(
  object: RowObject,
  resolved: ObjectResolved | undefined,
  kindWord: string,
  untitled: string
): string | null {
  const title = (resolved?.title ?? object.title ?? "").trim();
  if (title !== "") return title;
  // Read, and the object has no words of its own (a topic that is not named yet).
  if (resolved) return resolved.kind === "topic" ? untitled : kindWord;
  return null;
}

/**
 * One object as a row: its title (13 px, wraps), the path line and a meta line. It opens the object
 * beside the focused panel, or in it with Option held (A3: no hover card on a row of this panel).
 */
export function ContextRow({
  t,
  object,
  resolved,
  showKind = false,
  path = true,
  meta,
  extra,
  onOpen,
  muted = false
}: {
  t: Translator;
  object: RowObject;
  resolved?: ObjectResolved | undefined;
  /** Draws the kind's glyph before the title (lists that mix kinds). */
  showKind?: boolean;
  path?: boolean;
  meta?: readonly string[];
  /** More under the meta (a snippet). */
  extra?: ReactNode;
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  muted?: boolean;
}) {
  const kindWord = t(`objects.kinds.${object.kind}`);
  const title = rowTitle(object, resolved, kindWord, t("panelFrame.ribbon.untitled"));
  const titles = path
    ? (resolved?.path ?? []).map((ref) => ref.title || t("panelFrame.ribbon.untitled"))
    : [];
  return (
    <button
      type="button"
      data-object={object.address}
      onClick={(event: MouseEvent) => onOpen(object.address, { replace: event.altKey })}
      className={cn(
        "-mx-2 block w-[calc(100%+16px)] min-w-0 cursor-pointer rounded-md border-0 bg-transparent px-2 py-2 text-left",
        "hover:bg-surface-hover",
        rowFocus
      )}
    >
      <span className="flex min-w-0 items-start gap-2">
        {showKind ? (
          <ObjectKindGlyph
            kind={object.kind}
            size={14}
            className={cn("mt-[3px]", objectKindTextClass[object.kind])}
          />
        ) : null}
        <span className="min-w-0 flex-1">
          {title === null ? (
            <span className="block py-1.5">
              <Skeleton className="h-3 w-4/5" />
            </span>
          ) : (
            <span
              className={cn(
                "block text-sm leading-5 [overflow-wrap:anywhere]",
                muted ? "text-secondary-foreground" : "text-foreground"
              )}
            >
              {title}
            </span>
          )}
          {titles.length > 0 ? (
            <PathLine titles={titles} label={t("contextPanel.locate.label")} />
          ) : null}
          {meta && meta.length > 0 ? <MetaLine parts={meta} /> : null}
          {extra}
        </span>
      </span>
    </button>
  );
}

/** A meta line: each part binds to the separator before it, so a line never starts or ends on "·". */
export function MetaLine({ parts }: { parts: readonly string[] }) {
  return (
    <span className="block text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
      {parts.map((part, index) => (
        <span key={`${index}:${part}`}>
          {index > 0 ? " " : null}
          <span className="inline-block">
            {index > 0 ? <span aria-hidden="true">{"· "}</span> : null}
            {part}
          </span>
        </span>
      ))}
    </span>
  );
}

/** The heading of a group of rows, with its glyph in the group's colour and its count. */
export function GroupHeading({
  glyph,
  className,
  children,
  count
}: {
  glyph?: ReactNode;
  className?: string;
  children: ReactNode;
  count?: number | undefined;
}) {
  return (
    <h3
      className={cn(
        "m-0 mb-1 flex min-w-0 items-start gap-2 text-sm font-semibold text-foreground",
        className
      )}
    >
      {glyph ? <span className="mt-[3px] flex-none">{glyph}</span> : null}
      <span className="min-w-0 [text-wrap:pretty]">{children}</span>
      {count === undefined ? null : (
        <span className="ml-auto flex-none pl-2 text-xs font-normal text-muted-foreground tabular-nums">
          {count}
        </span>
      )}
    </h3>
  );
}

/** The foot of a paged list: "Mostrar mais", its waiting words, or its failure and a way to try again. */
export function ShowMore({
  t,
  paged,
  onMore
}: {
  t: Translator;
  paged: Pick<Paged<unknown>, "hasMore" | "more">;
  onMore: () => void;
}) {
  if (!paged.hasMore) return null;
  return (
    <div className="mb-4 grid justify-items-start gap-1">
      {paged.more === "error" ? (
        <p role="status" className="m-0 text-xs text-secondary-foreground">
          {t("contextPanel.moreFailed")}
        </p>
      ) : null}
      <Button
        variant="secondary"
        aria-busy={paged.more === "loading" || undefined}
        disabled={paged.more === "loading"}
        onClick={onMore}
      >
        {paged.more === "loading"
          ? t("contextPanel.loadingMore")
          : paged.more === "error"
            ? t("shell.actions.retry")
            : t("contextPanel.showMore")}
      </Button>
    </div>
  );
}

/** Four rows shaped like the content: a title, a path and a meta bar each (design record §5.6). */
export function ContextLoading({ t, rows = 4 }: { t: Translator; rows?: number }) {
  return (
    <LoadingState t={t} className="gap-4">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="grid gap-1.5">
          <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-11/12" : "w-3/4")} />
          <Skeleton className="h-3 w-3/5" />
          <Skeleton className="h-3 w-2/5" />
        </div>
      ))}
    </LoadingState>
  );
}

/** A failure in place: one plain sentence, what is kept, one "Tentar de novo". */
export function ContextError({
  t,
  message,
  kept,
  onRetry
}: {
  t: Translator;
  message: MessageKey;
  kept: ObjectKind;
  onRetry: () => void;
}) {
  return (
    <ErrorState
      t={t}
      message={t(message)}
      kept={t(`contextPanel.errors.kept.${kept}`)}
      onRetry={onRetry}
      retryLabel={t("shell.actions.retry")}
    />
  );
}

/** An empty tab: what this is and what comes next, in one sentence. */
export function ContextEmpty({ children }: { children: ReactNode }) {
  return <EmptyState variant="compact">{children}</EmptyState>;
}

const stanceLegendTypes = [
  "supports",
  "contradicts",
  "extends",
  "depends_on",
  "example_of",
  "related"
] as const;

/** The six kinds of connection, each with its glyph and word (colour is never the only signal). */
export function StanceLegend({ t }: { t: Translator }) {
  return (
    <ul
      aria-label={t("contextPanel.connections.legend")}
      className="m-0 mt-3 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0"
    >
      {stanceLegendTypes.map((type) => (
        <li key={type}>
          <RelationStanceLabel type={type} t={t} />
        </li>
      ))}
    </ul>
  );
}
