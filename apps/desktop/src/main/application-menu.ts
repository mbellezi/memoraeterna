import type { IpcMain, MenuItemConstructorOptions } from "electron";
import { createTranslator, type LanguageCode, type MessageKey } from "@app/i18n";
import {
  legacyViewIds,
  type AppDestinationId,
  type AppMenuCommand,
  type AppViewId,
  type LegacyViewId
} from "../shared/app-menu.js";
import { ipcChannels, languageCodeSchema } from "../shared/ipc.js";
import type { WindowNavigationDirection } from "./window-navigation.js";

/**
 * The application menu: App, File, Edit, View, Go, Window and Help, in the interface language.
 *
 * - Cmd-W is "Close Panel": the renderer closes the topmost dialog or panel, and when nothing is
 *   open it does nothing. The menu has no Close Window item, so Cmd-W can never close the window.
 * - Cmd-[ and Cmd-] already reach the renderer through the window navigation channel (before the
 *   menu sees the key); the Back and Forward items here only act when clicked.
 * - The workspace accelerators (design record section 12) live here: Cmd-1..5 go to the five
 *   destinations, Cmd-K opens the palette, Cmd-N adds a source, Cmd-Shift-T reopens a closed panel,
 *   Cmd-\ and Cmd-Shift-\ toggle the navigator and the context panel, Cmd-Shift-F is focus mode
 *   and Ctrl-Tab moves between panels. Cmd-6..8 are free again.
 * - No accelerator uses E, I or "." with the platform modifier: those belong to text editing.
 *   Single-key shortcuts are never part of a menu.
 */

/** The destinations of the Go menu, in rail order; they take Cmd-1 to Cmd-5. */
export const goDestinations: ReadonlyArray<{ view: AppDestinationId; label: MessageKey }> = [
  { view: "home", label: "workspace.destinations.home" },
  { view: "explore", label: "workspace.destinations.explore" },
  { view: "library", label: "workspace.destinations.library" },
  { view: "inbox", label: "workspace.destinations.inbox" },
  { view: "map", label: "workspace.destinations.map" }
];

/** The old views, in the "Old screens" submenu of Go until the cards that remove them (D6). */
export const legacyViewLabels: Readonly<Record<LegacyViewId, MessageKey>> = {
  import: "shell.navigation.import",
  search: "shell.navigation.search",
  review: "shell.navigation.review",
  jobs: "shell.navigation.jobs",
  debug: "debug.title"
};

/** Settings and Monitoring have their own menu items; every other view is in the Go menu. */
export const viewsOutsideGoMenu: readonly AppViewId[] = ["settings", "debug"];

export interface ApplicationMenuOptions {
  /** Any locale; an unsupported one falls back to English. */
  language: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  send: (command: AppMenuCommand) => void;
  navigate: (direction: WindowNavigationDirection) => void;
}

