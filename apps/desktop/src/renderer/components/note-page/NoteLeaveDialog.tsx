import { useEffect, useId, useRef } from "react";
import type { MessageKey, Translator } from "@app/i18n";

import { Button } from "../ui/button";

export interface LeaveCopy {
  title: MessageKey;
  description: MessageKey;
  keep: MessageKey;
  discard: MessageKey;
}

const defaultCopy: LeaveCopy = {
  title: "notePage.leave.title",
  description: "notePage.leave.description",
  keep: "notePage.leave.keepEditing",
  discard: "notePage.leave.discard"
};

/**
 * Asked before a move would drop an unsaved edit of the note: keep editing (the default, also
 * Escape and Cmd-W) or discard the edit and go on. A modal native dialog: it traps focus and gives
 * it back to the control that was focused.
 */
export function NoteLeaveDialog({
  t,
  onKeepEditing,
  onDiscard,
  copy = defaultCopy
}: {
  t: Translator;
  onKeepEditing: () => void;
  onDiscard: () => void;
  /** Another form that holds unsaved work (the import panel) says its own words in the same dialog. */
  copy?: LeaveCopy;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const keepRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const textId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    // Keeping the edit is the safe default.
    keepRef.current?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <dialog
      ref={ref}
      role="alertdialog"
      aria-labelledby={titleId}
      aria-describedby={textId}
      onCancel={(event) => {
        event.preventDefault();
        onKeepEditing();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") event.stopPropagation();
      }}
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-surface p-5 text-foreground shadow-lg backdrop:bg-background/70"
    >
      <h2 id={titleId} className="text-lg font-semibold">
        {t(copy.title)}
      </h2>
      <p id={textId} className="mt-2 text-sm text-secondary-foreground">
        {t(copy.description)}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button type="button" onClick={onDiscard}>
          {t(copy.discard)}
        </Button>
        <Button ref={keepRef} type="button" variant="primary" onClick={onKeepEditing}>
          {t(copy.keep)}
        </Button>
      </div>
    </dialog>
  );
}
