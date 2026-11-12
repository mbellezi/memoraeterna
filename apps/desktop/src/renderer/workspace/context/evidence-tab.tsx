import type { MouseEvent, ReactNode } from "react";
import {
  formatObjectAddress,
  type NotePage,
  type NotePageEvidence,
  type ObjectBacklink,
  type ObjectResolved,
  type TopicPage
} from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../../components/glyphs";
import { evidenceLinkState, provenanceMessage } from "../../components/note-page/note-page-model";
import { cn } from "../../lib/cn";
import type { QuestionView } from "../../../shared/ipc-questions";
import {
  answerCitations,
  countText,
  groupPassages,
  notePassageTarget,
  passageAddress,
  type AnswerCitation,
  type PassageEntry
} from "../context-model";
import type { PanelLoadState } from "../PanelFrame";
import {
  ContextEmpty,
  ContextLink,
  ContextError,
  ContextFrame,
  ContextHeading,
  ContextLoading,
  listState,
  MetaLine,
  ShowMore,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";
import {
  backlinkKey,
  readBacklinks,
  useContextRead,
  usePagedRead,
  useResolved,
  type Paged,
  type Read
} from "./context-reads";

/** The Evidência tab (design record §5.6): the passages behind the object, numbered as in its body. */
export const tab = "evidence";
export const surface = "context-evidence";

const rowFocus =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

/**
 * One passage: its number, the cited words (the reading face, at most three lines), the source and
 * where in it, and what the person should know about it. It opens the passage in its source beside
 * the focused panel when it has an address; a passage whose source is gone is plain text.
 */
export function EvidenceRow({
  number,
  quote,
  meta,
  note,
  address,
  onOpen
}: {
  number?: number | undefined;
  /** The passage's words; null while they are read. */
  quote: string | null;
  meta: readonly string[];
  /** A caution under the meta ("pode estar desatualizada"). */
  note?: string | undefined;
  address: string | null;
  onOpen: ContextTabProps["onOpen"];
}) {
  const body: ReactNode = (
    <span className="flex min-w-0 items-start gap-2">
      {number === undefined ? null : (
        <span className="mt-px w-4 flex-none text-right text-xs leading-5 font-semibold text-secondary-foreground tabular-nums">
          {number}
        </span>
      )}
      <span className="min-w-0 flex-1">
        {quote === null ? (
          <span className="block py-1">
            <span className="block h-3 w-11/12 rounded-sm bg-soft" aria-hidden="true" />
          </span>
        ) : quote.trim() === "" ? null : (
          <q className="line-clamp-3 block font-reading text-sm leading-5 text-foreground [overflow-wrap:anywhere]">
            {quote}
          </q>
        )}
        <span className="mt-0.5 flex min-w-0 items-start gap-1">
          <ObjectKindGlyph kind="source" size={12} className="mt-[4px] text-object-source" />
          <span className="min-w-0 flex-1">
            <MetaLine parts={meta} />
          </span>
        </span>
        {note ? (
          <span className="block text-xs leading-5 text-secondary-foreground">{note}</span>
        ) : null}
      </span>
    </span>
  );
  const frame = "-mx-2 block w-[calc(100%+16px)] min-w-0 rounded-md px-2 py-2 text-left";
  if (address === null) return <div className={frame}>{body}</div>;
  return (
    <button
      type="button"
      data-object={address}
      onClick={(event: MouseEvent) => onOpen(address, { replace: event.altKey })}
      className={cn(
        frame,
        "cursor-pointer border-0 bg-transparent hover:bg-surface-hover",
        rowFocus
      )}
    >
      {body}
    </button>
  );
}

/** A tab body with its heading and the three non-success states in place. */
function EvidenceShell({
  t,
  kind,
  title,
  description,
  detail,
  read,
  emptyText,
  emptyAction,
  onRetry,
  state,
  children
}: {
  t: Translator;
  kind: ContextTabProps["kind"];
  title: string;
  description: string;
  detail?: string | undefined;
  read: Read<unknown>;
  emptyText: string;
  /** What an empty tab offers next, when something does. */
  emptyAction?: ReactNode;
  onRetry: () => void;
  state: PanelLoadState;
  children: ReactNode;
}) {
  return (
    <ContextFrame surface={surface} state={state}>
      <ContextHeading title={title} description={description} detail={detail} />
      {read.status === "loading" ? (
        <ContextLoading t={t} />
      ) : read.status === "error" ? (
        <ContextError t={t} message="contextPanel.errors.evidence" kept={kind} onRetry={onRetry} />
      ) : state === "empty" ? (
        <ContextEmpty action={emptyAction}>{emptyText}</ContextEmpty>
      ) : (
        children
      )}
    </ContextFrame>
  );
}

// ---------------------------------------------------------------------------
// A note: the passages it rests on, then who wrote it

type NoteEvidenceRead = Pick<NotePage, "note" | "evidence">;

/** The meta of a note's passage: the work, the section, the passage's number and its page. */
export function noteEvidenceMeta(t: Translator, item: NotePageEvidence): string[] {
  const parts = [item.workTitle ?? item.sourceTitle];
  if (item.workTitle !== null && item.sourceTitle !== item.workTitle) parts.push(item.sourceTitle);
  // A page is something a reader can turn to; the passage's own number is only for a source with none.
  if (item.page !== null) parts.push(t("notePage.evidence.page", { values: { page: item.page } }));
  else if (item.chunkIndex !== null)
    parts.push(t("notePage.evidence.passage", { values: { number: item.chunkIndex + 1 } }));
  return parts;
}

export function NoteEvidenceView({
  t,
  read,
  onOpen,
  onRetry,
  onTab
}: {
  t: Translator;
  read: Read<NoteEvidenceRead>;
  onOpen: ContextTabProps["onOpen"];
  onRetry: () => void;
  /** Switches the panel's tab; the empty tab offers the note's connections through it. */
  onTab?: ContextTabProps["onTab"];
}) {
  const items = read.status === "ready" ? read.value.evidence.items : [];
  const state: PanelLoadState = listState(
    read.status === "ready" ? { status: "ready", value: { items } } : read
  );
  return (
    <EvidenceShell
      t={t}
      kind="note"
      title={t("contextPanel.headings.evidence.note.title")}
      description={t("contextPanel.headings.evidence.note.description")}
      detail={
        read.status === "ready" && items.length > 0
          ? `${countText(t, "passages", read.value.evidence.total)}.`
          : undefined
      }
      read={read}
      emptyText={t("contextPanel.evidence.empty.note")}
      emptyAction={
        onTab ? (
          <ContextLink onClick={() => onTab("connections")}>
            {t("contextPanel.evidence.seeConnections")}
          </ContextLink>
        ) : undefined
      }
      onRetry={onRetry}
      state={state}
    >
      {read.status === "ready" ? (
        <>
          <ol className="m-0 mb-4 list-none p-0">
            {items.map((item, index) => {
              const link = evidenceLinkState(item);
              return (
                <li key={item.chunkId}>
                  <EvidenceRow
                    number={index + 1}
                    quote={item.excerpt}
                    meta={noteEvidenceMeta(t, item)}
                    note={
                      link === "earlierVersion"
                        ? t("contextPanel.evidence.earlierVersion")
                        : link === "preserved"
                          ? t("contextPanel.evidence.preserved")
                          : undefined
                    }
                    address={notePassageTarget(item)}
                    onOpen={onOpen}
                  />
                </li>
              );
            })}
          </ol>
          <section
            aria-label={t("contextPanel.evidence.provenance")}
            className="border-t border-border pt-2"
          >
            <h3 className="m-0 text-xs font-semibold text-secondary-foreground">
              {t("contextPanel.evidence.provenance")}
            </h3>
            <ProvenanceText t={t} page={read.value} />
          </section>
        </>
      ) : null}
    </EvidenceShell>
  );
}

function ProvenanceText({ t, page }: { t: Translator; page: NoteEvidenceRead }) {
  const message = provenanceMessage(page, t.locale);
  return (
    <p className="m-0 text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
      {t(message.key, { values: message.values })}
    </p>
  );
}

function NoteEvidence(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onTab, onState, onCount } = props;
  const { read, retry } = useContextRead<NoteEvidenceRead | null>({
    key: `note:${id}`,
    active,
    follow: [address],
    load: (app) => app.notes.page({ noteId: id, relationLimit: 1 })
  });
  // A note that is gone reads as a failed read, retryable like any other.
  const view: Read<NoteEvidenceRead> =
    read.status === "ready"
      ? read.value
        ? { status: "ready", value: read.value }
        : { status: "error" }
      : read;
  useReportedState(
    listState(
      view.status === "ready"
        ? { status: "ready", value: { items: view.value.evidence.items } }
        : view
    ),
    onState
  );
  useReportedCount(view.status === "ready" ? view.value.evidence.total : null, onCount);
  return (
    <NoteEvidenceView
      t={t}
      read={view}
      onOpen={onOpen}
      onRetry={retry}
      {...(onTab ? { onTab } : {})}
    />
  );
}

