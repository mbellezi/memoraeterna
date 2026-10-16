import { useId, useState } from "react";
import { MessageCircle } from "lucide-react";
import type { Translator } from "@app/i18n";

import { ConsultationDialog } from "../ConsultationDialog";
import { Button } from "../ui/button";
import type { TopicPageActions } from "./topic-page-model";

export interface TopicAskSlotProps {
  t: Translator;
  topic: { id: string; title: string };
  /** False while the host view is hidden: the slot loads nothing and holds nothing open. */
  active: boolean;
  actions: TopicPageActions;
}

/**
 * Where a cited passage of an answer leads from the Topic page: the note when the citation names
 * one, otherwise its source. The page opens objects by ID through the host, so the exact passage
 * anchor is not carried (the source opens at its place in the Library).
 */
export function openCitedSource(
  actions: Pick<TopicPageActions, "openNote" | "openSource">
): (sourceId: string, noteId?: string) => void {
  return (sourceId, noteId) => (noteId ? actions.openNote(noteId) : actions.openSource(sourceId));
}

export interface TopicAskViewProps extends TopicAskSlotProps {
  /** Whether the Ask dialog for this topic is showing. */
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}

/**
 * "Ask about this topic": a button in the side column that opens Ask limited to the topic and its
 * subtopics. The dialog is the library's Ask with the topic as its scope, so it covers its own
 * loading, empty, error and answer states; this view loads nothing until the person opens it.
 */
export function TopicAskView({
  t,
  topic,
  active,
  actions,
  open,
  onOpen,
  onClose
}: TopicAskViewProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <h2 id={headingId} className="text-sm font-semibold text-secondary-foreground">
        {t("topics.page.ask.heading")}
      </h2>
      <p className="text-sm text-secondary-foreground">{t("topics.page.ask.hint")}</p>
      <Button type="button" aria-haspopup="dialog" className="self-start" onClick={onOpen}>
        <MessageCircle aria-hidden="true" />
        {t("topics.page.ask.button")}
      </Button>
      {open ? (
        <ConsultationDialog
          t={t}
          active={active}
          initialQuestion=""
          topic={topic}
          onClose={onClose}
          onOpenSource={openCitedSource(actions)}
        />
      ) : null}
    </section>
  );
}

/**
 * The slot at the end of the side column. The open dialog belongs to the topic it was opened on:
 * another topic on the same page closes it (its request is canceled as it unmounts).
 */
export function TopicAskSlot(props: TopicAskSlotProps) {
  const [openFor, setOpenFor] = useState<string | null>(null);
  return (
    <TopicAskView
      {...props}
      open={openFor === props.topic.id}
      onOpen={() => setOpenFor(props.topic.id)}
      onClose={() => setOpenFor(null)}
    />
  );
}
