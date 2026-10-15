import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { recordView } from "../../lib/view-history";
import { useObjectOpener, type OpenableNavigation } from "../WhereIsThis";
import { TopicPageController } from "./topic-page-controller";
import type { TopicPageActions } from "./topic-page-model";
import { TopicPageView } from "./TopicPageView";

export interface TopicPageProps {
  /** The topic to show; a topic that was merged into another shows its successor. */
  topicId: string;
  /** False while the host view is hidden: nothing loads, nothing listens, nothing is recorded. */
  active: boolean;
  t: Translator;
  /** Where a click leads: a topic, or a source or note the Library opens. */
  onNavigate(navigation: OpenableNavigation): void;
  /** When the host can close the page, the strip offers it and Cmd-W does the same. */
  onClose?: (() => void) | undefined;
}

/**
 * The Topic page of the Wiki: a deterministic map of content with no AI call. Opening it reads
 * the page once and records the open; the state lives in a controller so the rules are tested
 * without a renderer. The host mounts it where the topic shows and keeps it mounted while hidden.
 */
export function TopicPage({ topicId, active, t, onNavigate, onClose }: TopicPageProps) {
  const [controller] = useState(
    () =>
      new TopicPageController({
        api: () => window.app.topics,
        record: recordView
      })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusedTopic = useRef<string | null>(null);
  const opener = useObjectOpener(onNavigate);

  useEffect(() => {
    controller.show(topicId, active, t);
  }, [controller, topicId, active, t]);

  useEffect(() => () => controller.dispose(), [controller]);

  // Cmd-W closes the page when the host can close it; otherwise it is left to the host.
  const close = useEffectEvent(() => onClose?.());
  const closable = onClose !== undefined;
  useEffect(() => {
    if (!active || !closable) return;
    return subscribeClosePanel(() => {
      close();
      return true;
    }, closePanelPriority.panel);
  }, [active, closable]);

  // The heading takes focus when a page first shows, unless focus rests somewhere that stays (the
  // host's tree): a link followed inside the page removes the control that had focus.
  const shownTopic = snapshot.load.status === "ready" ? snapshot.load.page.topic.id : null;
  useEffect(() => {
    if (!active || shownTopic === null || focusedTopic.current === shownTopic) return;
    focusedTopic.current = shownTopic;
    const focused = document.activeElement;
    if (focused && focused !== document.body) return;
    headingRef.current?.focus({ preventScroll: true });
  }, [active, shownTopic]);

  const actions: TopicPageActions = {
    openTopic: (id) => onNavigate({ type: "topic", topicId: id }),
    openNote: (id) =>
      opener.open({ type: "resolve", address: formatObjectAddress({ kind: "note", id }) }),
    openSource: (id) =>
      opener.open({ type: "resolve", address: formatObjectAddress({ kind: "source", id }) })
  };

  return (
    <TopicPageView
      t={t}
      snapshot={snapshot}
      active={active}
      headingRef={headingRef}
      actions={actions}
      openFailed={opener.openFailed}
      onClose={closable ? () => onClose?.() : undefined}
      onRetry={() => controller.retry()}
      onUndo={() => void controller.undo()}
      onShowAllNotes={() => controller.showAllNotes()}
      onLoadMoreNotes={() => controller.loadMoreNotes()}
      onRetryNotes={() => controller.retryNotes()}
    />
  );
}
