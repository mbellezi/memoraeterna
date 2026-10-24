import { useId } from "react";
import { ArrowRightLeft, Layers, Minus, PenLine, Plus } from "lucide-react";
import type { ChangesDiff, TopicDiffChange } from "@app/domain";
import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Button } from "../ui/button";
import {
  overviewDiffView,
  relationDiffRows,
  topicDiffRows,
  type TopicDiffRow
} from "./inbox-diff-model";
import type { InboxDiffLoad } from "./inbox-state";

/** A change as a glyph and a word; the colour only repeats it. */
const changeMark: Record<TopicDiffChange, { icon: typeof Plus; tone: string }> = {
  added: { icon: Plus, tone: "text-success" },
  removed: { icon: Minus, tone: "text-danger" },
  moved: { icon: ArrowRightLeft, tone: "text-info" },
  renamed: { icon: PenLine, tone: "text-info" },
  changed: { icon: PenLine, tone: "text-info" },
  items: { icon: Layers, tone: "text-info" },
  context: { icon: Layers, tone: "text-muted-foreground" }
};

export interface InboxDiffProps {
  t: Translator;
  load: InboxDiffLoad | undefined;
  onRetry: () => void;
}

/**
 * What a change-set would change, read from `changes.diff`, in words and tables: the topics a
 * structural change touches, the connections a pass touched, an overview before and after with the
 * Divergences kept beside it. The structural diff is also drawn as icicles (T95) above its table;
 * this is the table alternative every drawing has.
 */
export function InboxDiff({ t, load, onRetry }: InboxDiffProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h3 id={headingId} className="text-xs font-semibold text-secondary-foreground">
        {t("inbox.diff.title")}
      </h3>
      <DiffBody t={t} load={load} onRetry={onRetry} />
    </section>
  );
}

function DiffBody({ t, load, onRetry }: InboxDiffProps) {
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
  return <DiffContent t={t} diff={load.diff} />;
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

function DiffContent({ t, diff }: { t: Translator; diff: ChangesDiff }) {
  if (diff.kind === "topic")
    return (
      <>
        {/* The icicle diff (T95, `IcicleDiff`) draws the two trees here, above its table alternative. */}
        <TopicDiffTable t={t} rows={topicDiffRows(t, diff.nodes)} />
        {hiddenNote(t, diff.hidden)}
      </>
    );
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
 * The table alternative of the structural diff: every topic the change touches, indented under its
 * parent, with what happened to it. A change reads as a glyph and a word.
 */
export function TopicDiffTable({ t, rows }: { t: Translator; rows: readonly TopicDiffRow[] }) {
  return (
    <table className="w-full border-collapse text-left text-xs">
      <caption className="sr-only">{t("inbox.diff.topic.caption")}</caption>
      <thead>
        <tr className="text-secondary-foreground">
          <th scope="col" className="py-1 pr-3 font-semibold">
            {t("inbox.diff.topic.topic")}
          </th>
          <th scope="col" className="py-1 font-semibold">
            {t("inbox.diff.topic.change")}
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const mark = changeMark[row.change];
          const Icon = mark.icon;
          return (
            <tr key={row.id} className="border-t border-border align-top">
              <th
                scope="row"
                className="py-1.5 pr-3 font-normal text-foreground [overflow-wrap:anywhere]"
                style={{ paddingLeft: `${Math.min(row.depth, 8) * 0.75}rem` }}
              >
                {row.name}
              </th>
              <td className="py-1.5">
                <span className={cn("inline-flex items-center gap-1 font-medium", mark.tone)}>
                  <Icon className="size-3.5 shrink-0" aria-hidden="true" />
                  {row.changeLabel}
                </span>
                {row.detail ? (
                  <span className="block text-muted-foreground [overflow-wrap:anywhere]">
                    {row.detail}
                  </span>
                ) : null}
                {row.items ? (
                  <span className="block text-muted-foreground [overflow-wrap:anywhere]">
                    {row.items}
                  </span>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
