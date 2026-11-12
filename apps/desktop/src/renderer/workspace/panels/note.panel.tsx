import { useCallback } from "react";
import { formatObjectAddress, parseObjectAddress, type ObjectSummary } from "@app/domain";

import { NotePage } from "../../components/note-page/NotePage";
import type { OpenableNavigation } from "../../components/WhereIsThis";
import type { PassageAnchor } from "../../lib/object-navigation";
import { useContextDocked } from "../context-dock";
import type { PanelProps } from "../PanelStack";
import { addressForNavigation, addressForPassage, frameState } from "./object-open";

/**
 * The Note panel (design record 6.3; D8, D10): the Note page inside a panel of the stack. The frame
 * draws the kind, the history arrows, Foco, the pin, the close and the path ribbon; this file
 * registers the panel by file and turns what the page opens (a note, a passage in its source, a
 * topic) into addresses pushed beside the panel, so a click never changes the destination. The
 * page stays mounted in the previous panel's compact form, so an unsaved edit is kept; where the
 * workspace would unmount it (the panel closes, steps back or is folded into a spine) the page's
 * leave guard, registered through `onLeaveGuard`, asks first.
 */

export const kind = "note";

export function match(address: string): boolean {
  return parseObjectAddress(address)?.kind === "note";
}

/** The title is the note's, as `objects.get` reads it; the kind word comes from the frame. */
export function title(summary: ObjectSummary | null): string {
  return summary?.title ?? "";
}

export function Component({ t, address, mode, active, onState, onOpen, onLeaveGuard }: PanelProps) {
  const id = parseObjectAddress(address)?.id ?? null;
  const docked = useContextDocked();
  const report = useCallback(
    (status: "loading" | "error" | "missing" | "ready") => onState(frameState(status)),
    [onState]
  );
  const openNavigation = useCallback(
    (navigation: OpenableNavigation) => {
      const next = addressForNavigation(navigation);
      if (next) onOpen(next);
    },
    [onOpen]
  );
  const openNote = useCallback(
    (noteId: string) => onOpen(formatObjectAddress({ kind: "note", id: noteId })),
    [onOpen]
  );
  const openPassage = useCallback(
    (sourceItemId: string, passage: PassageAnchor) =>
      onOpen(addressForPassage(sourceItemId, passage)),
    [onOpen]
  );
  if (id === null) return null;
  return (
    <NotePage
      noteId={id}
      active={active}
      backLabel=""
      t={t}
      embedded
      compact={mode === "compact"}
      relationsView={docked ? "summary" : "full"}
      onLoadState={report}
      onBack={() => undefined}
      onOpenNote={openNote}
      onOpenPassage={openPassage}
      onNavigate={openNavigation}
      {...(onLeaveGuard ? { onLeaveGuard } : {})}
    />
  );
}
