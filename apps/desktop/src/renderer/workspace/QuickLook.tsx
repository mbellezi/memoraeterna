import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Eye } from "lucide-react";
import { parseObjectAddress, type ObjectKind } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { EmptyState } from "../components/ui/empty-state";
import { ErrorState } from "../components/ui/error-state";
import { Kbd } from "../components/ui/kbd";
import { Sheet, SheetBody, SheetContent, SheetFooter, SheetHeader } from "../components/ui/sheet";
import { LoadingState, Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/cn";
import { useObjectPreview, PlaceText, type ObjectPreview } from "./ObjectLink";
import {
  countKey,
  kindWordKeys,
  placeOf,
  previewCounts,
  surfaceState,
  titleOf
} from "./ObjectLinkModel";
import { previewBatcher, type PreviewBatcher } from "./preview-batcher";
import {
  isEditableElement,
  quickLook,
  quickLookKey,
  quickLookTarget,
  type QuickLookStore
} from "./QuickLookModel";

/**
 * Quick-look (D15 as amended by A4; design record §10.2): a centred, non-modal sheet that peeks at
 * the object of the row the keyboard is on. Space (outside text fields) or Cmd-Y (anywhere,
 * Cmd-K included) opens it; ↑ and ↓ move the list's own row and the sheet follows; Esc or a click
 * outside closes it, as does Enter, which opens the row beside as it always does. The sheet takes
 * no focus and traps none, so the keyboard never leaves the row.
 */

/** The notes a source or an entity shows in the sheet: the first few, with their titles. */
const noteLimit = 3;
const noteVia: Partial<Record<ObjectKind, string>> = { source: "evidence", entity: "mention" };

export interface RelatedNote {
  address: string;
  title: string;
}

function useRelatedNotes(
  address: string,
  kind: ObjectKind | null,
  enabled: boolean,
  batcher?: PreviewBatcher
): RelatedNote[] {
  const [held, setHeld] = useState<{ address: string; notes: RelatedNote[] } | null>(null);
  useEffect(() => {
    const via = kind ? noteVia[kind] : undefined;
    const objects = typeof window === "undefined" ? undefined : window.app?.objects;
    if (!enabled || !via || !objects) return undefined;
    let live = true;
    const reader = batcher ?? previewBatcher();
    objects
      .backlinks({ address, limit: 20 })
      .then(async (page) => {
        const from = [
          ...new Set(
            page.items
              .filter((entry) => entry.via === via && entry.from.startsWith("memora://note/"))
              .map((entry) => entry.from)
          )
        ].slice(0, noteLimit);
        const results = await Promise.all(from.map((note) => reader.request(note)));
        const notes = results.flatMap((result, index) =>
          result.status === "ready" && from[index]
            ? [{ address: from[index], title: result.item.title }]
            : []
        );
        if (live) setHeld({ address, notes });
      })
      // The list is an extra: a read that fails leaves the sheet without it.
      .catch(() => live && setHeld({ address, notes: [] }));
    return () => {
      live = false;
    };
  }, [address, kind, enabled, batcher]);
  return held?.address === address ? held.notes : [];
}

function SheetSkeleton() {
  return (
    <div className="grid gap-3" data-sheet-skeleton="">
      <Skeleton className="h-3 w-28" />
      <Skeleton className="h-3 w-2/5" />
      <Skeleton className="h-6 w-3/5" />
      <div className="grid max-w-(--measure) gap-2">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
      </div>
      <Skeleton className="h-3 w-1/3" />
    </div>
  );
}

function dateOf(t: Translator, iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(t.locale, { dateStyle: "medium" }).format(date);
}

function SheetObject({
  t,
  preview,
  notes
}: {
  t: Translator;
  preview: ObjectPreview;
  notes: readonly RelatedNote[];
}) {
  const { state } = preview;
  if (state.status === "loading")
    return (
      <LoadingState t={t}>
        <SheetSkeleton />
      </LoadingState>
    );
  if (state.status === "error")
    return (
      <ErrorState
        t={t}
        message={t("preview.quickLook.error")}
        kept={t("preview.quickLook.errorKept")}
        onRetry={preview.retry}
        retryLabel={t("shell.actions.retry")}
      />
    );
  if (state.status === "missing") return <EmptyState>{t("preview.quickLook.missing")}</EmptyState>;

  const { item } = state;
  const kind = item.kind;
  const place = placeOf(item);
  const counts = previewCounts(item);
  const updated = dateOf(t, item.updatedAt);
  const status =
    item.status === "retired"
      ? t("preview.card.status.retired")
      : item.status === "redirected"
        ? t("preview.card.status.redirected")
        : null;
  const title = titleOf(item, t(kindWordKeys[kind]));
  const empty = surfaceState(state) === "empty";
  const meta = [
    ...counts.map((entry) => t(countKey(entry), { values: { count: entry.count } })),
    ...(updated ? [t("preview.quickLook.updated", { values: { date: updated } })] : [])
  ];
  return (
    <div className="grid min-w-0 gap-3">
      <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-secondary-foreground">
        <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
        <span className="font-medium">{t(kindWordKeys[kind])}</span>
        {status ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="text-muted-foreground">{status}</span>
          </>
        ) : null}
      </p>
      {place.length > 0 ? (
        <p
          aria-label={t("panelFrame.ribbon.label")}
          className="m-0 flex items-start gap-1.5 text-sm leading-5 text-secondary-foreground [text-wrap:pretty]"
        >
          <ObjectKindGlyph kind="topic" size={14} className="mt-[3px] text-object-topic" />
          <PlaceText t={t} path={place} />
        </p>
      ) : null}
      <h2
        title={title}
        className="m-0 font-reading text-xl leading-snug font-semibold [overflow-wrap:anywhere] [text-wrap:balance]"
      >
        {title}
      </h2>
      {empty ? (
        <p className="m-0 max-w-(--measure) text-sm text-secondary-foreground [text-wrap:pretty]">
          {t("preview.quickLook.empty")}
        </p>
      ) : (
        <p className="m-0 max-w-(--measure) font-reading text-reading leading-relaxed text-secondary-foreground [text-wrap:pretty]">
          {item.preview}
        </p>
      )}
      {meta.length > 0 ? (
        <p className="m-0 flex flex-wrap gap-x-2 text-xs text-muted-foreground">
          {meta.map((part, index) => (
            <span key={index} className="inline-flex gap-2">
              {index > 0 ? <span aria-hidden="true">·</span> : null}
              {part}
            </span>
          ))}
        </p>
      ) : null}
      {notes.length > 0 ? (
        <div className="grid gap-1 border-t border-border pt-3">
          <p className="m-0 text-xs font-medium text-muted-foreground">
            {t(
              kind === "entity"
                ? "preview.quickLook.notesMentioning"
                : "preview.quickLook.notesOfSource"
            )}
          </p>
          <ul className="m-0 grid list-none gap-0 p-0">
            {notes.map((note) => (
              <li
                key={note.address}
                className="flex items-center gap-2 border-b border-border py-1.5 text-sm last:border-b-0"
              >
                <ObjectKindGlyph kind="note" size={14} className={objectKindTextClass.note} />
                <span title={note.title} className="min-w-0 [overflow-wrap:anywhere]">
                  {note.title}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Keys({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-1.5 gap-y-1", className)}>
      {children}
    </span>
  );
}

export interface QuickLookViewProps {
  t: Translator;
  /** The read of the address, and whether it answers this address or the one peeked before it. */
  preview: ObjectPreview;
  notes?: readonly RelatedNote[];
  onClose: () => void;
  /** Tests and screens render the sheet in place; the app renders it in a portal. */
  portal?: boolean;
}

/** The sheet over a read: the head with its keys, the object, the foot that says what stays. */
export function QuickLookView({
  t,
  preview,
  notes = [],
  onClose,
  portal = true
}: QuickLookViewProps) {
  const ready = preview.state.status === "ready" ? preview.state.item : null;
  const space = t("preview.quickLook.keys.space");
  return (
    <Sheet open onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        portal={portal}
        title={ready ? titleOf(ready, t("preview.quickLook.label")) : t("preview.quickLook.label")}
        className="max-h-[calc(100vh-var(--space-24))] overflow-hidden"
      >
        <div
          data-surface="quick-look"
          data-state={surfaceState(preview.state)}
          className="flex min-h-0 flex-col"
        >
          <SheetHeader className="flex-wrap justify-between gap-x-4 gap-y-1">
            <Keys>
              <Eye aria-hidden="true" className="size-3.5" />
              <span>{t("preview.quickLook.peeking")}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <Kbd>{space}</Kbd>
              <span>{t("preview.quickLook.keys.closes")}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <Kbd>↵</Kbd>
              <span>{t("preview.quickLook.keys.opensBeside")}</span>
            </Keys>
            {/* The head's right padding is the primitive's 12 px; this margin brings it to the left's 20. */}
            <Keys className="mr-2">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span>{t("preview.quickLook.keys.peekNext")}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                ·
              </span>
              <Kbd>⌥↵</Kbd>
              <span>{t("preview.quickLook.keys.openHere")}</span>
            </Keys>
          </SheetHeader>
          <SheetBody
            // While the next row's read is on its way the body keeps the last object at full contrast
            // (the design has no opacity on text) and says it is busy.
            aria-busy={preview.current ? undefined : true}
            className="min-h-0 overflow-auto"
          >
            <SheetObject t={t} preview={preview} notes={notes} />
          </SheetBody>
          <SheetFooter className="flex-wrap gap-x-4 gap-y-1">
            <Keys>
              <Kbd>Esc</Kbd>
              <span>{t("preview.quickLook.keys.close")}</span>
            </Keys>
            {/* A failed read already says what is kept; the foot does not say it twice. */}
            {preview.state.status === "error" ? null : (
              <span className="text-muted-foreground">{t("preview.quickLook.stays")}</span>
            )}
          </SheetFooter>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export interface QuickLookProps {
  t: Translator;
  address: string;
  onClose: () => void;
  portal?: boolean;
  /** Tests and screens: the batcher the sheet reads through. */
  batcher?: PreviewBatcher;
}

/** The sheet for one address: it reads the object, and for a source or an entity its first notes. */
export function QuickLook({ t, address, onClose, portal = true, batcher }: QuickLookProps) {
  const preview = useObjectPreview(address, true, batcher);
  const kind = parseObjectAddress(address)?.kind ?? null;
  const notes = useRelatedNotes(address, kind, preview.state.status === "ready", batcher);
  return <QuickLookView t={t} preview={preview} notes={notes} onClose={onClose} portal={portal} />;
}

/**
 * The app's one quick-look: it shows the sheet for the address in the store and answers the keys
 * (`quickLookKey`) on the document. Mount it once, beside the panel stack.
 */
export function QuickLookHost({ t, store = quickLook }: { t: Translator; store?: QuickLookStore }) {
  const address = useSyncExternalStore(store.subscribe, store.get, () => null);
  // A Space the sheet took is not also a click on the button that holds the focus.
  const tookSpace = useRef(false);
  useEffect(() => {
    const actionOf = (event: KeyboardEvent) =>
      quickLookKey(
        {
          key: event.key,
          code: event.code,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          isComposing: event.isComposing,
          editable: isEditableElement(event.target as Element | null)
        },
        store.get() !== null
      );
    // The arrows and Enter are the list's own keys, and a list that owns them cancels them (cmdk
    // does, before the event reaches the document), so the sheet reads them first, in the capture
    // phase and whether or not they are cancelled: it only follows the list after it has moved.
    const onKeyDownCapture = (event: KeyboardEvent) => {
      const action = actionOf(event);
      if (action === "follow") {
        requestAnimationFrame(() => {
          const next = quickLookTarget(document);
          if (next !== null && store.get() !== null) store.open(next);
        });
      } else if (action === "close-after-enter") {
        requestAnimationFrame(() => store.close());
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // A Space or Cmd-Y that something already took is not the sheet's.
      if (event.defaultPrevented) return;
      switch (actionOf(event)) {
        case "toggle": {
          event.preventDefault();
          if (store.get() !== null) store.close();
          else store.toggle(quickLookTarget(document));
          return;
        }
        case "open-from-row": {
          // Space peeks only at the row the keyboard is on, never at a selected row elsewhere.
          const target = quickLookTarget(document, false);
          if (target === null) return;
          event.preventDefault();
          tookSpace.current = true;
          store.open(target);
          return;
        }
        case "close":
          event.preventDefault();
          tookSpace.current = true;
          store.close();
          return;
        default:
          return;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === " " && tookSpace.current) {
        tookSpace.current = false;
        event.preventDefault();
      }
    };
    // A click or Tab onto another row moves the peek there as well.
    const onFocusIn = () => {
      if (store.get() === null) return;
      const next = quickLookTarget(document);
      if (next !== null) store.open(next);
    };
    document.addEventListener("keydown", onKeyDownCapture, true);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("keyup", onKeyUp);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDownCapture, true);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("keyup", onKeyUp);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [store]);
  return address ? <QuickLook t={t} address={address} onClose={store.close} /> : null;
}
