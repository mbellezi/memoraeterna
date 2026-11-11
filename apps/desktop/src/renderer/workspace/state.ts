import { z } from "zod";

import { objectKinds, parseObjectAddress, type ObjectKind } from "@app/domain";

import {
  destinationIds,
  destinationRoots,
  isDestinationId,
  navigatorDefaults,
  type DestinationId,
  type WorkspacePlace
} from "./destinations";
import {
  contextMode,
  layoutConfig,
  prevShowsAt,
  tierFor,
  topMinFor,
  type LayoutTier
} from "./layout-config";
import { parseAddress, parseViewAddress } from "./route";

/**
 * The workspace state and its reducer (docs/f5-decisions.md D8, D9). Pure: no React, no clock, no
 * storage. Each destination has a stack: a root surface and the panels pushed to its right, each
 * with its own history. Settings is a full surface without a stack.
 */
export type { DestinationId, WorkspacePlace };

/** An object or view address (`memora://…`). */
export type PanelAddress = string;

export interface Panel {
  id: string;
  history: PanelAddress[];
  index: number;
  width?: number;
  /** The panel body's scroll offset in px (S1). */
  scroll?: number;
}

export interface Stack {
  root: PanelAddress;
  panels: Panel[];
  /** The focused panel; -1 is the root. */
  focus: number;
  /** Closed panels, the most recent last. */
  closed: Panel[];
  /** Set by a close: the next Forward reopens the panel just closed. Any other move clears it. */
  forwardReopens?: true;
}

/** The version of the persisted shape; it names the storage key too. */
export const workspaceStateVersion = 1;

export interface WorkspaceState {
  version: typeof workspaceStateVersion;
  destination: WorkspacePlace;
  stacks: Record<DestinationId, Stack>;
  navigator: Record<DestinationId, boolean>;
  context: boolean;
  /** The local day (YYYY-MM-DD) Home was last shown on. */
  lastHomeDay: string;
  /** When Home was last opened (ISO); Home's "New" counts from it. */
  lastHomeOpenAt: string | null;
  /** The last context tab chosen per object kind (S1); a kind without one uses its default. */
  contextTab: Partial<Record<ObjectKind, ContextTabId>>;
  /** The topic Explore's navigator is hoisted to, or null. */
  hoist: string | null;
  /** The Library header's density toggle (S1). */
  density: Density;
}

/** The context panel's tabs in amendment A5's order (Option-1..6 follow it). */
export const contextTabIds = [
  "connections",
  "evidence",
  "ask",
  "mentions",
  "graph",
  "history"
] as const;
export type ContextTabId = (typeof contextTabIds)[number];
export const densities = ["comfortable", "compact"] as const;
export type Density = (typeof densities)[number];

/**
 * The tab the context panel opens on for a kind before the user picks one (design record §5.6): a
 * Source still generating opens on Ask, a ready one on Connections.
 */
export const defaultContextTabs: Readonly<Record<ObjectKind, ContextTabId>> = {
  source: "connections",
  note: "connections",
  topic: "connections",
  question: "evidence",
  entity: "ask"
};

/** The tab to show for `kind`: the last one chosen, or the kind's default. */
export function contextTabFor(
  state: Pick<WorkspaceState, "contextTab">,
  kind: ObjectKind,
  options: { sourceGenerating?: boolean } = {}
): ContextTabId {
  const chosen = state.contextTab[kind];
  if (chosen) return chosen;
  return kind === "source" && options.sourceGenerating ? "ask" : defaultContextTabs[kind];
}

export type WorkspaceAction =
  | { type: "open"; address: PanelAddress; from: number; mode: "push" | "replace" }
  | { type: "back" }
  | { type: "forward" }
  | { type: "close"; panel?: number }
  | { type: "reopen" }
  | { type: "focus"; panel: number }
  | { type: "focusNext"; delta: 1 | -1 }
  | { type: "go"; destination: WorkspacePlace }
  | { type: "toggleNavigator" }
  | { type: "toggleContext" }
  | { type: "redirect"; panel: number; to: PanelAddress }
  | { type: "resize"; panel: number; width: number }
  | { type: "homeOpened"; at: string }
  /** Onboarding's first source (D9, A6): go to Explore and push the Source. */
  | { type: "firstSource"; address: PanelAddress }
  | { type: "setContextTab"; kind: ObjectKind; tab: ContextTabId }
  | { type: "hoist"; topicId: string | null }
  | { type: "setDensity"; density: Density }
  | { type: "scroll"; panel: number; top: number };

