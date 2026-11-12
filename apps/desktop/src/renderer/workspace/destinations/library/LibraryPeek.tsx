import { Eye } from "lucide-react";
import { parseObjectAddress, type ObjectSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { ErrorState } from "../../../components/ui/error-state";
import { Kbd } from "../../../components/ui/kbd";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader
} from "../../../components/ui/sheet";
import { SkeletonLines } from "../../../components/ui/skeleton";
import type { ObjectState } from "../../../lib/object-events";
import type { PanelLoadState } from "../../PanelFrame";
import { PathRibbon, type RibbonPlace } from "../../PathRibbon";

/**
 * Quick-look in the Library (D15, A4; design record §10.2): Space or Cmd-Y on a row opens a
 * centred sheet that is not modal. The keyboard stays on the row underneath, the arrows move the
 * row and the sheet follows, Esc or a click outside closes it, and nothing is opened: the Library
 * stays where it is. It reads the object by its address (`objects.get`), so it serves a source
 * and a question alike, and it reads again when the object changes.
 */

/** What the frame of the screens tool reports for the sheet over the table (`LibraryRoot` `preview="peek"`). */
export const libraryPeekSurface = "library-peek";

export interface LibraryPeekProps {
  t: Translator;
  /** The object being looked at; null closes the sheet. */
  address: string | null;
  /** What `objects.get` says of it (read by the Library, which follows the object's changes). */
  object: ObjectState;
  /** The row's own title, shown at once while the object is read. */
  title: string;
  /** The kind and what the row knows of it ("Livro · A. Autor"). */
  meta: string;
  /** How the object is placed: a source still being made reads tentative, never as placed. */
  place?: RibbonPlace;
  onClose: () => void;
  /** Read the object again after a failed read ("Tentar de novo"). */
  onRetry: () => void;
  /** A crumb of the ribbon: its topic opens beside the table. */
  onOpen: (address: string) => void;
  /** Render in place instead of in a portal (tests and screens). */
  portal?: boolean;
}

/** The count line of a summary: "14 notas · 31 trechos" for a source, "2 respostas" for a question. */
export function peekCounts(t: Translator, counts: ObjectSummary["counts"]): string {
  if (!counts) return "";
  const part = (value: number | undefined, one: Parameters<Translator>[0], many: typeof one) =>
    value === undefined
      ? null
      : t(value === 1 ? one : many, {
          values: { count: new Intl.NumberFormat(t.locale).format(value) }
        });
  return [
    part(counts.notes, "libraryTable.peek.notesOne", "libraryTable.peek.notesMany"),
    part(counts.passages, "libraryTable.peek.passagesOne", "libraryTable.peek.passagesMany"),
    part(counts.answers, "libraryTable.peek.answersOne", "libraryTable.peek.answersMany")
  ]
    .filter((text): text is string => text !== null)
    .join(" · ");
}

/**
 * What the frame of the screens tool reports for the sheet: loading while the object is read,
 * error when it could not be, empty for an object that has no summary and no counts yet.
 */
export function peekFrameState(object: ObjectState): PanelLoadState {
  if (object.status === "loading") return "loading";
  if (object.status !== "ready") return "error";
  return peekIsEmpty(object.object) ? "empty" : "success";
}

/** An object that has no summary and no counts yet: the sheet then says why and what to do. */
export function peekIsEmpty(summary: ObjectSummary): boolean {
  const counts = Object.values(summary.counts ?? {}).some((value) => (value ?? 0) > 0);
  return !summary.preview && !counts;
}

function PeekBody({
  t,
  address,
  object,
  title,
  meta,
  place,
  onOpen,
  onRetry
}: Pick<LibraryPeekProps, "t" | "object" | "title" | "meta" | "place" | "onOpen" | "onRetry"> & {
  address: string;
}) {
  const kind = parseObjectAddress(address)?.kind ?? "source";
  const summary = object.status === "ready" ? object.object : null;
  const counts = summary ? peekCounts(t, summary.counts) : "";
  return (
    <SheetBody>
      <p className="m-0 flex min-w-0 items-center gap-2 text-sm text-secondary-foreground">
        <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
        <span className="min-w-0 [text-wrap:pretty]">{meta}</span>
      </p>
      <PathRibbon t={t} address={address} onOpen={onOpen} {...(place ? { place } : {})} />
      <h3 className="m-0 min-w-0 font-reading text-xl font-semibold [text-wrap:balance] [overflow-wrap:anywhere]">
        {summary?.title || title}
      </h3>
      {object.status === "loading" ? (
        <SkeletonLines lines={3} />
      ) : object.status === "ready" ? (
        <>
          {summary?.preview ? (
            <p className="m-0 font-reading text-reading text-secondary-foreground [text-wrap:pretty]">
              {summary.preview}
            </p>
          ) : null}
          {counts ? <p className="m-0 text-xs text-muted-foreground">{counts}</p> : null}
          {summary && peekIsEmpty(summary) ? (
            <div className="grid gap-1 text-sm text-secondary-foreground">
              <p className="m-0 [text-wrap:pretty]">
                {t(
                  kind === "question"
                    ? "libraryTable.peek.noSummaryQuestion"
                    : "libraryTable.peek.noSummarySource"
                )}
              </p>
              <p className="m-0 inline-flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <Kbd>↵</Kbd> {t("libraryTable.peek.opens")}
              </p>
            </div>
          ) : null}
        </>
      ) : (
        <ErrorState
          t={t}
          message={t(
            kind === "question"
              ? "libraryTable.peek.unavailableQuestion"
              : "libraryTable.peek.unavailableSource"
          )}
          kept={t("libraryTable.peek.kept")}
          retryLabel={t("shell.actions.retry")}
          onRetry={onRetry}
        />
      )}
    </SheetBody>
  );
}

export function LibraryPeek({
  t,
  address,
  object,
  title,
  meta,
  place,
  onClose,
  onRetry,
  onOpen,
  portal
}: LibraryPeekProps) {
  return (
    <Sheet open={address !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {address !== null ? (
        <SheetContent
          title={t("libraryTable.peek.title", { values: { title } })}
          // Centred in the window but never over the bars: below the filter, the chips and the
          // territory bar (two lines at 960), so no half-hidden chip shows above the sheet.
          className="top-[max(12rem,calc(50%-10rem))]!"
          {...(portal === undefined ? {} : { portal })}
        >
          <SheetHeader className="flex-wrap gap-x-4 gap-y-1">
            <span className="inline-flex items-center gap-2">
              <Eye aria-hidden="true" className="size-3.5 shrink-0" />
              <span className="font-semibold text-foreground">
                {t("libraryTable.peek.heading")}
              </span>
            </span>
            <span>
              <Kbd>{t("libraryTable.keys.space")}</Kbd> {t("libraryTable.peek.closes")}
            </span>
            <span>
              <Kbd>↵</Kbd> {t("libraryTable.peek.opens")}
            </span>
            <span className="ml-auto">
              <Kbd>↑↓</Kbd> {t("libraryTable.peek.next")}
            </span>
          </SheetHeader>
          <PeekBody
            t={t}
            address={address}
            object={object}
            title={title}
            meta={meta}
            onOpen={onOpen}
            onRetry={onRetry}
            {...(place ? { place } : {})}
          />
          <SheetFooter>
            <span>
              <Kbd>Esc</Kbd> {t("libraryTable.peek.close")}
            </span>
            <span className="text-muted-foreground">{t("libraryTable.peek.stays")}</span>
          </SheetFooter>
        </SheetContent>
      ) : null}
    </Sheet>
  );
}
