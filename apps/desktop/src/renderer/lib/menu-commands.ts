import type { AppMenuCommand, AppViewId } from "../../shared/app-menu";
import type { KeymapResult } from "../workspace/keymap";

export interface MenuCommandHandlers {
  closePanel: () => void;
  goTo: (view: AppViewId) => void;
  toggleNavigation: () => void;
  toggleTheme: () => void;
  /** A shortcut of the workspace: an action of its reducer or a UI command (the keymap's result). */
  workspace: (result: KeymapResult) => void;
  /** "Show only this branch" for the topic in the top panel. */
  hoistTopic: () => void;
}

/**
 * What a menu command of the workspace means in the workspace's own terms: the same result the
 * keymap gives its key, so the menu item and the key reach one handler. Null for the commands that
 * are not workspace results (closing a panel, going to a place, the navigator, the theme, hoisting
 * the focused topic).
 */
export function menuWorkspaceResult(command: AppMenuCommand): KeymapResult | null {
  switch (command.type) {
    case "open-palette":
      return { type: "openPalette" };
    case "new-import":
      return { type: "newImport" };
    case "focus-panel":
      return { type: "focusNext", delta: command.direction === "next" ? 1 : -1 };
    case "reopen-closed":
      return { type: "reopen" };
    case "toggle-context":
      return { type: "toggleContext" };
    case "toggle-focus-mode":
      return { type: "toggleFocusMode" };
    case "unhoist":
      return { type: "hoist", topicId: null };
    default:
      return null;
  }
}

/** Runs one command of the application menu; a new command type fails to compile until handled. */
export function applyMenuCommand(command: AppMenuCommand, handlers: MenuCommandHandlers): void {
  switch (command.type) {
    case "close-panel":
      return handlers.closePanel();
    case "go-to":
      return handlers.goTo(command.view);
    case "toggle-navigation":
      return handlers.toggleNavigation();
    case "toggle-theme":
      return handlers.toggleTheme();
    case "hoist-topic":
      return handlers.hoistTopic();
    case "open-palette":
    case "new-import":
    case "focus-panel":
    case "reopen-closed":
    case "toggle-context":
    case "toggle-focus-mode":
    case "unhoist": {
      const result = menuWorkspaceResult(command);
      if (result) handlers.workspace(result);
      return;
    }
  }
}
