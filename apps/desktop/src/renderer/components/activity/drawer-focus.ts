/**
 * Focus and keys of the Activity drawer, apart from React so they are tested without a renderer.
 * The drawer is not modal: opening it moves focus into it so the keyboard reaches what it lists,
 * closing it by the person's own hand (Escape, the close button, the pill, Cmd-W) gives focus back
 * to the pill, and nothing traps Tab.
 */

export interface Focusable {
  focus(options?: { preventScroll?: boolean }): void;
}

/** The two elements, as React refs hold them. */
export interface DrawerFocusTargets {
  pill: { readonly current: Focusable | null };
  drawer: { readonly current: Focusable | null };
}

export function createDrawerFocus(targets: DrawerFocusTargets) {
  return {
    /** The drawer opened: focus moves to it. */
    opened(): void {
      targets.drawer.current?.focus({ preventScroll: true });
    },
    /** The person closed it: focus returns to the pill that opened it. */
    closed(): void {
      targets.pill.current?.focus({ preventScroll: true });
    }
  };
}

export interface KeyLike {
  key: string;
  defaultPrevented: boolean;
  /** An input method (IME) composition uses Escape to cancel itself. */
  isComposing?: boolean;
}

/** Escape closes the drawer unless something inside already handled it. */
export function closesDrawer(event: KeyLike): boolean {
  return event.key === "Escape" && !event.defaultPrevented && event.isComposing !== true;
}
