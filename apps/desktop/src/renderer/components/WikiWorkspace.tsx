import type { Translator } from "@app/i18n";
import type { PassageAnchor } from "../lib/object-navigation";
import { WikiPlaceholder } from "./topics/WikiPlaceholder";

export interface WikiWorkspaceProps {
  t: Translator;
  /** Whether the Wiki is the view on screen. A hidden Wiki loads nothing and keeps no modal open. */
  active: boolean;
  /** Changes each time an old link or call asks for a page of the removed wiki; null when none did. */
  noticeToken: number | null;
  onOpenLibrary: () => void;
  /** Opens a source; with a passage, the reader opens on that exact chunk and SourceSpan. */
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}

/**
 * The Wiki screen. It is the shell that hosts what the Wiki shows: today the empty state with Ask,
 * and the topic navigator once it replaces it. The app keeps it mounted while hidden.
 */
export function WikiWorkspace({
  t,
  active,
  noticeToken,
  onOpenLibrary,
  onOpenSource
}: WikiWorkspaceProps) {
  return (
    <WikiPlaceholder
      t={t}
      active={active}
      noticeToken={noticeToken}
      onOpenLibrary={onOpenLibrary}
      onOpenSource={onOpenSource}
    />
  );
}
