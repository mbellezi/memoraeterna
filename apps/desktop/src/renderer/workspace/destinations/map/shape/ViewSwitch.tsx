import type { KeyboardEvent, ReactNode } from "react";

import { cn } from "../../../../lib/cn";

export interface ViewSwitchItem<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  /** A quiet word after the label ("later"). */
  note?: string | undefined;
  disabled?: boolean;
}

export const tabDomId = (prefix: string, id: string): string => `${prefix}-tab-${id}`;
export const panelDomId = (prefix: string, id: string): string => `${prefix}-panel-${id}`;

/**
 * The tab an arrow key leads to: the next or previous enabled one (wrapping), the first or the
 * last. Null for any other key or when no other tab is enabled.
 */
export function nextTab(
  items: readonly { disabled?: boolean }[],
  from: number,
  key: string
): number | null {
  const enabled = items.flatMap((item, index) => (item.disabled ? [] : [index]));
  if (enabled.length === 0) return null;
  if (key === "Home") return enabled[0]!;
  if (key === "End") return enabled.at(-1)!;
  if (key !== "ArrowRight" && key !== "ArrowLeft") return null;
  const step = key === "ArrowRight" ? 1 : -1;
  for (let offset = 1; offset <= items.length; offset += 1) {
    const index = (from + step * offset + items.length * offset) % items.length;
    if (!items[index]!.disabled) return index;
  }
  return null;
}

export interface ViewSwitchProps<T extends string> {
  label: string;
  value: T;
  items: ReadonlyArray<ViewSwitchItem<T>>;
  onChange: (value: T) => void;
  /** Prefix of the DOM ids: the tabs are `<prefix>-tab-<id>`, the panels they control `<prefix>-panel-<id>`. */
  idPrefix: string;
  size?: "md" | "sm";
}

/**
 * Tabs for views of the same thing: one tab stop, arrows, Home and End move between them. A tab
 * that is not available yet is disabled and says why beside its label. Each tab controls the
 * panel `<prefix>-panel-<id>` that the host renders.
 */
export function ViewSwitch<T extends string>({
  label,
  value,
  items,
  onChange,
  idPrefix,
  size = "md"
}: ViewSwitchProps<T>) {
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = nextTab(items, index, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = items[next]!;
    onChange(target.id);
    document.getElementById(tabDomId(idPrefix, target.id))?.focus();
  };
  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(
        "inline-flex flex-wrap gap-0.5 bg-soft p-0.5",
        size === "sm" ? "rounded-md" : "rounded-lg"
      )}
    >
      {items.map((item, index) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={tabDomId(idPrefix, item.id)}
            aria-selected={selected}
            {...(item.disabled
              ? { disabled: true, "aria-disabled": true }
              : { "aria-controls": panelDomId(idPrefix, item.id) })}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex items-center gap-1.5 font-medium whitespace-nowrap [&>svg]:size-4 [&>svg]:shrink-0",
              size === "sm" ? "h-7 rounded px-2.5 text-xs" : "h-8 rounded-md px-3 text-sm",
              selected
                ? "bg-surface text-foreground ring-1 ring-border"
                : item.disabled
                  ? "text-muted-foreground"
                  : "text-secondary-foreground hover:bg-surface-hover"
            )}
          >
            {item.icon}
            {item.label}
            {item.note ? <span className="text-xs font-normal">{`· ${item.note}`}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
