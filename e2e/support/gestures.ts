// The gesture counter of the exit bars X1 and X10 (F5 T137, spec 5.2), pre-registered before the
// journeys that use it. It lives in the renderer: capture-phase listeners on `window` count trusted
// `pointerdown` events (any button) and trusted `keydown` events that are not typing, so every
// Playwright path (Locator, page or mouse API) is counted the same way.
//
// A keydown is a gesture when its key is not printable (Enter, Escape, Tab, Space, the arrows,
// Backspace, Delete, Home/End, Page Up/Down, F1-F24) or when it carries Meta or Ctrl. A character
// typed into a field (`a`, `?`, `É`, Shift+letter) is not a gesture; neither is a bare modifier
// (the Meta keydown of Cmd-K is part of the one gesture `k` with Meta), a dead key, an IME
// composition step, or an auto-repeat.
import type { Page } from "@playwright/test";

export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  repeat: boolean;
  isComposing?: boolean;
}

/**
 * Whether one trusted keydown is a gesture. Self-contained (no outside reference): its source is
 * sent into the page as is, so the page counts exactly what this function's tests check.
 */
export function keyIsGesture(event: KeyLike): boolean {
  const modifiers = ["Shift", "Control", "Alt", "AltGraph", "Meta", "CapsLock", "Fn", "FnLock"];
  const notKeys = ["Dead", "Process", "Unidentified", "Compose"];
  if (event.repeat || event.isComposing === true) return false;
  if (modifiers.includes(event.key) || notKeys.includes(event.key)) return false;
  if (event.metaKey || event.ctrlKey) return true;
  // One character (one code point) is printable, except the space bar, which activates.
  if ([...event.key].length === 1) return event.key === " ";
  return true;
}

export interface GestureCount {
  total: number;
  pointer: number;
  keys: number;
  /** The keys counted, in order (`Meta+k`, `Enter`), for a report. */
  log: string[];
}

const stateKey = "__memoraGestures";

/** Runs in the page: installs the listeners once per document and resets the count. */
function installInPage(classify: (event: KeyLike) => boolean, key: string): void {
  const scope = window as unknown as Record<string, unknown>;
  const existing = scope[key] as GestureCount | undefined;
  if (existing) {
    existing.total = 0;
    existing.pointer = 0;
    existing.keys = 0;
    existing.log = [];
    return;
  }
  const state: GestureCount = { total: 0, pointer: 0, keys: 0, log: [] };
  scope[key] = state;
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!event.isTrusted) return;
      state.total += 1;
      state.pointer += 1;
      state.log.push(`pointer:${event.button}`);
    },
    { capture: true }
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (!event.isTrusted || !classify(event)) return;
      state.total += 1;
      state.keys += 1;
      const prefix = `${event.metaKey ? "Meta+" : ""}${event.ctrlKey ? "Control+" : ""}`;
      state.log.push(`${prefix}${event.key}`);
    },
    { capture: true }
  );
}

/** The expression `page.evaluate` runs: the installer applied to the classifier's own source. */
export function installerSource(): string {
  return `(${installInPage.toString()})(${keyIsGesture.toString()}, ${JSON.stringify(stateKey)})`;
}

/**
 * Installs the counter in the page's current document (a reload needs a new install) and sets it to
 * zero. A second call on the same document only resets it.
 */
export async function installGestureCounter(page: Page): Promise<void> {
  await page.evaluate(installerSource());
}

export async function resetGestures(page: Page): Promise<void> {
  await installGestureCounter(page);
}

export async function readGestures(page: Page): Promise<GestureCount> {
  const count = await page.evaluate(
    (key) => (window as unknown as Record<string, unknown>)[key] as GestureCount | undefined,
    stateKey
  );
  if (!count) throw new Error("The gesture counter is not installed in this document");
  return { ...count, log: [...count.log] };
}
