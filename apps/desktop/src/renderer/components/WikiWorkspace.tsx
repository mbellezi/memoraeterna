import { useId, useLayoutEffect, useRef, useState } from "react";
import { Map as MapIcon } from "lucide-react";
import type { Translator } from "@app/i18n";
import { ObjectKindGlyph } from "./glyphs";
import type { PassageAnchor } from "../lib/object-navigation";
import { ConsultationDialog } from "./ConsultationDialog";
import { TopicPage } from "./topic-page/TopicPage";
import { ShapeScreen } from "./topic-shape/ShapeScreen";
import { panelDomId, tabDomId, ViewSwitch } from "./topic-shape/ViewSwitch";
import { lensAfterNavigation, lensAfterTopicChange, type WikiLens } from "./topic-shape/wiki-lens";
import { TopicNavigator } from "./topics/TopicNavigator";
import { WikiPlaceholder, type WikiNoticeKind } from "./topics/WikiPlaceholder";
import type { OpenableNavigation } from "./WhereIsThis";
import { WikiNavigationPane } from "./WikiNavigationPane";

export interface WikiWorkspaceViewProps {
  t: Translator;
  /** Whether the Wiki is the view on screen. A hidden Wiki loads nothing and keeps no modal open. */
  active: boolean;
  /** Changes each time a link asks for a page of the removed wiki or a topic that is gone; null when none did. */
  noticeToken: number | null;
  /** What the notice says; a page of the removed wiki when not given. */
  noticeKind?: WikiNoticeKind | undefined;
  /** The topic open in the reading surface; null shows where to start. */
  topicId: string | null;
  /** Whether the Ask dialog is mounted; it loads when it mounts and not before. */
  askOpen: boolean;
  onAsk: () => void;
  onCloseAsk: () => void;
  /** The lens on screen; both stay mounted, so each keeps its place while the other shows. */
  lens: WikiLens;
  onLens: (lens: WikiLens) => void;
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
 * surface has two lenses: the open topic's Topic page (or where to start while no topic is open;
 * the start stays mounted under an open topic, so a notice it showed once is not shown again),
 * and the Map of the whole tree. A lens that is not on screen loads nothing.
 */
export function WikiWorkspaceView({
  t,
  active,
  noticeToken,
  noticeKind,
  topicId,
  askOpen,
  onAsk,
  onCloseAsk,
  lens,
  onLens,
  onNavigate,
  onCloseTopic,
  onOpenLibrary,
  onOpenSource
}: WikiWorkspaceViewProps) {
  const surface = useRef<HTMLDivElement>(null);
  const lensPrefix = useId();
  const topicActive = active && lens === "topic";
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
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
          <ViewSwitch
            label={t("topics.shape.tabs.label")}
            value={lens}
            idPrefix={lensPrefix}
            items={[
              {
                id: "topic",
                label: t("topics.shape.tabs.topic"),
                icon: <ObjectKindGlyph kind="topic" />
              },
              { id: "map", label: t("topics.shape.tabs.map"), icon: <MapIcon aria-hidden="true" /> }
            ]}
            onChange={onLens}
          />
        </div>
        <div
          ref={surface}
          role="tabpanel"
          id={panelDomId(lensPrefix, "topic")}
          aria-labelledby={tabDomId(lensPrefix, "topic")}
          hidden={lens !== "topic"}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4"
        >
          {topicId === null ? null : (
            <div className="py-4">
              <TopicPage
                topicId={topicId}
                active={topicActive}
                t={t}
                onNavigate={onNavigate}
                onClose={onCloseTopic}
              />
            </div>
          )}
          <div hidden={topicId !== null}>
            <WikiPlaceholder
              t={t}
              active={topicActive && topicId === null}
              noticeToken={noticeToken}
              noticeKind={noticeKind}
              onOpenLibrary={onOpenLibrary}
              onAsk={onAsk}
            />
          </div>
        </div>
        <div
          role="tabpanel"
          id={panelDomId(lensPrefix, "map")}
          aria-labelledby={tabDomId(lensPrefix, "map")}
          hidden={lens !== "map"}
          className="min-h-0 min-w-0 flex-1 overflow-y-auto px-4 py-4"
        >
          <ShapeScreen t={t} active={active && lens === "map"} onNavigate={onNavigate} />
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

export type WikiWorkspaceProps = Omit<
  WikiWorkspaceViewProps,
  "askOpen" | "onAsk" | "onCloseAsk" | "lens" | "onLens"
>;

/**
 * The Wiki screen. The app decides which topic is open (links from the Library and Back and
 * Forward reach it there); the screen holds whether Ask is open and which lens shows. The app
 * keeps it mounted while hidden, so the navigator keeps its open branches and scroll, the Topic
 * page its last read and the Map its zoomed branch.
 */
export function WikiWorkspace(props: WikiWorkspaceProps) {
  const [askOpen, setAskOpen] = useState(false);
  const [lens, setLens] = useState<WikiLens>("topic");
  // A topic that opens (the tree, a link, Back or Forward) shows in the Topic lens.
  const [shownTopic, setShownTopic] = useState(props.topicId);
  if (shownTopic !== props.topicId) {
    setShownTopic(props.topicId);
    setLens(lensAfterTopicChange(lens, shownTopic, props.topicId));
  }
  return (
    <WikiWorkspaceView
      {...props}
      askOpen={askOpen}
      onAsk={() => setAskOpen(true)}
      onCloseAsk={() => setAskOpen(false)}
      lens={lens}
      onLens={setLens}
      onNavigate={(navigation) => {
        // The same topic opened again from the Map still has to show: the topic id does not change.
        setLens(lensAfterNavigation(lens, navigation));
        props.onNavigate(navigation);
      }}
    />
  );
}
