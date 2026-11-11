import { Eye } from "lucide-react";
import { parseObjectAddress, type ObjectSummary } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Kbd } from "../../../components/ui/kbd";
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetFooter,
  SheetHeader
} from "../../../components/ui/sheet";
import { SkeletonLines } from "../../../components/ui/skeleton";
import { useObject } from "../../../lib/object-events";
import { PathRibbon } from "../../PathRibbon";

/**
 * Quick-look in the Library (D15, A4; design record §10.2): Space or Cmd-Y on a row opens a
 * centred sheet that is not modal. The keyboard stays on the row underneath, the arrows move the
 * row and the sheet follows, Esc or a click outside closes it, and nothing is opened: the Library
 * stays where it is. It reads the object by its address (`objects.get`), so it serves a source
 * and a question alike, and it reads again when the object changes.
 */

export interface LibraryPeekProps {
  t: Translator;
  /** The object being looked at; null closes the sheet. */
  address: string | null;
  /** The row's own title, shown at once while the object is read. */
  title: string;
  /** The kind and what the row knows of it ("Livro · A. Autor"). */
  meta: string;
  onClose: () => void;
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

function PeekBody({
  t,
  address,
  title,
  meta,
  onOpen
}: Pick<LibraryPeekProps, "t" | "title" | "meta" | "onOpen"> & { address: string }) {
  const object = useObject(address);
  const kind = parseObjectAddress(address)?.kind ?? "source";
  const summary = object.status === "ready" ? object.object : null;
  const counts = summary ? peekCounts(t, summary.counts) : "";
  return (
    <SheetBody>
      <p className="m-0 flex min-w-0 items-center gap-2 text-sm text-secondary-foreground">
        <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
        <span className="min-w-0 [text-wrap:pretty]">{meta}</span>
      </p>
      <PathRibbon t={t} address={address} onOpen={onOpen} />
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
        </>
      ) : (
        <p className="m-0 text-sm text-secondary-foreground">
          {t("libraryTable.peek.unavailable")}
        </p>
      )}
    </SheetBody>
  );
}

export function LibraryPeek({
  t,
  address,
  title,
  meta,
  onClose,
  onOpen,
  portal
}: LibraryPeekProps) {
  return (
    <Sheet open={address !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      {address !== null ? (
        <SheetContent
          title={t("libraryTable.peek.title", { values: { title } })}
          {...(portal === undefined ? {} : { portal })}
        >
          <SheetHeader className="flex-wrap">
            <Eye aria-hidden="true" className="size-3.5 shrink-0" />
            <span className="font-semibold text-foreground">{t("libraryTable.peek.heading")}</span>
            <span aria-hidden="true">·</span>
            <span>
              <Kbd>{t("libraryTable.keys.space")}</Kbd> {t("libraryTable.peek.closes")}
            </span>
            <span aria-hidden="true">·</span>
            <span>
              <Kbd>↵</Kbd> {t("libraryTable.peek.opens")}
            </span>
            <span className="ml-auto">
              <Kbd>↑↓</Kbd> {t("libraryTable.peek.next")}
            </span>
          </SheetHeader>
          <PeekBody t={t} address={address} title={title} meta={meta} onOpen={onOpen} />
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
