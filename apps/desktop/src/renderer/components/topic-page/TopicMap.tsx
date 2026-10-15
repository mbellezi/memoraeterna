import { useId } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import type { TopicNoteLeaf, TopicPage } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { ObjectKindGlyph } from "../glyphs";
import { Button } from "../ui/button";
import type { NotesListState } from "./topic-page-controller";
import {
  countLabel,
  moreSubtopicsLabel,
  noteSourceLine,
  relationsLabel,
  topicTitle,
  type TopicPageActions
} from "./topic-page-model";

const subHeading = "text-sm font-semibold text-secondary-foreground";
const rowButton =
  "flex w-full gap-3 rounded-md px-3 py-2.5 text-left text-foreground hover:bg-surface-hover";
const pill =
  "inline-flex h-5 items-center gap-1 rounded-full border border-border px-2 text-xs font-medium text-secondary-foreground";

/** Who wrote the note: the AI badge of the Library, or the person's own mark. */
function Provenance({ t, provenance }: { t: Translator; provenance: "ai" | "human" }) {
  if (provenance === "human") return <span className={pill}>{t("notePage.badge.yours")}</span>;
  return (
    <span className="inline-flex h-5 items-center gap-1 rounded-full bg-soft px-2 text-xs font-medium text-secondary-foreground">
      <Sparkles className="size-3" aria-hidden="true" />
      {t("knowledge.notes.aiBadge")}
    </span>
  );
}

export interface TopicMapProps {
  t: Translator;
  page: TopicPage;
  notes: NotesListState;
  actions: TopicPageActions;
  onShowAllNotes: () => void;
  onLoadMoreNotes: () => void;
  onRetryNotes: () => void;
}

/**
 * The map of content: what the topic holds, read from the tree with no AI. Subtopics with their
 * counts, the notes that sit closest to the centre of the topic, and the sources they come from.
 */
