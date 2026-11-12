import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject
} from "react";
import type { MessageKey, Translator } from "@app/i18n";

import type { LegacyViewId } from "../../shared/app-menu";
import { ActivityHost } from "../components/activity/ActivityHost";
import type { ActivityNavigation } from "../components/activity/activity-model";
import { cn } from "../lib/cn";
import { AddStatusSlot } from "./add/AddFailureNotice";
import { AddMenu } from "./add/AddMenu";
import type { AddFlow } from "./add/add-flow";
import { DropHost } from "./add/DropOverlay";
import type { WorkspacePlace } from "./destinations";
import { keymap } from "./keymap";
import { NavigatorHost, navigatorIsEmpty } from "./NavigatorHost";
import { Rail } from "./Rail";
import {
  destinationTitleKeys,
  hasNavigator,
  layoutCustomProperties,
  legacyTitleKeys,
  nextRegion,
  pillDropsWaiting,
  type RegionId
} from "./shell-model";
import { TitleBar } from "./TitleBar";
import { useInboxCount, useNavigatorTree } from "./use-shell-data";

export interface ShellProps {
  t: Translator;
  place: WorkspacePlace;
  /** An old view is on screen: the title bar names it and the rail marks "Old screens". */
  legacyView?: LegacyViewId | null;
  /** The destination's navigator is on (`workspace.navigator[destination]`). */
  navigatorOn: boolean;
  /**
   * An old view that hosts its own navigator (the Wiki, until Explore's root lands) keeps the host
   * out of the way, so the window never shows two trees.
   */
  navigatorHidden?: boolean;
  /** The destination's own navigator, hosted in place of the top-level list (T141). */
  navigator?: ReactNode;
  /** False until the library is open: nothing is asked of the database before it is ready. */
  dataEnabled?: boolean;
  onGo: (place: WorkspacePlace) => void;
  onOpenLegacy: (view: LegacyViewId) => void;
  /** Cmd-K and the omni trigger. */
  onOpenPalette: () => void;
  /** Adicionar and the window's drop: the flow behind Cmd-N, the split button and the drop overlay. */
  addFlow: AddFlow;
  /** What an action of the Activity drawer leads to (a place in Settings). */
  onNavigateActivity: (to: ActivityNavigation) => void;
  onOpenInbox: () => void;
  /** Opens a topic of the navigator host's default list beside the focused panel. */
  onOpenTopic?: (topicId: string) => void;
  /** The destination's content: the panel stack (T136), or the old view until then. */
  children: ReactNode;
}

/** The shell's state for its frame: what its own reads say (the Inbox count and the tree). */
export function shellState(
  inbox: { status: "loading" | "error" | "ready" },
  tree: { status: "loading" | "error" | "ready"; empty?: boolean } | null
): "loading" | "empty" | "error" | "success" {
  const reads = tree ? [inbox, tree] : [inbox];
  if (reads.some((read) => read.status === "error")) return "error";
  if (reads.some((read) => read.status === "loading")) return "loading";
  return tree?.empty ? "empty" : "success";
}

/** The title bar's name: the old view's, Ajustes, or the destination's own full name. */
export function titleKey(place: WorkspacePlace, legacyView: LegacyViewId | null): MessageKey {
  if (legacyView !== null) return legacyTitleKeys[legacyView];
  return place === "settings" ? "workspace.rail.settings" : destinationTitleKeys[place];
}

