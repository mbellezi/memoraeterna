// The application's shortcuts in a journey (F5 T154). Cmd-1..5, Cmd-,, Cmd-K, Cmd-N, Cmd-W, Cmd-\ and
// the other workspace accelerators are items of the native application menu (`M/application-menu.ts`):
// on macOS the menu runs them after the page has seen the key, and a key that Playwright injects with
// the DevTools protocol never reaches the menu, so `page.keyboard.press("Meta+K")` opens nothing.
// `pressShortcut` therefore does both halves of a real key press: the key reaches the page (a
// trusted keydown, which the gesture counter counts as the gesture it is) and the menu item that owns
// the accelerator is clicked in main, exactly as the menu would on that key.
//
// Keys that do not belong to the menu (Cmd-[ and Cmd-], which main reads before the menu through
// `before-input-event`; Cmd-Y; Space; Escape; the arrows) are pressed as keys only.
import type { ElectronApplication, Page } from "@playwright/test";

/** The menu accelerators of the workspace, in Electron's spelling. */
export const menuAccelerators: readonly string[] = [
  "CmdOrCtrl+1",
  "CmdOrCtrl+2",
  "CmdOrCtrl+3",
  "CmdOrCtrl+4",
  "CmdOrCtrl+5",
  "CmdOrCtrl+,",
  "CmdOrCtrl+K",
  "CmdOrCtrl+N",
  "CmdOrCtrl+W",
  "CmdOrCtrl+\\",
  "CmdOrCtrl+Shift+\\",
  "CmdOrCtrl+Shift+F",
  "CmdOrCtrl+Shift+T"
];

/** Playwright's `Meta+K` as Electron's `CmdOrCtrl+K`; a letter is upper case, as the menu spells it. */
export function acceleratorOf(combo: string): string {
  // The `+` key ends the combination with a second `+`: "Meta++".
  const plus = combo.endsWith("++");
  const parts = (plus ? combo.slice(0, -2) : combo).split("+");
  const key = plus ? "+" : (parts.pop() ?? "");
  const modifiers = parts.map((part) =>
    part === "Meta" || part === "Control" ? "CmdOrCtrl" : part
  );
  return [...modifiers, key.length === 1 ? key.toUpperCase() : key].join("+");
}

/** Whether the combination is an accelerator of the application menu. */
export function isMenuShortcut(combo: string): boolean {
  return menuAccelerators.includes(acceleratorOf(combo));
}

/** Clicks the menu item that owns `accelerator`; false when the menu has none. */
async function clickMenuItem(electronApp: ElectronApplication, accelerator: string) {
  return electronApp.evaluate(({ BrowserWindow, Menu }, wanted) => {
    const find = (items: Electron.MenuItem[]): Electron.MenuItem | null => {
      for (const item of items) {
        if (String(item.accelerator ?? "") === wanted) return item;
        const inner = item.submenu ? find(item.submenu.items) : null;
        if (inner) return inner;
      }
      return null;
    };
    const item = find(Menu.getApplicationMenu()?.items ?? []);
    if (!item) return false;
    const window = BrowserWindow.getAllWindows()[0];
    item.click({ triggeredByAccelerator: true } as never, window, window?.webContents);
    return true;
  }, accelerator);
}

/**
 * Presses `combo` (Playwright's spelling: `Meta+K`, `Meta+,`, `Meta+Shift+T`). A menu shortcut also
 * clicks its menu item, so the workspace acts on it; the page sees the key either way.
 */
export async function pressShortcut(
  session: { electronApp: ElectronApplication; page: Page },
  combo: string
): Promise<void> {
  await session.page.keyboard.press(combo);
  if (!isMenuShortcut(combo)) return;
  const accelerator = acceleratorOf(combo);
  if (!(await clickMenuItem(session.electronApp, accelerator)))
    throw new Error(`The application menu has no item for ${accelerator}`);
}