export function TopicMap({
  t,
  page,
  notes,
  actions,
  onShowAllNotes,
  onLoadMoreNotes,
  onRetryNotes
}: TopicMapProps) {
  const headingId = useId();
  const empty =
    page.subtopics.length === 0 && page.centralNotes.length === 0 && page.sources.length === 0;
  const hiddenSubtopics = page.counts.subtopics - page.subtopics.length;
  const hasMoreNotes = page.counts.notes > page.centralNotes.length;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <h2 id={headingId} className="text-base font-semibold text-foreground">
          {t("topics.page.map.title")}
        </h2>
        <span className="text-xs text-muted-foreground">{t("topics.page.map.hint")}</span>
      </div>
      {empty ? <p className="text-sm text-muted-foreground">{t("topics.page.empty")}</p> : null}
      {page.subtopics.length > 0 ? (
        <Subtopics t={t} page={page} hidden={hiddenSubtopics} actions={actions} />
      ) : null}
      {page.centralNotes.length > 0 ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <h3 className={subHeading}>{t("topics.page.map.notes")}</h3>
            <span className="text-xs text-muted-foreground">{t("topics.page.map.notesHint")}</span>
          </div>
          <ul className="-mx-3 flex flex-col">
            {page.centralNotes.map((note) => (
              <li key={note.id}>
                <CentralNote t={t} note={note} actions={actions} />
              </li>
            ))}
          </ul>
          {hasMoreNotes && notes === null ? (
            <div className="-ml-3">
              <Button type="button" variant="link" onClick={onShowAllNotes}>
                {t("topics.page.map.seeAll", {
                  values: { count: new Intl.NumberFormat(t.locale).format(page.counts.notes) }
                })}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {notes !== null ? (
        <AllNotes
          t={t}
          notes={notes}
          actions={actions}
          onLoadMore={onLoadMoreNotes}
          onRetry={onRetryNotes}
        />
      ) : null}
      {page.sources.length > 0 ? <Sources t={t} page={page} actions={actions} /> : null}
    </section>
  );
}

function Subtopics({
  t,
  page,
  hidden,
  actions
}: {
  t: Translator;
  page: TopicPage;
  hidden: number;
  actions: TopicPageActions;
}) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className={subHeading}>{t("topics.page.map.subtopics")}</h3>
      <ul className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(min(15rem,100%),1fr))]">
        {page.subtopics.map((subtopic) => (
          <li key={subtopic.id} className="flex min-w-0">
            <button
              type="button"
              lang={subtopic.title !== null ? (page.topic.nameLanguage ?? undefined) : undefined}
              className="flex w-full min-w-0 flex-col gap-1.5 rounded-lg border border-border-strong bg-surface px-4 py-3 text-left text-foreground hover:bg-surface-hover"
              onClick={() => actions.openTopic(subtopic.id)}
            >
              <span className="flex items-start gap-2">
                <ObjectKindGlyph kind="topic" className="mt-1 text-object-topic" />
                <span className="sr-only">{t("objects.kinds.topic")}: </span>
                <span className="min-w-0 flex-1 text-base font-semibold [overflow-wrap:anywhere]">
                  {topicTitle(t, subtopic, false)}
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {countLabel(t, "items", subtopic.items)}
                </span>
              </span>
              {subtopic.description ? (
                <span className="text-sm text-secondary-foreground">{subtopic.description}</span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
      {hidden > 0 ? (
        <p className="text-xs text-muted-foreground">{moreSubtopicsLabel(t, hidden)}</p>
      ) : null}
    </div>
  );
}

function CentralNote({
  t,
  note,
  actions
}: {
  t: Translator;
  note: TopicPage["centralNotes"][number];
  actions: TopicPageActions;
}) {
  const source = noteSourceLine(t, note);
  return (
    <button type="button" className={rowButton} onClick={() => actions.openNote(note.id)}>
      <ObjectKindGlyph kind="note" className="mt-1.5 text-object-note" />
      <span className="sr-only">{t("objects.kinds.note")}: </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
        <span className="font-reading text-reading leading-6 text-pretty">
          {note.idea || note.title}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          {source ? (
            <>
              <span className="max-w-full [overflow-wrap:anywhere]">{source}</span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <span>{relationsLabel(t, note.relationCount)}</span>
          <Provenance t={t} provenance={note.provenance} />
        </span>
        {note.movedFrom ? (
          <span className="text-xs text-muted-foreground">
            {t("topics.page.map.movedFrom", {
              values: {
                topic: topicTitle(t, { title: note.movedFrom.title }, false)
              }
            })}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function AllNotes({
  t,
  notes,
  actions,
  onLoadMore,
  onRetry
}: {
  t: Translator;
  notes: Exclude<NotesListState, null>;
  actions: TopicPageActions;
  onLoadMore: () => void;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className={subHeading}>{t("topics.page.map.allNotes")}</h3>
      {notes.status === "loading" ? (
        <p role="status" aria-busy="true" className="text-sm text-muted-foreground">
          {t("shell.states.loading")}
        </p>
      ) : null}
      {notes.status === "error" ? <NotesFailure t={t} onRetry={onRetry} /> : null}
      {notes.status === "ready" ? (
        <>
          <ul className="-mx-3 flex flex-col">
            {notes.notes.map((note) => (
              <li key={note.id}>
                <ListedNote t={t} note={note} actions={actions} />
              </li>
            ))}
          </ul>
          {notes.more === "error" ? <NotesFailure t={t} onRetry={onRetry} /> : null}
          {notes.nextCursor !== null && notes.more !== "error" ? (
            <div className="-ml-3">
              <Button
                type="button"
                variant="link"
                disabled={notes.more === "loading"}
                onClick={onLoadMore}
              >
                {t("topics.page.map.showMore")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function NotesFailure({ t, onRetry }: { t: Translator; onRetry: () => void }) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-3">
      <p className="text-sm text-foreground">{t("topics.page.map.notesError")}</p>
      <Button type="button" onClick={onRetry}>
        <RefreshCw aria-hidden="true" />
        {t("shell.actions.retry")}
      </Button>
    </div>
  );
}

function ListedNote({
  t,
  note,
  actions
}: {
  t: Translator;
  note: TopicNoteLeaf;
  actions: TopicPageActions;
}) {
  const source = noteSourceLine(t, note);
  return (
    <button
      type="button"
      className={cn(rowButton, "items-center")}
      onClick={() => actions.openNote(note.id)}
    >
      <ObjectKindGlyph kind="note" className="text-object-note" />
      <span className="sr-only">{t("objects.kinds.note")}: </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm text-foreground text-pretty">{note.title}</span>
        {source ? (
          <span className="max-w-full [overflow-wrap:anywhere] text-xs text-muted-foreground">
            {source}
          </span>
        ) : null}
      </span>
      <Provenance t={t} provenance={note.provenance} />
    </button>
  );
}

function Sources({
  t,
  page,
  actions
}: {
  t: Translator;
  page: TopicPage;
  actions: TopicPageActions;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className={subHeading}>{t("topics.page.map.sources")}</h3>
      <ul className="-mx-3 flex flex-col">
        {page.sources.map((source) => (
          <li key={source.id}>
            <button
              type="button"
              className={cn(rowButton, "items-center")}
              onClick={() => actions.openSource(source.id)}
            >
              <ObjectKindGlyph kind="source" className="text-object-source" />
              <span className="sr-only">{t("objects.kinds.source")}: </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                <span className="text-sm font-medium">{source.title}</span>
                {source.subtitle ? (
                  <span className="text-xs text-muted-foreground">{source.subtitle}</span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {countLabel(t, "notes", source.noteCount)}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
