export type WindowNavigationDirection = "back" | "forward";

interface WindowNavigationInput {
  type: string;
  key: string;
  code?: string;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

export function navigationDirectionFromAppCommand(
  command: string
): WindowNavigationDirection | null {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}

export function navigationDirectionFromSwipe(direction: string): WindowNavigationDirection | null {
  if (direction === "left") return "back";
  if (direction === "right") return "forward";
  return null;
}

/** Whether exactly the given modifiers are held: a chord with an extra modifier is another chord. */
function holdsOnly(input: WindowNavigationInput, modifier: "alt" | "control" | "meta"): boolean {
  return (
    input.alt === (modifier === "alt") &&
    input.control === (modifier === "control") &&
    input.meta === (modifier === "meta") &&
    !input.shift
  );
}

/**
 * History navigation from the keyboard, before the page sees the key. Only chords that nothing else
 * owns are taken (rules/frontend.md): the dedicated Browser Back and Forward keys, the platform
 * modifier with [ and ] (the Go menu items), and Alt-Left and Alt-Right where that is the platform's
 * history chord. On macOS Option-Arrow moves and selects by word in every text field, so it is never
 * taken, and a chord with Shift or any further modifier (Cmd-Shift-[ switches tabs in other apps)
 * belongs to editing or to the platform.
 */
export function navigationDirectionFromInput(
  input: WindowNavigationInput,
  platform: string
): WindowNavigationDirection | null {
  if (input.type !== "keyDown") return null;
  if (input.key === "BrowserBack") return "back";
  if (input.key === "BrowserForward") return "forward";
  const isMac = platform === "darwin";
  if (holdsOnly(input, isMac ? "meta" : "control")) {
    if (input.key === "[" || input.code === "BracketLeft") return "back";
    if (input.key === "]" || input.code === "BracketRight") return "forward";
  }
  if (!isMac && holdsOnly(input, "alt")) {
    if (input.key === "ArrowLeft") return "back";
    if (input.key === "ArrowRight") return "forward";
  }
  return null;
}
