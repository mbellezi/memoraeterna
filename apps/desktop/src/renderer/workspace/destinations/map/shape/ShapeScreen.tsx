import { useEffect, useState, useSyncExternalStore } from "react";
import type { Translator } from "@app/i18n";

import type { OpenableNavigation } from "../../../../components/WhereIsThis";
import { ShapeController } from "./shape-controller";
import { ShapeView, type ShapeDisplay } from "./ShapeView";

export interface ShapeScreenProps {
  t: Translator;
  /** False while the host view or this lens is hidden: nothing loads and nothing listens. */
  active: boolean;
  /** Where "Open topic" leads. */
  onNavigate: (navigation: OpenableNavigation) => void;
}

/**
 * The Map lens "Shape" of the Wiki. The state of the tree lives in a controller (tested without a
 * renderer); the chart or table choice and the chart's zoom are the person's view and live here.
 * The host keeps it mounted while hidden, so the zoomed branch and the selection survive.
 */
export function ShapeScreen({ t, active, onNavigate }: ShapeScreenProps) {
  const [controller] = useState(() => new ShapeController({ api: () => window.app.topics }));
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot
  );
  const [display, setDisplay] = useState<ShapeDisplay>("chart");
  const [zoomPercent, setZoomPercent] = useState(100);

  useEffect(() => {
    controller.show(active, t);
  }, [controller, active, t]);

  useEffect(() => () => controller.dispose(), [controller]);

  return (
    <ShapeView
      t={t}
      snapshot={snapshot}
      display={display}
      zoomPercent={zoomPercent}
      onDisplay={setDisplay}
      onZoomPercent={setZoomPercent}
      onRetry={() => controller.retry()}
      onSelect={(key) => controller.select(key)}
      onZoomInto={(topicId, title, depth) => {
        controller.zoomInto(topicId, title, depth);
        // A branch fits the area when it is shown alone.
        setZoomPercent(100);
      }}
      onZoomTo={(index) => {
        controller.zoomTo(index);
        setZoomPercent(100);
      }}
      onOpenTopic={(topicId) => onNavigate({ type: "topic", topicId })}
      onReview={(changeSetId, decision) => void controller.review(changeSetId, decision)}
      onUndo={(changeSetId) => void controller.undo(changeSetId)}
      onToggleDetails={(changeSetId) => controller.toggleDetails(changeSetId)}
      onRetryDetails={(changeSetId) => controller.retryDetails(changeSetId)}
    />
  );
}
