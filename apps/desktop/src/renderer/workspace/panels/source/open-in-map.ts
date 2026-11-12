import { formatView } from "../../route";

/**
 * "Abrir no Mapa" on a Source: the address of the Map's Relations lens scoped to this source (D19,
 * design record 6.2). This is the first link of the file's chain (T140 then T152): until the lens
 * lands, the address opens the Map's root, which already reads the scope from it. The Source panel
 * only opens the address; where it leads is the Map's business.
 */
export function openInMapAddress(sourceId: string): string {
  return formatView({
    view: "map",
    lens: "relations",
    scope: { kind: "source", id: sourceId }
  });
}
