import { useEffect, useEffectEvent, useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../../../lib/cn";

export interface MenuItem {
  id: string;
  label: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/** Where a menu opens: the point of a click, or the lower left of the row or button that asked. */
export interface MenuAnchor {
  x: number;
  y: number;
}

export interface FloatingMenuProps {
  /** The accessible name of the menu. */
  label: string;
  anchor: MenuAnchor;
  items: readonly MenuItem[];
  onClose: () => void;
}

/** Widest and tallest the menu can be, so a point near an edge still shows all of it. */
const menuWidth = 224;
const itemHeight = 32;

/** The index of the next enabled item in a direction, wrapping round; -1 when none is enabled. */
export function nextEnabled(items: readonly MenuItem[], from: number, step: 1 | -1): number {
  for (let i = 1; i <= items.length; i += 1) {
    const index = (from + step * i + items.length * i) % items.length;
    if (!items[index]?.disabled) return index;
  }
  return -1;
}

/**
 * A menu of actions (WAI-ARIA menu): the first item takes focus, arrows, Home and End move, Enter
 * and Space choose, Escape and Tab close it and a press outside closes it. Focus goes back to
 * the control that had it, unless the action moves focus on purpose.
 */
export function FloatingMenu({ label, anchor, items, onClose }: FloatingMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useEffectEvent(() => onClose());
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ref.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  const focusAt = (index: number) => {
    if (index >= 0) buttons.current[index]?.focus();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = buttons.current.findIndex((button) => button === document.activeElement);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusAt(nextEnabled(items, current, 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        focusAt(nextEnabled(items, current < 0 ? 0 : current, -1));
        break;
      case "Home":
        event.preventDefault();
        focusAt(nextEnabled(items, -1, 1));
        break;
      case "End":
        event.preventDefault();
        focusAt(nextEnabled(items, 0, -1));
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        event.preventDefault();
        onClose();
        break;
      default:
    }
  };

  const width = typeof window === "undefined" ? 1024 : window.innerWidth;
  const height = typeof window === "undefined" ? 768 : window.innerHeight;
  const left = Math.max(4, Math.min(anchor.x, width - menuWidth - 4));
  const top = Math.max(4, Math.min(anchor.y, height - items.length * itemHeight - 12));
  return (
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      style={{ left, top, width: menuWidth }}
      className="fixed z-50 grid gap-0.5 rounded-lg border border-border bg-surface p-1 text-foreground shadow-lg"
      onKeyDown={onKeyDown}
    >
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            buttons.current[index] = node;
          }}
          type="button"
          role="menuitem"
          tabIndex={-1}
          disabled={item.disabled}
          className={cn(
            "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm outline-none",
            "hover:bg-soft focus-visible:bg-accent-soft focus-visible:outline-2",
            "focus-visible:-outline-offset-2 focus-visible:outline-accent",
            "disabled:cursor-not-allowed disabled:opacity-45",
            "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground"
          )}
          onClick={() => {
            onClose();
            item.onSelect();
          }}
        >
          {item.icon}
          <span className="min-w-0 flex-1 truncate">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
