import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore
} from "react";
import { statusSentence } from "@app/domain";
import type { Translator } from "@app/i18n";

import { closePanelPriority, subscribeClosePanel } from "../../lib/close-panel";
import { isUndoKey } from "../topics/ops/notice-key";
import {
  canUndoNotice,
  sharedNoticeCenter,
  type TopicNoticeCenter
} from "../topics/ops/topic-notice-center";
import { useStableCallback } from "../../lib/stable-callback";
import { ActivityController, activityApiOf } from "./activity-controller";
import {
  effectiveStatus,
  pillView,
  type ActivityNavigation,
  type ActivitySnapshot
} from "./activity-model";
import { ActivityDrawer } from "./ActivityDrawer";
import { ActivityPill, type PillNotice } from "./ActivityPill";
import { closesDrawer, createDrawerFocus } from "./drawer-focus";

export interface ActivityHostProps {
  t: Translator;
  /** Opens the place an action leads to. */
  onNavigate: (to: ActivityNavigation) => void;
  /** Opens the Inbox; without it the drawer counts the reviews and offers no button. */
  onOpenInbox?: () => void;
  /** Home drops the pill's needs-you clause: its "Precisa de você" column shows it. */
  hideNeedsYou?: boolean;
  /** At compact width the pill drops its "waiting" clause first. */
  compact?: boolean;
  /**
   * The window's notice center: what follows a change to the topics is shown in the pill as its undo
   * extension, with the U key, in place of the floating toast (the window's, unless a test brings
   * its own).
   */
  notices?: TopicNoticeCenter;
}

/** A name in a notice: the stored one, or the words for a topic that has none. */
const nameOf = (t: Translator, title: string | null): string =>
  title === null || title === "" ? t("topics.unnamed") : title;

/**
 * What the polite live region says: the result of an action, or the sentence when the Gardener
 * starts to need the person. Two equal messages in a row differ by a no-break space, so the second
 * is spoken too.
 */
export function announcementText(t: Translator, snapshot: ActivitySnapshot): string {
  const { announcement } = snapshot;
  if (announcement === null) return "";
  const status = effectiveStatus(snapshot);
  const text =
    announcement.kind === "message"
      ? t(announcement.key)
      : status
        ? statusSentence(status, t.locale, { now: snapshot.now }).text
        : "";
  return announcement.id % 2 === 0 ? `${text}\u00a0` : text;
}

/**
 * The shell header's Activity: the pill, and the drawer it opens. It keeps the controller (all the
 * rules, tested without a renderer) and the focus choreography; the pill is always on screen, so
 * the status is followed for as long as the shell lives, and the drawer reads its own data only
 * while it is open.
 */
export function ActivityHost({
  t,
  onNavigate,
  onOpenInbox,
  hideNeedsYou = false,
  compact = false,
  notices = sharedNoticeCenter
}: ActivityHostProps) {
  const drawerId = useId();
  const navigate = useStableCallback(onNavigate);
  const [controller] = useState(
    () => new ActivityController({ api: () => activityApiOf(window.app), navigate })
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const pillRef = useRef<HTMLButtonElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const { open } = snapshot;

  useEffect(() => {
    controller.start();
    return () => controller.stop();
  }, [controller]);

  // Opening moves focus into the drawer (it is rendered with the open state, so it exists now).
  useEffect(() => {
    if (open) createDrawerFocus({ pill: pillRef, drawer: drawerRef }).opened();
  }, [open]);

  const dismiss = useCallback(() => {
    controller.setOpen(false);
    createDrawerFocus({ pill: pillRef, drawer: drawerRef }).closed();
  }, [controller]);

  // Cmd-W closes the drawer like any other panel, and does nothing when it is not open.
  useEffect(() => {
    if (!open) return undefined;
    return subscribeClosePanel(() => {
      dismiss();
      return true;
    }, closePanelPriority.panel);
  }, [open, dismiss]);

  const { notice } = useSyncExternalStore(
    notices.subscribe,
    notices.getSnapshot,
    notices.getSnapshot
  );
  const undoable = canUndoNotice(notice);

  // The U key undoes the notice in the pill, from anywhere but a text field, a dialog or a modifier.
  useEffect(() => {
    if (!undoable) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isUndoKey(event)) return;
      event.preventDefault();
      void notices.undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undoable, notices]);

  const pillNotice: PillNotice | null = notice
    ? {
        text: t(notice.key, {
          values: { title: nameOf(t, notice.title), parent: nameOf(t, notice.parent) }
        }),
        canUndo: undoable,
        pending: notice.state === "pending",
        blocked: notice.state === "blocked",
        failed: notice.state === "failed",
        onUndo: () => void notices.undo(),
        onHold: (held) => notices.hold(held)
      }
    : null;

  const view = pillView(t, snapshot);
  const live = useMemo(() => announcementText(t, snapshot), [t, snapshot]);
  const closeOnEscape = (event: {
    key: string;
    defaultPrevented: boolean;
    stopPropagation(): void;
  }) => {
    if (!open || !closesDrawer(event)) return;
    event.stopPropagation();
    dismiss();
  };

  return (
    <div className="flex min-w-0 items-center">
      <ActivityPill
        ref={pillRef}
        t={t}
        view={view}
        open={open}
        drawerId={drawerId}
        onToggle={() => {
          if (open) dismiss();
          else controller.setOpen(true);
        }}
        onKeyDown={closeOnEscape}
        hideNeedsYou={hideNeedsYou}
        compact={compact}
        notice={pillNotice}
      />
      {open ? (
        <ActivityDrawer
          ref={drawerRef}
          id={drawerId}
          t={t}
          snapshot={snapshot}
          now={snapshot.now}
          onClose={dismiss}
          onRetry={() => controller.retry()}
          onAction={(action) => void controller.runAction(action)}
          onUndo={(change) => void controller.undo(change)}
          onKeyDown={closeOnEscape}
          {...(onOpenInbox
            ? {
                // The Inbox opens in place of the page; the drawer closes as for any other place.
                onOpenInbox: () => {
                  onOpenInbox();
                  controller.setOpen(false);
                }
              }
            : {})}
        />
      ) : null}
      <div role="status" aria-live="polite" className="sr-only">
        {live}
      </div>
    </div>
  );
}
