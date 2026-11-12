import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import { formatObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { useAppEvent } from "../../lib/app-events";
import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { recordView } from "../../lib/view-history";
import { TopicOpsOverlay, useTopicOps } from "../topics/ops/use-topic-ops";
import { useObjectOpener, type OpenableNavigation } from "../WhereIsThis";
import type { HeaderOps } from "./TopicHeader";
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
  /** Opens an object address, anchors included (a cited passage opens highlighted in its source). */
  onOpenAddress?: ((address: string) => void) | undefined;
  /** The page is a panel of the workspace: the frame draws the kind, the close and the ribbon. */
  embedded?: boolean;
  /** The previous panel's compact form, and the address opened from it. */
  compact?: boolean;
  current?: string | undefined;
  /** Where the page's own load stands, for the frame's `data-state`. */
  onLoadState?: ((status: "loading" | "error" | "missing" | "ready") => void) | undefined;
}

/**
 * The Topic page of the Wiki: a deterministic map of content with no AI call. Opening it reads
 * the page once and records the open; the state lives in a controller so the rules are tested
 * without a renderer. The host mounts it where the topic shows and keeps it mounted while hidden.
 */
export function TopicPage({
  topicId,
  active,
  t,
  onNavigate,
  onClose,
  onOpenAddress,
  embedded = false,
  compact = false,
  current,
  onLoadState
}: TopicPageProps) {
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
  const topicOps = useTopicOps(active);
  // The topic whose heading is being renamed; another topic or a hidden page ends the rename
  // (adjusted while rendering, not in an effect).
  const [renamingFor, setRenamingFor] = useState<string | null>(null);
  const [wasActive, setWasActive] = useState(active);
  if (active !== wasActive) {
    setWasActive(active);
    if (!active) setRenamingFor(null);
  }
  const renaming = renamingFor === topicId;

  useEffect(() => {
    controller.show(topicId, active, t);
  }, [controller, topicId, active, t]);

  useEffect(() => () => controller.dispose(), [controller]);

  // An undone or applied overview publishes `overview.changed` and nothing else.
  useAppEvent(
    "overview.changed",
    (event) => {
      if (event.topicId === topicId) controller.reread();
    },
    active
  );

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
  const loadStatus = snapshot.load.status;
  useEffect(() => {
    onLoadState?.(loadStatus);
  }, [loadStatus, onLoadState]);
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
      opener.open({ type: "resolve", address: formatObjectAddress({ kind: "source", id }) }),
    openAddress: (address) =>
      onOpenAddress ? onOpenAddress(address) : opener.open({ type: "resolve", address })
  };

  const { controller: ops } = topicOps;
  const shown = snapshot.load.status === "ready" ? snapshot.load.page.topic : null;
  const headerOps: HeaderOps | undefined = shown
    ? {
        renaming,
        busy: topicOps.snapshot.busy,
        error: topicOps.dialog === null ? topicOps.snapshot.error : null,
        onStartRename: () => {
          ops.clearError();
          setRenamingFor(topicId);
        },
        onCommitRename: (title) =>
          void ops.rename(shown, title).then((done) => {
            if (!done) return;
            setRenamingFor(null);
            headingRef.current?.focus({ preventScroll: true });
          }),
        onCancelRename: () => {
          ops.clearError();
          setRenamingFor(null);
          headingRef.current?.focus({ preventScroll: true });
        },
        onCreate: () =>
          topicOps.openDialog({
            kind: "create",
            parent: { id: shown.id, title: shown.title },
            top: shown.parentId === null
          }),
        onMove: () => topicOps.openDialog({ kind: "move", topic: shown }),
        onTogglePin: () => void ops.pin(shown, shown.management !== "pinned")
      }
    : undefined;

  return (
    <TopicPageView
      t={t}
      snapshot={snapshot}
      active={active}
      headingRef={headingRef}
      actions={actions}
      ops={headerOps}
      overlay={<TopicOpsOverlay t={t} ops={topicOps} />}
      openFailed={opener.openFailed}
      onClose={closable ? () => onClose?.() : undefined}
      onRetry={() => controller.retry()}
      onUndo={() => void controller.undo()}
      onShowAllNotes={() => controller.showAllNotes()}
      onLoadMoreNotes={() => controller.loadMoreNotes()}
      onRetryNotes={() => controller.retryNotes()}
      embedded={embedded}
      compact={compact}
      current={current}
      onOpenNoteAddress={actions.openAddress}
    />
  );
}
