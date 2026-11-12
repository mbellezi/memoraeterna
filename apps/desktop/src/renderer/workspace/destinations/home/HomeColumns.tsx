import { Fragment, type ReactNode } from "react";
import { Undo2 } from "lucide-react";
import type { ChangeSetSummary, InboxItem, InboxKind } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { changeSetTitle } from "../../../components/activity/change-title";
import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { itemTitle, kindLabels, objectName } from "../../../components/inbox/inbox-model";
import { riskIcon, riskTone } from "../../../components/inbox/inbox-marks";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import type { HomeInboxRow, HomeQuestion } from "../../../../shared/ipc-home";
import { foldCrumbs, questionScope, type ArrivalRow, type HomeArea } from "./home-model";
import type { HomeUndo } from "./home-store";
import { countText, pluralKey, whenText } from "./home-text";

const nbsp = "\u00a0";

/** One header pattern for every column: the title with its link at the right, the meta under it. */
export function ColumnHeader({
  id,
  title,
  sub,
  link
}: {
  id: string;
  title: ReactNode;
  sub: ReactNode;
  link?: { label: string; onClick?: (() => void) | undefined } | undefined;
}) {
  return (
    <header className="grid gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <h3
          id={id}
          className="m-0 min-w-0 rounded-sm text-base font-semibold text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {title}
        </h3>
        {link?.onClick ? (
          <button
            type="button"
            onClick={link.onClick}
            className={cn(
              "shrink-0 cursor-pointer rounded-sm border-0 bg-transparent p-0 text-sm font-medium text-accent hover:text-accent-hover",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            )}
          >
            {link.label}
          </button>
        ) : null}
      </div>
      <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">{sub}</p>
    </header>
  );
}

/** A column: its header and its rows, placed in the grid by its area. */
export function Column({
  area,
  headerId,
  header,
  children
}: {
  area: HomeArea;
  headerId: string;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={headerId}
      style={{ gridArea: area }}
      className="grid min-w-0 content-start gap-3"
    >
      {header}
      {children}
    </section>
  );
}

const rowButton =
  "grid w-full min-w-0 cursor-pointer gap-0.5 border-0 bg-transparent px-0 py-3 text-left hover:bg-transparent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

const riskWords = {
  high: "home.need.risk.high",
  medium: "home.need.risk.medium",
  low: "home.need.risk.low"
} as const satisfies Record<HomeInboxRow["risk"], MessageKey>;

// ---------------------------------------------------------------------------
// Precisa de você

const positive = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;

/** The kind of decision as one singular word ("Contradição"), not the Inbox filter's plural. */
const needKindWords = {
  review: "home.need.kinds.review",
  quarantined: "home.need.kinds.quarantined",
  contradiction: "home.need.kinds.contradiction",
  withdrawn: "home.need.kinds.withdrawn",
  suggestion: "home.need.kinds.suggestion",
  duplicate: "home.need.kinds.duplicate",
  obsidian_conflict: "home.need.kinds.obsidianConflict",
  budget: "home.need.kinds.budget",
  backlog: "home.need.kinds.backlog"
} as const satisfies Record<InboxKind, MessageKey>;

const reviewKindWords = {
  topic: "home.need.kinds.reviewTopic",
  relation: "home.need.kinds.reviewRelation",
  overview: "home.need.kinds.reviewOverview"
} as const satisfies Record<string, MessageKey>;

/**
 * What a decision would change, when it says so: the notes that get a new path in a proposal of
 * the tree, the items of any other proposal, the notes of a backlog, the notes a contradiction or a
 * duplicate is about. Null when the item names no count.
 */
function impactText(t: Translator, item: InboxItem): string | null {
  const items = positive(item.changeSet?.titleParams.items);
  if (items !== null) {
    if (item.kind === "review" && item.variant === "topic")
      return t(
        pluralKey(t.locale, items, "home.need.impact.pathOne", "home.need.impact.pathOther"),
        { values: { count: new Intl.NumberFormat(t.locale).format(items) } }
      );
    return countText(t, "items", items);
  }
  if (item.kind === "backlog") {
    const notes = positive(item.params.notes);
    return notes === null ? null : countText(t, "notes", notes);
  }
  const noteCount = item.objects.filter((object) => object.kind === "note").length;
  return noteCount > 0 ? countText(t, "notes", noteCount) : null;
}

