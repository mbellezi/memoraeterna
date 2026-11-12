import { useState, type KeyboardEvent } from "react";
import { Check, Delete, Link2, X } from "lucide-react";
import { formatObjectAddress, type NotePageRelation, type ObjectResolved } from "@app/domain";
import type { Translator } from "@app/i18n";

import { refreshRelationLimit, relationSentence } from "../../components/note-page/note-page-model";
import { StanceGlyph } from "../../components/glyphs";
import { Button } from "../../components/ui/button";
import { Kbd } from "../../components/ui/kbd";
import { cn } from "../../lib/cn";
import { relationTypeView, stanceTextClass } from "../../lib/relation-stance";
import {
  connectionCounts,
  connectionMeta,
  connectionPageSize,
  connectionTotal,
  countText,
  groupConnections,
  groupHeadingKey,
  isShownSourceRelation,
  sourceConnectionRow,
  suggestionRouting,
  suggestionVerdict,
  type ConnectionRow
} from "../context-model";
import type { PanelLoadState } from "../PanelFrame";
import { formatView } from "../route";
import {
  ContextEmpty,
  ContextFoot,
  ContextLink,
  ContextError,
  ContextFrame,
  ContextHeading,
  ContextLoading,
  ContextRow,
  GroupHeading,
  listState,
  ShowMore,
  StanceLegend,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";
import { useContextRead, usePagedRead, useResolved, type Paged, type Read } from "./context-reads";

/** The Conexões tab (design record §5.6): how the focused object links to others, and who decided. */
export const tab = "connections";
export const surface = "context-connections";

const mapScope = (kind: "note" | "source" | "topic" | "entity" | "question", id: string) =>
  formatView({ view: "map", lens: "relations", scope: { kind, id } });

export function ConnectionsTab(props: ContextTabProps) {
  switch (props.kind) {
    case "note":
      return <NoteConnections {...props} />;
    case "source":
      return <SourceConnections {...props} />;
    case "topic":
      return <TopicConnections {...props} />;
    case "entity":
      return <EntityConnections {...props} />;
    case "question":
      return <QuestionConnections {...props} />;
  }
}
export { ConnectionsTab as Component };

// ---------------------------------------------------------------------------
// A note

/**
 * The question a suggestion's box asks, which the person answers with Keep or Remove: "Apoia esta
 * nota?" when the other note would be the subject (the row below it names that note), "Esta nota
 * apoia a nota abaixo?" when this note would be, and "Ligadas por apoio?" when the pair has no
 * direction. A symmetric type reads the first way.
 */
function suggestionQuestion(t: Translator, row: ConnectionRow): string {
  const sentence = relationSentence({
    type: row.type,
    direction: row.direction,
    directionSource: row.directionSource
  });
  const upper = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
  if (sentence.key === "notePage.card.undirected")
    return t("contextPanel.connections.question.linked", {
      values: { heading: t(groupHeadingKey(row.stance, "linked")) }
    });
  const directed = relationTypeView(row.type).directed;
  if (sentence.subject === "this" && directed)
    return t("contextPanel.connections.question.thisSubject", {
      values: {
        subject: t("notePage.card.thisNoteSubject"),
        verb: t(sentence.verbKey),
        object: t("contextPanel.connections.question.below")
      }
    });
  return t("contextPanel.connections.question.otherSubject", {
    values: { verb: upper(t(sentence.verbKey)), object: t("notePage.card.thisNoteObject") }
  });
}

export interface ReviewState {
  id: string;
  status: "pending" | "failed";
}

export function NoteConnectionsView({
  t,
  read,
  resolved,
  review,
  onOpen,
  onMore,
  onRetry,
  onReview,
  onTab,
  onLink,
  mapAddress
}: {
  t: Translator;
  read: Read<Paged<NotePageRelation>>;
  resolved: ReadonlyMap<string, ObjectResolved>;
  review: ReviewState | null;
  onOpen: ContextTabProps["onOpen"];
  onMore: () => void;
  onRetry: () => void;
  onReview: (row: ConnectionRow, verdict: "keep" | "remove") => void;
  onTab?: ContextTabProps["onTab"];
  /** Starts linking this note to another; absent, the empty tab does not offer it. */
  onLink?: () => void;
  mapAddress: string;
}) {
  const state = listState(read);
  const title = t("contextPanel.headings.connections.note.title");
  const description = t("contextPanel.headings.connections.note.description");
  return (
    <ContextFrame surface={surface} state={state}>
      {read.status === "loading" ? (
        <>
          <ContextHeading title={title} description={description} />
          <ContextLoading t={t} />
        </>
      ) : read.status === "error" ? (
        <>
          <ContextHeading title={title} description={description} />
          <ContextError
            t={t}
            message="contextPanel.errors.connections"
            kept="note"
            onRetry={onRetry}
          />
        </>
      ) : read.value.items.length === 0 ? (
        <>
          <ContextHeading title={title} description={description} />
          <ContextEmpty
            action={
              onLink ? (
                <Button variant="secondary" onClick={onLink}>
                  <Link2 aria-hidden="true" />
                  {t("contextPanel.connections.link")}
                </Button>
              ) : undefined
            }
          >
            {t("contextPanel.connections.empty.note")}
          </ContextEmpty>
          <StanceLegend t={t} />
        </>
      ) : (
        <NoteConnectionsList
          t={t}
          paged={read.value}
          resolved={resolved}
          review={review}
          onOpen={onOpen}
          onMore={onMore}
          onReview={onReview}
          onTab={onTab}
          mapAddress={mapAddress}
          title={title}
          description={description}
        />
      )}
    </ContextFrame>
  );
}

function NoteConnectionsList({
  t,
  paged,
  resolved,
  review,
  onOpen,
  onMore,
  onReview,
  onTab,
  mapAddress,
  title,
  description
}: {
  t: Translator;
  paged: Paged<NotePageRelation>;
  resolved: ReadonlyMap<string, ObjectResolved>;
  review: ReviewState | null;
  onOpen: ContextTabProps["onOpen"];
  onMore: () => void;
  onReview: (row: ConnectionRow, verdict: "keep" | "remove") => void;
  onTab?: ContextTabProps["onTab"];
  mapAddress: string;
  title: string;
  description: string;
}) {
  const { groups, suggestions } = groupConnections(paged.items);
  const counts = connectionCounts(paged.items);
  // Not every row is loaded yet: the total says how many connections there are in all.
  const connections = connectionTotal(paged.items, paged);
  const detail = [
    countText(t, "connections", connections),
    counts.suggestions > 0 ? countText(t, "suggestions", counts.suggestions) : null
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <>
      <ContextHeading title={title} description={description} detail={`${detail}.`} />
      {groups.map((group) => {
        return (
          <section key={group.key} className="mb-4" aria-label={t(group.headingKey)}>
            <GroupHeading
              count={group.rows.length}
              tone={stanceTextClass[group.stance]}
              glyph={<StanceGlyph stance={group.stance} size={16} />}
            >
              {t(group.headingKey)}
            </GroupHeading>
            {group.rows.map((row) => (
              <ContextRow
                key={row.id}
                t={t}
                object={{ address: row.address, kind: "note", title: row.title }}
                resolved={resolved.get(row.address)}
                meta={connectionMeta(row).map((key) => t(key))}
                onOpen={onOpen}
              />
            ))}
          </section>
        );
      })}
      {suggestions.map((row) => (
        <SuggestionBox
          key={row.id}
          t={t}
          row={row}
          resolved={resolved.get(row.address)}
          review={review?.id === row.id ? review : null}
          onOpen={onOpen}
          onReview={onReview}
        />
      ))}
      <ShowMore t={t} paged={paged} onMore={onMore} />
      <ContextFoot
        items={[
          ...(onTab
            ? [
                <ContextLink key="graph" onClick={() => onTab("graph")}>
                  {t("contextPanel.connections.foot.graph")}
                </ContextLink>
              ]
            : []),
          <ContextLink key="map" onClick={() => onOpen(mapAddress)}>
            {t("contextPanel.connections.foot.map")}
          </ContextLink>
        ]}
      />
    </>
  );
}

/**
 * A suggested connection in its dashed box (design record §5.6): the sentence it would make true,
 * the other note with its place, who suggested it and what to do next, and Keep and Remove. The box
 * says "também na Caixa de entrada" when the Inbox holds it too (D33). Keep is `a` and Remove is
 * Backspace while focus is in the box (D34).
 */
function SuggestionBox({
  t,
  row,
  resolved,
  review,
  onOpen,
  onReview
}: {
  t: Translator;
  row: ConnectionRow;
  resolved: ObjectResolved | undefined;
  review: ReviewState | null;
  onOpen: ContextTabProps["onOpen"];
  onReview: (row: ConnectionRow, verdict: "keep" | "remove") => void;
}) {
  const pending = review?.status === "pending";
  const title = resolved?.title || row.title;
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input, textarea, select, [contenteditable='true']")) return;
    const verdict = suggestionVerdict(event);
    if (verdict === null || pending) return;
    event.preventDefault();
    onReview(row, verdict);
  };
  return (
    <section
      aria-label={t("contextPanel.connections.suggestionsLabel")}
      data-suggestion={row.id}
      onKeyDown={onKeyDown}
      className="mb-4 rounded-lg border border-dashed border-border-strong px-3 pt-2 pb-3"
    >
      <h3
        className={cn(
          "m-0 mb-1 flex items-start gap-2 text-sm font-semibold",
          stanceTextClass[row.stance]
        )}
      >
        <span className="mt-[3px] flex-none">
          <StanceGlyph stance={row.stance} size={16} />
        </span>
        <span className="min-w-0 [text-wrap:pretty]">
          {suggestionQuestion(t, row)}
          <span className="ml-2 text-xs leading-5 font-normal text-muted-foreground">
            {t("contextPanel.connections.suggestionTag")}
          </span>
        </span>
      </h3>
      <ContextRow
        t={t}
        object={{ address: row.address, kind: "note", title: row.title }}
        resolved={resolved}
        meta={[...connectionMeta(row), suggestionRouting(row)].map((key) => t(key))}
        onOpen={onOpen}
      />
      <div className="mt-1 flex flex-wrap items-center gap-2">
        <Button
          variant="secondary"
          aria-label={t("contextPanel.connections.actions.keepLabel", { values: { title } })}
          aria-keyshortcuts="a"
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={() => onReview(row, "keep")}
        >
          <Check aria-hidden="true" />
          {t("contextPanel.connections.actions.keep")}
          <Kbd>A</Kbd>
        </Button>
        <Button
          variant="ghost"
          aria-label={t("contextPanel.connections.actions.removeLabel", { values: { title } })}
          aria-keyshortcuts="Backspace"
          aria-busy={pending || undefined}
          disabled={pending}
          onClick={() => onReview(row, "remove")}
        >
          <X aria-hidden="true" />
          {t("contextPanel.connections.actions.remove")}
          <Kbd aria-hidden="true">
            <Delete className="size-3.5" />
          </Kbd>
        </Button>
      </div>
      {review?.status === "failed" ? (
        <p role="status" className="m-0 mt-2 text-xs text-secondary-foreground">
          {t("contextPanel.connections.actions.failed")}
        </p>
      ) : null}
    </section>
  );
}

