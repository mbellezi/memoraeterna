import { useEffect, useId, useRef, useSyncExternalStore, type KeyboardEvent } from "react";
import { ChevronRight, CornerLeftUp, FolderInput, LoaderCircle, RefreshCw } from "lucide-react";
import type { TopicPlacementRole } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { cn } from "../../../lib/cn";
import { ObjectKindGlyph, objectKindTextClass } from "../../glyphs";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { opsErrorText } from "./topic-ops";
import type { Crumb, TopicPickerController } from "./topic-picker";

export interface TopicMoveDialogProps {
  t: Translator;
  /** `move` re-parents a topic; `place` puts a note or source in a topic. */
  mode: "move" | "place";
  subjectTitle: string | null;
  /** The topic's parent: moving it there again changes nothing. */
  currentParentId: string | null;
  picker: TopicPickerController;
  busy: boolean;
  error: MessageKey | null;
  onConfirm: (here: Crumb, role: TopicPlacementRole) => void;
  onCancel: () => void;
}

const nameOf = (t: Translator, crumb: Crumb, first: boolean) =>
  crumb.title ?? (first ? t("topics.ops.move.root") : t("topics.unnamed"));

/**
 * "Move to..." and "Place in topic": a modal dialog that browses the topic tree one level at a
 * time, a list of the subtopics of the level on show with a filter, the path above it and a button
 * that chooses the level on show. Everything is a button or a field, so the keyboard reaches all of
 * it; Escape closes it and focus returns to the control that opened it.
 */
