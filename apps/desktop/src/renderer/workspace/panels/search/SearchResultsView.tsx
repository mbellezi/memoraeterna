import { useRef, type KeyboardEvent, type MouseEvent } from "react";
import { objectKinds, type ObjectKind, type ObjectResolved } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { ErrorState } from "../../../components/ui/error-state";
import { Kbd } from "../../../components/ui/kbd";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { OmniSnapshot } from "../../../lib/use-omni";
import { kindWordKeys, placeOf } from "../../ObjectLinkModel";
import type { PreviewBatcher } from "../../preview-batcher";
import { markPieces, queryTerms } from "../../palette/highlight";
import { rowMeta } from "../../palette/Palette";
import { useResolved } from "../../palette/use-resolved";
import { formatView } from "../../route";
import { degradedNotice, isPassage, searchLimit, toggleKind, type SearchAsk } from "./search-model";

/**
 * The search results panel (design record §11; spec 3.5): everything the library holds for a
 * query, in full mode (titles, text, passages and meaning), reached with ⇧↵ in Cmd-K or from a
 * group's "mostrar mais". A row opens beside this panel (⌥ or Option-click: in it); Space peeks.
 * It draws the four states of the panel contract. `compact` is the previous panel's form: the
 * query and the titles, with the row that was opened marked.
 */

export interface SearchResultsViewProps {
  t: Translator;
  ask: SearchAsk;
  /** The answer, with `status` as `useOmni` says it. */
  omni: Pick<OmniSnapshot, "status" | "items" | "degraded" | "answered">;
  mode: "full" | "compact";
  /** For the compact form: the address of the panel that was opened from this one. */
  current?: string | undefined;
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  /** Narrows the panel to other kinds (it replaces the panel's content). */
  onFilter: (kinds: ObjectKind[]) => void;
  onRetry: () => void;
  batcher?: PreviewBatcher;
}

const filterKeys: Record<ObjectKind, MessageKey> = {
  topic: "palette.results.filterTopic",
  note: "palette.results.filterNote",
  source: "palette.results.filterSource",
  entity: "palette.results.filterEntity",
  question: "palette.results.filterQuestion"
};
/** The order of the chips: the groups of Cmd-K. */
const filterOrder: readonly ObjectKind[] = ["topic", "note", "source", "entity", "question"];

const rowClass = cn(
  "relative flex w-full min-w-0 items-start gap-3 rounded-md px-3 py-2 text-left text-base text-foreground",
  "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
);
/** The current row of a list is marked by the accent: a 2 px bar and the selected fill. */
const currentRowClass =
  "bg-surface-selected before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:rounded-full before:bg-accent";

function Marked({ text, terms }: { text: string; terms: readonly string[] }) {
  return (
    <>
      {markPieces(text, terms).map((piece, index) =>
        piece.marked ? (
          <mark
            key={index}
            className="bg-transparent font-semibold text-inherit underline decoration-1 underline-offset-[3px]"
          >
            {piece.text}
          </mark>
        ) : (
          <span key={index}>{piece.text}</span>
        )
      )}
    </>
  );
}

function Filters({
  t,
  ask,
  onFilter
}: {
  t: Translator;
  ask: SearchAsk;
  onFilter: (kinds: ObjectKind[]) => void;
}) {
  return (
    <div
      role="group"
      aria-label={t("palette.results.filtersLabel")}
      className="flex flex-wrap gap-2"
    >
      <Button aria-pressed={ask.kinds.length === 0} onClick={() => onFilter([])}>
        {t("palette.results.filterAll")}
      </Button>
      {filterOrder.map((kind) => (
        <Button
          key={kind}
          aria-pressed={ask.kinds.includes(kind)}
          onClick={() => onFilter(toggleKind(ask.kinds, kind))}
        >
          <ObjectKindGlyph kind={kind} size={14} className={objectKindTextClass[kind]} />
          {t(filterKeys[kind])}
        </Button>
      ))}
    </div>
  );
}

