import type { ObsidianDeepLink } from "../../shared/obsidian-deep-link";
import type { LibraryExternalTarget } from "../components/LibraryView";

/** Where a `memora://open/…` link from Obsidian leads inside the app. */
export type ObsidianLinkRoute =
  /** A page of the old wiki: it no longer exists, so the Wiki opens with a notice. */
  | { type: "removedWikiPage" }
  /** A source of the Library; Back returns to the Wiki. */
  | { type: "source"; target: Omit<LibraryExternalTarget, "token"> };

export function routeObsidianLink(link: ObsidianDeepLink): ObsidianLinkRoute {
  if (link.kind === "wiki") return { type: "removedWikiPage" };
  return {
    type: "source",
    target: {
      sourceItemId: link.id,
      origin: "wiki",
      ...(link.relation ? { sourceRelationId: link.relation } : {})
    }
  };
}
