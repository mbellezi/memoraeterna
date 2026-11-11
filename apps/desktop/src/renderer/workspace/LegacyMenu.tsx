import { Archive } from "lucide-react";
import type { Translator } from "@app/i18n";

import { legacyViewIds, type LegacyViewId } from "../../shared/app-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { cn } from "../lib/cn";
import { railCurrentClass, railItemClass } from "./rail-styles";
import { legacyTitleKeys } from "./shell-model";

/** The old views the menu lists, in order: every old view that no destination hosts yet. */
export const legacyMenuViews: readonly LegacyViewId[] = legacyViewIds;

export interface LegacyMenuProps {
  t: Translator;
  /** The old view on screen, if any. */
  current: LegacyViewId | null;
  onOpen: (view: LegacyViewId) => void;
}

/**
 * "Old screens": the quiet item above Ajustes that opens a menu of the old views that are still
 * reachable (D6). Each leaves when the card that replaces it lands (T156, T157, T158, T166), and the
 * item leaves with the last of them.
 */
export function LegacyMenu({ t, current, onOpen }: LegacyMenuProps) {
  if (legacyMenuViews.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("workspace.rail.legacyLabel")}
          aria-current={current !== null ? "page" : undefined}
          className={cn(railItemClass, current !== null && railCurrentClass)}
        >
          <Archive aria-hidden="true" className="size-5" />
          <span>{t("workspace.rail.legacy")}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="right" align="end">
        {legacyMenuViews.map((view) => (
          <DropdownMenuItem
            key={view}
            aria-current={current === view ? "page" : undefined}
            className={cn(current === view && "font-semibold")}
            onSelect={() => onOpen(view)}
          >
            {t(legacyTitleKeys[view])}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
