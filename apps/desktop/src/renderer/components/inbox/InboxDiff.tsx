import { useId, useState } from "react";
import type { ChangesDiff } from "@app/domain";
import type { Translator } from "@app/i18n";

import { IcicleDiffView, type IcicleDiffDisplay } from "../topic-shape/IcicleDiff";
import { Button } from "../ui/button";
import { overviewDiffView, relationDiffRows } from "./inbox-diff-model";
import type { InboxDiffLoad } from "./inbox-state";

export interface InboxDiffProps {
  t: Translator;
  load: InboxDiffLoad | undefined;
  onRetry: () => void;
  /** Opens a topic the structural diff names (one that still exists). */
  onOpenTopic?: ((topicId: string) => void) | undefined;
}

/**
 * What a change-set would change, read from `changes.diff`: the topic tree before and after as
 * icicles with their table alternative (T95's view), the connections a pass touched, an overview
 * before and after with the Divergences kept beside it.
 */
export function InboxDiff({ t, load, onRetry, onOpenTopic }: InboxDiffProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-xs font-semibold text-secondary-foreground">
        {t("inbox.diff.title")}
      </h3>
      <DiffBody t={t} load={load} onRetry={onRetry} onOpenTopic={onOpenTopic} />
    </section>
  );
}

function DiffBody({ t, load, onRetry, onOpenTopic }: InboxDiffProps) {
  if (!load || load.status === "loading")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("inbox.diff.loading")}
      </p>
    );
  if (load.status === "missing")
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {t("inbox.diff.missing")}
      </p>
    );
  if (load.status === "error")
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-danger">
        <p>{t("inbox.diff.error")}</p>
        <Button type="button" onClick={onRetry}>
          {t("shell.actions.retry")}
        </Button>
      </div>
    );
  return <DiffContent t={t} diff={load.diff} onOpenTopic={onOpenTopic} />;
}

function hiddenNote(t: Translator, hidden: number) {
  if (hidden <= 0) return null;
  return (
    <p className="text-xs text-muted-foreground">
      {t("inbox.diff.hidden", {
        values: { count: new Intl.NumberFormat(t.locale).format(hidden) }
      })}
    </p>
  );
}

function DiffContent({
  t,
  diff,
  onOpenTopic
}: {
  t: Translator;
  diff: ChangesDiff;
  onOpenTopic: ((topicId: string) => void) | undefined;
}) {
  // A new change-set starts on the chart with nothing selected.
  if (diff.kind === "topic")
    return <TopicDiff key={diff.summary.id} t={t} diff={diff} onOpenTopic={onOpenTopic} />;
  if (diff.kind === "relation") {
    const rows = relationDiffRows(t, diff.relations);
    return (
      <>
        <table className="w-full border-collapse text-left text-xs">
          <caption className="sr-only">{t("inbox.diff.relation.caption")}</caption>
          <thead>
            <tr className="text-secondary-foreground">
              <th scope="col" className="py-1 pr-3 font-semibold">
                {t("inbox.diff.relation.connection")}
              </th>
              <th scope="col" className="py-1 pr-3 font-semibold">
                {t("inbox.diff.relation.change")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-t border-border align-top">
                <td className="py-1.5 pr-3 text-foreground [overflow-wrap:anywhere]">
                  {row.between}
                  <span className="block text-muted-foreground">{row.type}</span>
                </td>
                <td className="py-1.5 pr-3 text-foreground">{row.changeLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {hiddenNote(t, diff.hidden)}
      </>
    );
  }
  const view = overviewDiffView(t, diff);
  const sides = [
    { id: "before", title: t("inbox.diff.overview.before"), side: view.before },
    { id: "after", title: t("inbox.diff.overview.after"), side: view.after }
  ] as const;
  return (
    <>
      <p className="text-sm font-medium text-foreground [overflow-wrap:anywhere]">{view.topic}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        {sides.map(({ id, title, side }) => (
          <section key={id} className="flex min-w-0 flex-col gap-1 rounded-md bg-soft p-3">
            <h4 className="text-xs font-semibold text-secondary-foreground">{title}</h4>
            {side && side.paragraphs.length > 0 ? (
              side.paragraphs.map((paragraph, index) => (
                <p key={index} className="text-xs text-foreground [overflow-wrap:anywhere]">
                  {paragraph}
                </p>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">{t("inbox.diff.overview.empty")}</p>
            )}
          </section>
        ))}
      </div>
      {view.divergences.length > 0 ? (
        <section className="flex flex-col gap-1">
          <h4 className="text-xs font-semibold text-secondary-foreground">
            {t("inbox.diff.overview.divergences")}
          </h4>
          <ul className="flex list-disc flex-col gap-1 pl-4 text-xs text-foreground">
            {view.divergences.map((sentence, index) => (
              <li key={index} className="[overflow-wrap:anywhere]">
                {sentence}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * The structural diff as T95 draws it: the icicles before and after, the same topics as a table
 * (the Chart/Table switch) and the selected topic in words. The Inbox has read the diff already, so
 * the view is given it ready; the choice of chart or table and the selection are this pane's.
 */
function TopicDiff({
  t,
  diff,
  onOpenTopic
}: {
  t: Translator;
  diff: Extract<ChangesDiff, { kind: "topic" }>;
  onOpenTopic: ((topicId: string) => void) | undefined;
}) {
  const [display, setDisplay] = useState<IcicleDiffDisplay>("chart");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  return (
    <IcicleDiffView
      t={t}
      snapshot={{ load: { status: "ready", nodes: diff.nodes, hidden: diff.hidden }, selectedId }}
      display={display}
      onDisplay={setDisplay}
      onSelect={setSelectedId}
      // The pane's own error state has the retry; a ready view has nothing to read again.
      onRetry={() => undefined}
      onOpenTopic={onOpenTopic}
    />
  );
}
