import { screenTranslator } from "../../screen-locale";
import { formatView } from "../../route";
import type { ScreenModule } from "../../surfaces";
import { MapRoot } from "./MapRoot";
import {
  sample,
  sampleChangeSet,
  sampleHistory,
  sampleShape,
  shapeId
} from "./shape/shape-fixtures";

export const surface = "destination-map";

const t = screenTranslator();
const noop = () => undefined;

/** The Map opened from a note's path: the topic it came from is the origin ("aqui"). */
const origin = { kind: "topic", id: shapeId(sample.forgetting) } as const;
const address = formatView({ view: "map", lens: "shape", scope: origin });

const emptyShape = sampleShape({
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
});

export const fixtures: ScreenModule["fixtures"] = {
  success: {
    "topics.shape": sampleShape(),
    "topics.changeSet": sampleChangeSet(),
    "topics.review": null,
    "topics.undo": { status: "undone" },
    "topics.history": sampleHistory,
    "objects.resolveMany": (input: { addresses: string[] }) => ({
      items: Object.fromEntries(
        input.addresses.map((entry) => [
          entry,
          {
            address: entry,
            kind: "topic",
            title: "Forgetting curve",
            status: "live",
            preview: "",
            updatedAt: "2026-10-15T13:41:00.000Z"
          }
        ])
      ),
      missing: []
    })
  },
  empty: {
    "topics.shape": emptyShape,
    "topics.history": sampleHistory,
    "objects.resolveMany": { items: {}, missing: [] }
  }
};

export function render() {
  return (
    <div className="h-full min-h-[640px] bg-background">
      <MapRoot
        t={t}
        address={address}
        mode="full"
        active
        onState={noop}
        onPlace={noop}
        onOpen={noop}
      />
    </div>
  );
}
