import type { AppMenuCommand, AppViewId } from "../../shared/app-menu";

export interface MenuCommandHandlers {
  closePanel: () => void;
  goTo: (view: AppViewId) => void;
  toggleNavigation: () => void;
  toggleTheme: () => void;
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
  }
}
