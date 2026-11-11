import { appDestinationIds, type LegacyViewId } from "../../shared/app-menu";
import { destinationIds, type DestinationId, type WorkspacePlace } from "./destinations";
import { layoutConfig, tierFor, type LayoutTier } from "./layout-config";

/**
 * The shell's pure parts (design record §3, §5.1, §5.2, §12): which destination has a navigator,
 * which old view a destination hosts until its replacement lands, the custom properties the shell
 * writes from `layout-config.ts`, the title bar's columns at any window width and the order F6
 * cycles the regions in. No React and no DOM, so every rule is tested over plain numbers.
 */

/** The destinations the rail lists, in rail order; a test pins that they are exactly five (X7). */
export const railDestinations: readonly DestinationId[] = destinationIds;

/** The application menu names the same five destinations (a test compares the two lists). */
export const menuDestinationIds: readonly string[] = appDestinationIds;

/**
 * The destinations that have a navigator (Cmd-\ acts only there). The Library has a filter bar
 * and a territory bar instead; Home, the Inbox and the Map have none (design record §20.1).
 */
export const navigatorDestinations: readonly DestinationId[] = ["explore"];

export function hasNavigator(place: WorkspacePlace): boolean {
  return place !== "settings" && navigatorDestinations.includes(place);
}

/** The old views a destination can host until the card that replaces its root lands. */
export type LegacyHost = "wiki" | "library" | "inbox" | "graph";

/**
 * The old view each destination hosts until its replacement lands (D6): Explore the Wiki, the
 * Library its own view, the Inbox its screen and the Map the knowledge graph; Home has no root
 * before T148 and shows the Library, where the app started before the shell. The cards that
 * replace a root (T141, T142, T148, T149) take its entry out.
 */
export const legacyHostFor: Readonly<Record<DestinationId, LegacyHost>> = {
  home: "library",
  explore: "wiki",
  library: "library",
  inbox: "inbox",
  map: "graph"
};

/**
 * The view id each hosted old view has in `App.tsx`. None of them is a `LegacyViewId`: a view a
 * destination hosts is that destination's, never an "Old screens" item (a test pins the two apart).
 */
export const hostedViewIds = {
  wiki: "wiki",
  library: "library",
  inbox: "inbox",
  graph: "knowledgeGraph"
} as const satisfies Record<LegacyHost, string>;

/** What each destination is called in the title bar, the menu and the rail's tooltip. */
export const destinationTitleKeys = {
  home: "workspace.destinations.home",
  explore: "workspace.destinations.explore",
  library: "workspace.destinations.library",
  inbox: "workspace.destinations.inbox",
  map: "workspace.destinations.map"
} as const satisfies Record<DestinationId, string>;

/** What a legacy view is called in the rail's overflow and in the title bar. */
export const legacyTitleKeys = {
  import: "shell.navigation.import",
  search: "shell.navigation.search",
  review: "shell.navigation.review",
  jobs: "shell.navigation.jobs",
  debug: "debug.title"
} as const satisfies Record<LegacyViewId, string>;

// ---------------------------------------------------------------------------
// The title bar

/** The title bar's fixed numbers, in px (design record §5.2). */
export const titleBarMetrics = {
  /** `--top-h`: every tier. */
  height: 48,
  /** The omni trigger never grows past this. */
  omniMax: 480,
  /** The status slot never grows past this. */
  statusMax: 420,
  /** Adicionar: the main part and the 24 px chevron part. */
  addW: 132,
  /** Padding on the right of the bar; the left one is the tier's `topPl`. */
  padRight: 16
} as const;

// ---------------------------------------------------------------------------
// The custom properties

/**
 * The shell's custom properties for a window `viewportWidth` px wide: one tier of
 * `layout-config.ts`, written onto the shell's element so the stylesheet and `layout()` read the
 * same numbers (design record §4.9). Values are px strings.
 */
export function layoutCustomProperties(viewportWidth: number): Record<`--${string}`, string> {
  const tier: LayoutTier = tierFor(viewportWidth);
  const px = (value: number) => `${value}px`;
  return {
    "--rail-w": px(tier.railW),
    "--top-h": px(titleBarMetrics.height),
    "--nav-w": px(tier.navW),
    "--ctx-w": px(tier.ctxW),
    "--prev-w": px(tier.prevW),
    "--spine-w": px(tier.spineW),
    "--row-h": px(tier.rowH),
    "--ind": px(tier.ind),
    "--top-pl": px(tier.topPl),
    "--top-gap": px(tier.topGap),
    "--top-min": px(layoutConfig.topMin),
    "--omni-min": px(layoutConfig.omniMin),
    "--omni-max": px(titleBarMetrics.omniMax),
    "--status-max": px(titleBarMetrics.statusMax),
    "--name-w": px(titleBarNameWidth(tier))
  };
}

