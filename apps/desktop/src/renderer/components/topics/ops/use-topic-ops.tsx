import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import { TopicMoveDialog } from "./TopicMoveDialog";
import { TopicNameDialog } from "./TopicNameDialog";
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

/**
 * The human structure operations of one view: the controller and the dialog that is open. The
 * notice that follows a change is the window's, not the view's: the Activity pill shows it. A
 * hidden view keeps no dialog and no notice of its own.
 */
export function useTopicOps(active: boolean): TopicOps {
  const [controller] = useState(() => new TopicOpsController(() => window.app.topics));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );

  useEffect(() => {
    if (!active) controller.reset();
  }, [active, controller]);

  const { dialog } = snapshot;
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

/** The dialog of a view's operations, drawn where the view puts it. */
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
