import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Kbd } from "../../../components/ui/kbd";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { useObjectPreview } from "../../ObjectLink";
import { titleOf } from "../../ObjectLinkModel";
import {
  citationObject,
  citedObjectCount,
  uncitedPassages,
  type SourceEntry,
  type UncitedPassage
} from "./answer-model";
import type { ReadNotCited, ReadSummary } from "./ask-session";

/**
 * The sources of an answer (design record §6.4, §10.3): "Evidência desta resposta", a numbered list
 * that matches the chips. A chip that is hovered or focused expands its entry in place: a raised
 * sheet with an accent rule holding the passage (italic serif, the cited sentence in `<mark>`) and
 * "Abrir o trecho ao lado ↵". Below 1280 px the same passage fills a tray at the panel's foot. No
 * card is ever drawn over the answer. An entry opens its passage beside the question on a click or
 * Enter; a passage that was removed says so and leads to its source.
 */

/** What one entry knows of its passage: the title of its object and the passage text. */
export type EntryPassage =
  | { status: "loading" }
  | { status: "error" }
  | { status: "gone" }
  | { status: "ready"; title: string; text: string };

/**
 * Reads one entry's passage through the preview batcher (one `resolveMany` per 16 ms for every
 * entry together). A citation whose object is gone, or whose address no longer resolves, is "gone".
 */
export function useEntryPassage(t: Translator, entry: SourceEntry | null): EntryPassage {
  const address = entry?.open ?? null;
  const preview = useObjectPreview(address ?? "", address !== null && !entry?.citation.unavailable);
  if (!entry || address === null || entry.citation.unavailable) return { status: "gone" };
  const { state } = preview;
  if (state.status === "loading" || !preview.current) return { status: "loading" };
  if (state.status === "error") return { status: "error" };
  if (state.status === "missing") return { status: "gone" };
  return {
    status: "ready",
    title: titleOf(state.item, t("objects.kinds.source")),
    text: state.item.preview.trim()
  };
}

/** The id of an entry's element: what a chip's `aria-controls` names. */
export const entryElementId = (base: string, number: number): string => `${base}-source-${number}`;

const hint = "inline-flex items-center gap-1.5 text-xs text-accent";

/**
 * Below 1280 px the passage tray is stuck over the foot of the panel and is at most 8rem tall
 * (`max-h-32`). A row that takes keyboard focus scrolls at least 9rem clear of the panel's foot (the
 * tray and a rem of air for its ring), so the focused row is never behind the tray. Above 1280 px
 * there is no tray and no margin.
 */
export const trayClearance = "scroll-mb-36";

/** The width of the column that holds a citation's number chip: titles of both lists start after it. */
const leadColumn = "w-10 shrink-0";

function Passage({ text }: { text: string }) {
  return (
    <span className="block font-reading text-base leading-relaxed text-foreground italic [text-wrap:pretty]">
      <mark className="rounded-sm bg-accent-soft px-0.5 text-inherit [box-decoration-break:clone]">
        {text}
      </mark>
    </span>
  );
}

export interface SourceEntryRowProps {
  t: Translator;
  entry: SourceEntry;
  idBase: string;
  active: boolean;
  /** The passage is read in the tray at the panel's foot: the entry marks itself but stays closed. */
  tray: boolean;
  onActivate: (number: number) => void;
  onOpen: (address: string) => void;
}

