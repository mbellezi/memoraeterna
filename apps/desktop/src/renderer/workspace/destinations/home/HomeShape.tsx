import type { Translator } from "@app/i18n";

import { SolidTriangle } from "../../../components/activity/solid-glyphs";
import { cn } from "../../../lib/cn";
import { shapeSegments, tooBigTopics, type ShapeSegment } from "./home-model";
import { countText, pluralKey } from "./home-text";
import type { HomeShape } from "../../../../shared/ipc-home";

const nbsp = "\u00a0";

/**
 * The plan's Shape lens on Home, as one strip (design record §7.1): the tree's size in a line, one
 * segment per root topic with its width following its notes, a solid triangle and a warning outline
 * on a root that is too big, the count of topics too big anywhere in the tree, and the way to the
 * Map. A segment's full name and count are also its hover text and its screen-reader name.
 */
export function ShapeStrip({
  t,
  shape,
  onOpenMap,
  onOpenRoot
}: {
  t: Translator;
  shape: HomeShape;
  onOpenMap?: (() => void) | undefined;
  onOpenRoot?: ((id: string) => void) | undefined;
}) {
  const segments = shapeSegments(shape);
  const tooBig = tooBigTopics(shape);
  const summary = [
    t("home.shape.summary", {
      values: {
        notes: countText(t, "notes", shape.notes),
        topics: countText(t, "topics", shape.topics)
      }
    }),
    shape.depth > 0 ? countText(t, "levels", shape.depth) : null,
    shape.arrivalsThisWeek > 0 ? countText(t, "weekNotes", shape.arrivalsThisWeek) : null
  ].filter((part): part is string => part !== null);
  return (
    <section aria-label={t("home.shape.label")} className="grid min-w-0 gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="m-0 min-w-0 text-sm text-muted-foreground [text-wrap:pretty]">
          <span className="font-medium text-foreground">{t("home.shape.title")}</span>
          {summary.map((part) => (
            <span key={part} className="whitespace-nowrap">
              {`${nbsp}·${nbsp}${part}`}
            </span>
          ))}
        </p>
        <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm text-secondary-foreground">
          {tooBig > 0 ? (
            <>
              <SolidTriangle className="size-3.5 text-warning" />
              <span className="font-medium text-foreground">
                {t(pluralKey(t.locale, tooBig, "home.shape.tooBigOne", "home.shape.tooBigOther"), {
                  values: { count: new Intl.NumberFormat(t.locale).format(tooBig) }
                })}
              </span>
              <span aria-hidden="true">·</span>
            </>
          ) : null}
          <button
            type="button"
            onClick={onOpenMap}
            disabled={!onOpenMap}
            className={cn(
              "cursor-pointer rounded-sm border-0 bg-transparent p-0 text-sm font-medium text-accent hover:text-accent-hover",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default"
            )}
          >
            {t("home.shape.seeInMap")}
          </button>
        </p>
      </div>
      <ul className="m-0 flex min-w-0 list-none flex-wrap gap-0.5 p-0">
        {segments.map((segment) => (
          <Segment key={segment.id} t={t} segment={segment} onOpen={onOpenRoot} />
        ))}
      </ul>
    </section>
  );
}

function Segment({
  t,
  segment,
  onOpen
}: {
  t: Translator;
  segment: ShapeSegment;
  onOpen?: ((id: string) => void) | undefined;
}) {
  const title =
    segment.title === null || segment.title === "" ? t("topics.unnamed") : segment.title;
  const notes = countText(t, "notes", segment.notes);
  const label = [title, notes, segment.tooBig ? t("home.shape.rootTooBig") : null]
    .filter((part) => part !== null)
    .join(" · ");
  return (
    <li
      className="min-w-24"
      // Width follows the notes: every segment starts from nothing and grows by its count, so
      // the strip draws the tree's shape; only a label's own width (two lines) is a floor.
      style={{ flex: `${Math.max(1, segment.notes)} 1 0%` }}
    >
      <button
        type="button"
        title={label}
        aria-label={label}
        onClick={onOpen ? () => onOpen(segment.id) : undefined}
        disabled={!onOpen}
        className={cn(
          "flex h-full min-h-11 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md border-[1.5px] bg-soft px-3 py-2 text-left text-sm text-foreground",
          "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-default",
          segment.tooBig ? "border-warning" : "border-transparent"
        )}
      >
        {segment.tooBig ? <SolidTriangle className="size-3.5 text-warning" /> : null}
        <span className="min-w-0 [text-wrap:balance]">
          {title} <span className="text-muted-foreground">{segment.notes}</span>
        </span>
      </button>
    </li>
  );
}
