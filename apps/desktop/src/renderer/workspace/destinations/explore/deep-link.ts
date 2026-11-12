import { useEffect } from "react";

import type { DeepLink } from "../../../../shared/obsidian-deep-link";
import { useStableCallback } from "../../../lib/stable-callback";
import type { DestinationId } from "../../destinations";
import type { WorkspaceAction, WorkspaceState } from "../../state";

/**
 * What the app does with a `memora://` link from outside (D10): it opens one object as a pushed
 * panel in Explore, or in the destination the person is in when that is the Library or the Inbox
 * (a link never takes the person out of the list they are working through). A link to a page of
 * the retired wiki opens nothing: Explore shows a notice. The plan is a pure function of the link
 * and the workspace, so it is tested without a renderer.
 */

export interface DeepLinkPlan {
  /** Workspace actions, in order. */
  actions: WorkspaceAction[];
  /** The notice to show, if any. */
  notice: "retiredWiki" | null;
}

/** The destinations a link opens its object in without leaving them. */
const staysIn: readonly DestinationId[] = ["library", "inbox"];

export function planDeepLink(link: DeepLink, workspace: WorkspaceState): DeepLinkPlan {
  const current = workspace.destination;
  const destination: DestinationId =
    current !== "settings" && staysIn.includes(current) ? current : "explore";
  const actions: WorkspaceAction[] = [];
  if (current !== destination) actions.push({ type: "go", destination });
  if (link.kind === "retired-wiki") return { actions, notice: "retiredWiki" };
  actions.push({
    type: "open",
    address: link.address,
    from: workspace.stacks[destination].focus,
    mode: "push"
  });
  return { actions, notice: null };
}

/** The part of `window.app` the link subscription needs. */
export interface DeepLinkApi {
  onOpen: (listener: (link: DeepLink) => void) => () => void;
  pendingOpen: () => Promise<DeepLink | null>;
}

/**
 * Follows the links that arrive while the app runs and the one that started it. A link that arrives
 * while the workspace is not ready is kept by the main process until `pendingOpen` asks.
 */
export function watchDeepLinks(
  api: () => DeepLinkApi | undefined,
  onLink: (link: DeepLink) => void
): () => void {
  const deepLink = api();
  if (!deepLink) return () => undefined;
  let live = true;
  const stop = deepLink.onOpen(onLink);
  void deepLink
    .pendingOpen()
    .then((link) => {
      if (live && link) onLink(link);
    })
    .catch(() => undefined);
  return () => {
    live = false;
    stop();
  };
}

/** What the app gives a link that arrives. */
export interface DeepLinkHandlers {
  dispatch: (action: WorkspaceAction) => void;
  onNotice: (notice: "retiredWiki") => void;
  /** An old screen covers the stack: the link uncovers it. */
  onShowStack?: (() => void) | undefined;
}

/** Applies a link to the workspace: uncovers the stack, runs the plan's actions, tells the notice. */
export function applyDeepLink(
  link: DeepLink,
  workspace: WorkspaceState,
  handlers: DeepLinkHandlers
): DeepLinkPlan {
  const plan = planDeepLink(link, workspace);
  // An old screen (Import, Search, Review, Jobs, Debug) covers the stack: the link uncovers it.
  handlers.onShowStack?.();
  for (const action of plan.actions) handlers.dispatch(action);
  if (plan.notice) handlers.onNotice(plan.notice);
  return plan;
}

/**
 * Opens the links from outside in the workspace. `workspace` is read when a link arrives, so the
 * subscription lives as long as the window.
 */
export function useDeepLinks(
  workspace: WorkspaceState,
  dispatch: (action: WorkspaceAction) => void,
  onNotice: (notice: "retiredWiki") => void,
  onShowStack?: () => void
): void {
  const open = useStableCallback((link: DeepLink) =>
    applyDeepLink(link, workspace, { dispatch, onNotice, onShowStack })
  );
  useEffect(
    () =>
      watchDeepLinks(
        () => (typeof window === "undefined" ? undefined : window.app?.deepLink),
        open
      ),
    [open]
  );
}
