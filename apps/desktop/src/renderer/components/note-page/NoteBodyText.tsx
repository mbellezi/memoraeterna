import { useId } from "react";
import type { NotePageNote } from "@app/domain";
import type { Translator } from "@app/i18n";

import { MarkdownPreview } from "../MarkdownEditor";

/** The note's text, read-only, when it says more than the idea statement. */
export function NoteBodyText({
  t,
  note,
  embedded = false,
  citations = 0
}: {
  t: Translator;
  note: Pick<NotePageNote, "bodyMarkdown" | "ideaStatement" | "language">;
  /** In a panel the prose follows the title directly, in the reading measure, with no heading. */
  embedded?: boolean;
  /** In a panel: how many numbered quotes the Evidence lists; `[n]` up to it shows as a numeral. */
  citations?: number;
}) {
  const headingId = useId();
  if (note.bodyMarkdown.trim() === note.ideaStatement.trim()) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className={embedded ? "sr-only" : "text-lg font-semibold"}>
        {t("notePage.body.title")}
      </h2>
      <div
        lang={note.language ?? undefined}
        className={`font-reading text-reading ${embedded ? "max-w-(--measure)" : ""}`}
      >
        <MarkdownPreview
          markdown={note.bodyMarkdown}
          emptyLabel=""
          reference={embedded && citations > 0 ? (token) => footnote(token, citations) : undefined}
        />
      </div>
    </section>
  );
}

/** `[2]` in a panel's prose is the accent superscript numeral of the second quote in Evidence. */
function footnote(token: string, citations: number) {
  const number = /^\[([1-9][0-9]{0,3})\]$/u.exec(token)?.[1];
  if (number === undefined || Number(number) > citations) return null;
  return <sup className="ml-px text-xs font-semibold text-accent">{number}</sup>;
}
