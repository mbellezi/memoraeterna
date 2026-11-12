import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Eye, Network } from "lucide-react";
import { parseObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import type { SourceDetail } from "../../../../shared/ipc";
import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { Kbd } from "../../../components/ui/kbd";
import { SkeletonLines } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import { resolvePassage } from "../../../lib/object-navigation";
import { formatView } from "../../route";
import { openInMapAddress } from "./open-in-map";
import { SourceNoteRows } from "./source-note-rows";
import type { SourceSnapshot } from "./source-controller";
import {
  metaItems,
  noteRows,
  notesPageSize,
  overviewNotes,
  passageOf,
  splitSentence,
  tabForAnchor,
  type SourceTab
} from "./source-panel-model";
import { ConnectionsTab, ContentTab, DetailsTab, Quiet, Section } from "./source-tab-bodies";
import { SourceTabRow } from "./source-tab-row";
import { MetaLine, SourceStrip, SourceStripError, SourceStripSkeleton } from "./SourceStrip";
import { stripModel, type StripModel } from "./source-strip-model";

/**
 * The Source panel's page (design record 6.2): ribbon (the frame draws it) → title → meta → the
 * live generation strip → the tabs. It draws a snapshot of the controller and calls what it is
 * given; it reads nothing itself, so the same page is the real panel and the screen module's.
 */

export interface SourcePanelHandlers {
  onOpen: (address: string, options?: { replace?: boolean }) => void;
  onRetryStrip: () => void;
  onRun: (request: "notes" | "retry") => void;
  /** The places of the notes on screen. */
  want: (noteIds: readonly string[]) => void;
}

/**
 * The page's content grid (design record 5.4, "Focus mode"): 600 of text, a 48 gap and a 264
 * margin, 912 in all. The Source has nothing for the margin, but the page sits in the same grid as
 * the other object pages, so focus mode, which centres the grid, puts the text where theirs is. The
 * loading, error and gone states use it too, so the page does not move when it arrives.
 */
export function SourceGrid({ children }: { children: ReactNode }) {
  return (
    <div className="min-w-0 max-w-[57rem]" data-source-grid="">
      {children}
    </div>
  );
}

/** A sentence with one inline keycap: the translator gets a token and the caller draws the key. */
function WithKey({ sentence, keyName }: { sentence: string; keyName: string }) {
  const parts = splitSentence(sentence, "{key}");
  if (!parts) return <>{sentence}</>;
  return (
    <>
      {parts[0]}
      <Kbd>{keyName}</Kbd>
      {parts[1]}
    </>
  );
}

function Hint({ t, firstSource }: { t: Translator; firstSource: boolean }) {
  return (
    <div className="mb-6 flex items-start gap-3 rounded-lg bg-soft px-3 py-2.5 text-sm text-secondary-foreground">
      <Eye aria-hidden="true" className="mt-0.5 size-4 flex-none" />
      <p className="m-0 [text-wrap:pretty]">
        {firstSource ? (
          t("sourcePage.hint.firstSource")
        ) : (
          <WithKey
            sentence={t("sourcePage.hint.notes", { values: { key: "{key}" } })}
            keyName={t("sourcePage.hint.key")}
          />
        )}
      </p>
    </div>
  );
}

function Summary({ t, detail, model }: { t: Translator; detail: SourceDetail; model: StripModel }) {
  const writing = model.steps.find((step) => step.id === "summary")?.state === "running";
  const paragraphs = (detail.summary ?? "").split(/\n{2,}/u).filter((part) => part.trim() !== "");
  return (
    <Section title={t("sourcePage.summary.title")}>
      {paragraphs.length > 0 ? (
        <>
          <div className="max-w-(--measure) font-reading text-reading text-foreground [text-wrap:pretty]">
            {paragraphs.map((paragraph) => (
              <p key={paragraph} className="m-0 mb-4 whitespace-pre-wrap">
                {paragraph}
              </p>
            ))}
          </div>
          {detail.metadata.summaryStale === true ? (
            <p className="m-0 mt-1 text-xs text-secondary-foreground">{t("sourcePage.stale")}</p>
          ) : null}
        </>
      ) : writing ? (
        <div role="status">
          <span className="sr-only">{t("sourcePage.summary.writing")}</span>
          <SkeletonLines lines={3} className="max-w-(--measure)" />
        </div>
      ) : model.kind === "running" ? (
        <Quiet>{t("sourcePage.summary.later")}</Quiet>
      ) : (
        <Quiet>{t("sourcePage.summary.none")}</Quiet>
      )}
    </Section>
  );
}

export function SourcePanelView({
  t,
  address,
  mode,
  current,
  detail,
  snapshot,
  handlers
}: {
  t: Translator;
  address: string;
  mode: "full" | "compact";
  current?: string | undefined;
  detail: SourceDetail;
  snapshot: SourceSnapshot;
  handlers: SourcePanelHandlers;
}) {
  const parsed = parseObjectAddress(address);
  const anchor = parsed?.anchor;
  const [tab, setTab] = useState<SourceTab>(() => tabForAnchor(anchor));
  const [notesShown, setNotesShown] = useState(notesPageSize);
  // A new address (another passage, another relation) opens its tab, while rendering, so the page
  // never paints the previous tab first.
  const [seen, setSeen] = useState(address);
  if (seen !== address) {
    setSeen(address);
    setTab(tabForAnchor(anchor));
  }

  const { strip, paths, cost, action, readAt } = snapshot;
  const model = useMemo(
    () =>
      strip.status === "ready" ? stripModel(strip.progress, readAt) : stripModel(null, readAt),
    [strip, readAt]
  );
  const generating = model.kind === "running";
  const rows = useMemo(() => noteRows(detail, readAt, generating), [detail, readAt, generating]);
  const expectsMore = strip.status === "loading" ? false : model.expectsNotes && generating;
  const visibleOnTab = tab === "overview" ? overviewNotes : tab === "notes" ? notesShown : 0;
  const wantedIds = useMemo(
    () => (mode === "compact" ? [] : rows.slice(0, visibleOnTab).map((row) => row.id)),
    [rows, visibleOnTab, mode]
  );
  const wantedKey = wantedIds.join(",");
  const { want } = handlers;
  useEffect(() => want(wantedIds), [wantedKey, want]); // eslint-disable-line react-hooks/exhaustive-deps

  const meta = metaItems(detail, readAt, t);
  const passage = passageOf(anchor);
  const cited = passage ? resolvePassage(detail.documents, passage) : null;

  if (mode === "compact")
    return (
      <article className="min-w-0" data-compact="">
        <h1 className="m-0 mb-1 font-reading text-lg leading-snug font-semibold text-foreground [text-wrap:balance]">
          {detail.title}
        </h1>
        <MetaLine items={meta.slice(0, 2)} className="mb-3 text-xs text-secondary-foreground" />
        <ul className="m-0 grid list-none gap-0.5 p-0">
          {rows.slice(0, 12).map((row) => (
            <li key={row.id}>
              <button
                type="button"
                data-address={row.address}
                data-quick-look={row.address}
                aria-current={row.address === current ? "true" : undefined}
                onClick={() => handlers.onOpen(row.address)}
                className={cn(
                  "relative flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left text-sm text-foreground hover:bg-surface-hover",
                  row.address === current &&
                    "bg-surface-selected before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent"
                )}
              >
                <ObjectKindGlyph
                  kind="note"
                  size={14}
                  className={cn("mt-[3px] flex-none", objectKindTextClass.note)}
                />
                <span className="min-w-0">{row.title}</span>
              </button>
            </li>
          ))}
        </ul>
      </article>
    );

  const notesCount = rows.length;
  const notesHeading = (
    <h3 className="m-0 text-sm font-semibold text-foreground">
      {t("sourcePage.tabs.notes")}{" "}
      {generating || notesCount > 1 ? (
        <span className="text-xs font-normal text-muted-foreground">
          {generating
            ? t(notesCount === 1 ? "sourcePage.notes.countLiveOne" : "sourcePage.notes.countLive", {
                values: { count: notesCount }
              })
            : t("sourcePage.notes.newestFirst")}
        </span>
      ) : null}
    </h3>
  );
  const empty =
    notesCount === 0 && !expectsMore && strip.status !== "loading" && !generating ? (
      <EmptyState
        className="max-w-(--measure)"
        headline={t("sourcePage.notes.emptyHeadline")}
        {...(model.kind === "none"
          ? {
              action: (
                <Button
                  variant="secondary"
                  disabled={action.status === "pending"}
                  onClick={() => handlers.onRun("notes")}
                >
                  {t("sourcePage.actions.generateNotes")}
                </Button>
              )
            }
          : {})}
      >
        {t("sourcePage.notes.emptyBody")}
      </EmptyState>
    ) : null;
  const rowsView = (
    <SourceNoteRows
      t={t}
      rows={rows.slice(0, visibleOnTab)}
      paths={paths}
      generating={generating}
      expectsMore={generating && (expectsMore || notesCount === 0)}
      onOpen={handlers.onOpen}
    />
  );

  return (
    <SourceGrid>
      <article className="min-w-0 max-w-(--measure)" data-source-page="">
        <h1 className="m-0 mb-1 font-reading text-xl font-semibold text-foreground [text-wrap:balance]">
          {detail.title}
        </h1>
        {detail.subtitle ? (
          <p className="m-0 mb-1 text-sm text-secondary-foreground [text-wrap:pretty]">
            {detail.subtitle}
          </p>
        ) : null}
        <MetaLine items={meta} className="mb-5 text-sm text-secondary-foreground" />
        {strip.status === "loading" ? (
          <SourceStripSkeleton />
        ) : strip.status === "error" ? (
          <SourceStripError t={t} onRetry={handlers.onRetryStrip} />
        ) : (
          <SourceStrip
            t={t}
            model={model}
            cost={cost}
            action={action}
            actions={{
              onAsk: () =>
                handlers.onOpen(
                  formatView({ view: "ask", scope: { kind: "source", id: detail.id } })
                ),
              onRun: handlers.onRun,
              onChooseModel: () => handlers.onOpen(formatView({ view: "settings", section: "ai" }))
            }}
          />
        )}
        <SourceTabRow
          label={t("sourcePage.tabs.label")}
          value={tab}
          onChange={setTab}
          items={[
            { id: "overview", label: t("sourcePage.overview") },
            { id: "notes", label: t("sourcePage.tabs.notes"), count: notesCount },
            {
              id: "connections",
              label: t("sourcePage.tabs.connections"),
              count: detail.relations.length
            },
            { id: "content", label: t("sourcePage.content") },
            { id: "details", label: t("sourcePage.tabs.details") }
          ]}
        >
          {tab === "overview" ? (
            <>
              {generating ? <Hint t={t} firstSource={snapshot.firstSource} /> : null}
              <section className="mb-8">
                <div className="mb-1 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                  {notesHeading}
                  <Button
                    variant="secondary"
                    onClick={() => handlers.onOpen(openInMapAddress(detail.id))}
                  >
                    <Network aria-hidden="true" />
                    {t("sourcePage.actions.openInMap")}
                  </Button>
                </div>
                {empty ?? rowsView}
                {notesCount > overviewNotes ? (
                  <Button variant="link" className="mt-2 -ml-3" onClick={() => setTab("notes")}>
                    {t("sourcePage.notes.seeAll", { values: { count: notesCount } })}
                  </Button>
                ) : null}
              </section>
              <Summary t={t} detail={detail} model={model} />
            </>
          ) : null}
          {tab === "notes" ? (
            <section className="mb-8">
              <div className="mb-1">{notesHeading}</div>
              {empty ?? rowsView}
              {notesCount > notesShown ? (
                <Button
                  variant="link"
                  className="mt-2 -ml-3"
                  onClick={() => setNotesShown((count) => count + notesPageSize)}
                >
                  {t("sourcePage.notes.showMore", {
                    values: { count: Math.min(notesPageSize, notesCount - notesShown) }
                  })}
                </Button>
              ) : null}
            </section>
          ) : null}
          {tab === "connections" ? (
            <ConnectionsTab
              t={t}
              detail={detail}
              relationId={anchor?.relation}
              onOpen={handlers.onOpen}
              relationsEpoch={snapshot.relationsEpoch}
            />
          ) : null}
          {tab === "content" ? (
            <ContentTab t={t} detail={detail} cited={cited} asked={passage ? address : null} />
          ) : null}
          {tab === "details" ? (
            <DetailsTab
              t={t}
              detail={detail}
              onEdit={() => handlers.onOpen(formatView({ view: "import", sourceId: detail.id }))}
            />
          ) : null}
        </SourceTabRow>
      </article>
    </SourceGrid>
  );
}