function SourceEntryRow({
  t,
  entry,
  idBase,
  active,
  tray,
  onActivate,
  onOpen
}: SourceEntryRowProps) {
  const passage = useEntryPassage(t, entry);
  const id = entryElementId(idBase, entry.number);
  const object = citationObject(entry.citation);
  const title = passage.status === "ready" ? passage.title : t("objects.kinds.source");
  const reading = passage.status === "loading";
  const gone = passage.status === "gone";
  // A removed passage still leads to its source when the source is there.
  const target = gone ? object : entry.open;
  // The passage opens in place only where there is no tray: one passage is never drawn twice.
  const expanded = active && !tray;

  return (
    <li className="min-w-0">
      <button
        type="button"
        id={id}
        data-source-entry={entry.number}
        data-active={active ? "" : undefined}
        aria-describedby={expanded && passage.status === "ready" ? `${id}-passage` : undefined}
        disabled={target === null}
        onFocus={() => onActivate(entry.number)}
        onClick={() => target !== null && onOpen(target)}
        className={cn(
          "relative grid w-full min-w-0 gap-1.5 rounded-md px-3 py-2 text-left text-sm text-foreground",
          tray && trayClearance,
          "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
          active
            ? "bg-surface [box-shadow:var(--shadow-sheet)] before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
            : "hover:bg-surface-hover disabled:cursor-default disabled:hover:bg-transparent"
        )}
      >
        <span className="flex min-w-0 items-start gap-2">
          <span
            aria-hidden="true"
            className={cn(
              leadColumn,
              "mt-0.5 inline-flex h-5 items-center justify-center gap-0.5 rounded-sm border border-border bg-soft px-1 text-xs font-medium tabular-nums text-secondary-foreground"
            )}
          >
            <ObjectKindGlyph kind="source" size={12} className={objectKindTextClass.source} />
            {entry.number}
          </span>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            <span className="line-clamp-2 font-medium" title={title}>
              {title}
            </span>
            {reading ? (
              <span className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                <Skeleton className="h-2.5 w-24" />
                {t("askPanel.sources.reading")}
              </span>
            ) : null}
            {/* line-clamp sets its own display: a `block` beside it would undo the clamp. */}
            {!active && passage.status === "ready" && passage.text !== "" ? (
              <span className="mt-0.5 line-clamp-1 font-reading text-sm text-secondary-foreground italic">
                {passage.text}
              </span>
            ) : null}
            {gone ? (
              <span className="block text-xs text-secondary-foreground">
                {t("askPanel.sources.removed")}
                {object !== null ? (
                  <>
                    {" · "}
                    <span className="text-accent underline-offset-2">
                      {t("askPanel.sources.seeSource")}
                    </span>
                  </>
                ) : null}
              </span>
            ) : null}
            {entry.citation.stale && !gone ? (
              <span className="block text-xs text-warning">{t("askPanel.sources.changed")}</span>
            ) : null}
            {expanded && passage.status === "ready" ? (
              <span className="mt-1.5 grid gap-1.5">
                <span id={`${id}-passage`}>
                  <Passage text={passage.text} />
                </span>
                <span className={hint}>
                  {t("askPanel.sources.open")}
                  <Kbd>↵</Kbd>
                </span>
              </span>
            ) : null}
            {expanded && passage.status === "error" ? (
              <span className="mt-1 block text-xs text-secondary-foreground">
                {t("askPanel.sources.readFailed")}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}

/**
 * One passage the Ask read and left out: the kind glyph, its source's title and, when the answer
 * cites another passage of that source, which citation it is; then the Ask's own reason, if it gave one.
 */
function NotCitedRow({
  t,
  item,
  sibling,
  tray,
  onOpen
}: {
  t: Translator;
  item: ReadNotCited;
  /** The number of the citation into the same source, when the answer cites another passage of it. */
  sibling: number | null;
  tray: boolean;
  onOpen: (address: string) => void;
}) {
  const preview = useObjectPreview(item.address, true);
  const title =
    preview.state.status === "ready"
      ? titleOf(preview.state.item, t("objects.kinds.source"))
      : t("objects.kinds.source");
  const reading = preview.state.status === "loading" || !preview.current;
  const gone = preview.current && preview.state.status === "missing";
  return (
    <li className="min-w-0">
      <button
        type="button"
        data-read-not-cited=""
        disabled={gone === true}
        onClick={() => onOpen(item.address)}
        className={cn(
          "flex w-full min-w-0 items-start gap-2 rounded-md px-3 py-1.5 text-left text-sm text-secondary-foreground",
          tray && trayClearance,
          "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
          "disabled:cursor-default disabled:hover:bg-transparent"
        )}
      >
        <span
          aria-hidden="true"
          className={cn(leadColumn, "inline-flex h-5 items-center justify-center")}
        >
          <ObjectKindGlyph kind="source" size={12} className={objectKindTextClass.source} />
        </span>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
          <span className="line-clamp-1 font-medium text-foreground" title={title}>
            {title}
          </span>
          {reading ? (
            <span className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
              <Skeleton className="h-2.5 w-24" />
              {t("askPanel.sources.reading")}
            </span>
          ) : (
            <span className="block text-xs text-muted-foreground [text-wrap:pretty]">
              {gone
                ? t("askPanel.sources.removed")
                : [
                    sibling !== null
                      ? t("askPanel.sources.readNotCitedSibling", { values: { number: sibling } })
                      : null,
                    // The Ask's own words; with none, only that the answer did not use it (the app
                    // does not know why, so it says no more).
                    item.reason ??
                      (sibling === null ? t("askPanel.sources.readNotCitedReason") : null)
                  ]
                    .filter((part) => part !== null)
                    .join(" · ")}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export interface SourcesRailProps {
  t: Translator;
  sources: readonly SourceEntry[];
  idBase: string;
  /** The number of the entry that is expanded, or null. */
  active: number | null;
  onActivate: (number: number) => void;
  onOpen: (address: string) => void;
  headingId: string;
  /** The line under the heading: what the numbers are, or how to read a passage in the tray. */
  hint: string;
  /** Below 1280 px the passage of the active entry is read in the tray, not in the list. */
  tray: boolean;
  /** What the Ask was about, as the scope line writes it ("toda a biblioteca"); null until known. */
  scope: string | null;
  /** What the Ask's retrieval reported it read; null when the answer did not keep it. */
  read: ReadSummary | null;
  /** The answer is still being written: what was read and not cited is not settled yet. */
  live: boolean;
  /** Where the page places the list (a column beside the answer from 1280 px). */
  className?: string;
}

/** The numbered list of an answer's sources. It is empty only while the answer has cited nothing. */
export function SourcesRail({
  t,
  sources,
  idBase,
  active,
  onActivate,
  onOpen,
  headingId,
  hint,
  tray,
  scope,
  read,
  live,
  className
}: SourcesRailProps) {
  if (sources.length === 0) return null;
  // What the answer knows: the passages it cites and the sources they sit in; what the retrieval
  // read, when it reported it.
  const passages = read?.passages ?? sources.length;
  const around = read?.sources ?? citedObjectCount(sources);
  const counts = read
    ? `${t(
        passages === 1 ? "askPanel.sources.readPassagesOne" : "askPanel.sources.readPassagesMany",
        {
          values: { count: passages }
        }
      )} ${t(around === 1 ? "askPanel.sources.readFromOne" : "askPanel.sources.readFromMany", {
        values: { count: around }
      })}`
    : `${t(passages === 1 ? "askPanel.sources.passagesOne" : "askPanel.sources.passagesMany", {
        values: { count: passages }
      })} · ${t(around === 1 ? "askPanel.band.sourcesOne" : "askPanel.band.sourcesMany", {
        values: { count: around }
      })}`;
  // Only what the answer does not cite: a passage a citation points at is not listed here.
  const notCited: UncitedPassage<ReadNotCited>[] = read
    ? uncitedPassages(sources, read.notCited)
    : [];
  const notCitedId = `${headingId}-not-cited`;
  return (
    <section
      aria-labelledby={headingId}
      className={cn("grid min-w-0 max-w-(--measure) gap-3", className)}
    >
      <div className="grid gap-1">
        <h2 id={headingId} className="m-0 grid gap-0.5 text-sm font-semibold text-foreground">
          {t("askPanel.sources.heading")}
          <span className="text-xs font-normal text-secondary-foreground">
            {scope !== null ? `${t("askPanel.launcher.scope.label")}: ${scope} · ` : ""}
            {counts}
          </span>
          <span className="text-xs font-normal text-muted-foreground [text-wrap:pretty]">
            {hint}
          </span>
        </h2>
        <ol
          aria-label={t("askPanel.sources.label")}
          className="m-0 -mx-1 grid list-none gap-0.5 p-0"
        >
          {sources.map((entry) => (
            <SourceEntryRow
              key={entry.number}
              t={t}
              entry={entry}
              idBase={idBase}
              active={active === entry.number}
              tray={tray}
              onActivate={onActivate}
              onOpen={onOpen}
            />
          ))}
        </ol>
      </div>
      {live || read === null || notCited.length === 0 ? null : (
        // What was read and left out: the answer rests on the entries above, never on these.
        <div className="grid gap-1" role="group" aria-labelledby={notCitedId}>
          <h3 id={notCitedId} className="m-0 text-xs font-semibold text-secondary-foreground">
            {t("askPanel.sources.readNotCited")} ({notCited.length})
          </h3>
          <ul className="m-0 -mx-1 grid list-none gap-0.5 p-0">
            {notCited.map(({ item, sibling }) => (
              <NotCitedRow
                key={item.address}
                t={t}
                item={item}
                sibling={sibling}
                tray={tray}
                onOpen={onOpen}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export interface PassageTrayProps {
  t: Translator;
  entry: SourceEntry | null;
}

/**
 * Below 1280 px the context is a strip, so the passage of the citation that is hovered or focused
 * is read at the foot of the panel: at most 128 tall, after the answer's last line (it sticks to
 * the foot of the panel while the answer scrolls, and a chip or an entry that takes focus scrolls
 * clear of it). It is a strip of the panel, never a card over the answer.
 */
export function PassageTray({ t, entry }: PassageTrayProps) {
  const passage = useEntryPassage(t, entry);
  // With no citation in reach there is nothing to read: the sources heading says how to reach one,
  // so the tray takes no room from the answer until it has a passage.
  if (entry === null) return null;
  return (
    <aside
      data-passage-tray=""
      aria-label={t("askPanel.tray.label")}
      style={{
        marginInline: "calc(var(--top-pl, 1rem) * -1)",
        paddingInline: "var(--top-pl, 1rem)"
      }}
      // The panel body keeps 3rem of padding under its content and a sticky edge stops at the
      // padding, so the tray reaches past it to rest on the panel's foot.
      className="sticky order-2 [bottom:-3rem] z-[1] mt-6 max-h-32 overflow-hidden border-t border-border bg-surface py-2.5 [box-shadow:var(--shadow-edge-up)]"
    >
      <div className="grid max-w-(--measure) gap-1">
        <p className="m-0 flex min-w-0 items-baseline text-xs font-medium text-foreground">
          <span className="shrink-0">
            {t("askPanel.tray.heading", { values: { number: entry.number } })}
          </span>
          {passage.status === "ready" ? (
            <>
              <span
                aria-hidden="true"
                className="shrink-0 px-1.5 font-normal text-muted-foreground"
              >
                ·
              </span>
              <span className="min-w-0 truncate font-normal text-secondary-foreground">
                {passage.title}
              </span>
            </>
          ) : null}
        </p>
        {passage.status === "ready" ? (
          <span className="line-clamp-3 font-reading text-sm leading-snug text-foreground italic">
            <mark className="rounded-sm bg-accent-soft px-0.5 text-inherit">{passage.text}</mark>
          </span>
        ) : passage.status === "loading" ? (
          <span className="flex items-center gap-2 text-xs text-muted-foreground">
            <Skeleton className="h-2.5 w-24" />
            {t("askPanel.sources.reading")}
          </span>
        ) : passage.status === "gone" ? (
          <span className="text-xs text-secondary-foreground">{t("askPanel.sources.removed")}</span>
        ) : (
          <span className="text-xs text-secondary-foreground">
            {t("askPanel.sources.readFailed")}
          </span>
        )}
        <p className={cn(hint, "m-0")}>
          {t("askPanel.sources.open")}
          <Kbd>↵</Kbd>
        </p>
      </div>
    </aside>
  );
}
