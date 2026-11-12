import { useId, type ReactNode } from "react";

import { cn } from "../../../lib/cn";

/**
 * The tab row of the Source panel: a tablist whose current tab is marked by the accent colour and a
 * 2 px bar, with arrow keys, Home and End. Labels never shrink or cut: when the row is narrow the
 * tabs wrap to a second line whole. The panel owns the choice (`value`); the row owns no state.
 */
export interface TabItem<T extends string> {
  id: T;
  label: string;
  /** A count after the label ("Notas 18"); absent for tabs that hold no list. */
  count?: number;
}

export function SourceTabRow<T extends string>({
  label,
  value,
  items,
  onChange,
  children
}: {
  label: string;
  value: T;
  items: readonly TabItem<T>[];
  onChange: (value: T) => void;
  children: ReactNode;
}) {
  const id = useId();
  const focusTab = (index: number) => {
    const next = items[index];
    if (!next) return;
    onChange(next.id);
    document.getElementById(`${id}-${next.id}`)?.focus();
  };
  return (
    <div className="min-w-0">
      <div
        role="tablist"
        aria-label={label}
        className="mb-5 flex flex-wrap gap-x-5 border-b border-border"
      >
        {items.map((item, index) => {
          const current = item.id === value;
          return (
            <button
              key={item.id}
              id={`${id}-${item.id}`}
              type="button"
              role="tab"
              aria-selected={current}
              aria-controls={`${id}-panel`}
              tabIndex={current ? 0 : -1}
              data-tab={item.id}
              onClick={() => onChange(item.id)}
              onKeyDown={(event) => {
                const last = items.length - 1;
                const target =
                  event.key === "ArrowRight"
                    ? (index + 1) % items.length
                    : event.key === "ArrowLeft"
                      ? (index + last) % items.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? last
                          : null;
                if (target === null) return;
                event.preventDefault();
                focusTab(target);
              }}
              className={cn(
                "-mb-px inline-flex items-baseline gap-1.5 border-b-2 py-2 text-sm whitespace-nowrap",
                "focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent",
                current
                  ? "border-accent font-semibold text-accent"
                  : "border-transparent font-medium text-secondary-foreground hover:text-foreground"
              )}
            >
              {item.label}
              {item.count !== undefined ? (
                <span
                  className={cn(
                    "text-xs font-normal tabular-nums",
                    current ? "text-accent" : "text-muted-foreground"
                  )}
                >
                  {item.count}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${value}`}
        className="min-w-0 outline-none"
      >
        {children}
      </div>
    </div>
  );
}
