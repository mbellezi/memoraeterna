import type { ReactNode } from "react";
import { Search } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Kbd } from "../components/ui/kbd";
import { cn } from "../lib/cn";
import { useOverflowLevel } from "../lib/use-overflow-level";

export interface TitleBarProps {
  t: Translator;
  /** The destination's name, or the old view's, or Ajustes. The same element on every screen. */
  title: string;
  /** Opens the palette (Cmd-K). */
  onOpenPalette: () => void;
  /** The status slot: the Activity pill and its drawer. */
  status: ReactNode;
  /** Adicionar: the split button with its menu (`add/AddMenu.tsx`). */
  add: ReactNode;
}

/**
 * The title bar (design record §5.2), one row of 48 px on the desk colour: the destination name, the
 * omni trigger, the status slot and Adicionar. There is no back or forward (each panel has its own
 * history) and no Ask control (asking is Cmd-K's `?`). The name column ends where the navigator
 * does, so the omni trigger starts at the same x on every screen. The widths follow
 * `titleBarLayout` (`shell-model.ts`): the trigger keeps its floor of `--omni-min`, and the status
 * slot truncates inside the pill and never covers it.
 */
export function TitleBar({ t, title, onOpenPalette, status, add }: TitleBarProps) {
  return (
    <header
      aria-label={t("workspace.regions.titleBar")}
      data-region="titleBar"
      className={cn(
        "flex h-(--top-h) min-w-0 shrink-0 items-center gap-(--top-gap) border-b border-border",
        "bg-background pl-(--top-pl) pr-4"
      )}
    >
      <h1 className="w-(--name-w) shrink-0 truncate text-base font-semibold text-foreground">
        {title}
      </h1>
      <button
        type="button"
        aria-label={`${t("workspace.titleBar.omniLabel")} (⌘K)`}
        aria-keyshortcuts="Meta+K"
        data-omni=""
        className={cn(
          "flex h-8 min-w-(--omni-min) max-w-(--omni-max) flex-[1_1_0] items-center gap-2 rounded-lg",
          "border border-border bg-surface pl-3 pr-1 text-sm text-muted-foreground transition-colors",
          "hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2",
          "focus-visible:outline-accent"
        )}
        onClick={onOpenPalette}
      >
        <Search aria-hidden="true" className="size-4 shrink-0" />
        <OmniLabel t={t} />
        <Kbd>⌘K</Kbd>
      </button>
      <div
        aria-label={t("workspace.titleBar.status")}
        data-status=""
        role="group"
        className="ml-auto flex min-w-0 max-w-(--status-max) flex-[2_1_0] justify-end"
      >
        {status}
      </div>
      {add}
    </header>
  );
}

/**
 * The trigger's words. When the full "Search, open or ask…" does not fit beside the keycap (a long
 * language at the 960 px window), the whole clause "open" goes and the shorter phrase stays; the
 * words are never cut in the middle. The button's accessible name always has the full label.
 */
function OmniLabel({ t }: { t: Translator }) {
  const full = t("workspace.titleBar.omniPlaceholder");
  const short = t("workspace.titleBar.omniShort");
  const { box, content, level } = useOverflowLevel<HTMLSpanElement, HTMLSpanElement>(
    2,
    `${full}|${short}`
  );
  return (
    <span ref={box} className="min-w-0 flex-1 overflow-hidden text-left">
      <span
        ref={content}
        data-fit="omni"
        data-fit-level={level}
        className="inline-block whitespace-nowrap"
      >
        {level === 0 ? full : short}
      </span>
    </span>
  );
}