function NoteConnections(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onTab, onLink, onState, onCount } = props;
  const paged = usePagedRead<NotePageRelation, number>({
    key: `note:${id}`,
    active,
    follow: [address],
    first: async (app, wanted) => {
      const page = await app.notes.relations({
        noteId: id,
        group: "shown",
        offset: 0,
        limit: refreshRelationLimit(wanted)
      });
      return {
        items: page.items,
        total: page.total,
        next: page.items.length > 0 && page.items.length < page.total ? page.items.length : null
      };
    },
    next: async (app, offset) => {
      const page = await app.notes.relations({
        noteId: id,
        group: "shown",
        offset,
        limit: connectionPageSize
      });
      return {
        items: page.items,
        total: page.total,
        next:
          page.items.length > 0 && offset + page.items.length < page.total
            ? offset + page.items.length
            : null
      };
    },
    keyOf: (relation) => relation.id
  });
  const items = paged.read.status === "ready" ? paged.read.value.items : [];
  const resolved = useResolved(
    items.map((relation) => formatObjectAddress({ kind: "note", id: relation.other.id })),
    { active, path: true }
  );
  const [review, setReview] = useState<ReviewState | null>(null);
  const onReview = (row: ConnectionRow, verdict: "keep" | "remove") => {
    if (review?.status === "pending") return;
    setReview({ id: row.id, status: "pending" });
    const request =
      typeof window === "undefined"
        ? Promise.reject(new Error("window.app is not available"))
        : window.app.relations.review({ relationId: row.id, verdict });
    request
      .then(() => {
        setReview(null);
        paged.reread();
      })
      .catch(() => setReview({ id: row.id, status: "failed" }));
  };

  const state = listState(paged.read);
  useReportedState(state, onState);
  useReportedCount(
    paged.read.status === "ready"
      ? connectionTotal(paged.read.value.items, paged.read.value)
      : null,
    onCount
  );
  return (
    <NoteConnectionsView
      t={t}
      read={paged.read}
      resolved={resolved}
      review={review}
      onOpen={onOpen}
      onMore={paged.loadMore}
      onRetry={paged.retry}
      onReview={onReview}
      {...(onTab ? { onTab } : {})}
      {...(onLink ? { onLink: () => onLink(address) } : {})}
      mapAddress={mapScope("note", id)}
    />
  );
}

