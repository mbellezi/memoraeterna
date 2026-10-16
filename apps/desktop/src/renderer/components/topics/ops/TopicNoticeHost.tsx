import { useEffect, useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import { isUndoKey } from "./notice-key";
import { TopicUndoToast } from "./TopicUndoToast";
import { canUndoNotice, sharedNoticeCenter, type TopicNoticeCenter } from "./topic-notice-center";

export interface TopicNoticeHostProps {
  t: Translator;
  /** The center whose notice this shows (the window's, unless a test brings its own). */
  center?: TopicNoticeCenter;
}

/**
 * The window's one notice host, mounted once by the app: the notice that follows a change to the
 * topics, from whichever view made it, and the U key that undoes it. The live region is always in
 * the page, so a screen reader announces each new notice.
 */
export function TopicNoticeHost({ t, center = sharedNoticeCenter }: TopicNoticeHostProps) {
  const { notice } = useSyncExternalStore(center.subscribe, center.getSnapshot, center.getSnapshot);
  const undoable = canUndoNotice(notice);

  useEffect(() => {
    if (!undoable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isUndoKey(event)) return;
      event.preventDefault();
      void center.undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undoable, center]);

  return (
    <TopicUndoToast
      t={t}
      notice={notice}
      onUndo={() => void center.undo()}
      onDismiss={() => center.dismiss()}
      onHold={(held) => center.hold(held)}
    />
  );
}
