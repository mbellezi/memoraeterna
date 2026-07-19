export type WindowNavigationDirection = "back" | "forward";

interface WindowNavigationInput {
  type: string;
  key: string;
  code?: string;
  alt: boolean;
  meta: boolean;
}

export function navigationDirectionFromAppCommand(command: string): WindowNavigationDirection | null {
  if (command === "browser-backward") return "back";
  if (command === "browser-forward") return "forward";
  return null;
}

export function navigationDirectionFromSwipe(direction: string): WindowNavigationDirection | null {
  if (direction === "left") return "back";
  if (direction === "right") return "forward";
  return null;
}

export function navigationDirectionFromInput(input: WindowNavigationInput): WindowNavigationDirection | null {
  if (input.type !== "keyDown") return null;
  if (input.key === "BrowserBack" || (input.alt && input.key === "ArrowLeft")
    || (input.meta && (input.key === "[" || input.code === "BracketLeft"))) return "back";
  if (input.key === "BrowserForward" || (input.alt && input.key === "ArrowRight")
    || (input.meta && (input.key === "]" || input.code === "BracketRight"))) return "forward";
  return null;
}
