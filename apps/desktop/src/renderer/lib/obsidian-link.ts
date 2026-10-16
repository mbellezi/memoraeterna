import type { DesktopApi } from "../../shared/ipc";
import type { ObsidianDeepLink } from "../../shared/obsidian-deep-link";
import type { LibraryExternalTarget } from "../components/LibraryView";

/** Where a `memora://` link from Obsidian leads inside the app, before the tree is asked. */
export type ObsidianLinkRoute =
  /** A page of the old wiki: it no longer exists, so the Wiki opens with a notice. */
  | { type: "removedWikiPage" }
  /** A topic of the topic tree, named by the ID its map was written with. */
  | { type: "topic"; topicId: string }
  /** A source of the Library; Back returns to the Wiki. */
  | { type: "source"; target: Omit<LibraryExternalTarget, "token"> };

export function routeObsidianLink(link: ObsidianDeepLink): ObsidianLinkRoute {
  if (link.kind === "wiki") return { type: "removedWikiPage" };
  if (link.kind === "topic") return { type: "topic", topicId: link.id };
  return {
    type: "source",
    target: {
      sourceItemId: link.id,
      origin: "wiki",
      ...(link.relation ? { sourceRelationId: link.relation } : {})
    }
  };
}

/** What a link finally does: the route, with a topic resolved against the tree as it is now. */
export type ObsidianLinkOutcome =
  | Exclude<ObsidianLinkRoute, { type: "topic" }>
  /** The Wiki opens this topic; `redirected` when the link named a topic that was merged into it. */
  | { type: "topic"; topicId: string; redirected: boolean }
  /** The tree has no such topic, live or retired with a successor. */
  | { type: "topicNotFound" };

/**
 * Follows a link: a map written before a merge still opens the topic that took its place (a
 * retired topic resolves to its successor), and an ID the tree does not know is `topicNotFound`,
 * not a page that fails to load. When the tree cannot be asked (the app is still starting, or the
 * read failed) the link opens the topic it names: the Topic page follows the same redirects and
 * has its own states for a missing topic and a failed read.
 */
export async function followObsidianLink(
  link: ObsidianDeepLink,
  topics: Pick<DesktopApi["topics"], "path">
): Promise<ObsidianLinkOutcome> {
  const route = routeObsidianLink(link);
  if (route.type !== "topic") return route;
  try {
    const resolved = await topics.path({ id: route.topicId });
    if (!resolved) return { type: "topicNotFound" };
    return {
      type: "topic",
      topicId: resolved.resolvedId,
      redirected: resolved.redirectedFrom !== null
    };
  } catch {
    return { type: "topic", topicId: route.topicId, redirected: false };
  }
}

/** What the app does for a link; each is one thing the person sees. */
export interface ObsidianLinkActions {
  /** The Wiki opens where it starts, with the notice about the removed wiki. */
  removedWikiPage(): void;
  /** The Library opens the source. */
  source(target: Omit<LibraryExternalTarget, "token">): void;
  /** The Wiki opens the topic; `redirected` when the link named one that was merged into it. */
  topic(topicId: string, redirected: boolean): void;
  /** The Wiki opens where it starts, with the notice that the topic is gone. */
  topicNotFound(): void;
}

export interface ObsidianLinkOpenerDeps {
  /** Read at each link, so a window that is not ready yet is not asked early. */
  topics: () => Pick<DesktopApi["topics"], "path">;
  /** Read at each link, so the actions are the ones of the latest render. */
  actions: () => ObsidianLinkActions;
}

/**
 * Opens the links Obsidian sends. A topic link is resolved first, so only the newest link is
 * followed: the slower answer to an earlier link would otherwise open after it.
 */
export function createObsidianLinkOpener(
  deps: ObsidianLinkOpenerDeps
): (link: ObsidianDeepLink) => Promise<void> {
  let latest = 0;
  return async (link) => {
    const request = (latest += 1);
    const outcome = await followObsidianLink(link, deps.topics());
    if (request !== latest) return;
    const actions = deps.actions();
    if (outcome.type === "removedWikiPage") actions.removedWikiPage();
    else if (outcome.type === "source") actions.source(outcome.target);
    else if (outcome.type === "topic") actions.topic(outcome.topicId, outcome.redirected);
    else actions.topicNotFound();
  };
}
