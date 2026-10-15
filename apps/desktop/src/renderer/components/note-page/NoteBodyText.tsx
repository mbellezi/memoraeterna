import { useId } from "react";
import type { NotePageNote } from "@app/domain";
import type { Translator } from "@app/i18n";

import { MarkdownPreview } from "../MarkdownEditor";

/** The note's text, read-only, when it says more than the idea statement. */
export function NoteBodyText({
  t,
  note
}: {
  t: Translator;
  note: Pick<NotePageNote, "bodyMarkdown" | "ideaStatement" | "language">;
}) {
  const headingId = useId();
  if (note.bodyMarkdown.trim() === note.ideaStatement.trim()) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t("notePage.body.title")}
      </h2>
      <div lang={note.language ?? undefined} className="font-reading text-reading">
        <MarkdownPreview markdown={note.bodyMarkdown} emptyLabel="" />
      </div>
    </section>
  );
}
