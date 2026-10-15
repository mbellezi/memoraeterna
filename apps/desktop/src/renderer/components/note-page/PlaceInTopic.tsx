import { FolderInput } from "lucide-react";
import type { Translator } from "@app/i18n";

import { opsErrorText } from "../topics/ops/topic-ops";
import { TopicOpsOverlay, useTopicOps } from "../topics/ops/use-topic-ops";
import { Button } from "../ui/button";

export interface PlaceInTopicProps {
  t: Translator;
  noteId: string;
  noteTitle: string;
  /** False while the page is hidden: no dialog stays open. */
  active: boolean;
  /** After the note was placed, so the page shows where it is now. */
  onPlaced: () => void;
}

/**
 * "Place in topic": the person puts the note in a topic of their choice, as its place or as one
 * more topic it shows up in. The placement is theirs: the engine never moves it. The change comes
 * with an Undo that stays long enough to be reached by keyboard.
 */
export function PlaceInTopic({ t, noteId, noteTitle, active, onPlaced }: PlaceInTopicProps) {
  const ops = useTopicOps(active);
  const { error } = ops.snapshot;
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        aria-haspopup="dialog"
        onClick={() =>
          ops.openDialog({
            kind: "place",
            item: { kind: "note", id: noteId, title: noteTitle }
          })
        }
      >
        <FolderInput aria-hidden="true" />
        {t("topics.ops.actions.place")}
      </Button>
      {error && ops.dialog === null ? (
        <span role="alert" className="text-xs text-danger">
          {opsErrorText(t, error)}
        </span>
      ) : null}
      <TopicOpsOverlay t={t} ops={ops} onPlaced={onPlaced} />
    </>
  );
}
