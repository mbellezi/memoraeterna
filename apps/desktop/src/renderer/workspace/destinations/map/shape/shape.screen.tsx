import { screenTranslator } from "../../../screen-locale";
import type { ScreenModule } from "../../../surfaces";
import { sampleChangeSet, sampleHistory, sampleShape } from "./shape-fixtures";
import { ShapeScreen } from "./ShapeScreen";

export const surface = "shape";

const t = screenTranslator();
const noop = () => undefined;

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "topics.shape": sampleShape(),
    "topics.history": sampleHistory,
    "topics.changeSet": sampleChangeSet(),
    "topics.review": null,
    "topics.undo": { status: "undone" }
  },
  empty: {
    "topics.history": sampleHistory,
    "topics.shape": sampleShape({
      nodes: [],
      warnings: [],
      changedToday: [],
      summary: {
        items: 0,
        topics: 0,
        meanDepth: 0,
        reachable: 0,
        unsortedShare: 0,
        needsVector: 0,
        soft: 0,
        hard: 0
      }
    })
  }
};

export function render() {
  return <ShapeScreen t={t} active onNavigate={noop} />;
}
