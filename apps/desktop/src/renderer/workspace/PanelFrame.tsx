import { useEffect, useId, useRef, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Maximize2, Pin, X } from "lucide-react";
import type { ObjectKind } from "@app/domain";
import type { Translator } from "@app/i18n";

import { ObjectKindGlyph, objectKindTextClass } from "../components/glyphs";
import { Tooltip } from "../components/ui/tooltip";
import { cn } from "../lib/cn";
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
  /** Opens an address beside this panel (a ribbon crumb). */
  onOpen: (address: string) => void;
  ribbonPlace?: RibbonPlace;
  onChoosePlace?: () => void;
  /** The body's scroll offset to restore when the panel is shown again. */
  scroll?: number;
  /** The body stopped scrolling at `top` px. */
  onScrollEnd?: (top: number) => void;
  children: ReactNode;
}

const iconButton = cn(
  "inline-grid size-7 shrink-0 place-items-center rounded-md text-secondary-foreground",
  "transition-colors hover:bg-surface-hover hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
  "[&>svg]:size-4"
);

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
      onMouseDown={!top && onFocus ? onFocus : undefined}
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
              className={iconButton}
              onClick={onPin}
            >
              <Pin aria-hidden="true" />
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
        className={cn(
          "min-h-0 flex-1 overflow-auto",
          compact ? "px-4 pt-4 pb-8" : "px-(--top-pl) pt-5 pb-12"
        )}
      >
        {objectPanel ? (
          <div className="sticky top-0 z-[1] -mx-1 bg-surface px-1">
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
        {children}
      </div>
    </section>
  );
}
