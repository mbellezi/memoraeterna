import { Cpu, Library, Lock, Network, Plug, SlidersHorizontal, Wrench } from "lucide-react";
import type { ComponentType } from "react";
import type { Translator } from "@app/i18n";

import { cn } from "../lib/cn";
import { ChangedDot } from "./ChangedMarker";
import {
  sectionMeta,
  settingsSectionIds,
  type SectionIcon,
  type SettingsSectionId
} from "./settings-model";

const icons: Record<SectionIcon, ComponentType<{ className?: string; "aria-hidden"?: "true" }>> = {
  sliders: SlidersHorizontal,
  cpu: Cpu,
  network: Network,
  library: Library,
  plug: Plug,
  lock: Lock,
  wrench: Wrench
};

export interface SectionNavProps {
  t: Translator;
  current: SettingsSectionId;
  onSelect: (section: SettingsSectionId) => void;
  /** Changed settings per section; null while the values are not read. */
  changed: Readonly<Record<SettingsSectionId, number>> | null;
  /** Search hits per section while a search is typed; null otherwise. */
  hits: Readonly<Record<SettingsSectionId, number>> | null;
}

/**
 * The seven sections (design record §7.6), each with an icon, a name and a one-line description.
 * A section with changed settings shows a grey dot and its count; while a search is typed the count
 * is the number of hits and a section with none is quiet. The current section is marked by the accent
 * bar and the selected fill; the word "current" is `aria-current`.
 */
export function SectionNav({ t, current, onSelect, changed, hits }: SectionNavProps) {
  return (
    <nav aria-label={t("settingsShell.navLabel")}>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
        {settingsSectionIds.map((id) => {
          const meta = sectionMeta[id];
          const Icon = icons[meta.icon];
          const hitCount = hits?.[id] ?? 0;
          const changedCount = changed?.[id] ?? 0;
          const selected = id === current;
          const quiet = hits !== null && hitCount === 0;
          return (
            <li key={id}>
              <button
                type="button"
                aria-current={selected ? "true" : undefined}
                data-section={id}
                onClick={() => onSelect(id)}
                className={cn(
                  "relative flex w-full items-start gap-3 rounded-lg border-0 p-2 text-left",
                  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
                  selected
                    ? "bg-surface-selected [box-shadow:inset_2px_0_0_var(--accent)]"
                    : "bg-transparent hover:bg-surface-hover"
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    selected
                      ? "text-accent"
                      : quiet
                        ? "text-muted-foreground"
                        : "text-secondary-foreground"
                  )}
                />
                <span className="grid min-w-0 flex-1 gap-0.5">
                  <span
                    className={cn(
                      "block pr-6 text-sm leading-5 [text-wrap:balance]",
                      selected ? "font-semibold text-foreground" : "font-medium",
                      !selected && (quiet ? "text-muted-foreground" : "text-foreground")
                    )}
                  >
                    {t(meta.name)}
                  </span>
                  <span className="block text-xs leading-4 text-muted-foreground [text-wrap:pretty]">
                    {t(meta.description)}
                  </span>
                </span>
                {hits !== null && hitCount > 0 ? (
                  <span
                    className={cn(
                      "absolute right-2 top-2 inline-flex h-5 min-w-5 items-center justify-center rounded-full",
                      "bg-surface px-1.5 text-xs font-semibold leading-5 text-foreground tabular-nums",
                      "[box-shadow:inset_0_0_0_1px_var(--border-strong)]"
                    )}
                    aria-label={t(
                      hitCount === 1 ? "settingsShell.navHitsOne" : "settingsShell.navHitsMany",
                      { values: { count: hitCount } }
                    )}
                  >
                    {hitCount}
                  </span>
                ) : hits === null && changedCount > 0 ? (
                  <span
                    className="absolute right-2 top-2 inline-flex items-center gap-1 text-xs leading-5 text-secondary-foreground tabular-nums"
                    aria-label={t(
                      changedCount === 1
                        ? "settingsShell.navChangedOne"
                        : "settingsShell.navChangedMany",
                      { values: { count: changedCount } }
                    )}
                  >
                    <ChangedDot />
                    {changedCount}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
