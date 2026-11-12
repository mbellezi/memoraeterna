import {
  useCallback,
  useEffect,
  useState,
  type ComponentType,
  type Dispatch,
  type ReactNode
} from "react";
import { objectKinds, parseObjectAddress, type ObjectKind, type ObjectSummary } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Skeleton } from "../components/ui/skeleton";
import { useAppEvent } from "../lib/app-events";
import { cn } from "../lib/cn";
import { destinationIds, type DestinationId } from "./destinations";
import { PanelFrame, type PanelLoadState } from "./PanelFrame";
import { destinationGlyphs } from "./Rail";
import type { RibbonPlace } from "./PathRibbon";
import { destinationTitleKeys } from "./shell-model";
import {
  layout,
  type Density,
  type LayoutChrome,
  type Panel,
  type PanelAddress,
  type Stack,
  type WorkspaceAction,
  type WorkspaceState
} from "./state";
import { layoutConfig } from "./layout-config";
import { panelStackStyles } from "./panel-stack-styles";

/**
 * The panel stack host (design record §3, §5.4, §5.5, §8; D8 as amended by A1). Each destination
 * has a stack: a root surface and the panels pushed to its right. The host draws the active
 * destination's stack as `layout()` says (the top panel full, the previous one compact when the
 * stack is at least 848 px wide, the others 40 px spines, more than six spines merged into "+N"),
 * keeps every destination mounted while hidden, and reports the top item's state on its own frame.
 *
 * Panels register by file: each `panels/<kind>.panel.tsx` exports `kind`, `match`, `title` and
 * `Component`, and the host finds them with `import.meta.glob`; there is no shared registry to edit.
 */

/**
 * How a panel's object is placed, as the panel knows it: a Source still being processed or a
 * Question still streaming is `tentative…`, a finished Question is `byCitations`. `choose` is the
 * panel's "Escolher lugar" for an object with no place; absent, the ribbon only says "Sem lugar".
 */
export interface PanelPlace {
  place: RibbonPlace;
  choose?: () => void;
}

/** What the frame draws of a panel's place. */
interface PanelPlaceShown {
  place: RibbonPlace;
  canChoose: boolean;
}

/** What the host gives a panel's component. */
export interface PanelProps {
  t: Translator;
  address: PanelAddress;
  /** `full` on top; `compact` as the previous panel (its list with the current row marked). */
  mode: "full" | "compact";
  /** The panel is on screen; a hidden one loads nothing and listens to nothing. */
  active: boolean;
  /** The panel's own load state; the frame writes it as `data-state`. */
  onState: (state: PanelLoadState) => void;
  /** How the panel's object is placed; the frame's path ribbon draws it ("placed" until told). */
  onPlace: (place: PanelPlace) => void;
  /** Opens an address beside this panel, or in it ("abrir neste painel", Option-click). */
  onOpen: (address: PanelAddress, options?: { replace?: boolean }) => void;
  /** For a root in its compact form: the address of the panel it opened (`aria-current`). */
  current?: PanelAddress;
  /** For a root: the density kept per device (the Library header's toggle, D18) and how to change it. */
  density?: Density;
  onDensity?: (density: Density) => void;
  /** For a root: the shell's Add command (Cmd-N), for an empty destination that offers it. */
  onAdd?: () => void;
}

/** A panel kind, as its `*.panel.tsx` module exports it. */
export interface PanelModule {
  /** The surface id the frame reports. */
  kind: string;
  match: (address: PanelAddress) => boolean;
  /** The title for the header's name and the spine; `summary` is null for a view address. */
  title: (summary: ObjectSummary | null, t: Translator) => string;
  Component: ComponentType<PanelProps>;
  /**
   * A root shared by several destinations is mounted once under this key (the old Library, which
   * Home shows until its own root lands). Absent, each destination's root is its own.
   */
  rootKey?: (address: PanelAddress) => string;
  /** A root with no compact form draws as a spine where it would be the previous panel. */
  compact?: false;
}

