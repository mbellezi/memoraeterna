import type { BacklinkVia, ObjectBacklink, ObjectKind, ObjectResolved } from "@app/domain";
import { parseObjectAddress } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { countText, groupBacklinks, mentionVias } from "../context-model";
import {
  ContextEmpty,
  ContextError,
  ContextFrame,
  ContextHeading,
  ContextLoading,
  ContextRow,
  GroupHeading,
  listState,
  ShowMore,
  useReportedCount,
  useReportedState,
  type ContextTabProps
} from "./context-parts";
import {
  backlinkKey,
  readBacklinks,
  usePagedRead,
  useResolved,
  type Paged,
  type Read
} from "./context-reads";

/** The Menções tab (design record §5.6): where the object is cited without a connection. */
export const tab = "mentions";
export const surface = "context-mentions";

/** The kinds of link each kind of object shows under Mentions (relations are Connections'). */
const viasOf: Readonly<Record<ObjectKind, readonly BacklinkVia[]>> = {
  note: ["overview_citation", "question_citation"],
  source: ["question_citation"],
  topic: ["question_citation"],
  entity: ["mention"],
  question: []
};

const groupKeys: Readonly<Partial<Record<BacklinkVia, MessageKey>>> = {
  mention: "contextPanel.mentions.groups.mention",
  overview_citation: "contextPanel.mentions.groups.overview",
  question_citation: "contextPanel.mentions.groups.question"
};

/** The vias Mentions shows, in the order of the groups. */
export const mentionViasOf = (kind: ObjectKind): readonly BacklinkVia[] =>
  mentionVias.filter((via) => viasOf[kind].includes(via));

export function MentionsView({
  t,
  kind,
  read,
  resolved,
  onOpen,
  onMore,
  onRetry
}: {
  t: Translator;
  kind: ObjectKind;
  read: Read<Paged<ObjectBacklink>>;
  resolved: ReadonlyMap<string, ObjectResolved>;
  onOpen: ContextTabProps["onOpen"];
  onMore: () => void;
  onRetry: () => void;
}) {
  const state = listState(read);
  const items = read.status === "ready" ? read.value.items : [];
  const groups = groupBacklinks(items, mentionViasOf(kind));
  const detail =
    read.status === "ready" && !read.value.hasMore && items.length > 0
      ? `${countText(t, "mentions", items.length)}.`
      : undefined;
  return (
    <ContextFrame surface={surface} state={state}>
      <ContextHeading
        title={t("contextPanel.headings.mentions.title")}
        description={t("contextPanel.headings.mentions.description")}
        detail={detail}
      />
      {read.status === "loading" ? (
        <ContextLoading t={t} />
      ) : read.status === "error" ? (
        <ContextError t={t} message="contextPanel.errors.mentions" kept={kind} onRetry={onRetry} />
      ) : items.length === 0 ? (
        <ContextEmpty>{t("contextPanel.mentions.empty")}</ContextEmpty>
      ) : (
        <>
          {groups.map((group) => {
            const key = groupKeys[group.via];
            return (
              <section key={group.via} className="mb-4" aria-label={key ? t(key) : group.via}>
                {key ? <GroupHeading count={group.items.length}>{t(key)}</GroupHeading> : null}
                {group.items.map((item) => {
                  const parsed = parseObjectAddress(item.from);
                  const showPath = parsed?.kind === "note" || parsed?.kind === "topic";
                  return (
                    <ContextRow
                      key={backlinkKey(item)}
                      t={t}
                      object={{
                        address: item.from,
                        kind: parsed?.kind ?? "note",
                        // The question's own words; a note or a topic is named by its summary.
                        ...(parsed?.kind === "question" && item.snippet
                          ? { title: item.snippet }
                          : {})
                      }}
                      resolved={resolved.get(item.from)}
                      path={showPath}
                      showKind
                      onOpen={onOpen}
                      extra={
                        item.via !== "question_citation" && item.snippet ? (
                          <span className="mt-0.5 line-clamp-2 block text-xs leading-5 text-secondary-foreground">
                            {item.snippet}
                          </span>
                        ) : null
                      }
                    />
                  );
                })}
              </section>
            );
          })}
          <ShowMore t={t} paged={read.value} onMore={onMore} />
        </>
      )}
    </ContextFrame>
  );
}

export function MentionsTab(props: ContextTabProps) {
  const { t, kind, address, active, onOpen, onState, onCount } = props;
  const vias = mentionViasOf(kind);
  const paged = usePagedRead<ObjectBacklink, string>({
    key: `mentions:${address}`,
    active: active && vias.length > 0,
    follow: [address],
    first: (app) => readBacklinks(app, address, vias, null),
    next: (app, cursor) => readBacklinks(app, address, vias, cursor),
    keyOf: backlinkKey
  });
  const items = paged.read.status === "ready" ? paged.read.value.items : [];
  const resolved = useResolved(
    items.map((item) => item.from),
    { active, path: true }
  );
  // A question is cited by nothing: there is nothing to read, and the tab says so.
  const read: Read<Paged<ObjectBacklink>> =
    vias.length === 0
      ? { status: "ready", value: { items: [], total: 0, hasMore: false, more: "idle" } }
      : paged.read;
  useReportedState(listState(read), onState);
  useReportedCount(
    read.status === "ready" && !read.value.hasMore ? read.value.items.length : null,
    onCount
  );
  return (
    <MentionsView
      t={t}
      kind={kind}
      read={read}
      resolved={resolved}
      onOpen={onOpen}
      onMore={paged.loadMore}
      onRetry={paged.retry}
    />
  );
}
export { MentionsTab as Component };
