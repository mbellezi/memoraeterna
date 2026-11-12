import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Circle } from "lucide-react";
import type { Translator } from "@app/i18n";

import { RunningRing, SolidCheck, SolidTriangle } from "../../../components/ui/solid-glyphs";
import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Tooltip } from "../../../components/ui/tooltip";
import { cn } from "../../../lib/cn";
import type { LibraryRow } from "../../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import {
  formatAdded,
  placeView,
  questionStatusKeys,
  questionStatusTones,
  scopeLabel,
  sourceMeta,
  statusView,
  type StatusTone
} from "./library-model";

/**
 * What a row of the Library shows in each column (design record §7.3). A title is the person's own
 * text: it ends in a tail ellipsis when it does not fit, with the whole title on hover and on
 * keyboard focus; every other word is the app's (`libraryTable`).
 */

export interface CellState {
  /** The row has keyboard focus. */
  focused: boolean;
}

/** One line that ends in "…" when it does not fit; the whole text shows in a tooltip on hover and focus. */
export function TruncatedText({
  text,
  focused,
  className
}: {
  text: string;
  focused: boolean;
  className?: string;
}) {
  const node = useRef<HTMLSpanElement>(null);
  const [cut, setCut] = useState(false);
  const [hover, setHover] = useState(false);
  // Measured when the row takes focus; a hover measures at the moment it opens.
  useLayoutEffect(() => {
    const element = node.current;
    if (element && focused) setCut(element.scrollWidth > element.clientWidth + 1);
  }, [focused, text]);
  const tooltip = (
    <span ref={node} className={cn("block min-w-0 truncate", className)}>
      {text}
    </span>
  );
  return (
    <Tooltip
      label={text}
      side="top"
      open={hover || (focused && cut)}
      onOpenChange={(open) => {
        const element = node.current;
        setHover(open && element !== null && element.scrollWidth > element.clientWidth + 1);
      }}
    >
      {tooltip}
    </Tooltip>
  );
}

const toneGlyph: Readonly<Record<StatusTone, () => ReactNode>> = {
  success: () => <SolidCheck className="text-success" />,
  running: () => <RunningRing />,
  warning: () => <SolidTriangle className="text-warning" />,
  danger: () => <SolidTriangle className="text-danger" />,
  idle: () => (
    <Circle
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground [stroke-dasharray:3_3]"
    />
  )
};

const toneWord: Readonly<Record<StatusTone, string>> = {
  success: "text-foreground",
  running: "text-foreground",
  warning: "text-warning",
  danger: "text-danger",
  idle: "text-foreground"
};

/** The title cell of a source: glyph, title, then the type and the authors. */
export function SourceTitleCell({
  t,
  row,
  cell
}: {
  t: Translator;
  row: LibraryRow;
  cell: CellState;
}) {
  const title = row.title.trim() === "" ? t("panelFrame.untitled") : row.title;
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ObjectKindGlyph
        kind="source"
        size={16}
        className={cn("mt-0.5", objectKindTextClass.source)}
      />
      <div className="min-w-0">
        <TruncatedText
          text={title}
          focused={cell.focused}
          className="text-sm leading-5 font-medium text-foreground"
        />
        <span className="block truncate text-xs leading-5 text-muted-foreground">
          {sourceMeta(t, row)}
        </span>
      </div>
    </div>
  );
}