const isPanelModule = (value: unknown): value is PanelModule => {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Partial<PanelModule>;
  return (
    typeof module.kind === "string" &&
    typeof module.match === "function" &&
    typeof module.title === "function" &&
    (typeof module.Component === "function" || typeof module.Component === "object")
  );
};

/**
 * The panel modules of a glob (`import.meta.glob(..., { eager: true })`), in path order. A file
 * that does not export the four parts is a programming error and fails loudly.
 */
export function registerPanels(modules: Readonly<Record<string, unknown>>): PanelModule[] {
  return Object.keys(modules)
    .sort()
    .map((path) => {
      const module = modules[path];
      if (!isPanelModule(module))
        throw new Error(`${path} must export kind, match, title and Component`);
      return module;
    });
}

/** The first registered panel that takes the address, or null. */
export function matchPanel(
  registry: readonly PanelModule[],
  address: PanelAddress
): PanelModule | null {
  return registry.find((module) => module.match(address)) ?? null;
}

/** Every `panels/*.panel.tsx`, found at build time. */
export const panelRegistry: readonly PanelModule[] = registerPanels(
  import.meta.glob(["./panels/*.panel.tsx", "./destinations/*/*.panel.tsx"], { eager: true })
);

// ---------------------------------------------------------------------------
// The view model

export type StackItemMode = "full" | "compact" | "spine";

export interface StackItemView {
  /** The panel index; -1 is the root surface. */
  panel: number;
  mode: StackItemMode;
  /** Left of the top panel (the trail) or right of it (the forward trail). */
  side: "left" | "right";
  /** Drawn inside the one "+N" spine at the far left. */
  merged: boolean;
}

export interface StackView {
  items: StackItemView[];
  /** The merged items left of the top, oldest first, for the "+N · older" spine and its list. */
  merged: number[];
  /** The merged items right of the top, nearest first, for the "+N · ahead" spine beside it. */
  mergedAhead: number[];
  /** The top item: the focused panel, or -1 for the root. */
  top: number;
}

/**
 * How a stack draws in a window `viewportWidth` px wide, from `layout()` (the one source of the
 * numbers): every item's mode and side, and which ones the "+N" spines hold. `noCompact` lists the
 * items that have no compact form (they draw as their spine instead); in focus mode (`focusMode`)
 * no item does, so the sheet stands beside spines only (design record §3, §16 `#note`).
 *
 * `layout()` merges the leftmost spines. When the root is the top, those are the panels just ahead
 * of it, so the merged items split by side: the older ones go into the "+N · older" spine at the
 * far left, the ones ahead into a "+N · ahead" spine right of the top, before the forward spines
 * they precede, and the trail stays in order. A side that would merge a single item into a "+1"
 * spine, which saves no room, merges the next spine with it.
 */
export function stackView(
  stack: Stack,
  viewportWidth: number,
  chrome: LayoutChrome,
  noCompact: ReadonlySet<number> = new Set(),
  focusMode = false
): StackView {
  const top = Math.min(Math.max(stack.focus, -1), stack.panels.length - 1);
  const laid = layout(stack, viewportWidth, undefined, chrome).map((item): StackItemView => ({
    panel: item.panel,
    mode: item.mode === "compact" && (focusMode || noCompact.has(item.panel)) ? "spine" : item.mode,
    side: item.panel > top ? "right" : "left",
    merged: item.merged === true
  }));
  // The spines of each side in index order; layout() merges a prefix of all of them.
  const left = laid.filter((item) => item.side === "left" && item.mode === "spine");
  const right = laid.filter((item) => item.side === "right" && item.mode === "spine");
  // A "+1" spine would save nothing: one more merges with it, or it stays its own spine.
  const pair = (count: number, spines: readonly StackItemView[]) =>
    count === 1 ? (spines.length >= 2 ? 2 : 0) : count;
  const split = (merged: number): [number, number] => {
    const olderPart = Math.min(merged, left.length);
    return [pair(olderPart, left), pair(merged - olderPart, right)];
  };
  let merged = laid.filter((item) => item.merged).length;
  let [olderCount, aheadCount] = split(merged);
  // A previous panel drawn as its spine (focus mode) may pass six spines: the next ones merge.
  while (
    left.length + right.length - olderCount - aheadCount > layoutConfig.maxSpines &&
    merged < left.length + right.length
  ) {
    merged += 1;
    [olderCount, aheadCount] = split(merged);
  }
  const older = new Set(left.slice(0, olderCount).map((item) => item.panel));
  const ahead = new Set(right.slice(0, aheadCount).map((item) => item.panel));
  const items = laid.map((item) => ({
    ...item,
    merged: older.has(item.panel) || ahead.has(item.panel)
  }));
  return { items, merged: [...older], mergedAhead: [...ahead], top };
}

