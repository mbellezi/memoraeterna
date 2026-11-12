import { createGraphPhysics } from "../../../../components/graph/physics";
import { screenTranslator } from "../../../screen-locale";
import type { ScreenModule } from "../../../surfaces";
import { branchTopics, sampleBranch, unconnectedBranch } from "./branch-fixtures";
import type { BranchLayoutFactory } from "./RelationsCanvas";
import { RelationsLens, surfaceId } from "./RelationsLens";

export const surface = surfaceId;

const t = screenTranslator();
const noop = () => undefined;

const settings = { graphWheelZoomSensitivity: 1 };

/**
 * The capture's bundle carries no Web Worker: the same physics settles here, before the shot,
 * and hands the canvas its final positions (the app lays out in the worker).
 */
const settledLayout: BranchLayoutFactory = (nodes, edges, forces, onPositions) => {
  const physics = createGraphPhysics(nodes, edges, forces, false);
  for (let tick = 0; tick < 800 && !physics.tick(); tick += 1);
  queueMicrotask(() => onPositions(physics.positions(), false));
  return { kill: () => undefined };
};

/** The Map › Grafo of the Fermentação branch (design record 7.5, `#map-graph`). */
export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "relations.branch": sampleBranch(),
    "settings.getApp": settings
  },
  empty: {
    "relations.branch": unconnectedBranch(),
    "settings.getApp": settings
  }
};

export function render() {
  return (
    <div className="min-h-[720px] bg-background px-6 py-5 max-[1179px]:px-4">
      <RelationsLens
        t={t}
        active
        scope={{ kind: "topic", id: branchTopics.fermentation }}
        onOpenNote={noop}
        onShowTree={noop}
        createLayout={settledLayout}
      />
    </div>
  );
}