// ---------------------------------------------------------------------------
// The other kinds

/** One row of a list of other objects: the object, and the words of its meta line. */
export interface OtherConnection {
  key: string;
  address: string;
  kind: "source" | "topic" | "entity";
  title: string;
  meta: string[];
}

/** The list for a kind with no stance groups: one heading, the rows, then the foot. */
function OtherConnectionsView({
  t,
  kind,
  read,
  rows,
  resolved,
  groupKey,
  onOpen,
  onRetry,
  mapAddress,
  state,
  partial = false
}: {
  t: Translator;
  kind: ContextTabProps["kind"];
  read: Read<unknown>;
  rows: readonly OtherConnection[];
  resolved: ReadonlyMap<string, ObjectResolved>;
  groupKey:
    | "contextPanel.connections.groupsOther.sources"
    | "contextPanel.connections.groupsOther.topics"
    | "contextPanel.connections.groupsOther.entities";
  onOpen: ContextTabProps["onOpen"];
  onRetry: () => void;
  mapAddress: string;
  state: PanelLoadState;
  /** More pages follow: the rows shown are not the whole count, so no total is stated. */
  partial?: boolean;
}) {
  const heading = (
    <ContextHeading
      title={t(`contextPanel.headings.connections.${kind}.title`)}
      description={t(`contextPanel.headings.connections.${kind}.description`)}
      {...(state === "success" && !partial
        ? { detail: `${countText(t, "connections", rows.length)}.` }
        : {})}
    />
  );
  return (
    <ContextFrame surface={surface} state={state}>
      {heading}
      {read.status === "loading" ? (
        <ContextLoading t={t} />
      ) : read.status === "error" ? (
        <ContextError
          t={t}
          message="contextPanel.errors.connections"
          kept={kind}
          onRetry={onRetry}
        />
      ) : rows.length === 0 ? (
        <ContextEmpty>{t(`contextPanel.connections.empty.${kind}`)}</ContextEmpty>
      ) : (
        <>
          <section className="mb-4" aria-label={t(groupKey)}>
            <GroupHeading count={rows.length}>{t(groupKey)}</GroupHeading>
            {rows.map((row) => (
              <ContextRow
                key={row.key}
                t={t}
                object={{ address: row.address, kind: row.kind, title: row.title }}
                resolved={resolved.get(row.address)}
                path={row.kind !== "entity"}
                meta={row.meta}
                onOpen={onOpen}
              />
            ))}
          </section>
          <ContextFoot
            items={[
              <ContextLink key="map" onClick={() => onOpen(mapAddress)}>
                {t("contextPanel.connections.foot.map")}
              </ContextLink>
            ]}
          />
        </>
      )}
    </ContextFrame>
  );
}

