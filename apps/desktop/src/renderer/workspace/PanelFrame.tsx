import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Pin, X } from "lucide-react";
import type { ObjectKind } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { Tooltip } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
import { ObjectLinkProvider, type ObjectOpen } from "./ObjectLink";
import { PathRibbon, type RibbonPlace } from "./PathRibbon";

/**
 * The frame of one panel of a stack (design record §5.4, §8, §9): the 40 px header with the kind
 * glyph and word, the per-panel history arrows, Foco, the pin and close; the body with the path
 * ribbon above an object page; and the four-state contract. The frame writes `data-surface` and
 * `data-state` from the state the panel reports (loading, empty, error, success), so the screens
 * check and the journeys read each panel from its own frame.
 */

export const panelStates = ["loading", "empty", "error", "success"] as const;
export type PanelLoadState = (typeof panelStates)[number];

/** How a panel draws: the top panel takes the rest of the stack, the previous one its compact form. */
export type PanelFrameMode = "full" | "compact";

export interface PanelFrameProps {
  t: Translator;
  /** The surface id the frame reports (`data-surface`): the panel's kind of surface. */
  surface: string;
  /** The panel's address; an object address shows the path ribbon. */
  address: string;
  /** The object kind for the glyph and colour; null for a view panel (search, ask, import). */
  kind: ObjectKind | null;
  /** The kind word ("Nota"). */
  kindLabel: string;
  /** The panel's title, for its accessible name (the page shows its own heading). */
  title: string;
  mode: PanelFrameMode;
  /** The top panel: raised, focused, and the only one with the arrows, Foco and the pin. */
  top: boolean;
  /** What the panel reports of its own load. */
  state: PanelLoadState;
  /** The panel is on screen (its destination shown); a hidden one listens to nothing. */
  active?: boolean;
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  onClose: () => void;
  /** Makes this panel the top (a click on the previous panel's body or header). */
  onFocus?: () => void;
  focusMode?: boolean;
  onToggleFocusMode?: () => void;
  /** "Fixar no navegador"; absent until the navigator's pins land, so no control does nothing. */
  onPin?: () => void;
  /** The object is pinned: the pin is drawn pressed (`aria-pressed`, the accent fill). */
  pinned?: boolean;
  /** Opens an address beside this panel (a ribbon crumb). */
  onOpen: ObjectOpen;
  ribbonPlace?: RibbonPlace;
  onChoosePlace?: () => void;
  /** The body's scroll offset to restore when the panel is shown again. */
  scroll?: number;
  /** The body stopped scrolling at `top` px. */
  onScrollEnd?: (top: number) => void;
  children: ReactNode;
}

/** The controls a press on the previous panel reaches as itself, without making the panel the top. */
const panelControls =
  'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], ' +
  '[role="option"], [role="treeitem"], [role="menuitem"], [role="tab"], [contenteditable="true"]';

/** The part of an element a press lands on that `closest` reads (a DOM element, or a test double). */
interface PressTarget {
  closest: (selector: string) => unknown;
}

const isPressTarget = (target: unknown): target is PressTarget =>
  typeof target === "object" &&
  target !== null &&
  typeof (target as Partial<PressTarget>).closest === "function";

/**
 * Whether a press on a panel that is not the top makes it the top. A press on one of its controls
 * (a list row, a link, its ×) does not: the control acts on mouseup, and making the panel the top
 * on mousedown would redraw it full width and move the control from under the pointer (§8 rule 5:
 * a click on the previous panel's own surface returns to it).
 */
export function pressFocusesPanel(target: unknown, frame: unknown): boolean {
  if (!isPressTarget(target)) return true;
  const control = target.closest(panelControls);
  if (control === null || control === undefined || control === frame) return true;
  return false;
}

const iconButtonBase = cn(
  "inline-grid size-7 shrink-0 place-items-center rounded-md transition-colors",
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
  "[&>svg]:size-4"
);
const iconButtonIdle = "text-secondary-foreground hover:bg-surface-hover hover:text-foreground";
const iconButton = cn(iconButtonBase, iconButtonIdle);
/** The pressed pin: the accent colour and its soft fill (the idle colours are not on it). */
const iconButtonPressed = cn(iconButtonBase, "bg-accent-soft text-accent hover:bg-accent-soft");