// ---------------------------------------------------------------------------
// A source: the passages that notes and questions cite

/** "2 notas e 1 pergunta": who cites a passage, in the locale's own list words. */
export function citedByText(
  t: Translator,
  entry: Pick<PassageEntry, "notes" | "questions">
): string {
  const parts = [
    entry.notes > 0 ? countText(t, "notes", entry.notes) : null,
    entry.questions > 0 ? countText(t, "questions", entry.questions) : null
  ].filter((part): part is string => part !== null);
  return t("contextPanel.evidence.citedBy", {
    values: {
      parts: new Intl.ListFormat(t.locale, { style: "long", type: "conjunction" }).format(parts)
    }
  });
}

export function SourceEvidenceView({
  t,
  sourceId,
  read,
  resolved,
  onOpen,
  onMore,
  onRetry
}: {
  t: Translator;
  sourceId: string;
  read: Read<Paged<ObjectBacklink>>;
  resolved: ReadonlyMap<string, ObjectResolved>;
  onOpen: ContextTabProps["onOpen"];
  onMore: () => void;
  onRetry: () => void;
}) {
  const items = read.status === "ready" ? read.value.items : [];
  const { passages } = groupPassages(items);
  const state: PanelLoadState = listState(
    read.status === "ready"
      ? { status: "ready", value: { items: passages, hasMore: read.value.hasMore } }
      : read
  );
  return (
    <EvidenceShell
      t={t}
      kind="source"
      title={t("contextPanel.headings.evidence.source.title")}
      description={t("contextPanel.headings.evidence.source.description")}
      detail={
        read.status === "ready" && !read.value.hasMore && passages.length > 0
          ? `${countText(t, "passages", passages.length)}.`
          : undefined
      }
      read={read}
      emptyText={t("contextPanel.evidence.empty.source")}
      onRetry={onRetry}
      state={state}
    >
      {read.status === "ready" ? (
        <>
          <ul className="m-0 mb-4 list-none p-0">
            {passages.map((entry) => {
              const target = passageAddress(sourceId, entry.anchor);
              return (
                <li key={entry.anchor}>
                  <EvidenceRow
                    quote={entry.snippet ?? resolved.get(target)?.preview ?? null}
                    meta={[citedByText(t, entry)]}
                    address={target}
                    onOpen={onOpen}
                  />
                </li>
              );
            })}
          </ul>
          <ShowMore t={t} paged={read.value} onMore={onMore} />
        </>
      ) : null}
    </EvidenceShell>
  );
}

