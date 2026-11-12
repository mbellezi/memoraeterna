import type { Translator } from "@app/i18n";
import type { SourceDetail } from "../../../../shared/ipc";
import { AtomicNoteCard, CollapsibleSection, StateCard } from "./source-parts";

/** The notes a source produced; the focused one is ringed and takes focus from the page. */
export function SourceNotesList({
  detail,
  focusedAtomicNoteId,
  t,
  onOpenNote
}: {
  detail: SourceDetail;
  focusedAtomicNoteId: string | null;
  t: Translator;
  onOpenNote: (noteId: string) => void;
}) {
  return (
    <CollapsibleSection
      title={t("library.sections.atomicNotes")}
      count={detail.atomicNotes.length}
      defaultOpen
    >
      {detail.atomicNotes.length === 0 ? (
        <StateCard>{t("knowledge.notes.emptyForSource")}</StateCard>
      ) : (
        <ol className="grid gap-2">
          {detail.atomicNotes.map((note) => (
            <li key={note.id}>
              <AtomicNoteCard
                note={note}
                focused={note.id === focusedAtomicNoteId}
                t={t}
                onOpenNote={onOpenNote}
              />
            </li>
          ))}
        </ol>
      )}
    </CollapsibleSection>
  );
}
