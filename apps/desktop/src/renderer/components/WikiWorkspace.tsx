import { useLayoutEffect, useRef, useState } from "react";
import type { Translator } from "@app/i18n";
import type { PassageAnchor } from "../lib/object-navigation";
import { ConsultationDialog } from "./ConsultationDialog";
import { TopicPage } from "./topic-page/TopicPage";
import { TopicNavigator } from "./topics/TopicNavigator";
import { WikiPlaceholder } from "./topics/WikiPlaceholder";
import type { OpenableNavigation } from "./WhereIsThis";
import { WikiNavigationPane } from "./WikiNavigationPane";

export interface WikiWorkspaceViewProps {
  t: Translator;
  /** Whether the Wiki is the view on screen. A hidden Wiki loads nothing and keeps no modal open. */
  active: boolean;
  /** Changes each time an old link or call asks for a page of the removed wiki; null when none did. */
  noticeToken: number | null;
  /** The topic open in the reading surface; null shows where to start. */
  topicId: string | null;
  /** Whether the Ask dialog is mounted; it loads when it mounts and not before. */
  askOpen: boolean;
  onAsk: () => void;
  onCloseAsk: () => void;
  /**
   * Where a topic, note or source opened in the Wiki leads: a topic opens in the reading surface
   * (from the tree, Pinned, Recents or a link on the Topic page), the rest in the Library.
   */
  onNavigate: (navigation: OpenableNavigation) => void;
  /** Closes the Topic page; the reading surface shows where to start again. */
  onCloseTopic: () => void;
  onOpenLibrary: () => void;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}

/**
 * The topic navigator beside the reading surface, and the Ask dialog above both. The reading
 * surface shows the open topic's Topic page, or where to start while no topic is open; the start
 * stays mounted under an open topic, so a notice it showed once is not shown again.
 */
export function WikiWorkspaceView({
  t,
  active,
  noticeToken,
  topicId,
  askOpen,
  onAsk,
  onCloseAsk,
  onNavigate,
  onCloseTopic,
  onOpenLibrary,
  onOpenSource
}: WikiWorkspaceViewProps) {
  const surface = useRef<HTMLDivElement>(null);
  // Each topic opens at its top, also when a link lower on the previous page led to it.
  useLayoutEffect(() => {
    if (surface.current) surface.current.scrollTop = 0;
  }, [topicId]);
  return (
    <div className="flex h-[calc(100vh-7.5rem)] min-h-80 min-w-0 overflow-hidden">
      <WikiNavigationPane t={t}>
        <TopicNavigator
          t={t}
          active={active}
          selectedTopicId={topicId}
          onOpenTopic={(id) => onNavigate({ type: "topic", topicId: id })}
          onOpenSource={onOpenSource}
          onAsk={onAsk}
        />
      </WikiNavigationPane>
      <div ref={surface} className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4">
        {topicId === null ? null : (
          <div className="py-4">
            <TopicPage
              topicId={topicId}
              active={active}
              t={t}
              onNavigate={onNavigate}
              onClose={onCloseTopic}
            />
          </div>
        )}
        <div hidden={topicId !== null}>
          <WikiPlaceholder
            t={t}
            active={active && topicId === null}
            noticeToken={noticeToken}
            onOpenLibrary={onOpenLibrary}
            onAsk={onAsk}
          />
        </div>
      </div>
      {askOpen ? (
        <ConsultationDialog
          t={t}
          active={active}
          initialQuestion=""
          onClose={onCloseAsk}
          onOpenSource={onOpenSource}
        />
      ) : null}
    </div>
  );
}

export type WikiWorkspaceProps = Omit<WikiWorkspaceViewProps, "askOpen" | "onAsk" | "onCloseAsk">;

/**
 * The Wiki screen. The app decides which topic is open (links from the Library and Back and
 * Forward reach it there); the screen holds whether Ask is open. The app keeps it mounted while
 * hidden, so the navigator keeps its open branches and scroll and the Topic page its last read.
 */
export function WikiWorkspace(props: WikiWorkspaceProps) {
  const [askOpen, setAskOpen] = useState(false);
  return (
    <WikiWorkspaceView
      {...props}
      askOpen={askOpen}
      onAsk={() => setAskOpen(true)}
      onCloseAsk={() => setAskOpen(false)}
    />
  );
}