export function TopicMoveDialog({
  t,
  mode,
  subjectTitle,
  currentParentId,
  picker,
  busy,
  error,
  onConfirm,
  onCancel
}: TopicMoveDialogProps) {
  const snapshot = useSyncExternalStore(picker.subscribe, picker.getSnapshot, picker.getSnapshot);
  const ref = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const titleId = useId();
  const errorId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    picker.open();
    return () => {
      dialog?.close();
      picker.dispose();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [picker]);

  const { phase, trail, filter } = snapshot;
  const here = trail.at(-1) ?? null;
  const atRoot = trail.length < 2;
  const visible = picker.visible();
  const subject = subjectTitle ?? t("topics.unnamed");
  // The root takes topics, never an item: items wait there for the engine.
  const canChoose = phase === "ready" && here !== null && !busy && (mode === "move" || !atRoot);
  const sameParent = mode === "move" && here !== null && here.id === currentParentId;

  const onListKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const buttons = [...(listRef.current?.querySelectorAll("button") ?? [])];
    const at = buttons.findIndex((button) => button === document.activeElement);
    const next = buttons[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className={cn(
        "fixed inset-0 m-auto flex max-h-[min(36rem,calc(100vh-2rem))] w-[calc(100%-2rem)] max-w-lg",
        "flex-col rounded-lg border border-border bg-surface p-5 text-foreground shadow-lg",
        "backdrop:bg-background/70"
      )}
    >
      <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
        <FolderInput className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="min-w-0 [overflow-wrap:anywhere]">
          {t(mode === "move" ? "topics.ops.move.title" : "topics.ops.move.titlePlace", {
            values: { title: subject }
          })}
        </span>
      </h2>
      <p className="mt-1 text-sm text-secondary-foreground">
        {t(mode === "move" ? "topics.ops.move.hint" : "topics.ops.move.hintPlace")}
      </p>
      {trail.length > 0 ? (
        <nav aria-label={t("topics.ops.move.pathLabel")} className="mt-3">
          <ol className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-sm">
            {trail.map((crumb, index) => {
              const last = index === trail.length - 1;
              return (
                <li key={crumb.id} className="flex min-w-0 items-center gap-1">
                  {last ? (
                    <span aria-current="location" className="font-medium [overflow-wrap:anywhere]">
                      {nameOf(t, crumb, index === 0)}
                    </span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={cn(
                          "rounded-sm text-left text-secondary-foreground [overflow-wrap:anywhere]",
                          "hover:text-accent hover:underline focus-visible:outline-2",
                          "focus-visible:outline-offset-2 focus-visible:outline-accent"
                        )}
                        onClick={() => picker.goTo(index)}
                      >
                        {nameOf(t, crumb, index === 0)}
                      </button>
                      <ChevronRight
                        className="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      ) : null}
      <div className="mt-3 flex items-center gap-2">
        <Button
          type="button"
          disabled={atRoot || phase === "loading"}
          onClick={() => picker.up()}
          aria-label={t("topics.ops.move.up")}
          title={t("topics.ops.move.up")}
        >
          <CornerLeftUp aria-hidden="true" />
        </Button>
        <Input
          value={filter}
          aria-label={t("topics.ops.move.filter")}
          placeholder={t("topics.ops.move.filter")}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => picker.setFilter(event.target.value)}
        />
      </div>
      <div className="mt-3 min-h-24 flex-1 overflow-y-auto rounded-md border border-border-strong">
        {phase === "loading" ? (
          <p
            role="status"
            className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground"
          >
            <LoaderCircle
              aria-hidden="true"
              className="size-4 animate-spin motion-reduce:animate-none"
            />
            {t("topics.ops.move.loading")}
          </p>
        ) : null}
        {phase === "error" ? (
          <div role="alert" className="flex flex-wrap items-center gap-3 px-3 py-3">
            <p className="text-sm text-foreground">{t("topics.ops.move.error")}</p>
            <Button type="button" onClick={() => picker.retry()}>
              <RefreshCw aria-hidden="true" />
              {t("shell.actions.retry")}
            </Button>
          </div>
        ) : null}
        {phase === "ready" && visible.length === 0 ? (
          <p className="px-3 py-3 text-sm text-muted-foreground">
            {snapshot.nodes.length === 0 ? t("topics.ops.move.none") : t("topics.ops.move.noMatch")}
          </p>
        ) : null}
        {phase === "ready" && visible.length > 0 ? (
          <ul ref={listRef} className="grid" onKeyDown={onListKeyDown}>
            {visible.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className={cn(
                    "flex min-h-9 w-full items-center gap-2 px-3 py-1 text-left text-sm hover:bg-soft",
                    "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                  )}
                  onClick={() => picker.enter(node)}
                >
                  <ObjectKindGlyph kind="topic" className={objectKindTextClass.topic} />
                  <span
                    className={cn(
                      "min-w-0 flex-1 [overflow-wrap:anywhere]",
                      node.title === null && "italic text-muted-foreground"
                    )}
                  >
                    {node.title ?? t("topics.unnamed")}
                  </span>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {t("topics.navigator.itemCount", { values: { count: node.items } })}
                  </span>
                  <span className="sr-only">{t("topics.ops.move.open")}</span>
                  <ChevronRight
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {phase === "ready" && snapshot.nextCursor !== null ? (
          <div className="px-3 py-2">
            <Button
              type="button"
              variant="link"
              disabled={snapshot.more === "loading"}
              onClick={() => void picker.loadMore()}
            >
              {snapshot.more === "error"
                ? t("topics.navigator.moreFailed")
                : t("topics.navigator.moreTopics")}
            </Button>
          </div>
        ) : null}
      </div>
      {sameParent ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("topics.ops.move.alreadyHere")}</p>
      ) : null}
      {mode === "place" && atRoot && phase === "ready" ? (
        <p className="mt-2 text-xs text-muted-foreground">{t("topics.ops.move.chooseTopic")}</p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
          {opsErrorText(t, error)}
        </p>
      ) : null}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          {t("topics.ops.cancel")}
        </Button>
        {mode === "place" ? (
          <Button
            type="button"
            disabled={!canChoose}
            onClick={() => here && onConfirm(here, "secondary")}
          >
            {t("topics.ops.move.alsoHere")}
          </Button>
        ) : null}
        <Button
          type="button"
          variant="primary"
          disabled={!canChoose || sameParent}
          onClick={() => here && onConfirm(here, "primary")}
        >
          {busy
            ? t("topics.ops.working")
            : t(mode === "move" ? "topics.ops.move.here" : "topics.ops.move.placeHere")}
        </Button>
      </div>
    </dialog>
  );
}
