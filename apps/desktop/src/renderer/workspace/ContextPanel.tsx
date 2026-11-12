import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent
} from "react";
import { ChevronDown, PanelRight } from "lucide-react";
import type { ObjectLocateResult } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph } from "../components/glyphs";
import { EmptyState } from "../components/ui/empty-state";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { Skeleton } from "../components/ui/skeleton";
import { Tooltip } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { useOverflowLevel } from "../lib/use-overflow-level";
import {
  resolveTab,
  stripParts,
  tabForKey,
  tabLabelKeys,
  tabRow,
  tabShortcut,
  tabSlots,
  type FocusedObject
} from "./context-model";
import type { ContextTabProps } from "./context/context-parts";
import { useLocate } from "./context/context-reads";
import { ObjectLink } from "./ObjectLink";
import type { PanelLoadState } from "./PanelFrame";
import { ribbonSegments } from "./PathRibbon";
import type { ContextTabId } from "./state";

/**
 * The context panel (design record §5.6; D31 as amended by A2, A3, A5): what surrounds the object
 * in the focused panel. A row of worded tabs (three shown, the rest under "Mais", a chosen "Mais"
 * tab taking the third slot), a locate header that says where the object is and what cites it, and
 * the tab's body. Docked from 1280 px; below that a 40 px strip with "Contexto · Conexões · 5"
 * written top to bottom, which opens a 304 px overlay over the top panel's right edge.
 *
 * Tabs register by file: each `context/*-tab.tsx` exports `tab` and `Component`, and the host finds
 * them with `import.meta.glob`, so a later tab (History, Ask) is a new file and no edit here.
 */

/** A tab module, as its `context/*-tab.tsx` file exports it. */
export interface ContextTabModule {
  tab: ContextTabId;
  Component: ComponentType<ContextTabProps>;
}

const isTabModule = (value: unknown): value is ContextTabModule => {
  if (typeof value !== "object" || value === null) return false;
  const module = value as Partial<ContextTabModule>;
  return (
    typeof module.tab === "string" &&
    (typeof module.Component === "function" || typeof module.Component === "object")
  );
};

/** The tab modules of a glob, in path order; a file that does not export the two parts fails loudly. */
export function registerContextTabs(
  modules: Readonly<Record<string, unknown>>
): ContextTabModule[] {
  return Object.keys(modules)
    .sort()
    .map((path) => {
      const module = modules[path];
      if (!isTabModule(module)) throw new Error(`${path} must export tab and Component`);
      return module;
    });
}

/** Every `context/*-tab.tsx`, found at build time. */
export const contextTabRegistry: readonly ContextTabModule[] = registerContextTabs(
  import.meta.glob("./context/*-tab.tsx", { eager: true })
);

export interface ContextPanelProps {
  t: Translator;
  /** The object in the focused panel, or null (the root, a view panel). */
  focus: FocusedObject | null;
  /** The tab chosen for this kind (the remembered one, or the kind's default). */
  tab: ContextTabId;
  onTab: (tab: ContextTabId) => void;
  /** Docked beside the stack, or a 40 px strip that opens an overlay. */
  mode: "docked" | "strip";
  /** The strip's overlay is open. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Opens an address beside the focused panel, or in it (Option-click). */
  onOpen: ContextTabProps["onOpen"];
  /** Starts linking a note to another ("Ligar a outra nota"); absent, the action is not offered. */
  onLink?: ContextTabProps["onLink"];
  /** The panel is on screen; one that is not reads nothing and listens to nothing. */
  shown?: boolean;
  registry?: readonly ContextTabModule[];
}

// ---------------------------------------------------------------------------
// The tab row