function SourceEvidence(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const vias = ["evidence", "question_citation"] as const;
  const paged = usePagedRead<ObjectBacklink, string>({
    key: `source:${id}`,
    active,
    follow: [address],
    first: (app) => readBacklinks(app, address, vias, null),
    next: (app, cursor) => readBacklinks(app, address, vias, cursor),
    keyOf: backlinkKey
  });
  const items = paged.read.status === "ready" ? paged.read.value.items : [];
  const { passages } = groupPassages(items);
  // A passage only a question cites has no snippet: its own words are read from the passage.
  const resolved = useResolved(
    passages
      .filter((entry) => entry.snippet === null)
      .map((entry) => passageAddress(id, entry.anchor)),
    { active, path: false }
  );
  useReportedState(
    listState(
      paged.read.status === "ready"
        ? { status: "ready", value: { items: passages, hasMore: paged.read.value.hasMore } }
        : paged.read
    ),
    onState
  );
  useReportedCount(
    paged.read.status === "ready" && !paged.read.value.hasMore ? passages.length : null,
    onCount
  );
  return (
    <SourceEvidenceView
      t={t}
      sourceId={id}
      read={paged.read}
      resolved={resolved}
      onOpen={onOpen}
      onMore={paged.loadMore}
      onRetry={paged.retry}
    />
  );
}

