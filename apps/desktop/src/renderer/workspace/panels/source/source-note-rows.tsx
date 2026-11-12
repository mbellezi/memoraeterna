import { Fragment, type MouseEvent } from "react";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { RunningRing } from "../../../components/ui/solid-glyphs";
import { Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { NotePath } from "./source-controller";
import { sectionWords, type NoteRow } from "./source-panel-model";

/**
 * The notes of a source as the design lists them (record 6.2): the title, then the full path in
 * the tree as a chip, then the section the note rests on. The newest row carries a new-dot and
 * "agora mesmo" (never a fill: a fill means selection). A note still looking for its place says so
 * with the ring. A click opens the note beside the panel, Option-click in it; Space peeks (the
 * quick-look reads `data-quick-look`; `data-address` is for the panel's own row lookup).
 */

/** The path of a note as a chip: the topics from the first level down, each crumb whole. */
export function PathChip({ crumbs }: { crumbs: ReadonlyArray<{ id: string; title: string }> }) {
  return (
    <span
      data-path-chip=""
      data-path={crumbs.map((crumb) => crumb.title).join(" › ")}
      className="inline-flex min-w-0 flex-wrap items-baseline gap-x-1 text-xs leading-5 text-secondary-foreground"
    >
      <ObjectKindGlyph kind="topic" size={12} className="mt-[3px] self-start text-object-topic" />
      {crumbs.map((crumb, index) => (
        <Fragment key={crumb.id}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground">
              ›
            </span>
          ) : null}
          <span className={cn(index === crumbs.length - 1 && "font-medium text-foreground")}>
            {crumb.title}
          </span>
        </Fragment>
      ))}
    </span>
  );
}

function Place({
  path,
  generating,
  t
}: {
  path: NotePath | undefined;
  generating: boolean;
  t: Translator;
}) {
  if (path === undefined || path.status === "loading")
    return <Skeleton className="h-3 w-40 max-w-full" />;
  if (path.status === "placed") return <PathChip crumbs={path.crumbs} />;
  // Not placed yet while the source is being made: the Gardener is still looking.
  if (path.status === "unplaced" && generating)
    return (
      <span className="inline-flex items-center gap-1.5 text-xs leading-5 text-secondary-foreground">
        <RunningRing className="size-2.5" />
        {t("sourcePage.notes.placing")}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1.5 text-xs leading-5 text-muted-foreground">
      <ObjectKindGlyph kind="topic" size={12} className="text-muted-foreground" />
      {t("sourcePage.notes.unplaced")}
    </span>
  );
}

export function SourceNoteRows({
  t,
  rows,
  paths,
  generating,
  expectsMore,
  onOpen
}: {
  t: Translator;
  rows: readonly NoteRow[];
  paths: ReadonlyMap<string, NotePath>;
  /** The source is still being made: a note with no place is being placed. */
  generating: boolean;
  /** One skeleton row stands for the next note. */
  expectsMore: boolean;
  onOpen: (address: string, options?: { replace?: boolean }) => void;
}) {
  return (
    <ol className="m-0 list-none p-0" data-note-rows="">
      {rows.map((row) => (
        <li key={row.id} className="border-t border-border first:border-t-0">
          <button
            type="button"
            data-address={row.address}
            data-quick-look={row.address}
            title={t("sourcePage.notes.open", { values: { title: row.title } })}
            onClick={(event: MouseEvent) =>
              onOpen(row.address, event.altKey ? { replace: true } : undefined)
            }
            className={cn(
              "-mx-2 flex w-[calc(100%+1rem)] items-start gap-3 rounded-md px-2 py-3 text-left",
              "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
            )}
          >
            <ObjectKindGlyph
              kind="note"
              size={16}
              className={cn("mt-[3px] flex-none", objectKindTextClass.note)}
            />
            <span className="grid min-w-0 flex-1 gap-0.5">
              <span className="text-sm leading-5 font-medium text-foreground [text-wrap:pretty]">
                {row.title}
              </span>
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 gap-y-0.5">
                <Place path={paths.get(row.id)} generating={generating} t={t} />
                {row.section ? (
                  <span className="inline-flex max-w-full min-w-0 items-baseline gap-x-1.5 text-xs leading-5 whitespace-nowrap text-muted-foreground">
                    <span aria-hidden="true">·</span>
                    <span
                      className="min-w-0 truncate"
                      {...(row.section.kind === "heading"
                        ? { title: sectionWords(row.section, t) }
                        : {})}
                    >
                      {sectionWords(row.section, t)}
                    </span>
                  </span>
                ) : null}
              </span>
            </span>
            {row.fresh ? (
              <span className="inline-flex flex-none items-center gap-1 text-xs leading-5 whitespace-nowrap text-foreground">
                <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
                {t("sourcePage.notes.fresh")}
              </span>
            ) : null}
          </button>
        </li>
      ))}
      {expectsMore ? (
        <li aria-hidden="true" className="grid gap-2 border-t border-border py-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="w-2/5" />
        </li>
      ) : null}
    </ol>
  );
}
