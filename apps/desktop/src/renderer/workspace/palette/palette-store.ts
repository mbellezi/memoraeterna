/**
 * Whether Cmd-K is open, and the text it opens with. One store for the app: the shortcut, the menu
 * item and the title bar's search field all reach it, and `PaletteHost` is the one that draws. A
 * second Cmd-K while it is open closes it (the palette is a toggle, like quick-look).
 */
export interface PaletteOpen {
  open: boolean;
  /** The box's first text (the prefix a shortcut types for the person). */
  initial: string;
  /** Changes at every opening, so a palette opened twice in a row starts again. */
  token: number;
}

type Listener = () => void;

export interface PaletteStore {
  get(): PaletteOpen;
  subscribe(listener: Listener): () => void;
  open(initial?: string): void;
  close(): void;
  toggle(): void;
}

export function createPaletteStore(): PaletteStore {
  let current: PaletteOpen = { open: false, initial: "", token: 0 };
  const listeners = new Set<Listener>();
  const set = (next: PaletteOpen) => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  const open = (initial = "") => set({ open: true, initial, token: current.token + 1 });
  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open,
    close() {
      if (current.open) set({ ...current, open: false });
    },
    toggle() {
      if (current.open) set({ ...current, open: false });
      else open();
    }
  };
}

/** The palette the app shows. */
export const palette: PaletteStore = createPaletteStore();