/** "Lugar na árvore": the last two crumbs; "provável:" and dashed when tentative; "Sem lugar". */
export function PlaceCell({ t, row }: { t: Translator; row: LibraryRow }) {
  const place = placeView(row.place);
  if (place.kind === "none")
    return (
      <span className="inline-flex items-center gap-1.5 text-xs leading-5 text-secondary-foreground">
        <Circle aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
        {t("libraryTable.place.none")}
      </span>
    );
  const tentative = place.kind === "tentative";
  const last = place.crumbs.length - 1;
  // One inline flow that wraps only between crumbs, at most two lines (the row's height): the
  // first crumb keeps its glyph and the "…" before it, and a separator stays with the crumb it
  // follows, so a line never starts with "›" nor ends on a lone "…".
  const separator = (
    <>
      <span aria-hidden="true" className="ml-1 text-muted-foreground">
        ›
      </span>{" "}
    </>
  );
  return (
    <span
      title={tentative ? t("libraryTable.place.tentativeHint") : undefined}
      className="line-clamp-2 min-w-0 text-sm leading-5 text-secondary-foreground"
    >
      {tentative ? (
        <span className="mr-1 text-xs whitespace-nowrap text-muted-foreground">
          {t("libraryTable.place.tentative")}
        </span>
      ) : null}
      {place.crumbs.map((crumb, index) => (
        <Fragment key={crumb.id}>
          {index > 0 ? " " : null}
          <span className="whitespace-nowrap">
            {index === 0 ? (
              <>
                <ObjectKindGlyph
                  kind="topic"
                  size={12}
                  className={cn("mr-1 inline-block align-[-1px]", objectKindTextClass.topic)}
                />
                {place.deeper ? (
                  <>
                    <span aria-hidden="true">…</span>
                    {separator}
                  </>
                ) : null}
              </>
            ) : null}
            <span
              className={cn(
                tentative && "border-b border-dashed border-border-strong",
                crumb.title === "" && "italic"
              )}
            >
              {crumb.title === "" ? t("panelFrame.ribbon.untitled") : crumb.title}
            </span>
            {index < last ? separator : null}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

/** "Estado": the glyph and the word, with a second line when it needs you, is blocked or stored only. */
export function StateCell({
  t,
  row,
  onGenerate
}: {
  t: Translator;
  row: LibraryRow;
  /** "Gerar notas" on a source stored without notes: opens it where the notes are made. */
  onGenerate: () => void;
}) {
  const state = statusView(row);
  return (
    <div className="min-w-0">
      <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
        {toneGlyph[state.tone]()}
        <span className={cn("min-w-0 [text-wrap:pretty]", toneWord[state.tone])}>
          {t(state.word)}
        </span>
      </span>
      {state.detail === null ? null : state.status === "storedOnly" ? (
        <button
          type="button"
          aria-label={t("libraryTable.actions.generateFor", { values: { title: row.title } })}
          onClick={(event) => {
            event.stopPropagation();
            onGenerate();
          }}
          className={cn(
            "block max-w-full truncate rounded-sm text-left text-xs leading-5 text-accent",
            "hover:text-accent-hover hover:underline focus-visible:outline-2",
            "focus-visible:outline-offset-2 focus-visible:outline-accent"
          )}
        >
          {t(state.detail)}
        </button>
      ) : (
        <span className="block text-xs leading-5 text-muted-foreground [text-wrap:pretty]">
          {t(state.detail)}
        </span>
      )}
    </div>
  );
}

export const NotesCell = ({ count }: { count: number }) => (
  <span className="text-sm leading-5 text-foreground">{count === 0 ? "—" : count}</span>
);

export function DateCell({ t, iso, now }: { t: Translator; iso: string; now: Date }) {
  return (
    <span className="block text-sm leading-5 text-muted-foreground">
      {formatAdded(t, iso, now)}
    </span>
  );
}

/** The title cell of a question: glyph, the words, then what it was asked about. */
export function QuestionTitleCell({
  t,
  question,
  titles,
  cell
}: {
  t: Translator;
  question: QuestionListItemView;
  titles: ReadonlyMap<string, string | null>;
  cell: CellState;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <ObjectKindGlyph
        kind="question"
        size={16}
        className={cn("mt-0.5", objectKindTextClass.question)}
      />
      <div className="min-w-0">
        <TruncatedText
          text={question.text}
          focused={cell.focused}
          className="text-sm leading-5 font-medium text-foreground"
        />
        <span className="block truncate text-xs leading-5 text-muted-foreground">
          {scopeLabel(t, question.scope, titles)}
        </span>
      </div>
    </div>
  );
}

export function QuestionStateCell({
  t,
  question
}: {
  t: Translator;
  question: QuestionListItemView;
}) {
  const tone = questionStatusTones[question.status];
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-sm leading-5">
      {toneGlyph[tone]()}
      <span className={cn("min-w-0 [text-wrap:pretty]", toneWord[tone])}>
        {t(questionStatusKeys[question.status])}
      </span>
    </span>
  );
}