export function PanelFrame({
  t,
  surface,
  address,
  kind,
  kindLabel,
  title,
  mode,
  top,
  state,
  active = true,
  canBack,
  canForward,
  onBack,
  onForward,
  onClose,
  onFocus,
  focusMode = false,
  onToggleFocusMode,
  onPin,
  pinned = false,
  onOpen,
  ribbonPlace,
  onChoosePlace,
  scroll,
  onScrollEnd,
  children
}: PanelFrameProps) {
  const kindId = useId();
  const titleId = useId();
  const body = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLElement>(null);
  const compact = mode === "compact";
  const objectPanel = kind !== null && address.startsWith(`memora://${kind}/`);
  // A panel whose object failed says so once, in its body: the ribbon's own failure line is for a
  // place that fails while the object reads.
  const ribbon = objectPanel && state !== "error";
  // The ribbon draws an edge under it only while content slides beneath it.
  const [scrolled, setScrolled] = useState(false);

  // The body's scroll comes back where it was when the panel is shown again.
  useEffect(() => {
    const node = body.current;
    if (node && active && scroll !== undefined && Math.abs(node.scrollTop - scroll) > 1)
      node.scrollTop = scroll;
    // Only on being shown: a scroll the person makes is not undone.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, mode]);
  useEffect(() => {
    const node = body.current;
    if (!node || !onScrollEnd) return undefined;
    const end = () => onScrollEnd(Math.round(node.scrollTop));
    node.addEventListener("scrollend", end);
    return () => node.removeEventListener("scrollend", end);
  }, [onScrollEnd]);

  // The top panel holds keyboard focus when it becomes the top.
  useEffect(() => {
    if (!top || !active) return;
    const node = frame.current;
    if (node && !node.contains(document.activeElement)) node.focus({ preventScroll: true });
  }, [top, active, address]);

  return (
    <section
      ref={frame}
      tabIndex={-1}
      aria-labelledby={`${kindId} ${titleId}`}
      data-surface={surface}
      data-state={state}
      data-panel-mode={mode}
      data-panel-top={top ? "" : undefined}
      onMouseDown={
        !top && onFocus
          ? (event) => {
              if (event.button === 0 && pressFocusesPanel(event.target, event.currentTarget))
                onFocus();
            }
          : undefined
      }
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 flex-col bg-surface outline-none",
        "focus-visible:shadow-[inset_0_0_0_2px_var(--accent)]",
        top ? "relative z-[1] shadow-[var(--shadow-sheet)]" : "border-r border-border"
      )}
    >
      <header className="flex h-10 flex-none items-center gap-1 border-b border-border pr-2 pl-3">
        <span className="mr-1 inline-flex min-w-0 items-center gap-2 text-sm font-medium whitespace-nowrap text-secondary-foreground">
          {kind ? (
            <ObjectKindGlyph kind={kind} size={16} className={objectKindTextClass[kind]} />
          ) : null}
          <span id={kindId}>{kindLabel}</span>
          <span id={titleId} className="sr-only">
            {title}
          </span>
        </span>
        {top && canBack ? (
          <Tooltip label={t("panelFrame.back")} shortcut="⌘[">
            <button
              type="button"
              aria-label={t("panelFrame.back")}
              className={iconButton}
              onClick={onBack}
            >
              <ChevronLeft aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
        {top && canForward ? (
          <Tooltip label={t("panelFrame.forward")} shortcut="⌘]">
            <button
              type="button"
              aria-label={t("panelFrame.forward")}
              className={iconButton}
              onClick={onForward}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          </Tooltip>
        ) : null}
        <span className="flex-1" />
        {top && onToggleFocusMode ? (
          focusMode ? (
            <button
              type="button"
              aria-pressed="true"
              onClick={onToggleFocusMode}
              className={cn(
                "inline-flex h-7 shrink-0 items-center gap-2 rounded-md bg-surface-selected px-2 text-sm font-medium text-foreground",
                "shadow-[inset_0_0_0_1px_var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              )}
            >
              <Maximize2 aria-hidden="true" className="size-3.5" />
              {t("panelFrame.focusOn")}
            </button>
          ) : (
            <Tooltip label={t("panelFrame.focus")} shortcut="⌘⇧F">
              <button
                type="button"
                aria-pressed="false"
                onClick={onToggleFocusMode}
                className={cn(
                  iconButton,
                  "w-auto grid-flow-col gap-1.5 px-2 text-sm font-medium [&>svg]:size-3.5"
                )}
              >
                <Maximize2 aria-hidden="true" />
                {t("panelFrame.focus")}
              </button>
            </Tooltip>
          )
        ) : null}
        {top && onPin ? (
          <Tooltip label={t("panelFrame.pin")} shortcut="⌘D">
            <button
              type="button"
              aria-label={t("panelFrame.pin")}
              aria-pressed={pinned}
              className={pinned ? iconButtonPressed : iconButton}
              onClick={onPin}
            >
              <Pin aria-hidden="true" className={cn(pinned && "fill-current")} />
            </button>
          </Tooltip>
        ) : null}
        <Tooltip label={t("panelFrame.close")} {...(top ? { shortcut: "⌘W" } : {})}>
          <button
            type="button"
            aria-label={t("panelFrame.close")}
            className={iconButton}
            onClick={onClose}
          >
            <X aria-hidden="true" />
          </button>
        </Tooltip>
      </header>
      <div
        ref={body}
        data-panel-body=""
        onScroll={(event) => setScrolled(event.currentTarget.scrollTop > 0)}
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          compact ? "px-4 pb-8" : "px-(--top-pl) pb-12",
          // The ribbon holds the body's top padding itself, so its opaque box starts at the edge of
          // the scroll area and no text shows above it.
          !ribbon && (compact ? "pt-4" : "pt-5")
        )}
      >
        {ribbon ? (
          <div
            data-ribbon-stuck={scrolled ? "" : undefined}
            className={cn(
              "sticky top-0 z-[1] -mx-1 bg-surface px-1",
              compact ? "pt-4" : "pt-5",
              scrolled && "[box-shadow:0_1px_0_0_var(--border-subtle)]"
            )}
          >
            <PathRibbon
              t={t}
              address={address}
              compact={compact}
              active={active}
              onOpen={onOpen}
              {...(ribbonPlace ? { place: ribbonPlace } : {})}
              {...(onChoosePlace ? { onChoosePlace } : {})}
            />
          </div>
        ) : null}
        {/* The links inside the page (a Markdown `memora://` link) open beside this panel. */}
        <ObjectLinkProvider t={t} onOpen={onOpen}>
          {children}
        </ObjectLinkProvider>
      </div>
    </section>
  );
}
