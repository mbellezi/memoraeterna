import type { Translator } from "@app/i18n";

import { noteRefSegments } from "./note-page-model";

const ideaLength = 80;

/**
 * Model-written text with canonical `<note-ref id="..." />` tags, as safe React nodes: this note
 * reads "this note", the other note reads as its quoted idea, and any other reference stays inert
 * text. A raw tag or an ID is never shown.
 */
export function NoteRefText({
  text,
  thisId,
  other,
  t
}: {
  text: string;
  thisId: string;
  other: { id: string; ideaStatement: string };
  t: Translator;
}) {
  const idea =
    other.ideaStatement.length > ideaLength
      ? `${other.ideaStatement.slice(0, ideaLength - 1).trimEnd()}…`
      : other.ideaStatement;
  return (
    <>
      {noteRefSegments(text, { thisId, otherId: other.id }).map((segment, index) =>
        typeof segment === "string" ? (
          <span key={index}>{segment}</span>
        ) : segment.ref === "this" ? (
          <strong key={index} className="font-semibold">
            {t("notePage.card.thisNoteObject")}
          </strong>
        ) : segment.ref === "other" ? (
          <strong key={index} className="font-semibold">
            {t("notePage.card.quoted", { values: { text: idea } })}
          </strong>
        ) : (
          <span key={index}>{t("notePage.relations.otherNote")}</span>
        )
      )}
    </>
  );
}
