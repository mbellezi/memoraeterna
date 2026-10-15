import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import { TopicMoveDialog } from "./TopicMoveDialog";
import { TopicNameDialog } from "./TopicNameDialog";
import { TopicUndoToast } from "./TopicUndoToast";
import { TopicOpsController, type OpsDialog, type OpsSnapshot } from "./topic-ops-controller";
import { TopicPickerController } from "./topic-picker";

export type { OpsDialog };

export interface TopicOps {
  controller: TopicOpsController;
  snapshot: OpsSnapshot;
  dialog: OpsDialog | null;
  openDialog: (dialog: OpsDialog) => void;
  closeDialog: () => void;
}

/** True when a key press is being typed into something, where single keys are text. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === "undefined" || !(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

/**
 * The human structure operations of one view: the controller, the dialog that is open and the U key
 * for the notice that follows a change. A hidden view keeps no dialog, no notice and no key.
 */
export function useTopicOps(active: boolean): TopicOps {
  const [controller] = useState(() => new TopicOpsController(() => window.app.topics));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  useEffect(() => () => controller.dispose(), [controller]);

  useEffect(() => {
    if (!active) controller.reset();
  }, [active, controller]);

  const { dialog } = snapshot;

  // U undoes the change the notice names, unless the person is typing or a dialog has the window.
  const undoable = snapshot.notice?.changeSetId != null && snapshot.notice.state !== "blocked";
  useEffect(() => {
    if (!active || !undoable || dialog !== null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "u") return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.defaultPrevented || event.repeat || isTypingTarget(event.target)) return;
      event.preventDefault();
      void controller.undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [active, undoable, dialog, controller]);

  return useMemo(
    () => ({
      controller,
      snapshot,
      dialog,
      openDialog: (next: OpsDialog) => controller.openDialog(next),
      closeDialog: () => controller.closeDialog()
    }),
    [controller, snapshot, dialog]
  );
}

/** The notice and the dialog of a view's operations, drawn where the view puts them. */
export function TopicOpsOverlay({
  t,
  ops,
  onPlaced
}: {
  t: Translator;
  ops: TopicOps;
  /** After a note or source was placed by hand (the page it is on reads again). */
  onPlaced?: () => void;
}) {
  const { controller, snapshot, dialog, closeDialog } = ops;
  return (
    <>
      <TopicUndoToast
        t={t}
        notice={snapshot.notice}
        onUndo={() => void controller.undo()}
        onDismiss={() => controller.dismiss()}
        onHold={(held) => controller.hold(held)}
      />
      {dialog?.kind === "create" ? (
        <TopicNameDialog
          t={t}
          parentTitle={dialog.parent.title}
          top={dialog.top}
          busy={snapshot.busy}
          error={snapshot.error}
          onCancel={closeDialog}
          onSubmit={(title) =>
            void controller.create(dialog.parent, title).then((done) => {
              if (done) closeDialog();
            })
          }
        />
      ) : null}
      {dialog?.kind === "move" || dialog?.kind === "place" ? (
        <MoveDialogHost t={t} ops={ops} dialog={dialog} {...(onPlaced ? { onPlaced } : {})} />
      ) : null}
    </>
  );
}

function MoveDialogHost({
  t,
  ops,
  dialog,
  onPlaced
}: {
  t: Translator;
  ops: TopicOps;
  dialog: Extract<OpsDialog, { kind: "move" | "place" }>;
  onPlaced?: () => void;
}) {
  const { controller, snapshot, closeDialog } = ops;
  const excluded = dialog.kind === "move" ? dialog.topic.id : null;
  const picker = useMemo(
    () => new TopicPickerController(() => window.app.topics, excluded),
    [excluded]
  );
  return (
    <TopicMoveDialog
      t={t}
      mode={dialog.kind}
      subjectTitle={dialog.kind === "move" ? dialog.topic.title : dialog.item.title}
      currentParentId={dialog.kind === "move" ? (dialog.topic.parentId ?? null) : null}
      picker={picker}
      busy={snapshot.busy}
      error={snapshot.error}
      onCancel={closeDialog}
      onConfirm={(here, role) => {
        const done =
          dialog.kind === "move"
            ? controller.move(dialog.topic, here)
            : controller.place(dialog.item, here, role);
        void done.then((ok) => {
          if (!ok) return;
          closeDialog();
          if (dialog.kind === "place") onPlaced?.();
        });
      }}
    />
  );
}