function ResultRow({
  t,
  address,
  kind,
  title,
  snippet,
  item,
  terms,
  current,
  onOpen
}: {
  t: Translator;
  address: string;
  kind: ObjectKind;
  title: string;
  snippet: string | undefined;
  item: ObjectResolved | undefined;
  terms: readonly string[];
  current: boolean;
  onOpen: SearchResultsViewProps["onOpen"];
}) {
  const crumbs = item ? placeOf(item) : [];
  const shown = title.trim() === "" ? t(kindWordKeys[kind]) : title;
  const click = (event: MouseEvent) => onOpen(address, { replace: event.altKey });
  return (
    <li className="m-0 list-none">
      <button
        type="button"
        data-quick-look={address}
        data-search-row=""
        aria-current={current ? "true" : undefined}
        onClick={click}
        className={cn(rowClass, current && currentRowClass)}
      >
        <ObjectKindGlyph
          kind={kind}
          size={16}
          className={cn(objectKindTextClass[kind], "mt-[3px]")}
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span className="flex min-w-0 items-baseline justify-between gap-3">
            <span className="min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty]">
              <Marked text={shown} terms={terms} />
            </span>
            <span className="shrink-0 whitespace-nowrap text-xs text-muted-foreground">
              {isPassage(address) ? t("palette.results.passage") : rowMeta(t, kind, item)}
            </span>
          </span>
          {crumbs.length > 0 ? (
            <span className="min-w-0 text-sm text-secondary-foreground [text-wrap:pretty]">
              {crumbs.map((crumb, index) => (
                <span key={`${crumb.id}-${index}`}>
                  {index > 0 ? " › " : null}
                  <Marked
                    text={crumb.title === "" ? t("panelFrame.ribbon.untitled") : crumb.title}
                    terms={terms}
                  />
                </span>
              ))}
            </span>
          ) : null}
          {snippet ? (
            <span className="min-w-0 font-reading text-sm italic text-secondary-foreground [text-wrap:pretty]">
              “<Marked text={snippet} terms={terms} />”
            </span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

/** ↑ and ↓ move between the rows; the list is one tab stop's worth of keys, each row its own stop. */
function moveFocus(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-search-row]")];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  const next = rows[at + (event.key === "ArrowDown" ? 1 : -1)];
  if (next) {
    event.preventDefault();
    next.focus();
  }
}

export function SearchResultsView({
  t,
  ask,
  omni,
  mode,
  current,
  onOpen,
  onFilter,
  onRetry,
  batcher
}: SearchResultsViewProps) {
  const compact = mode === "compact";
  const terms = queryTerms(ask.query);
  const items = omni.status === "ready" || omni.status === "loading" ? omni.items : [];
  const resolved = useResolved(
    items.map((item) => item.address),
    batcher
  );
  const list = useRef<HTMLUListElement>(null);

  if (compact)
    return (
      <div
        className="grid min-w-0 gap-3"
        aria-label={t("palette.results.compactLabel", { values: { query: ask.query } })}
      >
        <p className="m-0 text-lg font-semibold leading-snug [overflow-wrap:anywhere] [text-wrap:balance]">
          {t("palette.results.heading", { values: { query: ask.query } })}
        </p>
        {omni.status === "error" ? (
          <p className="m-0 text-sm text-secondary-foreground">
            {t("palette.results.errorMessage")}
          </p>
        ) : omni.status === "ready" && items.length === 0 ? (
          <p className="m-0 text-sm text-secondary-foreground">
            {t("palette.results.emptyHeadline", { values: { query: ask.query } })}
          </p>
        ) : (
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {items.slice(0, 12).map((item) => (
              <li key={item.address} className="m-0">
                <button
                  type="button"
                  onClick={() => onOpen(item.address)}
                  aria-current={current === item.address ? "true" : undefined}
                  className={cn(
                    rowClass,
                    "items-center py-1.5 text-sm",
                    current === item.address && currentRowClass
                  )}
                >
                  <ObjectKindGlyph
                    kind={item.kind}
                    size={14}
                    className={objectKindTextClass[item.kind]}
                  />
                  <span className="min-w-0 truncate" title={item.title}>
                    {item.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );

  const heading = (
    <div className="grid min-w-0 gap-3">
      <h2 className="m-0 font-reading text-xl font-semibold leading-snug [overflow-wrap:anywhere] [text-wrap:balance]">
        {t("palette.results.heading", { values: { query: ask.query } })}
      </h2>
      <Filters t={t} ask={ask} onFilter={onFilter} />
    </div>
  );

  if (omni.status === "error")
    return (
      <div className="grid max-w-(--measure) gap-5">
        {heading}
        <ErrorState
          t={t}
          message={t("palette.results.errorMessage")}
          kept={t("palette.results.errorKept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={onRetry}
        />
      </div>
    );

  if (omni.status !== "ready" && items.length === 0)
    return (
      <div className="grid max-w-(--measure) gap-5">
        {heading}
        <LoadingState t={t}>
          <div className="grid gap-1" data-search-skeleton="">
            {[0, 1, 2, 3, 4].map((row) => (
              <div key={row} className="flex items-start gap-3 px-3 py-2">
                <Skeleton className="mt-[3px] size-4 shrink-0 rounded-sm" />
                <div className="grid min-w-0 flex-1 gap-2">
                  <Skeleton className={row % 2 === 0 ? "w-3/5" : "w-2/5"} />
                  <Skeleton className="w-4/5" />
                  {row % 2 === 0 ? <Skeleton className="w-3/4" /> : null}
                </div>
              </div>
            ))}
          </div>
        </LoadingState>
      </div>
    );

  if (items.length === 0)
    return (
      <div className="grid max-w-(--measure) gap-5">
        {heading}
        <EmptyState
          headline={t("palette.results.emptyHeadline", { values: { query: ask.query } })}
          action={
            <Button onClick={() => onOpen(formatView({ view: "ask", question: ask.query }))}>
              {t("palette.results.emptyAsk")}
            </Button>
          }
        >
          {t("palette.results.emptyBody")}
        </EmptyState>
      </div>
    );

  const count =
    items.length >= searchLimit
      ? t("palette.results.countFirst", { values: { count: items.length } })
      : t(items.length === 1 ? "palette.results.countOne" : "palette.results.countMany", {
          values: { count: items.length }
        });
  const degraded = degradedNotice(omni.degraded);
  const notice =
    degraded === "fts"
      ? t("palette.results.degradedFts")
      : degraded === "ann"
        ? t("palette.results.degradedAnn")
        : null;
  return (
    <div className="grid max-w-(--measure) gap-4">
      {heading}
      <p className="m-0 text-xs text-muted-foreground tabular-nums">{count}</p>
      {notice ? (
        <p className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">{notice}</p>
      ) : null}
      <ul
        ref={list}
        aria-label={t("palette.listLabel")}
        onKeyDown={moveFocus}
        className="m-0 grid list-none gap-0.5 p-0"
      >
        {items.map((item) => (
          <ResultRow
            key={item.address}
            t={t}
            address={item.address}
            kind={item.kind}
            title={item.title}
            snippet={item.snippet}
            item={resolved.get(item.address)}
            terms={terms}
            current={false}
            onOpen={onOpen}
          />
        ))}
      </ul>
      <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-border pt-3 text-xs text-secondary-foreground">
        <span className="inline-flex items-center gap-1.5">
          <Kbd>↵</Kbd> {t("palette.foot.beside")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>⌥↵</Kbd> {t("palette.foot.here")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>{t("preview.quickLook.keys.space")}</Kbd> {t("palette.foot.peek")}
        </span>
      </p>
    </div>
  );
}

/** Every kind a chip exists for; a test keeps the chips and the domain's kinds the same set. */
export const filterKinds: readonly ObjectKind[] = filterOrder.filter((kind) =>
  objectKinds.includes(kind)
);
