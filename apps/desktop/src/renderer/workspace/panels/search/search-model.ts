import { objectKinds, parseObjectAddress, type ObjectKind } from "@app/domain";

import type { OmniParams, OmniSnapshot } from "../../../lib/use-omni";
import type { PanelLoadState } from "../../PanelFrame";
import { formatView, parseViewAddress } from "../../route";

/**
 * The search results panel's rules (design record §11, spec 3.5): what its address asks, how a
 * kind filter changes the address, and which of the four states the panel reports. Pure.
 */

/** The most rows `search.omni` returns (its own bound). */
export const searchLimit = 50;

export interface SearchAsk {
  query: string;
  /** The kinds the panel is narrowed to; empty means every kind. */
  kinds: ObjectKind[];
}

/** What a `memora://search?q=…[&kinds=…]` address asks, or null for any other address. */
export function parseSearchAddress(address: string): SearchAsk | null {
  const view = parseViewAddress(address);
  return view?.view === "search" ? { query: view.query, kinds: view.kinds ?? [] } : null;
}

/** The panel address for a query and kinds; the filter is part of the address, so Back undoes it. */
export function searchAddress(query: string, kinds: readonly ObjectKind[]): string {
  const narrowed = kinds.length > 0 && kinds.length < objectKinds.length;
  return formatView({ view: "search", query, ...(narrowed ? { kinds: [...kinds] } : {}) });
}

/** The kinds after one chip is pressed: added or taken off; all of them is the same as none. */
export function toggleKind(kinds: readonly ObjectKind[], kind: ObjectKind): ObjectKind[] {
  const next = kinds.includes(kind) ? kinds.filter((entry) => entry !== kind) : [...kinds, kind];
  const ordered = objectKinds.filter((entry) => next.includes(entry));
  return ordered.length === objectKinds.length ? [] : ordered;
}

/** What to ask `search.omni`: the whole library in full mode (passages and meaning included). */
export function searchParams(ask: SearchAsk): OmniParams {
  return {
    query: ask.query.slice(0, 200),
    mode: "full",
    limit: searchLimit,
    ...(ask.kinds.length > 0 ? { kinds: ask.kinds } : {})
  };
}

/** The panel state for its frame: skeleton, nothing found, one failure in place, or results. */
export function reportedState(snapshot: Pick<OmniSnapshot, "status" | "items">): PanelLoadState {
  if (snapshot.status === "error") return "error";
  if (snapshot.status === "ready") return snapshot.items.length === 0 ? "empty" : "success";
  return "loading";
}

/** Whether a result is a passage of a source (its address carries the `passage` anchor). */
export function isPassage(address: string): boolean {
  return parseObjectAddress(address)?.anchor?.passage !== undefined;
}

/**
 * Which notice a degraded answer shows. With no word to look for inside the texts nothing but
 * titles and names was searched, so that one is the true one even when the meaning arm was also
 * missing; the meaning arm's notice (word matches only) holds only when the words did run.
 */
export function degradedNotice(degraded: readonly ("ann" | "fts")[]): "ann" | "fts" | null {
  if (degraded.includes("fts")) return "fts";
  return degraded.includes("ann") ? "ann" : null;
}
