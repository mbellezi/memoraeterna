import { describe, expect, it } from "vitest";

import { readMapAddress } from "../../destinations/map/MapRoot";
import { parseViewAddress } from "../../route";
import { openInMapAddress } from "./open-in-map";

const sourceId = "5b0a7c3e-0000-4000-8000-0000000000aa";

describe("Abrir no Mapa on a Source", () => {
  it("opens the Grafo scoped to that source, and the Map reads the scope back", () => {
    const address = openInMapAddress(sourceId);
    expect(address).toBe(`memora://map/relations?scope=memora%3A%2F%2Fsource%2F${sourceId}`);
    expect(parseViewAddress(address)).toEqual({
      view: "map",
      lens: "relations",
      scope: { kind: "source", id: sourceId }
    });
    expect(readMapAddress(address)).toEqual({
      lens: "relations",
      scope: `memora://source/${sourceId}`
    });
  });
});