// ---------------------------------------------------------------------------
// Titles

const objectKindWord: Record<ObjectKind, MessageKey> = {
  source: "objects.kinds.source",
  note: "objects.kinds.note",
  topic: "objects.kinds.topic",
  question: "objects.kinds.question",
  entity: "objects.kinds.entity"
};

/** The object kind of an address, or null for a view address. */
export function addressKind(address: PanelAddress): ObjectKind | null {
  const parsed = parseObjectAddress(address);
  return parsed && objectKinds.includes(parsed.kind) ? parsed.kind : null;
}

/**
 * The words of a spine: the kind word and, once the object's title is read, `kind · title`. A read
 * that failed keeps the kind word and adds a quiet dash, so a sighted person sees a title is
 * missing; the spine's label already says "title unavailable" in words.
 */
export function SpineText({
  kindWord,
  title,
  unavailable
}: {
  kindWord: string;
  title: string;
  unavailable: boolean;
}) {
  if (title !== "")
    return (
      <>
        <span className="panel-stack__spine-kind">{kindWord} · </span>
        {title}
      </>
    );
  return unavailable ? (
    <>
      {kindWord}
      <span aria-hidden="true" className="panel-stack__spine-kind">
        {" · —"}
      </span>
    </>
  ) : (
    <>{kindWord}</>
  );
}

/** The titles the spines show, and how their read went. */
interface Summaries {
  summaries: ReadonlyMap<string, ObjectSummary>;
  status: "loading" | "error" | "ready";
}

