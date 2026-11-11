import type { ReactNode } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import type { Translator } from "@app/i18n";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { Kbd } from "../components/ui/kbd";
import { Tooltip } from "../components/ui/tooltip";
import { cn } from "../lib/cn";

export interface TitleBarProps {
  t: Translator;
  /** The destination's name, or the old view's, or Ajustes. The same element on every screen. */
  title: string;
  /** Opens the palette (Cmd-K). */
  onOpenPalette: () => void;
  /** The status slot: the Activity pill and its drawer. */
  status: ReactNode;
  /** Adicionar. T150 passes its split button with the import menu; the default stands until then. */
  add?: ReactNode;
  onAdd: () => void;
  onAddMore: () => void;
}

/**
 * The title bar (design record §5.2), one row of 48 px on the desk colour: the destination name, the
 * omni trigger, the status slot and Adicionar. There is no back or forward (each panel has its own
 * history) and no Ask control (asking is Cmd-K's `?`). The name column ends where the navigator
 * does, so the omni trigger starts at the same x on every screen. The widths follow
 * `titleBarLayout` (`shell-model.ts`): the trigger keeps its floor of `--omni-min`, and the status
 * slot truncates inside the pill and never covers it.
 */
export function TitleBar({
  t,
  title,
  onOpenPalette,
  status,
  add,
  onAdd,
  onAddMore
}: TitleBarProps) {
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
        <span className="min-w-0 flex-1 truncate text-left">
          {t("workspace.titleBar.omniPlaceholder")}
        </span>
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
      {add ?? <AddSplitButton t={t} onAdd={onAdd} onAddMore={onAddMore} />}
    </header>
  );
}

/**
 * Adicionar as an outlined split button: the main part adds a source (the file picker, Cmd-N) and a
 * 24 px chevron part opens the menu of other ways. Each part has its own focus ring and name.
 */
function AddSplitButton({
  t,
  onAdd,
  onAddMore
}: {
  t: Translator;
  onAdd: () => void;
  onAddMore: () => void;
}) {
  return (
    <div
      className={cn(
        "inline-flex h-8 shrink-0 items-stretch rounded-lg border border-border-strong bg-surface",
        "text-sm font-medium text-foreground"
      )}
    >
      <Tooltip label={t("workspace.titleBar.addSource")} shortcut="⌘N">
        <button
          type="button"
          aria-label={t("workspace.titleBar.addSource")}
          aria-keyshortcuts="Meta+N"
          className={cn(
            "inline-flex items-center gap-2 rounded-l-lg px-3 transition-colors hover:bg-surface-hover",
            "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          )}
          onClick={onAdd}
        >
          <Plus aria-hidden="true" className="size-4" />
          {t("workspace.titleBar.add")}
        </button>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("workspace.titleBar.addMore")}
            className={cn(
              "inline-flex w-6 items-center justify-center rounded-r-lg border-l border-border",
              "text-secondary-foreground transition-colors hover:bg-surface-hover",
              "data-[state=open]:bg-accent-soft data-[state=open]:text-accent",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            )}
          >
            <ChevronDown aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem shortcut="⌘N" onSelect={onAdd}>
            {t("workspace.titleBar.addFile")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onAddMore}>
            {t("workspace.titleBar.addMoreOptions")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
