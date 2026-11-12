import { useEffect, useState, useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import type { OpenableNavigation } from "../../../../components/WhereIsThis";
import type { PanelLoadState } from "../../../PanelFrame";
import { ShapeController, type ShapeSnapshot } from "./shape-controller";
import { ShapeView, type ShapeDisplay, type ShapeOrigin } from "./ShapeView";

export interface ShapeScreenProps {
  t: Translator;
  /** False while the host view or this lens is hidden: nothing loads and nothing listens. */
  active: boolean;
  /** Where "Open topic" leads. */
  onNavigate: (navigation: OpenableNavigation) => void;
  /** Opens the Inbox (the next step of a topic with a proposal that waits). */
  onOpenInbox?: () => void;
  /** The topic the person came from, marked "aqui", and the way back to it. */
  origin?: ShapeOrigin | null;
  onBack?: () => void;
  /** The root is the previous panel of the stack: its table alone, the open topic marked. */
  compact?: boolean;
  currentTopicId?: string | null;
  /** Tells the host how the lens is doing, as the four states of a surface. */
  onState?: (state: PanelLoadState) => void;
}

/** The state a snapshot is in, as the frame names it: nothing to show is empty, not an error. */
export function shapeState(snapshot: Pick<ShapeSnapshot, "load">): PanelLoadState {
  const { load } = snapshot;
  if (load.status === "loading") return "loading";
  if (load.status === "error") return "error";
  if (load.status === "missing") return "empty";
  return load.shape.summary.items > 0 && load.shape.nodes.length > 0 ? "success" : "empty";
}

/**
 * The Map lens "Árvore". The state of the tree lives in a controller (tested without a renderer);
 * the chart or table choice is the person's view and lives here. The host keeps it mounted while
 * hidden, so the zoomed branch and the selection survive.
 */
export function ShapeScreen({
  t,
  active,
  onNavigate,
  onOpenInbox,
  origin,
  onBack,
  compact,
  currentTopicId,
  onState
}: ShapeScreenProps) {
  const [controller] = useState(() => new ShapeController({ api: () => window.app.topics }));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const [display, setDisplay] = useState<ShapeDisplay>("chart");

  useEffect(() => {
    controller.show(active, t);
  }, [controller, active, t]);

  useEffect(() => () => controller.dispose(), [controller]);

  const state = shapeState(snapshot);
  useEffect(() => {
    onState?.(state);
  }, [onState, state]);

  return (
    <ShapeView
      t={t}
      snapshot={snapshot}
      display={display}
      origin={origin}
      compact={compact}
      currentTopicId={currentTopicId}
      onBack={onBack}
      onOpenInbox={onOpenInbox}
      onDisplay={setDisplay}
      onRetry={() => controller.retry()}
      onSelect={(key) => controller.select(key)}
      onZoomInto={(topicId, title, depth) => controller.zoomInto(topicId, title, depth)}
      onZoomTo={(index) => controller.zoomTo(index)}
      onOpenTopic={(topicId) => onNavigate({ type: "topic", topicId })}
      onReview={(changeSetId, decision) => void controller.review(changeSetId, decision)}
      onUndo={(changeSetId) => void controller.undo(changeSetId)}
      onToggleDetails={(changeSetId) => controller.toggleDetails(changeSetId)}
      onRetryDetails={(changeSetId) => controller.retryDetails(changeSetId)}
    />
  );
}
