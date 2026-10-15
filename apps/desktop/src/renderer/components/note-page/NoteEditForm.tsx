import { useId, type KeyboardEvent } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import type { NoteDraft } from "./note-page-model";

export type EditError = "invalid" | "failed" | "conflict" | null;

/** The inline editor of a note: title, idea statement and text, with Save and Cancel. */
export function NoteEditForm({
  t,
  draft,
  language,
  canSave,
  saving,
  error,
  onChange,
  onSave,
  onCancel,
  onDiscardAndReload,
  onEscape
}: {
  t: Translator;
  draft: NoteDraft;
  language: string | null;
  canSave: boolean;
  saving: boolean;
  error: EditError;
  onChange: (draft: NoteDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onDiscardAndReload: () => void;
  /** Escape cancels a pristine edit only. */
  onEscape: () => void;
}) {
  const ids = { title: useId(), idea: useId(), body: useId(), hint: useId() };
  const lang = language ?? undefined;
  const escape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    onEscape();
  };
  return (
    <form
      className="flex flex-col gap-3"
      aria-describedby={ids.hint}
      aria-busy={saving || undefined}
      onKeyDown={escape}
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave && !saving) onSave();
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.title} className="text-xs font-medium text-secondary-foreground">
          {t("notePage.edit.title")}
        </label>
        <Input
          id={ids.title}
          // The editor replaces the control that opened it: focus moves into it.
          autoFocus
          lang={lang}
          value={draft.title}
          onChange={(event) => onChange({ ...draft, title: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.idea} className="text-xs font-medium text-secondary-foreground">
          {t("notePage.edit.idea")}
        </label>
        <Input
          id={ids.idea}
          lang={lang}
          value={draft.ideaStatement}
          onChange={(event) => onChange({ ...draft, ideaStatement: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.body} className="text-xs font-medium text-secondary-foreground">
          {t("notePage.edit.body")}
        </label>
        <textarea
          id={ids.body}
          lang={lang}
          value={draft.bodyMarkdown}
          onChange={(event) => onChange({ ...draft, bodyMarkdown: event.target.value })}
          className="min-h-36 rounded-md border border-border-strong bg-surface p-3 font-reading text-base text-foreground"
        />
      </div>
      <p id={ids.hint} className="text-xs text-muted-foreground">
        {t("notePage.edit.hint")}
      </p>
      {error === "invalid" ? (
        <p role="alert" className="text-sm text-foreground">
          {t("notePage.edit.invalid")}
        </p>
      ) : null}
      {error === "failed" ? (
        <p role="alert" className="text-sm text-foreground">
          {t("notePage.edit.failed")}
        </p>
      ) : null}
      {error === "conflict" ? (
        <div role="alert" className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-foreground">{t("notePage.edit.conflict")}</p>
          <Button type="button" onClick={onDiscardAndReload}>
            {t("notePage.edit.discardAndReload")}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          variant="primary"
          disabled={!canSave || saving}
          aria-busy={saving || undefined}
        >
          {t("shell.actions.save")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("shell.actions.cancel")}
        </Button>
      </div>
    </form>
  );
}