function SourceConnections(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const paged = usePagedRead<ReturnType<typeof sourceConnectionRow>, number>({
    key: `source:${id}`,
    active,
    follow: [address],
    first: async (app, wanted) => {
      const limit = Math.min(Math.max(wanted, connectionPageSize), 100);
      const page = await app.knowledge.listSourceRelations({ sourceItemId: id, offset: 0, limit });
      // The offset counts what the read returned, shown or not.
      const items = page.relations
        .filter((relation) => isShownSourceRelation(relation, id))
        .map((relation) => sourceConnectionRow(relation, id));
      return { items, total: null, next: page.hasMore ? page.relations.length : null };
    },
    next: async (app, offset) => {
      const page = await app.knowledge.listSourceRelations({
        sourceItemId: id,
        offset,
        limit: connectionPageSize
      });
      const items = page.relations
        .filter((relation) => isShownSourceRelation(relation, id))
        .map((relation) => sourceConnectionRow(relation, id));
      return { items, total: null, next: page.hasMore ? offset + page.relations.length : null };
    },
    keyOf: (row) => row.id
  });
  const items = paged.read.status === "ready" ? paged.read.value.items : [];
  const resolved = useResolved(
    items.map((row) => row.address),
    { active, path: true }
  );
  const rows: OtherConnection[] = items.map((row) => ({
    key: row.id,
    address: row.address,
    kind: "source",
    title: row.title,
    meta: [
      t(relationTypeView(row.type).wordKey),
      t(
        row.state === "kept"
          ? "contextPanel.connections.meta.byYou"
          : row.state === "suggested"
            ? "contextPanel.connections.meta.gardenerSuggested"
            : "contextPanel.connections.meta.gardener"
      )
    ]
  }));
  const state = listState(paged.read);
  useReportedState(state, onState);
  // The number is known only once every page is read: the removed relations are left out here.
  useReportedCount(
    paged.read.status === "ready" && !paged.read.value.hasMore ? items.length : null,
    onCount
  );
  return (
    <>
      <OtherConnectionsView
        t={t}
        kind="source"
        partial={paged.read.status === "ready" && paged.read.value.hasMore}
        read={paged.read}
        rows={rows}
        resolved={resolved}
        groupKey="contextPanel.connections.groupsOther.sources"
        onOpen={onOpen}
        onRetry={paged.retry}
        mapAddress={mapScope("source", id)}
        state={state}
      />
      {paged.read.status === "ready" ? (
        <ShowMore t={t} paged={paged.read.value} onMore={paged.loadMore} />
      ) : null}
    </>
  );
}

