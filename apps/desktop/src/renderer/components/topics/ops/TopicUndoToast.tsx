import { Undo2, X } from "lucide-react";
import type { Translator } from "@app/i18n";

import { canUndoNotice, type ShownNotice } from "./topic-notice-center";
import { Button } from "../../ui/button";

export interface TopicUndoToastProps {
  t: Translator;
  notice: ShownNotice | null;
  onUndo: () => void;
  onDismiss: () => void;
  /** Hovering or focusing the notice keeps it on screen. */
  onHold: (held: boolean) => void;
}

/** A name in a notice: the stored one, or the words for a topic that has none. */
function nameOf(t: Translator, title: string | null): string {
  return title === null || title === "" ? t("topics.unnamed") : title;
}

/**
 * The notice that follows a change the person made: what happened, and Undo while it can be
 * undone. The region is always in the page so a screen reader announces a new notice; the notice
 * itself is a few controls in tab order, stays long enough to read and to reach (it waits while
 * hovered or focused). The app draws one, through `TopicNoticeHost`, which also owns the U key
 * that undoes it.
 */
export function TopicUndoToast({ t, notice, onUndo, onDismiss, onHold }: TopicUndoToastProps) {
  const values = notice
    ? { title: nameOf(t, notice.title), parent: nameOf(t, notice.parent) }
    : undefined;
  const canUndo = canUndoNotice(notice);
  const pending = notice?.state === "pending";
  return (
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="pointer-events-none fixed bottom-4 left-4 z-40 flex w-[min(24rem,calc(100vw-2rem))] flex-col"
    >
      {notice ? (
        <div
          data-topic-notice=""
          className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border-strong bg-surface px-3 py-2 text-sm text-foreground shadow-lg"
          onMouseEnter={() => onHold(true)}
          onMouseLeave={() => onHold(false)}
          onFocus={() => onHold(true)}
          onBlur={() => onHold(false)}
        >
          <p className="min-w-40 flex-1 [overflow-wrap:anywhere]">
            {t(notice.key, values ? { values } : {})}
          </p>
          {canUndo ? (
            <Button
              type="button"
              variant="link"
              disabled={pending}
              aria-keyshortcuts="U"
              onClick={onUndo}
            >
              <Undo2 aria-hidden="true" />
              {pending ? t("topics.ops.toast.undoing") : t("topics.ops.toast.undo")}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="ghost"
            className="size-8 min-h-0 px-0"
            aria-label={t("topics.ops.toast.dismiss")}
            title={t("topics.ops.toast.dismiss")}
            onClick={onDismiss}
          >
            <X aria-hidden="true" />
          </Button>
          {notice.state === "blocked" ? (
            <p className="w-full text-xs text-muted-foreground">{t("topics.ops.toast.blocked")}</p>
          ) : null}
          {notice.state === "failed" ? (
            <p className="w-full text-xs text-danger">{t("topics.ops.toast.failed")}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