/** The row's tabs and "Mais"; fewer tabs show when the words do not fit the panel (never cut). */
export function ContextTabs({
  t,
  available,
  active,
  onTab,
  panelId
}: {
  t: Translator;
  available: readonly ContextTabId[];
  active: ContextTabId;
  onTab: (tab: ContextTabId) => void;
  panelId: string;
}) {
  const key = `${t.locale}|${available.join(",")}|${active}`;
  const { box, content, level } = useOverflowLevel<HTMLDivElement, HTMLDivElement>(3, key);
  const row = tabRow(available, active, tabSlots.full - level);
  const refs = useRef(new Map<ContextTabId, HTMLButtonElement>());
  const onKeyDown = (event: KeyboardEvent) => {
    const next = tabForKey(row.visible, active, event.key);
    if (next === null) return;
    event.preventDefault();
    onTab(next);
    refs.current.get(next)?.focus();
  };
  return (
    <div
      ref={box}
      className="flex h-10 min-w-0 flex-none items-stretch overflow-hidden border-b border-border pr-1 pl-2"
    >
      <div
        ref={content}
        data-fit="context-tabs"
        data-fit-level={level}
        className="flex w-max min-w-full items-stretch"
      >
        <div
          role="tablist"
          aria-label={t("contextPanel.tablist")}
          onKeyDown={onKeyDown}
          className="flex items-stretch"
        >
          {row.visible.map((tab) => {
            const selected = tab === active;
            return (
              <button
                key={tab}
                ref={(node) => {
                  if (node) refs.current.set(tab, node);
                  else refs.current.delete(tab);
                }}
                type="button"
                role="tab"
                id={`${panelId}-tab-${tab}`}
                aria-selected={selected}
                aria-controls={`${panelId}-body`}
                aria-keyshortcuts={`Alt+${tabShortcut(tab).slice(1)}`}
                tabIndex={selected ? 0 : -1}
                title={`${t(tabLabelKeys[tab])} (${tabShortcut(tab)})`}
                onClick={() => onTab(tab)}
                className={cn(
                  "-mb-px flex items-center border-b-2 px-1.5 text-sm whitespace-nowrap",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                  selected
                    ? "border-accent font-semibold text-foreground"
                    : "border-transparent text-secondary-foreground hover:bg-surface-hover hover:text-foreground"
                )}
              >
                {t(tabLabelKeys[tab])}
              </button>
            );
          })}
        </div>
        {row.more.length > 0 ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("contextPanel.moreLabel")}
                className={cn(
                  "ml-auto flex items-center gap-1 px-1.5 text-sm whitespace-nowrap text-secondary-foreground",
                  "hover:bg-surface-hover hover:text-foreground",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
                )}
              >
                {t("contextPanel.more")}
                <ChevronDown aria-hidden="true" className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              {row.more.map((tab) => (
                <DropdownMenuItem key={tab} shortcut={tabShortcut(tab)} onSelect={() => onTab(tab)}>
                  {t(tabLabelKeys[tab])}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The locate header

/**
 * A crumb is an inline link, not a box: a line of crumbs and words wraps at a word boundary, and a
 * long title never jumps to a line of its own. The retry stays a button (it is an action).
 */
const crumbLink =
  "[overflow-wrap:anywhere] underline-offset-[3px] hover:text-accent hover:underline";
const crumbButton = cn(
  "max-w-full rounded-sm text-left",
  crumbLink,
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
);

/** The crumbs the header shows: the whole path, or "…" and its last three. */
export function headerCrumbs<T>(segments: readonly T[]): { folded: boolean; shown: T[] } {
  return segments.length <= 3
    ? { folded: false, shown: [...segments] }
    : { folded: true, shown: segments.slice(-3) };
}

/** What the header says of a placed object (pure; the host reads `objects.locate`). */
export function LocateLines({
  t,
  located,
  onOpen
}: {
  t: Translator;
  located: ObjectLocateResult;
  onOpen: ContextTabProps["onOpen"];
}) {
  const segments = ribbonSegments(located);
  const { folded, shown } = headerCrumbs(segments);
  const untitled = t("panelFrame.ribbon.untitled");
  const alsoIn = located.alsoIn[0];
  const alsoMore = located.counts.alsoIn - 1;
  const cited = located.citedBy.slice(0, 2);
  const citedMore = located.counts.citedBy - cited.length;
  if (segments.length === 0 && !alsoIn && cited.length === 0) return null;
  return (
    <div data-locate="" className="mb-3 grid gap-0.5 text-xs leading-5 text-secondary-foreground">
      <p className="m-0 text-xs leading-5 font-medium text-muted-foreground">
        {t("contextPanel.locate.label")}
      </p>
      {segments.length > 0 ? (
        <p className="m-0 flex min-w-0 items-start gap-1">
          <ObjectKindGlyph
            kind="topic"
            size={12}
            className="mt-[4px] flex-none text-object-topic"
          />
          <span className="min-w-0">
            {folded ? <span aria-hidden="true">… › </span> : null}
            {shown.map((segment, index) => (
              <Fragment key={segment.id}>
                {index > 0 ? <span aria-hidden="true"> › </span> : null}
                <ObjectLink
                  address={segment.address}
                  onOpen={onOpen}
                  preview={false}
                  appearance="bare"
                  className={cn(
                    crumbLink,
                    index === shown.length - 1 && "font-medium text-foreground"
                  )}
                >
                  {segment.title || untitled}
                </ObjectLink>
              </Fragment>
            ))}
          </span>
        </p>
      ) : null}
      {alsoIn ? (
        <p className="m-0 pl-4 text-muted-foreground [text-wrap:pretty]">
          {t("contextPanel.locate.alsoIn")}{" "}
          <ObjectLink
            address={`memora://topic/${alsoIn.id}`}
            onOpen={onOpen}
            preview={false}
            appearance="bare"
            className={cn(crumbLink, "text-secondary-foreground")}
          >
            {alsoIn.title || untitled}
          </ObjectLink>
          {alsoMore > 0 ? (
            <> {t("contextPanel.locate.andMore", { values: { count: alsoMore } })}</>
          ) : null}
        </p>
      ) : null}
      {cited.length > 0 ? (
        <p className="m-0 pl-4 text-muted-foreground [text-wrap:pretty]">
          {t(
            cited.every((ref) => ref.kind === "topic")
              ? "contextPanel.locate.citedByOverview"
              : "contextPanel.locate.citedBy"
          )}{" "}
          {cited.map((ref, index) => (
            <Fragment key={ref.id}>
              {index > 0 ? ", " : null}
              <ObjectLink
                address={`memora://${ref.kind}/${ref.id}`}
                onOpen={onOpen}
                preview={false}
                appearance="bare"
                className={cn(crumbLink, "text-secondary-foreground")}
              >
                {ref.title || untitled}
              </ObjectLink>
            </Fragment>
          ))}
          {citedMore > 0 ? (
            <> {t("contextPanel.locate.andMore", { values: { count: citedMore } })}</>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}

function LocateHeader({
  t,
  focus,
  active,
  hideError,
  onOpen
}: {
  t: Translator;
  focus: FocusedObject;
  active: boolean;
  /** The tab below already says something failed: one failure, one retry (never two). */
  hideError: boolean;
  onOpen: ContextTabProps["onOpen"];
}) {
  const { read, retry } = useLocate(focus.address, active);
  if (read.status === "loading")
    return (
      <div className="mb-3 grid gap-1" aria-hidden="true">
        <Skeleton className="h-3 w-2/3" />
      </div>
    );
  if (read.status === "error")
    return hideError ? null : (
      <p className="m-0 mb-3 text-xs text-secondary-foreground">
        {t("contextPanel.locate.error")}{" "}
        <button type="button" onClick={retry} className={cn(crumbButton, "text-accent")}>
          {t("shell.actions.retry")}
        </button>
      </p>
    );
  if (!read.value) return null;
  return <LocateLines t={t} located={read.value} onOpen={onOpen} />;
}

// ---------------------------------------------------------------------------
// The panel

/** The body for the object in focus, or the sentence that says nothing is. */
function ContextBody({
  t,
  focus,
  tab,
  registry,
  active,
  onState,
  onCount,
  onTab,
  onOpen,
  onLink,
  state
}: {
  t: Translator;
  focus: FocusedObject | null;
  tab: ContextTabId;
  registry: readonly ContextTabModule[];
  active: boolean;
  onState: (state: PanelLoadState) => void;
  onCount: (count: number | null) => void;
  onTab: (tab: ContextTabId) => void;
  onOpen: ContextTabProps["onOpen"];
  onLink: ContextTabProps["onLink"];
  state: PanelLoadState;
}) {
  if (!focus)
    return (
      <EmptyState variant="compact" headline={t("contextPanel.none.title")}>
        {t("contextPanel.none.body")}
      </EmptyState>
    );
  const module = registry.find((entry) => entry.tab === tab);
  const Tab = module?.Component;
  return (
    <>
      <LocateHeader
        t={t}
        focus={focus}
        active={active}
        hideError={state === "error"}
        onOpen={onOpen}
      />
      {Tab ? (
        <Tab
          key={`${focus.address}:${tab}`}
          t={t}
          address={focus.address}
          kind={focus.kind}
          id={focus.id}
          active={active}
          onState={onState}
          onCount={onCount}
          onOpen={onOpen}
          onTab={onTab}
          {...(onLink ? { onLink } : {})}
        />
      ) : null}
    </>
  );
}

export function ContextPanel({
  t,
  focus,
  tab: requested,
  onTab,
  mode,
  open,
  onOpenChange,
  onOpen,
  onLink,
  shown = true,
  registry = contextTabRegistry
}: ContextPanelProps) {
  const id = useId();
  const available = registry.map((entry) => entry.tab);
  const tab = resolveTab(requested, available);
  const key = focus ? `${focus.address}:${tab}` : "none";
  const [reported, setReported] = useState<{
    key: string;
    state: PanelLoadState;
    count: number | null;
  }>({ key: "", state: "loading", count: null });
  const onState = useCallback(
    (state: PanelLoadState) =>
      setReported((current) =>
        current.key === key && current.state === state
          ? current
          : { key, state, count: current.key === key ? current.count : null }
      ),
    [key]
  );
  const onCount = useCallback(
    (count: number | null) =>
      setReported((current) =>
        current.key === key && current.count === count
          ? current
          : { key, state: current.key === key ? current.state : "loading", count }
      ),
    [key]
  );
  const mine = reported.key === key;
  const state: PanelLoadState = !focus ? "empty" : mine ? reported.state : "loading";
  const count = focus && mine ? reported.count : null;

  const wrapper = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLButtonElement>(null);
  const overlay = mode === "strip";
  // Esc, a click outside or the strip close the overlay; focus goes back to the strip.
  useEffect(() => {
    if (!overlay || !open) return undefined;
    const onPointerDown = (event: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(event.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [overlay, open, onOpenChange]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (!overlay || !open || event.key !== "Escape" || event.defaultPrevented) return;
    event.preventDefault();
    onOpenChange(false);
    strip.current?.focus();
  };
  // Opening the overlay puts focus on the selected tab.
  useEffect(() => {
    if (!overlay || !open) return;
    wrapper.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [overlay, open]);

  // The strip shows a number, so the tab behind it reads while the overlay is closed, except the
  // graph, which only draws when it is seen.
  const reads = shown && (!overlay || open || tab !== "graph");
  const tabName = t(tabLabelKeys[tab]);
  const body = (
    <aside
      aria-label={t("contextPanel.region")}
      hidden={overlay && !open}
      className={cn(
        "flex min-h-0 flex-col",
        overlay
          ? "absolute inset-y-0 right-full z-20 w-(--ctx-w) bg-surface [box-shadow:var(--shadow-pop)]"
          : "h-full w-(--ctx-w) flex-none border-l border-border bg-background"
      )}
    >
      <ContextTabs t={t} available={available} active={tab} onTab={onTab} panelId={id} />
      <div
        role="tabpanel"
        id={`${id}-body`}
        aria-labelledby={`${id}-tab-${tab}`}
        tabIndex={-1}
        data-scroll=""
        className="min-h-0 flex-1 scroll-pb-4 overflow-y-auto px-4 pt-4 pb-8 outline-none"
      >
        <ContextBody
          t={t}
          focus={focus}
          tab={tab}
          registry={registry}
          active={reads}
          onState={onState}
          onCount={onCount}
          onTab={onTab}
          onOpen={onOpen}
          onLink={onLink}
          state={state}
        />
      </div>
    </aside>
  );
  return (
    <div
      ref={wrapper}
      data-region="context"
      data-surface="context-panel"
      data-state={state}
      data-context-mode={mode}
      hidden={!shown}
      tabIndex={-1}
      onKeyDown={onKeyDown as never}
      className={cn(
        "min-h-0 outline-none",
        overlay ? "relative h-full w-10 flex-none" : "h-full flex-none"
      )}
    >
      {overlay ? (
        <>
          <Tooltip
            label={
              open
                ? t("contextPanel.strip.close")
                : t("contextPanel.strip.open", { values: { tab: tabName } })
            }
            shortcut="⌘⇧\"
            side="left"
          >
            <button
              ref={strip}
              type="button"
              aria-expanded={open}
              aria-label={
                open
                  ? t("contextPanel.strip.close")
                  : t("contextPanel.strip.open", { values: { tab: tabName } })
              }
              aria-keyshortcuts="Meta+Shift+Backslash"
              onClick={() => onOpenChange(!open)}
              className={cn(
                "flex h-full w-10 flex-col items-center gap-2 border-l border-border py-3",
                "hover:bg-surface-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                open
                  ? "bg-surface-selected text-foreground [box-shadow:inset_2px_0_0_var(--accent)]"
                  : "bg-background text-secondary-foreground"
              )}
            >
              <PanelRight aria-hidden="true" className="size-4 flex-none" />
              <span className="[writing-mode:vertical-rl] text-sm leading-5 whitespace-nowrap text-foreground">
                <span className="text-muted-foreground">{t("contextPanel.strip.label")} · </span>
                {stripParts(tabName, count).join(" · ")}
              </span>
            </button>
          </Tooltip>
          {body}
        </>
      ) : (
        body
      )}
    </div>
  );
}
