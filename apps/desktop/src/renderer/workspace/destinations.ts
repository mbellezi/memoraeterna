import { formatView } from "./route";

/**
 * The five destinations of the rail, in rail order (docs/f5-decisions.md D8). Settings sits in the
 * rail footer as a full surface, not a destination: it has no stack.
 */
export const destinationIds = ["home", "explore", "library", "inbox", "map"] as const;
export type DestinationId = (typeof destinationIds)[number];
/** Where the workspace can be: a destination or Settings. */
export type WorkspacePlace = DestinationId | "settings";

export function isDestinationId(value: unknown): value is DestinationId {
  return typeof value === "string" && (destinationIds as readonly string[]).includes(value);
}

/** The root surface each destination's stack starts from. Map opens on the Relations lens. */
export const destinationRoots: Readonly<Record<DestinationId, string>> = {
  home: formatView({ view: "home" }),
  explore: formatView({ view: "explore" }),
  library: formatView({ view: "library" }),
  inbox: formatView({ view: "inbox" }),
  map: formatView({ view: "map", lens: "relations" })
};

/**
 * The navigator is on by default in Explore only (design record §20.1 row 30: the Library has a
 * filter bar and a territory bar instead); Cmd-\ toggles it per destination.
 */
export const navigatorDefaults: Readonly<Record<DestinationId, boolean>> = {
  home: false,
  explore: true,
  library: false,
  inbox: false,
  map: false
};

/** Cmd-1..5 in rail order; any other digit names no destination. */
export function destinationForDigit(digit: number): DestinationId | null {
  return destinationIds[digit - 1] ?? null;
}
