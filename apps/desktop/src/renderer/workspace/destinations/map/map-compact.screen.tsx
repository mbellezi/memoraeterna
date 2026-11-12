import { formatObjectAddress } from "@app/domain";

import { screenTranslator } from "../../screen-locale";
import { formatView } from "../../route";
import type { ScreenModule } from "../../surfaces";
import { AddSourceContext } from "../../workspace-bridge";
import { compactSurfaceId, MapRoot } from "./MapRoot";
import type { MapTableProps } from "./shape/MapTable";
import { fixtures as mapFixtures } from "./map.screen";
import { sample, shapeId } from "./shape/shape-fixtures";

export const surface = compactSurfaceId;

const t = screenTranslator();
const noop = () => undefined;

/** The Map as the previous panel (design record §8): its table in the 240 px column beside a topic. */
const compact = { compact: true } satisfies Pick<MapTableProps, "compact">;
const open = formatObjectAddress({ kind: "topic", id: shapeId(sample.forgetting) });

export const fixtures: ScreenModule["fixtures"] = mapFixtures;

export function render() {
  return (
    <AddSourceContext.Provider value={noop}>
      <div className="h-full min-h-[640px] w-60 overflow-hidden rounded-lg border border-border bg-background">
        <MapRoot
          t={t}
          address={formatView({ view: "map", lens: "shape" })}
          mode={compact.compact ? "compact" : "full"}
          active
          current={open}
          onState={noop}
          onPlace={noop}
          onOpen={noop}
        />
      </div>
    </AddSourceContext.Provider>
  );
}
