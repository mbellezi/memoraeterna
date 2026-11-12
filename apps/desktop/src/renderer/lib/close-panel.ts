/**
 * Cmd-W (the application menu's Close Panel) closes the topmost thing that is open: a dialog first,
 * then the panel or detail of the shown view. When nothing is open nothing happens: the request
 * never closes the window or quits the app.
 */

/** Who answers first: dialogs, then unsaved editing, then panels and details. */
export const closePanelPriority = { dialog: 100, editing: 20, panel: 10 } as const;

export type ClosePanelListener = () => boolean;

/** One authority routes a close request; the highest priority listener that handles it wins. */
export function createClosePanelRouter() {
  const listeners: Array<{ callback: ClosePanelListener; priority: number; order: number }> = [];
  let sequence = 0;
  return {
    subscribe(callback: ClosePanelListener, priority: number = closePanelPriority.panel) {
      const entry = { callback, priority, order: sequence++ };
      listeners.push(entry);
      return () => {
        const index = listeners.indexOf(entry);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
    /** `true` when a listener closed (or deliberately kept open) something. */
    dispatch(): boolean {
      for (const listener of listeners.toSorted(
        (a, b) => b.priority - a.priority || b.order - a.order
      ))
        if (listener.callback()) return true;
      return false;
    }
  };
}

const router = createClosePanelRouter();
export const subscribeClosePanel = router.subscribe;
export const dispatchClosePanel = router.dispatch;

export interface DialogLike {
  tagName: string;
  getAttribute(name: string): string | null;
  dispatchEvent(event: Event): boolean;
  close?(): void;
}

/**
 * Closes the topmost dialog the way Escape would. A native dialog gets its `cancel` event, so a
 * dialog that guards its closing (a request in flight) keeps its say; one that does not prevent it
 * is closed. A custom dialog or panel gets an Escape key press, which it already handles. A dialog
 * that is busy and cannot be dismissed (aria-busy) is left alone and swallows the request.
 */
export function closeTopDialog(
  dialogs: readonly DialogLike[],
  createEscape: () => Event = () =>
    new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })
): boolean {
  const top = dialogs.at(-1);
  if (!top) return false;
  if (top.getAttribute("aria-busy") === "true") return true;
  if (top.tagName === "DIALOG") {
    if (top.dispatchEvent(new Event("cancel", { cancelable: true }))) top.close?.();
  } else {
    top.dispatchEvent(createEscape());
  }
  return true;
}

/**
 * The dialogs and dialog-like panels that are open and visible, in document order. A non-modal
 * preview (the quick-look sheet, `data-non-modal`) is not one: previews never answer Cmd-W.
 */
export function openDialogs(root: ParentNode = document): HTMLElement[] {
  return [
    ...root.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"]:not([data-non-modal])')
  ].filter((element) => element.closest("[hidden]") === null);
}
