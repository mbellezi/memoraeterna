import { useEffect, useId, useRef, useState } from "react";
import { FolderPlus } from "lucide-react";
import { topicLimits } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { opsErrorText } from "./topic-ops";

export interface TopicNameDialogProps {
  t: Translator;
  /** The topic the new one goes under; null for the top level. */
  parentTitle: string | null;
  top: boolean;
  busy: boolean;
  /** Why the last attempt was refused. */
  error: MessageKey | null;
  onSubmit: (title: string) => void;
  onCancel: () => void;
}

/**
 * "New subtopic": asks for a name and creates the topic under the one the person chose. A modal
 * native dialog: focus goes to the field, stays inside, and returns to the control that opened it.
 */
export function TopicNameDialog({
  t,
  parentTitle,
  top,
  busy,
  error,
  onSubmit,
  onCancel
}: TopicNameDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState("");
  const titleId = useId();
  const errorId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    dialog?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  const heading = top
    ? t("topics.ops.create.titleTop")
    : t("topics.ops.create.title", {
        values: { parent: parentTitle ?? t("topics.unnamed") }
      });
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
      className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border border-border bg-surface p-5 text-foreground shadow-lg backdrop:bg-background/70"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) onSubmit(value);
        }}
      >
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-semibold">
          <FolderPlus className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{heading}</span>
        </h2>
        <label className="mt-4 grid gap-1.5 text-sm font-medium text-secondary-foreground">
          {t("topics.ops.create.label")}
          <Input
            value={value}
            maxLength={topicLimits.titleMaxLength * 2}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error ? (
          <p id={errorId} role="alert" className="mt-2 text-sm text-danger">
            {opsErrorText(t, error)}
          </p>
        ) : null}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button type="button" onClick={onCancel}>
            {t("topics.ops.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? t("topics.ops.working") : t("topics.ops.create.submit")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