export const workspaceLimits = {
  /** Panels per stack; a 9th evicts the leftmost panel that is not focused (D8, cal.). */
  maxPanels: 8,
  /** Closed panels kept for Reopen. */
  maxClosed: 20,
  /** Entries per panel history; the oldest go first. */
  maxHistory: 50,
  /** A stored panel width's bounds: the narrowest compact panel (layout-config.ts) and a cap. */
  minPanelWidth: Math.min(...layoutConfig.tiers.map((tier) => tier.prevW)),
  maxPanelWidth: 4096,
  /** A panel's stored scroll offset cap, in px. */
  maxScroll: 10_000_000
} as const;

export interface ReduceOptions {
  maxPanels: number;
  /** The IANA zone that defines the local day; the system zone when absent. */
  timeZone?: string;
}

/** The local calendar day of `date` as YYYY-MM-DD, in `timeZone` or the system zone. */
export function localDay(date: Date, timeZone?: string): string {
  const format = (zone: string | undefined) =>
    new Intl.DateTimeFormat("en-US", {
      ...(zone ? { timeZone: zone } : {}),
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = format(timeZone);
  } catch {
    parts = format(undefined);
  }
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function emptyStack(destination: DestinationId): Stack {
  return { root: destinationRoots[destination], panels: [], focus: -1, closed: [] };
}

/** A fresh workspace: Home, empty stacks, the default navigators and no context panel. */
export function defaultWorkspace(today: string): WorkspaceState {
  const stacks = {} as Record<DestinationId, Stack>;
  for (const destination of destinationIds) stacks[destination] = emptyStack(destination);
  return {
    version: workspaceStateVersion,
    destination: "home",
    stacks,
    navigator: { ...navigatorDefaults },
    context: false,
    lastHomeDay: today,
    lastHomeOpenAt: null,
    contextTab: {},
    hoist: null,
    density: "comfortable"
  };
}

const isTopicId = (value: string) => parseObjectAddress(`memora://topic/${value}`) !== null;

const addressSchema = z.string().refine((value) => parseAddress(value) !== null);

const panelSchema = z
  .object({
    id: z.string().min(1).max(64),
    history: z.array(addressSchema).min(1).max(workspaceLimits.maxHistory),
    index: z.number().int().min(0),
    width: z
      .number()
      .int()
      .min(workspaceLimits.minPanelWidth)
      .max(workspaceLimits.maxPanelWidth)
      .optional(),
    scroll: z.number().int().min(0).max(workspaceLimits.maxScroll).optional()
  })
  .strict()
  .refine((panel) => panel.index < panel.history.length);

const stackSchema = (destination: DestinationId) =>
  z
    .object({
      root: z.string().refine((value) => parseViewAddress(value)?.view === destination),
      panels: z.array(panelSchema).max(workspaceLimits.maxPanels),
      focus: z.number().int().min(-1),
      closed: z.array(panelSchema).max(workspaceLimits.maxClosed),
      forwardReopens: z.literal(true).optional()
    })
    .strict()
    .refine((stack) => stack.focus < stack.panels.length)
    .refine((stack) => {
      const ids = [...stack.panels, ...stack.closed].map((panel) => panel.id);
      return new Set(ids).size === ids.length;
    });

const perDestination = <T extends z.ZodType>(schema: (destination: DestinationId) => T) =>
  z
    .object(
      Object.fromEntries(
        destinationIds.map((destination) => [destination, schema(destination)])
      ) as {
        [K in DestinationId]: T;
      }
    )
    .strict();

/**
 * The persisted shape (`memora.workspace.v1`); anything else falls back to the defaults. The S1
 * fields joined the same version (nothing had shipped): a state saved without them gets their
 * defaults.
 */
export const WorkspaceStateSchema = z
  .object({
    version: z.literal(workspaceStateVersion),
    destination: z.enum([...destinationIds, "settings"]),
    stacks: perDestination(stackSchema),
    navigator: perDestination(() => z.boolean()),
    context: z.boolean(),
    lastHomeDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lastHomeOpenAt: z.string().datetime({ offset: true }).nullable(),
    contextTab: z.partialRecord(z.enum(objectKinds), z.enum(contextTabIds)).default({}),
    hoist: z.string().refine(isTopicId).nullable().default(null),
    density: z.enum(densities).default("comfortable")
  })
  .strict();

/**
 * The state to start from (the Home rule, D9): Home on first run and on the first start of each
 * local day, otherwise the last place. A persisted value that does not validate is ignored. The
 * caller saves the result once, so the day Home was shown is remembered.
 */
export function initialState(
  now: Date,
  persisted: unknown,
  options: { timeZone?: string } = {}
): WorkspaceState {
  const today = localDay(now, options.timeZone);
  const parsed = WorkspaceStateSchema.safeParse(persisted);
  if (!parsed.success) return defaultWorkspace(today);
  const state = parsed.data as WorkspaceState;
  return state.lastHomeDay === today
    ? state
    : { ...state, destination: "home", lastHomeDay: today };
}

const currentAddress = (panel: Panel): PanelAddress => panel.history[panel.index] ?? "";

/** Where `address` is open in the stack: -1 for the root, a panel index, or null. */
function findOpen(stack: Stack, address: PanelAddress): number | null {
  if (stack.root === address) return -1;
  const index = stack.panels.findIndex((panel) => currentAddress(panel) === address);
  return index === -1 ? null : index;
}

function nextPanelId(stack: Stack): string {
  let max = 0;
  for (const panel of [...stack.panels, ...stack.closed]) {
    const match = /^p(\d+)$/.exec(panel.id);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return `p${max + 1}`;
}

/** Adds panels to the closed list (the last one becomes the next to reopen) and keeps it bounded. */
function addClosed(closed: Panel[], panels: Panel[]): Panel[] {
  return [...closed, ...panels].slice(-workspaceLimits.maxClosed);
}

function boundedHistory(panel: Panel): Panel {
  const excess = panel.history.length - workspaceLimits.maxHistory;
  if (excess <= 0) return panel;
  return {
    ...panel,
    history: panel.history.slice(excess),
    index: Math.max(0, panel.index - excess)
  };
}

/** Drops the close marker: only the move right after a close may reopen. */
function settled(stack: Stack): Stack {
  if (!stack.forwardReopens) return stack;
  return { root: stack.root, panels: stack.panels, focus: stack.focus, closed: stack.closed };
}

/** Evicts the leftmost panel that is not focused while the stack holds more than `maxPanels`. */
function capped(stack: Stack, maxPanels: number): Stack {
  let { panels, focus, closed } = stack;
  while (panels.length > Math.max(1, maxPanels)) {
    const evict = panels.findIndex((_, index) => index !== focus);
    const evicted = panels[evict];
    if (evict === -1 || !evicted) break;
    panels = panels.filter((_, index) => index !== evict);
    closed = addClosed(closed, [evicted]);
    if (evict < focus) focus -= 1;
  }
  return { ...stack, panels, focus, closed };
}

function withStack(state: WorkspaceState, destination: DestinationId, stack: Stack) {
  return { ...state, stacks: { ...state.stacks, [destination]: stack } };
}

const isPanelIndex = (stack: Stack, index: number) =>
  Number.isInteger(index) && index >= 0 && index < stack.panels.length;

function open(
  state: WorkspaceState,
  action: Extract<WorkspaceAction, { type: "open" }>,
  maxPanels: number
): WorkspaceState {
  const parsed = parseAddress(action.address);
  if (!parsed) return state;
  if ("view" in parsed) {
    const place = parsed.view.view;
    // Settings is a surface, not a panel; the Settings surface reads its section itself.
    if (place === "settings")
      return state.destination === "settings" ? state : { ...state, destination: "settings" };
    // A destination's own view sets that destination's root: it never becomes a panel.
    if (isDestinationId(place)) {
      const stack = state.stacks[place];
      if (state.destination === place && stack.root === action.address && stack.focus === -1)
        return state;
      const next = withStack(state, place, {
        ...settled(stack),
        root: action.address,
        focus: -1
      });
      return { ...next, destination: place };
    }
  }
  const destination = state.destination;
  if (destination === "settings") return state;
  const stack = state.stacks[destination];
  if (action.from !== -1 && !isPanelIndex(stack, action.from)) return state;
  const already = findOpen(stack, action.address);
  if (already !== null)
    return already === stack.focus && !stack.forwardReopens
      ? state
      : withStack(state, destination, { ...settled(stack), focus: already });
  const target = stack.panels[action.from];
  if (action.mode === "replace" && target) {
    const replaced = boundedHistory({
      ...target,
      history: [...target.history.slice(0, target.index + 1), action.address],
      index: target.index + 1
    });
    const panels = stack.panels.map((panel, index) => (index === action.from ? replaced : panel));
    return withStack(state, destination, { ...settled(stack), panels, focus: action.from });
  }
  const kept = stack.panels.slice(0, action.from + 1);
  // The rightmost goes in first, so Reopen brings them back left to right.
  const dropped = stack.panels.slice(action.from + 1).reverse();
  const panel: Panel = { id: nextPanelId(stack), history: [action.address], index: 0 };
  const next = capped(
    {
      root: stack.root,
      panels: [...kept, panel],
      focus: kept.length,
      closed: addClosed(stack.closed, dropped)
    },
    maxPanels
  );
  return withStack(state, destination, next);
}

function close(stack: Stack, index: number): Stack {
  const panel = stack.panels[index];
  if (!panel) return stack;
  const focus =
    index < stack.focus ? stack.focus - 1 : index === stack.focus ? index - 1 : stack.focus;
  return {
    root: stack.root,
    panels: stack.panels.filter((_, position) => position !== index),
    focus,
    closed: addClosed(stack.closed, [panel]),
    forwardReopens: true
  };
}

/** Reopens the most recently closed panel right of the focused one, or focuses it if open. */
function reopen(stack: Stack, maxPanels: number): Stack {
  const panel = stack.closed.at(-1);
  if (!panel) return stack;
  const closed = stack.closed.slice(0, -1);
  const already = findOpen(stack, currentAddress(panel));
  if (already !== null) return { ...settled(stack), closed, focus: already };
  const at = stack.focus + 1;
  return capped(
    {
      root: stack.root,
      panels: [...stack.panels.slice(0, at), panel, ...stack.panels.slice(at)],
      focus: at,
      closed
    },
    maxPanels
  );
}

/**
 * The workspace reducer. Pure: an action that changes nothing returns `state` itself.
 *
 * - `open` pushes right of `from` (the panels beyond go to the closed list) or, with `replace`,
 *   enters the address in panel `from`'s history; an address already open is focused instead. A
 *   destination's view address sets that destination's root; a Settings address goes to Settings.
 * - `back` at a panel's first entry closes it; `forward` right after a close reopens it.
 * - A 9th panel evicts the leftmost panel that is not focused (D8).
 * - `go` changes the destination and keeps every stack.
 * - `redirect` swaps a panel's address in its history (a topic redirect), without a new entry; when
 *   the target is already open elsewhere, the redirected panel goes and the open one takes focus.
 * - `firstSource` (D9, A6) goes to Explore and pushes the Source right of its focused panel.
 * - `setContextTab`, `hoist`, `setDensity` and `scroll` remember the S1 view state.
 */
export function reduce(
  state: WorkspaceState,
  action: WorkspaceAction,
  options: ReduceOptions = { maxPanels: workspaceLimits.maxPanels }
): WorkspaceState {
  const maxPanels = options.maxPanels;
  switch (action.type) {
    case "go":
      return state.destination === action.destination
        ? state
        : { ...state, destination: action.destination };
    case "toggleContext":
      return { ...state, context: !state.context };
    case "homeOpened": {
      const at = new Date(action.at);
      if (Number.isNaN(at.getTime())) return state;
      return {
        ...state,
        lastHomeOpenAt: at.toISOString(),
        lastHomeDay: localDay(at, options.timeZone)
      };
    }
    case "open":
      return open(state, action, maxPanels);
    case "firstSource": {
      const parsed = parseAddress(action.address);
      if (!parsed || !("object" in parsed) || parsed.object.kind !== "source") return state;
      const inExplore: WorkspaceState =
        state.destination === "explore" ? state : { ...state, destination: "explore" };
      const from = inExplore.stacks.explore.focus;
      return open(
        inExplore,
        { type: "open", address: action.address, from, mode: "push" },
        maxPanels
      );
    }
    case "setContextTab": {
      if (!objectKinds.includes(action.kind) || !contextTabIds.includes(action.tab)) return state;
      if (state.contextTab[action.kind] === action.tab) return state;
      return { ...state, contextTab: { ...state.contextTab, [action.kind]: action.tab } };
    }
    case "hoist": {
      if (action.topicId !== null && !isTopicId(action.topicId)) return state;
      return state.hoist === action.topicId ? state : { ...state, hoist: action.topicId };
    }
    case "setDensity":
      return !densities.includes(action.density) || state.density === action.density
        ? state
        : { ...state, density: action.density };
    default:
      break;
  }

  const destination = state.destination;
  if (destination === "settings") return state;
  const stack = state.stacks[destination];
  const focused = stack.panels[stack.focus];
  const update = (next: Stack) => withStack(state, destination, next);

  switch (action.type) {
    case "toggleNavigator":
      return {
        ...state,
        navigator: { ...state.navigator, [destination]: !state.navigator[destination] }
      };
    case "back": {
      if (!focused) return state;
      if (focused.index === 0) return update(close(stack, stack.focus));
      const panels = stack.panels.map((panel, index) =>
        index === stack.focus ? { ...panel, index: panel.index - 1 } : panel
      );
      return update({ ...settled(stack), panels });
    }
    case "forward": {
      if (stack.forwardReopens && stack.closed.length > 0) return update(reopen(stack, maxPanels));
      if (!focused || focused.index >= focused.history.length - 1) return state;
      const panels = stack.panels.map((panel, index) =>
        index === stack.focus ? { ...panel, index: panel.index + 1 } : panel
      );
      return update({ ...settled(stack), panels });
    }
    case "close": {
      const index = action.panel ?? stack.focus;
      return isPanelIndex(stack, index) ? update(close(stack, index)) : state;
    }
    case "reopen":
      return stack.closed.length > 0 ? update(reopen(stack, maxPanels)) : state;
    case "focus": {
      if (action.panel !== -1 && !isPanelIndex(stack, action.panel)) return state;
      if (action.panel === stack.focus && !stack.forwardReopens) return state;
      return update({ ...settled(stack), focus: action.panel });
    }
    case "focusNext": {
      if (stack.panels.length === 0) return state;
      const positions = stack.panels.length + 1;
      const position = (stack.focus + 1 + action.delta + positions) % positions;
      return update({ ...settled(stack), focus: position - 1 });
    }
    case "redirect": {
      const panel = stack.panels[action.panel];
      if (!panel || !isPanelIndex(stack, action.panel) || !parseAddress(action.to)) return state;
      const from = currentAddress(panel);
      if (from === action.to) return state;
      const existing = findOpen(stack, action.to);
      if (existing !== null) {
        // The target is open already: an address is never open twice (D8), so this panel goes.
        const panels = stack.panels.filter((_, index) => index !== action.panel);
        const shift = (index: number) => (index > action.panel ? index - 1 : index);
        const focus = stack.focus === action.panel ? shift(existing) : shift(stack.focus);
        return update({ ...settled(stack), panels, focus });
      }
      const redirected = {
        ...panel,
        history: panel.history.map((address) => (address === from ? action.to : address))
      };
      return update({
        ...stack,
        panels: stack.panels.map((entry, index) => (index === action.panel ? redirected : entry))
      });
    }
    case "scroll": {
      const panel = stack.panels[action.panel];
      if (!panel || !isPanelIndex(stack, action.panel) || !Number.isFinite(action.top))
        return state;
      const scroll = Math.min(workspaceLimits.maxScroll, Math.max(0, Math.round(action.top)));
      if ((panel.scroll ?? 0) === scroll) return state;
      return update({
        ...stack,
        panels: stack.panels.map((entry, index) =>
          index === action.panel ? { ...entry, scroll } : entry
        )
      });
    }
    case "resize": {
      const panel = stack.panels[action.panel];
      if (!panel || !isPanelIndex(stack, action.panel) || !Number.isFinite(action.width))
        return state;
      const width = Math.min(
        workspaceLimits.maxPanelWidth,
        Math.max(workspaceLimits.minPanelWidth, Math.round(action.width))
      );
      if (panel.width === width) return state;
      return update({
        ...stack,
        panels: stack.panels.map((entry, index) =>
          index === action.panel ? { ...entry, width } : entry
        )
      });
    }
  }
  return state;
}

export interface LayoutChrome {
  /** The destination's navigator is shown. */
  navigator: boolean;
  /** The context panel is shown: docked from 1280 px, otherwise its 40 px strip. */
  context: boolean;
}

export type LayoutMode = "full" | "compact" | "spine";
export interface LayoutItem {
  /** The panel index; -1 is the root surface. */
  panel: number;
  mode: LayoutMode;
  /** A spine drawn inside the one "+N" spine at the far left. */
  merged?: true;
}

/** The stack's width: the window less the rail, the navigator when shown and the context panel. */
export function stackWidth(
  viewportWidth: number,
  chrome: LayoutChrome,
  tier: LayoutTier = tierFor(viewportWidth)
): number {
  const context = !chrome.context
    ? 0
    : contextMode(viewportWidth) === "docked"
      ? tier.ctxW
      : layoutConfig.contextStripW;
  return Math.max(0, viewportWidth - tier.railW - (chrome.navigator ? tier.navW : 0) - context);
}

/**
 * How each item of a stack draws in a `viewportWidth` px window (D8 as amended by A1; design
 * record §3 and §8). The root counts as item -1.
 *
 * - The focused item is the top panel, `full`, and keeps at least `topMin` (568, 552 at a 960-999
 *   px window) where the rest allows it.
 * - The item left of it is `compact` when the stack is at least `prevShowsAt` (848 px) wide and the
 *   top keeps its floor beside it; otherwise it is a spine. Every other item is a spine.
 * - Spines beyond `maxSpines` (6) merge, the leftmost first, into one "+N" spine at the far left
 *   (`merged: true`); while the top would still fall below its floor, older spines merge too.
 */
export function layout(
  stack: Stack,
  viewportWidth: number,
  topMin: number = topMinFor(viewportWidth),
  chrome: LayoutChrome = { navigator: true, context: true }
): LayoutItem[] {
  const tier = tierFor(viewportWidth);
  const width = stackWidth(viewportWidth, chrome, tier);
  const items = [-1, ...stack.panels.map((_, index) => index)];
  const top = Math.min(Math.max(stack.focus, -1), stack.panels.length - 1);
  const spinesWith = (compact: boolean) =>
    items.filter((item) => item !== top && !(compact && item === top - 1));
  const drawn = (spines: number, merged: number) => spines - merged + (merged > 0 ? 1 : 0);
  const topWidth = (compact: boolean, merged: number) =>
    width - (compact ? tier.prevW : 0) - drawn(spinesWith(compact).length, merged) * tier.spineW;
  const beyondMax = (compact: boolean) =>
    Math.max(0, spinesWith(compact).length - layoutConfig.maxSpines);

  // 1. The previous panel folds to a spine first.
  const compact =
    top > -1 && width >= prevShowsAt(tier) && topWidth(true, beyondMax(true)) >= topMin;
  const spines = spinesWith(compact);
  // 2. Spines beyond six merge; older ones merge while the top is below its floor.
  let merged = beyondMax(compact);
  while (topWidth(compact, merged) < topMin && drawn(spines.length, merged) > 1)
    merged = merged === 0 ? 2 : merged + 1;
  const mergedItems = new Set(spines.slice(0, merged));

  return items.map((panel): LayoutItem => {
    if (panel === top) return { panel, mode: "full" };
    if (compact && panel === top - 1) return { panel, mode: "compact" };
    return mergedItems.has(panel)
      ? { panel, mode: "spine", merged: true }
      : { panel, mode: "spine" };
  });
}
