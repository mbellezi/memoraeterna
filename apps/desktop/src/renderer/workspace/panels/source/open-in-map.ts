import { formatView } from "../../route";

/**
 * "Abrir no Mapa" on a Source: the address of the Map's Grafo scoped to this source (D19, design
 * record 6.2). Second link of the file's chain (T140, then T152): the address is the same one, now
 * with its real target, the Grafo's branch of the notes of this source, their relations, the table
 * of the same connections and the topics outside it. The Source panel only opens the address; where
 * it leads is the Map's business (`readMapAddress` in `destinations/map/MapRoot.tsx`).
 */
export function openInMapAddress(sourceId: string): string {
  return formatView({
    view: "map",
    lens: "relations",
    scope: { kind: "source", id: sourceId }
  });
}