export function buildApplicationMenuTemplate(
  options: ApplicationMenuOptions
): MenuItemConstructorOptions[] {
  const t = createTranslator(options.language);
  const appName = t("app.title");
  const isMac = options.platform === "darwin";
  const send = (command: AppMenuCommand) => () => options.send(command);
  const goTo = (view: AppViewId) => send({ type: "go-to", view });
  const settings: MenuItemConstructorOptions = {
    label: t("app.menu.settings"),
    accelerator: "CmdOrCtrl+,",
    click: goTo("settings")
  };
  const quit: MenuItemConstructorOptions = { role: "quit", label: t("app.tray.quit") };
  // A key press is handled before the menu; only a click on the item navigates here.
  const navigation = (direction: WindowNavigationDirection, key: string, label: MessageKey) =>
    ({
      label: t(label),
      accelerator: `CmdOrCtrl+${key}`,
      click: (_item, _window, event) => {
        if (!event.triggeredByAccelerator) options.navigate(direction);
      }
    }) satisfies MenuItemConstructorOptions;

  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          label: appName,
          submenu: [
            { role: "about", label: t("app.menu.about", { values: { app: appName } }) },
            { type: "separator" },
            settings,
            { type: "separator" },
            { role: "services", label: t("app.menu.services") },
            { type: "separator" },
            { role: "hide", label: t("app.menu.hide", { values: { app: appName } }) },
            { role: "hideOthers", label: t("app.menu.hideOthers") },
            { role: "unhide", label: t("app.menu.showAll") },
            { type: "separator" },
            quit
          ]
        }
      ]
    : [];

  return [
    ...appMenu,
    {
      label: t("app.menu.file"),
      submenu: [
        {
          label: t("workspace.menu.addSource"),
          accelerator: "CmdOrCtrl+N",
          click: send({ type: "new-import" })
        },
        { type: "separator" },
        {
          label: t("app.menu.closePanel"),
          accelerator: "CmdOrCtrl+W",
          click: send({ type: "close-panel" })
        },
        ...(isMac ? [] : ([{ type: "separator" }, settings, quit] as const))
      ]
    },
    {
      label: t("app.menu.edit"),
      submenu: [
        { role: "undo", label: t("app.menu.undo") },
        { role: "redo", label: t("app.menu.redo") },
        { type: "separator" },
        { role: "cut", label: t("app.menu.cut") },
        { role: "copy", label: t("app.menu.copy") },
        { role: "paste", label: t("app.menu.paste") },
        { role: "selectAll", label: t("app.menu.selectAll") }
      ]
    },
    {
      label: t("app.menu.view"),
      submenu: [
        {
          label: t("app.menu.toggleNavigation"),
          accelerator: "CmdOrCtrl+\\",
          click: send({ type: "toggle-navigation" })
        },
        {
          label: t("workspace.menu.toggleContext"),
          accelerator: "CmdOrCtrl+Shift+\\",
          click: send({ type: "toggle-context" })
        },
        {
          label: t("workspace.menu.focusMode"),
          accelerator: "CmdOrCtrl+Shift+F",
          click: send({ type: "toggle-focus-mode" })
        },
        { type: "separator" },
        { label: t("workspace.menu.hoistTopic"), click: send({ type: "hoist-topic" }) },
        { label: t("workspace.menu.unhoist"), click: send({ type: "unhoist" }) },
        { type: "separator" },
        { label: t("shell.actions.toggleTheme"), click: send({ type: "toggle-theme" }) },
        { type: "separator" },
        { role: "togglefullscreen", label: t("app.menu.fullScreen") },
        // Development builds only: a packaged build has no reload or developer tools.
        ...(options.isPackaged
          ? []
          : ([
              { type: "separator" },
              { role: "reload", label: t("app.menu.reload") },
              { role: "forceReload", label: t("app.menu.forceReload") },
              { role: "toggleDevTools", label: t("app.menu.developerTools") }
            ] as const))
      ]
    },
    {
      label: t("app.menu.go"),
      submenu: [
        navigation("back", "[", "app.menu.back"),
        navigation("forward", "]", "app.menu.forward"),
        { type: "separator" },
        {
          label: t("workspace.menu.openPalette"),
          accelerator: "CmdOrCtrl+K",
          click: send({ type: "open-palette" })
        },
        { type: "separator" },
        ...goDestinations.map(({ view, label }, index) => ({
          label: t(label),
          accelerator: `CmdOrCtrl+${index + 1}`,
          click: goTo(view)
        })),
        { type: "separator" },
        {
          label: t("workspace.menu.focusNext"),
          accelerator: "Ctrl+Tab",
          click: send({ type: "focus-panel", direction: "next" })
        },
        {
          label: t("workspace.menu.focusPrevious"),
          accelerator: "Ctrl+Shift+Tab",
          click: send({ type: "focus-panel", direction: "prev" })
        },
        {
          label: t("workspace.menu.reopenClosed"),
          accelerator: "CmdOrCtrl+Shift+T",
          click: send({ type: "reopen-closed" })
        },
        { type: "separator" },
        {
          label: t("workspace.menu.legacyViews"),
          submenu: legacyViewIds
            .filter((view) => !viewsOutsideGoMenu.includes(view))
            .map((view) => ({ label: t(legacyViewLabels[view]), click: goTo(view) }))
        }
      ]
    },
    {
      label: t("app.menu.window"),
      submenu: [
        { role: "minimize", label: t("app.menu.minimize") },
        ...(isMac
          ? ([
              { role: "zoom", label: t("app.menu.zoom") },
              { type: "separator" },
              { role: "front", label: t("app.menu.bringAllToFront") }
            ] as const)
          : [])
      ]
    },
    {
      role: "help",
      label: t("app.menu.help"),
      submenu: [{ label: t("debug.title"), click: goTo("debug") }]
    }
  ];
}

export interface ApplicationMenuController {
  /** Rebuilds the menu when the interface language changed. */
  setLanguage: (language: string) => void;
  readonly language: LanguageCode;
}

export interface ApplicationMenuControllerOptions extends Omit<ApplicationMenuOptions, "language"> {
  initialLanguage: string;
  /** Installs a built template (`Menu.setApplicationMenu(Menu.buildFromTemplate(template))`). */
  apply: (template: MenuItemConstructorOptions[]) => void;
}

export function createApplicationMenuController(
  options: ApplicationMenuControllerOptions
): ApplicationMenuController {
  const { initialLanguage, apply, ...menu } = options;
  let language = createTranslator(initialLanguage).locale;
  apply(buildApplicationMenuTemplate({ ...menu, language }));
  return {
    get language() {
      return language;
    },
    setLanguage(next) {
      const locale = createTranslator(next).locale;
      if (locale === language) return;
      apply(buildApplicationMenuTemplate({ ...menu, language: locale }));
      language = locale;
    }
  };
}

export function registerApplicationMenuIpc(ipc: IpcMain, controller: ApplicationMenuController) {
  ipc.handle(ipcChannels.menuSetLanguage, (_event, payload: unknown) => {
    controller.setLanguage(languageCodeSchema.parse(payload));
  });
}