// ---------------------------------------------------------------------------
// A question: the sources its answer cites, in the order of the numbers

export function QuestionEvidenceView({
  t,
  read,
  resolved,
  onOpen,
  onRetry
}: {
  t: Translator;
  read: Read<{ citations: AnswerCitation[] }>;
  resolved: ReadonlyMap<string, ObjectResolved>;
  onOpen: ContextTabProps["onOpen"];
  onRetry: () => void;
}) {
  const citations = read.status === "ready" ? read.value.citations : [];
  const state: PanelLoadState = listState(
    read.status === "ready" ? { status: "ready", value: { items: citations } } : read
  );
  return (
    <EvidenceShell
      t={t}
      kind="question"
      title={t("contextPanel.headings.evidence.question.title")}
      description={t("contextPanel.headings.evidence.question.description")}
      detail={citations.length > 0 ? `${countText(t, "sources", citations.length)}.` : undefined}
      read={read}
      emptyText={t("contextPanel.evidence.empty.question")}
      onRetry={onRetry}
      state={state}
    >
      <ol className="m-0 mb-4 list-none p-0">
        {citations.map((citation) => {
          const summary = citation.address ? resolved.get(citation.address) : undefined;
          const gone = citation.address === null || citation.unavailable;
          return (
            <li key={citation.number}>
              <EvidenceRow
                number={citation.number}
                quote={gone ? "" : (summary?.preview ?? null)}
                meta={[summary?.title || t("objects.kinds.source")]}
                note={
                  gone
                    ? t("contextPanel.evidence.unavailable")
                    : citation.stale
                      ? t("contextPanel.evidence.stale")
                      : undefined
                }
                address={gone ? null : citation.address}
                onOpen={onOpen}
              />
            </li>
          );
        })}
      </ol>
    </EvidenceShell>
  );
}

function QuestionEvidence(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const { read, retry } = useContextRead<{ citations: AnswerCitation[] } | null>({
    key: `question:${id}`,
    active,
    follow: [address],
    load: async (app) => {
      const question: QuestionView | null = await app.questions.get({ id });
      return question ? { citations: answerCitations(question.answers) } : null;
    }
  });
  const view: Read<{ citations: AnswerCitation[] }> =
    read.status === "ready"
      ? read.value
        ? { status: "ready", value: read.value }
        : { status: "error" }
      : read;
  const resolved = useResolved(
    view.status === "ready"
      ? view.value.citations.flatMap((citation) =>
          citation.address && !citation.unavailable ? [citation.address] : []
        )
      : [],
    { active, path: false }
  );
  useReportedState(
    listState(
      view.status === "ready" ? { status: "ready", value: { items: view.value.citations } } : view
    ),
    onState
  );
  useReportedCount(view.status === "ready" ? view.value.citations.length : null, onCount);
  return (
    <QuestionEvidenceView t={t} read={view} resolved={resolved} onOpen={onOpen} onRetry={retry} />
  );
}