/**
 * The line under a row's title: the kind of decision and what it touches ("Estrutura · 85 notas
 * com caminho novo", "Contradição · 2 notas"). The titles of the objects it is about are the row's
 * tooltip, not part of the line.
 */
export function needMeta(t: Translator, row: HomeInboxRow): { line: string; names: string | null } {
  const item = row.item;
  if (!item) return { line: t(needKindWords[row.kind]), names: null };
  const names =
    item.objects.length > 0
      ? item.objects.map((object) => `“${objectName(t, object)}”`).join(" · ")
      : null;
  const variant =
    item.kind === "review" && Object.hasOwn(reviewKindWords, item.variant)
      ? reviewKindWords[item.variant as keyof typeof reviewKindWords]
      : null;
  const line = [t(variant ?? needKindWords[row.kind]), impactText(t, item)]
    .filter((part) => part !== null)
    .join(" · ");
  return { line, names };
}

export function NeedColumn({
  t,
  rows,
  total,
  onOpen,
  onInbox
}: {
  t: Translator;
  rows: readonly HomeInboxRow[];
  total: number;
  onOpen?: ((row: HomeInboxRow) => void) | undefined;
  onInbox?: (() => void) | undefined;
}) {
  return (
    <Column
      area="need"
      headerId="home-need"
      header={
        <ColumnHeader
          id="home-need"
          title={t("home.need.title")}
          sub={`${countText(t, "decisions", total)} · ${t("home.need.sub")}`}
          link={{ label: t("home.need.link"), onClick: onInbox }}
        />
      }
    >
      <ul className="m-0 grid list-none p-0">
        {rows.map((row) => {
          const Icon = riskIcon[row.risk];
          const title = row.item ? itemTitle(t, row.item) : t(kindLabels[row.kind]);
          const meta = needMeta(t, row);
          const button = (
            <button
              type="button"
              className={rowButton}
              onClick={onOpen ? () => onOpen(row) : undefined}
              disabled={!onOpen}
            >
              <span
                className={cn(
                  "inline-flex items-center gap-1 text-xs font-medium",
                  riskTone[row.risk]
                )}
              >
                <Icon aria-hidden="true" className="size-3.5" />
                {t(riskWords[row.risk])}
              </span>
              <span className="text-sm font-medium text-foreground [text-wrap:pretty]">
                {title}
              </span>
              <span className="text-xs text-muted-foreground [text-wrap:pretty]">{meta.line}</span>
            </button>
          );
          return (
            <li key={`${row.kind}:${row.id}`} className="border-t border-border first:border-t-0">
              {meta.names ? (
                <Tooltip label={meta.names} side="top">
                  {button}
                </Tooltip>
              ) : (
                button
              )}
            </li>
          );
        })}
      </ul>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// O que o Jardineiro fez

export function GardenerColumn({
  t,
  count,
  since,
  changes,
  undo,
  readAt,
  onUndo,
  onAll
}: {
  t: Translator;
  count: number;
  /** "since your last visit" or "in the last 7 days". */
  since: "visit" | "week";
  changes: readonly ChangeSetSummary[];
  undo: Readonly<Record<string, HomeUndo>>;
  readAt: number;
  onUndo?: ((change: ChangeSetSummary) => void) | undefined;
  onAll?: (() => void) | undefined;
}) {
  return (
    <Column
      area="gard"
      headerId="home-gard"
      header={
        <ColumnHeader
          id="home-gard"
          title={t("home.gardenerColumn.title")}
          sub={`${countText(t, "changes", count)} ${t(since === "visit" ? "home.since.visit" : "home.since.week")}`}
          link={{ label: t("home.gardenerColumn.all"), onClick: onAll }}
        />
      }
    >
      <ol className="relative m-0 grid list-none gap-4 p-0 before:absolute before:bottom-2 before:left-[3.5px] before:top-2 before:w-px before:bg-[var(--thread)]">
        {changes.map((change, index) => {
          const key = `${change.kind}:${change.id}`;
          const row = undo[key];
          const proposal = change.status === "pending_review";
          const undone = row?.status === "undone";
          // "Por quê?" sits under the first row's title, beside its date and Desfazer.
          const withWhy = index === 0 && onAll !== undefined;
          return (
            <li key={key} className="relative grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 pl-5">
              <span
                aria-hidden="true"
                className={cn(
                  "absolute left-0 top-[0.4rem] size-2 rounded-full",
                  proposal ? "border border-border-strong bg-background" : "bg-muted-foreground"
                )}
              />
              <p className="m-0 min-w-0 text-sm text-foreground [text-wrap:pretty]">
                {changeSetTitle(t, change)}
              </p>
              <div
                className={cn(
                  "grid content-start justify-items-end gap-0.5 text-xs text-muted-foreground",
                  withWhy && "row-span-2"
                )}
              >
                <span className="whitespace-nowrap">{whenText(t, change.at, readAt)}</span>
                {!proposal && !undone && change.undo === "available" ? (
                  <button
                    type="button"
                    disabled={row?.status === "pending" || !onUndo}
                    onClick={onUndo ? () => onUndo(change) : undefined}
                    className={cn(
                      "cursor-pointer rounded-sm border-0 bg-transparent p-0 text-xs font-medium text-accent hover:text-accent-hover",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                      "disabled:cursor-not-allowed disabled:opacity-45"
                    )}
                  >
                    {row?.status === "pending" ? (
                      t("activity.done.undoing")
                    ) : (
                      <span className="inline-flex items-center gap-1">
                        <Undo2 aria-hidden="true" className="size-3" />
                        {t("activity.done.undo")}
                      </span>
                    )}
                  </button>
                ) : null}
              </div>
              <div
                className={cn(
                  "grid justify-items-start gap-0.5 text-xs text-muted-foreground",
                  withWhy ? "col-start-1" : "col-span-2"
                )}
              >
                {proposal ? <span>{t("home.gardenerColumn.proposed")}</span> : null}
                {undone ? <span role="status">{t("activity.done.undone")}</span> : null}
                {!proposal && !undone && change.undo === "blocked" && row === undefined ? (
                  <span>{t("activity.done.undoBlocked")}</span>
                ) : null}
                {row && (row.status === "blocked" || row.status === "failed") ? (
                  <span role="alert" className="text-secondary-foreground">
                    {t(row.messageKey)}
                  </span>
                ) : null}
                {withWhy ? (
                  <button
                    type="button"
                    onClick={onAll}
                    className={cn(
                      "cursor-pointer rounded-sm border-0 bg-transparent p-0 text-xs font-medium text-accent hover:text-accent-hover",
                      "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                    )}
                  >
                    {t("home.gardenerColumn.why")}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </Column>
  );
}

// ---------------------------------------------------------------------------
// Chegou

export function ArrivedColumn({
  t,
  sources,
  notes,
  rows,
  readAt,
  onOpen,
  onLibrary
}: {
  t: Translator;
  sources: number;
  notes: number;
  rows: readonly ArrivalRow[];
  readAt: number;
  onOpen?: ((address: string) => void) | undefined;
  onLibrary?: (() => void) | undefined;
}) {
  return (
    <Column
      area="arr"
      headerId="home-arr"
      header={
        <ColumnHeader
          id="home-arr"
          title={t("home.arrived.title")}
          sub={`${countText(t, "sources", sources)} · ${countText(t, "notes", notes)}`}
          link={{ label: t("home.arrived.link"), onClick: onLibrary }}
        />
      }
    >
      <ul className="m-0 grid list-none p-0">
        {rows.map((row) => {
          const { folded, shown } = foldCrumbs(row.crumbs);
          const path = row.crumbs.join(" › ");
          return (
            <li key={row.address} className="border-t border-border first:border-t-0">
              <button
                type="button"
                className={cn(rowButton, "grid-cols-[1rem_minmax(0,1fr)_auto] gap-x-3")}
                onClick={onOpen ? () => onOpen(row.address) : undefined}
                disabled={!onOpen}
              >
                <ObjectKindGlyph
                  kind="source"
                  size={16}
                  className={cn("mt-0.5", objectKindTextClass.source)}
                />
                <span className="min-w-0 text-sm font-medium text-foreground [text-wrap:balance]">
                  {row.title}
                </span>
                <span className="grid content-start justify-items-end text-xs text-muted-foreground">
                  {row.notes !== null ? (
                    <span className="text-sm font-semibold tabular-nums text-foreground">
                      {row.notes}
                    </span>
                  ) : null}
                  <span className="whitespace-nowrap">{whenText(t, row.createdAt, readAt)}</span>
                </span>
                <span
                  className="col-start-2 col-end-4 min-w-0 text-xs text-muted-foreground"
                  title={path === "" ? undefined : path}
                >
                  {row.generating ? (
                    <Progress t={t} progress={row.progress} />
                  ) : shown.length > 0 ? (
                    <span className="flex items-start gap-1">
                      <ObjectKindGlyph
                        kind="topic"
                        size={12}
                        className={cn("mt-0.5 shrink-0", objectKindTextClass.topic)}
                      />
                      <span className="min-w-0 [overflow-wrap:anywhere] [text-wrap:pretty]">
                        {folded ? `…${nbsp}› ` : null}
                        {shown.map((crumb, index) => (
                          <Fragment key={`${index}:${crumb}`}>
                            {index > 0 ? `${nbsp}› ` : null}
                            {crumb}
                          </Fragment>
                        ))}
                      </span>
                    </span>
                  ) : (
                    t("home.arrived.noPlace")
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Column>
  );
}

function Progress({ t, progress }: { t: Translator; progress: ArrivalRow["progress"] }) {
  const numbers = new Intl.NumberFormat(t.locale);
  const share =
    progress && progress.estimate ? Math.min(1, progress.done / progress.estimate) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span>{t("home.arrived.generating")}</span>
      {share !== null ? (
        <span aria-hidden="true" className="h-1 w-16 overflow-hidden rounded-full bg-soft">
          <span
            className="block h-full rounded-full bg-accent"
            style={{ width: `${Math.round(share * 100)}%` }}
          />
        </span>
      ) : null}
      {progress ? (
        <span className="tabular-nums">
          {progress.estimate
            ? t("home.arrived.progressOf", {
                values: {
                  done: numbers.format(progress.done),
                  total: numbers.format(progress.estimate)
                }
              })
            : t("home.arrived.progressSoFar", { values: { done: numbers.format(progress.done) } })}
        </span>
      ) : null}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Perguntas recentes

export function QuestionsColumn({
  t,
  questions,
  topicTitles = {},
  readAt,
  onOpen,
  onAll
}: {
  t: Translator;
  questions: readonly HomeQuestion[];
  /** The titles of the topics the questions were asked in, by topic id. */
  topicTitles?: Readonly<Record<string, string>>;
  readAt: number;
  onOpen?: ((id: string) => void) | undefined;
  onAll?: (() => void) | undefined;
}) {
  return (
    <Column
      area="back"
      headerId="home-back"
      header={
        <ColumnHeader
          id="home-back"
          title={t("home.questions.title")}
          sub={t("home.questions.sub")}
          link={{ label: t("home.questions.link"), onClick: onAll }}
        />
      }
    >
      <ul className="m-0 grid list-none p-0">
        {questions.map((question) => {
          const scope = questionScope(question.scope, topicTitles);
          const scopeNode: ReactNode =
            scope.kind === "library" ? (
              t("home.questions.scopeLibrary")
            ) : scope.kind === "topic" ? (
              scope.title === null ? (
                t("home.questions.scopeTopic")
              ) : (
                <span className="inline-flex max-w-full items-baseline gap-1 align-baseline">
                  <ObjectKindGlyph
                    kind="topic"
                    size={12}
                    className={cn("shrink-0 self-center", objectKindTextClass.topic)}
                  />
                  <span className="min-w-0 [overflow-wrap:anywhere]">{scope.title}</span>
                </span>
              )
            ) : (
              countText(t, "sources", scope.count)
            );
          const meta: ReactNode[] = [
            scopeNode,
            question.status === "running"
              ? t("home.questions.running")
              : question.status === "failed"
                ? t("home.questions.failed")
                : null,
            whenText(t, question.createdAt, readAt)
          ].filter((part) => part !== null);
          return (
            <li key={question.id} className="border-t border-border first:border-t-0">
              <button
                type="button"
                className={cn(rowButton, "grid-cols-[1rem_minmax(0,1fr)] gap-x-3")}
                onClick={onOpen ? () => onOpen(question.id) : undefined}
                disabled={!onOpen}
              >
                <ObjectKindGlyph
                  kind="question"
                  size={16}
                  className={cn("mt-0.5", objectKindTextClass.question)}
                />
                <span className="line-clamp-2 min-w-0 text-sm font-medium text-foreground [text-wrap:pretty]">
                  {question.text}
                </span>
                <span className="col-start-2 text-xs text-muted-foreground [text-wrap:pretty]">
                  {meta.map((part, index) => (
                    <Fragment key={index}>
                      {index > 0 ? " · " : null}
                      {part}
                    </Fragment>
                  ))}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </Column>
  );
}