/** The destination name's column ends where the navigator does, so the omni trigger never moves. */
export function titleBarNameWidth(tier: LayoutTier): number {
  return tier.navW - tier.topPl - tier.topGap;
}

export interface TitleBarLayout {
  name: number;
  omni: number;
  status: number;
  add: number;
  /** The unused width between the omni trigger and the status slot. */
  gap: number;
}

interface Flexible {
  grow: number;
  min: number;
  max: number;
}

/** CSS flexbox's "resolve flexible lengths" for items with a zero basis, in px. */
function resolveFlex(items: readonly Flexible[], free: number): number[] {
  const sizes = items.map(() => 0);
  let active = items.map((_, index) => index);
  let remaining = free;
  while (active.length > 0) {
    const growSum = active.reduce((total, index) => total + items[index]!.grow, 0);
    const targets = active.map((index) => (remaining * items[index]!.grow) / growSum);
    let violation = 0;
    const clamped = active.map((index, at) => {
      const item = items[index]!;
      const size = Math.min(item.max, Math.max(item.min, targets[at]!));
      violation += size - targets[at]!;
      return size;
    });
    const next: number[] = [];
    active.forEach((index, at) => {
      const freezes =
        violation === 0 ||
        (violation > 0 ? clamped[at]! > targets[at]! : clamped[at]! < targets[at]!);
      if (freezes) {
        sizes[index] = clamped[at]!;
        remaining -= clamped[at]!;
      } else next.push(index);
    });
    active = next;
  }
  return sizes;
}

/**
 * The title bar's columns at a window width. The name column ends where the navigator does, so the
 * omni trigger starts at the same x on every screen; Adicionar is fixed. The omni trigger (grow 1,
 * between `omniMin` and `omniMax`) and the status slot (grow 2, up to `statusMax`) share what is
 * left, so the trigger keeps its floor and the slot truncates inside the pill, never covering it.
 * This is the twin of the stylesheet's flex rules in `TitleBar.tsx`: a test over it proves the
 * 960 px bar.
 */
export function titleBarLayout(viewportWidth: number): TitleBarLayout {
  const tier = tierFor(viewportWidth);
  const { omniMax, statusMax, addW, padRight } = titleBarMetrics;
  const name = titleBarNameWidth(tier);
  const free = Math.max(
    0,
    viewportWidth - tier.railW - tier.topPl - padRight - 3 * tier.topGap - name - addW
  );
  const [omni = layoutConfig.omniMin, status = 0] = resolveFlex(
    [
      { grow: 1, min: layoutConfig.omniMin, max: omniMax },
      { grow: 2, min: 0, max: statusMax }
    ],
    free
  );
  return { name, omni, status, add: addW, gap: Math.max(0, free - omni - status) };
}

/** The pill leaves out its "em espera" clause from the compact tier down. */
export function pillDropsWaiting(viewportWidth: number): boolean {
  return viewportWidth < layoutConfig.compactBelow;
}

// ---------------------------------------------------------------------------
// F6 regions

export const regionIds = ["rail", "titleBar", "navigator", "stack", "context"] as const;
export type RegionId = (typeof regionIds)[number];

/**
 * The region F6 (delta 1) or Shift-F6 (delta -1) moves to from `current`, over the regions that are
 * on screen: rail → top bar (omni, status slot, Adicionar) → navigator → stack → context, wrapping.
 * With no current region it starts at the first (or the last, backwards).
 */
export function nextRegion(
  present: readonly RegionId[],
  current: RegionId | null,
  delta: 1 | -1
): RegionId | null {
  const ordered = regionIds.filter((id) => present.includes(id));
  if (ordered.length === 0) return null;
  const at = current === null ? -1 : ordered.indexOf(current);
  if (at === -1) return ordered[delta === 1 ? 0 : ordered.length - 1] ?? null;
  return ordered[(at + delta + ordered.length) % ordered.length] ?? null;
}