// ---------------------------------------------------------------------------
// A topic: the passages its overview rests on

type TopicCitations = Extract<TopicPage["overview"], { status: "ready" }>["citations"];

export function TopicEvidenceView({
  t,
  read,
  onOpen,
  onRetry
}: {
  t: Translator;
  read: Read<{ citations: TopicCitations }>;
  onOpen: ContextTabProps["onOpen"];
  onRetry: () => void;
}) {
  const citations = read.status === "ready" ? read.value.citations : [];
  const state: PanelLoadState = listState(
    read.status === "ready" ? { status: "ready", value: { items: citations } } : read
  );
  return (
    <EvidenceShell
      t={t}
      kind="topic"
      title={t("contextPanel.headings.evidence.topic.title")}
      description={t("contextPanel.headings.evidence.topic.description")}
      detail={citations.length > 0 ? `${countText(t, "passages", citations.length)}.` : undefined}
      read={read}
      emptyText={t("contextPanel.evidence.empty.topic")}
      onRetry={onRetry}
      state={state}
    >
      <ol className="m-0 mb-4 list-none p-0">
        {citations.map((citation) => (
          <li key={citation.n}>
            <EvidenceRow
              number={citation.n}
              quote={citation.excerpt}
              meta={[citation.sourceTitle]}
              note={citation.available ? undefined : t("contextPanel.evidence.earlierVersion")}
              address={
                citation.sourceId
                  ? formatObjectAddress({
                      kind: "source",
                      id: citation.sourceId,
                      ...(citation.available && citation.chunkId
                        ? { anchor: { passage: citation.chunkId } }
                        : {})
                    })
                  : null
              }
              onOpen={onOpen}
            />
          </li>
        ))}
      </ol>
    </EvidenceShell>
  );
}

function TopicEvidence(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const { read, retry } = useContextRead<{ citations: TopicCitations } | null>({
    key: `topic:${id}`,
    active,
    follow: [address],
    load: async (app) => {
      const page = await app.topics.page({ id });
      if (!page) return null;
      return { citations: page.overview.status === "ready" ? page.overview.citations : [] };
    }
  });
  const view: Read<{ citations: TopicCitations }> =
    read.status === "ready"
      ? read.value
        ? { status: "ready", value: read.value }
        : { status: "error" }
      : read;
  useReportedState(
    listState(
      view.status === "ready" ? { status: "ready", value: { items: view.value.citations } } : view
    ),
    onState
  );
  useReportedCount(view.status === "ready" ? view.value.citations.length : null, onCount);
  return <TopicEvidenceView t={t} read={view} onOpen={onOpen} onRetry={retry} />;
}

// ---------------------------------------------------------------------------
// An entity has no passages of its own

function EntityEvidence({ t, onState, onCount }: ContextTabProps) {
  useReportedState("empty", onState);
  useReportedCount(null, onCount);
  return (
    <ContextFrame surface={surface} state="empty">
      <ContextHeading
        title={t("contextPanel.headings.evidence.entity.title")}
        description={t("contextPanel.headings.evidence.entity.description")}
      />
      <ContextEmpty>{t("contextPanel.evidence.empty.entity")}</ContextEmpty>
    </ContextFrame>
  );
}

export function EvidenceTab(props: ContextTabProps) {
  switch (props.kind) {
    case "note":
      return <NoteEvidence {...props} />;
    case "source":
      return <SourceEvidence {...props} />;
    case "question":
      return <QuestionEvidence {...props} />;
    case "topic":
      return <TopicEvidence {...props} />;
    case "entity":
      return <EntityEvidence {...props} />;
  }
}
export { EvidenceTab as Component };