function TopicConnections(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const { read, retry } = useContextRead({
    key: `topic:${id}`,
    active,
    follow: [address],
    load: (app) => app.topics.page({ id })
  });
  const related = read.status === "ready" && read.value ? read.value.relatedTopics : [];
  const empty: Read<{ items: unknown[] }> =
    read.status === "ready" ? { status: "ready", value: { items: related } } : read;
  const rows: OtherConnection[] = related.map((topic) => ({
    key: topic.id,
    address: formatObjectAddress({ kind: "topic", id: topic.id }),
    kind: "topic",
    title: topic.title ?? "",
    meta: [countText(t, "connections", topic.relationCount)]
  }));
  const resolved = useResolved(
    rows.map((row) => row.address),
    { active, path: true }
  );
  const state = listState(empty);
  useReportedState(state, onState);
  useReportedCount(read.status === "ready" ? rows.length : null, onCount);
  return (
    <OtherConnectionsView
      t={t}
      kind="topic"
      read={read.status === "ready" && read.value === null ? { status: "error" } : read}
      rows={rows}
      resolved={resolved}
      groupKey="contextPanel.connections.groupsOther.topics"
      onOpen={onOpen}
      onRetry={retry}
      mapAddress={mapScope("topic", id)}
      state={read.status === "ready" && read.value === null ? "error" : state}
    />
  );
}

function EntityConnections(props: ContextTabProps) {
  const { t, id, address, active, onOpen, onState, onCount } = props;
  const { read, retry } = useContextRead({
    key: `entity:${id}`,
    active,
    follow: [address],
    load: (app) => app.entities.page({ id })
  });
  const co = read.status === "ready" && read.value ? (read.value.coMentioned ?? []) : [];
  const rows: OtherConnection[] = co.map((entity) => ({
    key: entity.id,
    address: formatObjectAddress({ kind: "entity", id: entity.id }),
    kind: "entity",
    title: entity.canonicalName,
    meta: [
      t("contextPanel.connections.meta.inCommon", {
        values: { notes: countText(t, "notes", entity.sharedNotes) }
      })
    ]
  }));
  const failed = read.status === "ready" && read.value === null;
  const asList: Read<{ items: unknown[] }> =
    read.status === "ready" ? { status: "ready", value: { items: co } } : read;
  const state = failed ? "error" : listState(asList);
  useReportedState(state, onState);
  useReportedCount(read.status === "ready" ? rows.length : null, onCount);
  return (
    <OtherConnectionsView
      t={t}
      kind="entity"
      read={failed ? { status: "error" } : read}
      rows={rows}
      resolved={new Map()}
      groupKey="contextPanel.connections.groupsOther.entities"
      onOpen={onOpen}
      onRetry={retry}
      mapAddress={mapScope("entity", id)}
      state={state}
    />
  );
}

/** A question has no connections of its own: what it cites is under Evidence. */
function QuestionConnections(props: ContextTabProps) {
  const { t, onState, onCount } = props;
  useReportedState("empty", onState);
  useReportedCount(null, onCount);
  return (
    <ContextFrame surface={surface} state="empty">
      <ContextHeading
        title={t("contextPanel.headings.connections.question.title")}
        description={t("contextPanel.headings.connections.question.description")}
      />
      <ContextEmpty>{t("contextPanel.connections.empty.question")}</ContextEmpty>
    </ContextFrame>
  );
}
