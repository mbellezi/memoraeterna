import { useState } from "react";
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
  /** The topic that is open, if any. */
  selectedTopicId: string | null;
  /** Whether the Ask dialog is mounted; it loads when it mounts and not before. */
  askOpen: boolean;
  onOpenTopic: (id: string) => void;
  onAsk: () => void;
  onCloseAsk: () => void;
  /** The topic the Wiki shows; null shows the empty state. */
  topicId: string | null;
  /** Where a click on the Topic page leads: another topic, or a source or note in the Library. */
  onNavigate: (navigation: OpenableNavigation) => void;
  /** Closes the Topic page and returns to the empty state. */
  onCloseTopic: () => void;
  onOpenLibrary: () => void;
  onOpenSource: (id: string, noteId?: string, passage?: PassageAnchor) => void;
}

/**
 * The topic navigator beside the reading surface, and the Ask dialog above both. The reading surface
 * shows where to start until a topic is open; an open topic shows its Topic page.
 */
export function WikiWorkspaceView({
  t,
  active,
  noticeToken,
  selectedTopicId,
  askOpen,
  onOpenTopic,
  onAsk,
  onCloseAsk,
  topicId,
  onNavigate,
  onCloseTopic,
  onOpenLibrary,
  onOpenSource
}: WikiWorkspaceViewProps) {
  if (topicId !== null)
    return (
      <TopicPage
        topicId={topicId}
        active={active}
        t={t}
        onNavigate={onNavigate}
        onClose={onCloseTopic}
      />
    );
  return (
    <div className="flex h-[calc(100vh-7.5rem)] min-h-80 min-w-0 overflow-hidden">
      <WikiNavigationPane t={t}>
        <TopicNavigator
          t={t}
          active={active}
          selectedTopicId={selectedTopicId}
          onOpenTopic={onOpenTopic}
          onOpenSource={onOpenSource}
          onAsk={onAsk}
        />
      </WikiNavigationPane>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4">
        <WikiPlaceholder
          t={t}
          active={active}
          noticeToken={noticeToken}
          onOpenLibrary={onOpenLibrary}
          onAsk={onAsk}
        />
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

export type WikiWorkspaceProps = Pick<
  WikiWorkspaceViewProps,
  | "t"
  | "active"
  | "noticeToken"
  | "topicId"
  | "onNavigate"
  | "onCloseTopic"
  | "onOpenLibrary"
  | "onOpenSource"
>;

/**
 * The Wiki screen. It holds what the screen decides (which topic is open, whether Ask is open) and
 * the app keeps it mounted while hidden, so the navigator keeps its open branches and scroll.
 */
export function WikiWorkspace(props: WikiWorkspaceProps) {
  const [askOpen, setAskOpen] = useState(false);
  const [selectedTopicId, setSelectedTopicId] = useState<string | null>(null);
  return (
    <WikiWorkspaceView
      {...props}
      selectedTopicId={selectedTopicId}
      askOpen={askOpen}
      onOpenTopic={setSelectedTopicId}
      onAsk={() => setAskOpen(true)}
      onCloseAsk={() => setAskOpen(false)}
    />
  );
}