/** Tracks the window's width: the shell's tier and its title bar follow it. No timer. */
function useWidth(element: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(() =>
    typeof window === "undefined" ? 1280 : window.innerWidth
  );
  useEffect(() => {
    const node = element.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(([entry]) => {
      if (entry && entry.contentRect.width > 0) setWidth(Math.round(entry.contentRect.width));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

const focusable =
  "[aria-current='page'], [data-omni], button:not([disabled]), a[href], input, [tabindex='0']";

/** Moves focus into a region: its current item, its first control, or the region itself. */
function focusRegion(root: HTMLElement, id: RegionId): void {
  const region = root.querySelector<HTMLElement>(`[data-region="${id}"]`);
  if (!region) return;
  (region.querySelector<HTMLElement>(focusable) ?? region).focus();
}

/**
 * The shell (design record §3): the rail, the title bar, the navigator host and the destination's
 * content, on the desk colour. It writes the layout constants of `layout-config.ts` onto its element
 * as custom properties for the stylesheet and the panel stack, keeps F6 and Shift-F6 cycling the
 * regions (rail, top bar, navigator, stack, context) and reports its own state on its frame
 * (`data-surface`, `data-state`) from the two reads the chrome makes: the Inbox count behind the
 * rail's badge and the top level of the tree behind the navigator.
 */
export function Shell({
  t,
  place,
  legacyView = null,
  navigatorOn,
  navigatorHidden = false,
  navigator,
  dataEnabled = true,
  onGo,
  onOpenLegacy,
  onOpenPalette,
  addFlow,
  onNavigateActivity,
  onOpenInbox,
  onOpenTopic,
  children
}: ShellProps) {
  const root = useRef<HTMLDivElement>(null);
  const width = useWidth(root);
  const showNavigator =
    legacyView === null && hasNavigator(place) && navigatorOn && !navigatorHidden;
  const inbox = useInboxCount(dataEnabled);
  const tree = useNavigatorTree(dataEnabled && showNavigator);
  const state = shellState(
    inbox,
    showNavigator
      ? { status: tree.status, empty: tree.status === "ready" && navigatorIsEmpty(tree.value) }
      : null
  );

  // F6 and Shift-F6: the other accelerators belong to the application menu, which fires them once.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const node = root.current;
      if (!node || event.defaultPrevented) return;
      const result = keymap(event);
      if (result?.type !== "cycleRegion") return;
      event.preventDefault();
      const present = [...node.querySelectorAll<HTMLElement>("[data-region]")].map(
        (region) => region.dataset.region as RegionId
      );
      const active = document.activeElement?.closest<HTMLElement>("[data-region]");
      const current = (active?.dataset.region as RegionId | undefined) ?? null;
      const next = nextRegion(present, current, result.delta);
      if (next) focusRegion(node, next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const title = t(titleKey(place, legacyView));

  return (
    <div
      ref={root}
      data-surface="shell"
      data-state={state}
      style={layoutCustomProperties(width) as CSSProperties}
      className={cn(
        "grid h-screen min-w-0 grid-cols-[var(--rail-w)_minmax(0,1fr)] grid-rows-[var(--top-h)_minmax(0,1fr)]",
        "overflow-hidden bg-background text-foreground"
      )}
    >
      <div className="row-span-2 min-h-0">
        <Rail
          t={t}
          place={place}
          legacyView={legacyView}
          inbox={inbox}
          onGo={onGo}
          onOpenLegacy={onOpenLegacy}
          onRetryInbox={inbox.retry}
        />
      </div>
      <TitleBar
        t={t}
        title={title}
        onOpenPalette={onOpenPalette}
        add={<AddMenu t={t} flow={addFlow} />}
        status={
          <AddStatusSlot t={t} flow={addFlow}>
            <ActivityHost
              t={t}
              onNavigate={onNavigateActivity}
              onOpenInbox={onOpenInbox}
              hideNeedsYou={place === "home" && legacyView === null}
              compact={pillDropsWaiting(width)}
            />
          </AddStatusSlot>
        }
      />
      <div className="flex min-h-0 min-w-0">
        {showNavigator ? (
          <NavigatorHost
            t={t}
            tree={tree}
            compact={pillDropsWaiting(width)}
            {...(onOpenTopic ? { onOpenTopic } : {})}
          >
            {navigator}
          </NavigatorHost>
        ) : null}
        <main
          aria-label={t("workspace.regions.content")}
          data-region="stack"
          tabIndex={-1}
          className="relative min-h-0 min-w-0 flex-1 overflow-hidden focus-visible:outline-none"
        >
          {children}
        </main>
      </div>
      <DropHost t={t} flow={addFlow} />
    </div>
  );
}