/** The summaries of the object panels of a stack, in one `resolveMany` per change of the set. */
function useSummaries(addresses: readonly string[], active: boolean): Summaries {
  const [summaries, setSummaries] = useState<ReadonlyMap<string, ObjectSummary>>(new Map());
  // The set the last read settled for, and whether it failed: a set not settled yet is loading.
  const [settled, setSettled] = useState<{ key: string; failed: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const key = [...new Set(addresses.filter((address) => addressKind(address) !== null))]
    .sort()
    .join("\n");
  useEffect(() => {
    if (!active || key === "") return undefined;
    const objects = typeof window === "undefined" ? undefined : window.app?.objects;
    if (!objects?.resolveMany) return undefined;
    let live = true;
    objects
      .resolveMany({ addresses: key.split("\n") })
      .then((result) => {
        if (!live) return;
        setSummaries(new Map(Object.entries(result.items)));
        setSettled({ key, failed: false });
      })
      .catch(() => {
        // A failed re-read keeps the titles that are shown.
        if (live) setSettled((current) => (current?.key === key ? current : { key, failed: true }));
      });
    return () => {
      live = false;
    };
  }, [key, active, attempt]);
  // A renamed object shows its new title on its spine.
  useAppEvent("object.changed", () => setAttempt((value) => value + 1), active && key !== "");
  const status = settled?.key !== key ? "loading" : settled.failed ? "error" : "ready";
  return { summaries, status };
}

// ---------------------------------------------------------------------------
// The host

export interface PanelStackProps {
  t: Translator;
  workspace: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  /** The window's width, for `layout()`. */
  viewportWidth: number;
  /** What the shell shows beside the stack: the navigator and the context panel. */
  chrome: LayoutChrome;
  /** The stack is on screen (Settings or an old screen covers it otherwise). */
  shown?: boolean;
  /** Focus mode (⌘⇧F): the sheet beside spines, its content centred; Esc leaves it. */
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** The shell's Add command, given to the roots (the empty Library offers it). */
  onAdd?: () => void;
  /** The panel modules; the files of `panels/` by default (a screen or a test passes its own). */
  registry?: readonly PanelModule[];
}

const itemKey = (destination: DestinationId, panel: Panel) => `${destination}:${panel.id}`;
const addressOf = (panel: Panel): PanelAddress => panel.history[panel.index] ?? "";

interface ItemContext {
  destination: DestinationId;
  stack: Stack;
  active: boolean;
}

export function PanelStack({
  t,
  workspace,
  dispatch,
  viewportWidth,
  chrome,
  shown = true,
  focusMode = false,
  onToggleFocusMode,
  onAdd,
  registry = panelRegistry
}: PanelStackProps) {
  const place = workspace.destination;
  const current: DestinationId | null = place === "settings" ? null : place;
  const [states, setStates] = useState<ReadonlyMap<string, PanelLoadState>>(new Map());
  // What each panel says of its place. Its "Escolher lugar" is kept aside (one map for the host's
  // life), so a new callback from a panel draws nothing again.
  const [places, setPlaces] = useState<ReadonlyMap<string, PanelPlaceShown>>(new Map());
  const [choosers] = useState(() => new Map<string, () => void>());
  const reportPlace = useCallback(
    (key: string, report: PanelPlace) => {
      if (report.choose) choosers.set(key, report.choose);
      else choosers.delete(key);
      const shown: PanelPlaceShown = {
        place: report.place,
        canChoose: report.choose !== undefined
      };
      setPlaces((map) => {
        const known = map.get(key);
        if (known && known.place === shown.place && known.canChoose === shown.canChoose) return map;
        const next = new Map(map);
        next.set(key, shown);
        return next;
      });
    },
    [choosers]
  );
  const report = useCallback((key: string, state: PanelLoadState) => {
    setStates((map) => {
      if (map.get(key) === state) return map;
      const next = new Map(map);
      next.set(key, state);
      return next;
    });
  }, []);

  const moduleFor = useCallback(
    (address: PanelAddress) => matchPanel(registry, address),
    [registry]
  );

  // Roots: one element per root key, so a root two destinations share is mounted once.
  const rootKeyOf = (destination: DestinationId) => {
    const address = workspace.stacks[destination].root;
    return moduleFor(address)?.rootKey?.(address) ?? `root:${destination}`;
  };
  const rootKeys = destinationIds.map(rootKeyOf);
  const activeRootKey = current ? rootKeyOf(current) : null;

  const activeStack = current ? workspace.stacks[current] : null;
  const noCompact = new Set<number>();
  if (activeStack && moduleFor(activeStack.root)?.compact === false) noCompact.add(-1);
  const view: StackView = activeStack
    ? stackView(activeStack, viewportWidth, chrome, noCompact, focusMode)
    : { items: [], merged: [], mergedAhead: [], top: -1 };
  const { summaries, status: titlesStatus } = useSummaries(
    activeStack ? activeStack.panels.map(addressOf) : [],
    shown && activeStack !== null
  );

  // The stack's state is its top item's.
  const topKey =
    activeStack === null
      ? null
      : view.top === -1
        ? (activeRootKey as string)
        : itemKey(current as DestinationId, activeStack.panels[view.top] as Panel);
  const stackState: PanelLoadState = (topKey ? states.get(topKey) : undefined) ?? "loading";

  // Esc leaves focus mode (a dialog or a menu takes Esc first and stops it).
  useEffect(() => {
    if (!focusMode || !onToggleFocusMode || !shown) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      onToggleFocusMode();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [focusMode, onToggleFocusMode, shown]);

  const titleOf = (address: PanelAddress): string => {
    const module = moduleFor(address);
    const summary = summaries.get(address) ?? null;
    // Not read yet (or the read failed): the kind word stands alone, never "Untitled".
    if (addressKind(address) !== null && summary === null) return "";
    const title = module ? module.title(summary, t) : (summary?.title ?? "");
    return title.trim() === "" ? t("panelFrame.untitled") : title;
  };
  const kindWordOf = (address: PanelAddress): string => {
    const kind = addressKind(address);
    if (kind) return t(objectKindWord[kind]);
    return moduleFor(address)?.title(null, t) ?? "";
  };
  const rootTitle = (destination: DestinationId) => t(destinationTitleKeys[destination]);

  const openFrom = (from: number) => (address: PanelAddress, options?: { replace?: boolean }) =>
    dispatch({ type: "open", address, from, mode: options?.replace ? "replace" : "push" });

  // --- Spines ---------------------------------------------------------------------------------
  const spineFor = (
    destination: DestinationId,
    stack: Stack,
    item: StackItemView,
    twin = false
  ) => {
    const isRoot = item.panel === -1;
    const panel = isRoot ? null : (stack.panels[item.panel] as Panel);
    const address = panel ? addressOf(panel) : stack.root;
    const kind = addressKind(address);
    const kindWord = isRoot ? rootTitle(destination) : kindWordOf(address);
    const title = isRoot ? "" : titleOf(address);
    // An object whose title is not read yet shows a bar after its kind word; one whose read failed
    // says so in its name.
    const pending = !isRoot && kind !== null && title === "" ? titlesStatus : "ready";
    const label =
      pending === "error"
        ? t("panelFrame.reopenSpineUnavailable", { values: { kind: kindWord } })
        : isRoot || title === ""
          ? t("panelFrame.reopenRoot", { values: { title: kindWord } })
          : t(item.side === "right" ? "panelFrame.forwardSpine" : "panelFrame.reopenSpine", {
              values: { kind: kindWord, title }
            });
    const RootGlyph = isRoot ? destinationGlyphs[destination] : null;
    return (
      <button
        key={`${twin ? "twin" : "spine"}:${isRoot ? "root" : (panel as Panel).id}`}
        type="button"
        className="panel-stack__spine"
        data-side={item.side}
        data-prev-twin={twin ? "" : undefined}
        aria-label={label}
        title={label}
        onClick={() => dispatch({ type: "focus", panel: item.panel })}
      >
        {kind ? (
          <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
        ) : RootGlyph ? (
          <RootGlyph aria-hidden="true" className="size-4 flex-none text-secondary-foreground" />
        ) : null}
        <span
          className="panel-stack__spine-text"
          data-pending={pending === "loading" ? "" : undefined}
        >
          <SpineText
            kindWord={kindWord}
            title={isRoot ? "" : title}
            unavailable={pending === "error"}
          />
        </span>
        {pending === "loading" ? <Skeleton className="h-16 w-3 flex-none" /> : null}
      </button>
    );
  };

  const moreSpine = (
    destination: DestinationId,
    stack: Stack,
    merged: readonly number[],
    side: StackItemView["side"] = "left"
  ) => {
    const copy =
      side === "left"
        ? ({
            open: "panelFrame.olderOpen",
            list: "panelFrame.olderList",
            word: "panelFrame.older"
          } as const)
        : ({
            open: "panelFrame.aheadOpen",
            list: "panelFrame.aheadList",
            word: "panelFrame.ahead"
          } as const);
    const names = merged.map((index) =>
      index === -1
        ? rootTitle(destination)
        : `${kindWordOf(addressOf(stack.panels[index] as Panel))}: ${titleOf(addressOf(stack.panels[index] as Panel))}`
    );
    const label = t(copy.open, {
      values: { count: merged.length, titles: names.join("; ") }
    });
    return (
      <Popover key={`more:${side}`}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="panel-stack__spine"
            data-side={side}
            aria-label={label}
            title={label}
          >
            <span className="panel-stack__spine-count">+{merged.length}</span>
            <span className="panel-stack__spine-text">
              <span className="panel-stack__spine-kind">{t(copy.word)}</span>
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side={side === "left" ? "right" : "left"}
          align="start"
          className="w-72 p-1"
        >
          <p className="m-0 px-2 pt-1.5 pb-1 text-xs font-semibold text-secondary-foreground">
            {t(copy.list, { values: { count: merged.length } })}
          </p>
          <ul className="m-0 grid list-none gap-0.5 p-0">
            {merged.map((index, at) => {
              const address = index === -1 ? stack.root : addressOf(stack.panels[index] as Panel);
              const kind = index === -1 ? null : addressKind(address);
              return (
                <li key={index}>
                  <button
                    type="button"
                    onClick={() => dispatch({ type: "focus", panel: index })}
                    className={cn(
                      "flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                      "text-foreground hover:bg-surface-hover focus-visible:outline-2",
                      "focus-visible:outline-offset-[-2px] focus-visible:outline-accent"
                    )}
                  >
                    {kind ? (
                      <ObjectKindGlyph
                        kind={kind}
                        size={14}
                        className={objectKindTextClass[kind]}
                      />
                    ) : null}
                    <span className="min-w-0 truncate">{names[at]}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
    );
  };

  // --- Panels -----------------------------------------------------------------------------------
  const panelItem = (
    context: ItemContext,
    panel: Panel,
    index: number,
    item: StackItemView | null
  ) => {
    const { destination, stack, active } = context;
    const address = addressOf(panel);
    const module = moduleFor(address);
    const key = itemKey(destination, panel);
    const mode = item?.mode ?? "spine";
    const drawn = item !== null && !item.merged && mode !== "spine";
    const onScreen = active && drawn;
    const shownPlace = places.get(key);
    if (!module) return null;
    const Component = module.Component;
    return (
      <div
        key={key}
        className="panel-stack__item"
        data-mode={drawn ? mode : "spine"}
        hidden={!drawn || !active}
      >
        {drawn ? (
          <PanelFrame
            t={t}
            surface={module.kind}
            address={address}
            kind={addressKind(address)}
            kindLabel={kindWordOf(address)}
            title={titleOf(address)}
            mode={mode === "compact" ? "compact" : "full"}
            top={index === stack.focus}
            state={states.get(key) ?? "loading"}
            active={onScreen}
            canBack={panel.index > 0}
            canForward={panel.index < panel.history.length - 1}
            onBack={() => {
              dispatch({ type: "focus", panel: index });
              dispatch({ type: "back" });
            }}
            onForward={() => {
              dispatch({ type: "focus", panel: index });
              dispatch({ type: "forward" });
            }}
            onClose={() => dispatch({ type: "close", panel: index })}
            onFocus={() => dispatch({ type: "focus", panel: index })}
            {...(shownPlace ? { ribbonPlace: shownPlace.place } : {})}
            {...(shownPlace?.canChoose ? { onChoosePlace: () => choosers.get(key)?.() } : {})}
            focusMode={focusMode}
            {...(onToggleFocusMode ? { onToggleFocusMode } : {})}
            onOpen={openFrom(index)}
            {...(panel.scroll !== undefined ? { scroll: panel.scroll } : {})}
            onScrollEnd={(top) => dispatch({ type: "scroll", panel: index, top })}
          >
            <Component
              t={t}
              address={address}
              mode={mode === "compact" ? "compact" : "full"}
              active={onScreen}
              onState={(state) => report(key, state)}
              onPlace={(place) => reportPlace(key, place)}
              onOpen={openFrom(index)}
              {...(mode === "compact" && stack.panels[index + 1]
                ? { current: addressOf(stack.panels[index + 1] as Panel) }
                : {})}
            />
          </PanelFrame>
        ) : null}
      </div>
    );
  };

  // The roots, each mounted once and shown where its destination's stack draws it.
  const rootItems = [...new Set(rootKeys)].map((key) => {
    const owner = destinationIds[rootKeys.indexOf(key)] as DestinationId;
    const destination = current && activeRootKey === key ? current : owner;
    const stack = workspace.stacks[destination];
    const module = moduleFor(stack.root);
    const item = activeRootKey === key ? view.items.find((entry) => entry.panel === -1) : null;
    const mode = item?.mode ?? "full";
    const drawn = item !== null && item !== undefined && !item.merged && mode !== "spine";
    const onScreen = shown && drawn;
    if (!module) return null;
    const Component = module.Component;
    const next = stack.panels[0];
    return (
      <div
        key={key}
        className="panel-stack__item"
        data-mode={drawn ? mode : "spine"}
        data-root=""
        hidden={!drawn}
      >
        <Component
          t={t}
          address={stack.root}
          mode={mode === "compact" ? "compact" : "full"}
          active={onScreen}
          onState={(state) => report(key, state)}
          onPlace={(place) => reportPlace(key, place)}
          onOpen={openFrom(-1)}
          density={workspace.density}
          onDensity={(density) => dispatch({ type: "setDensity", density })}
          {...(onAdd ? { onAdd } : {})}
          {...(mode === "compact" && next ? { current: addressOf(next) } : {})}
        />
      </div>
    );
  });

  // The active destination's spines, in their places around the drawn items.
  const before: ReactNode[] = [];
  const after: ReactNode[] = [];
  if (current && activeStack) {
    if (view.merged.length > 0) before.push(moreSpine(current, activeStack, view.merged));
    if (view.mergedAhead.length > 0)
      after.push(moreSpine(current, activeStack, view.mergedAhead, "right"));
    for (const item of view.items) {
      if (item.merged) continue;
      if (item.mode === "spine")
        (item.side === "right" ? after : before).push(spineFor(current, activeStack, item));
      else if (item.mode === "compact") before.push(spineFor(current, activeStack, item, true));
    }
  }

  // Drawn order: the "+N" spine, the left spines, the root, the panels, the "+N" spine of the
  // panels ahead, the forward spines. A spine left of the root is impossible (the root is the
  // first item), so the left spines all follow it when the root is drawn; when it is a spine
  // itself, it is among them.
  const rootDrawn = view.items.some(
    (item) => item.panel === -1 && item.mode !== "spine" && !item.merged
  );
  const leftOfRoot = rootDrawn ? before.slice(0, view.merged.length > 0 ? 1 : 0) : before;
  const rightOfRoot = rootDrawn ? before.slice(view.merged.length > 0 ? 1 : 0) : [];

  return (
    <div
      data-surface="panel-stack"
      data-state={stackState}
      aria-label={t("panelFrame.stackLabel")}
      role="group"
      hidden={!shown}
      className="h-full min-h-0 min-w-0"
    >
      <style href="memora-panel-stack" precedence="default">
        {panelStackStyles}
      </style>
      <div className="panel-stack" data-focus-mode={focusMode ? "" : undefined}>
        {leftOfRoot}
        {rootItems}
        {rightOfRoot}
        {destinationIds.map((destination) => {
          const stack = workspace.stacks[destination];
          const active = shown && destination === current;
          // A hidden destination keeps the panels it draws mounted, so it comes back as it was.
          const layoutItems =
            destination === current ? view.items : stackView(stack, viewportWidth, chrome).items;
          return stack.panels.map((panel, index) =>
            panelItem(
              { destination, stack, active },
              panel,
              index,
              layoutItems.find((entry) => entry.panel === index) ?? null
            )
          );
        })}
        {after}
      </div>
    </div>
  );
}
