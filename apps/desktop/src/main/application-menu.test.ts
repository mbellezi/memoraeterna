import type { IpcMain, MenuItemConstructorOptions } from "electron";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { appViewIds, type AppMenuCommand } from "../shared/app-menu.js";
import { ipcChannels } from "../shared/ipc.js";
import {
  buildApplicationMenuTemplate,
  createApplicationMenuController,
  goDestinations,
  registerApplicationMenuIpc,
  viewsOutsideGoMenu
} from "./application-menu.js";

type Item = MenuItemConstructorOptions;

function build(overrides: Partial<Parameters<typeof buildApplicationMenuTemplate>[0]> = {}) {
  const send = vi.fn<(command: AppMenuCommand) => void>();
  const navigate = vi.fn();
  const template = buildApplicationMenuTemplate({
    language: "en",
    platform: "darwin",
    isPackaged: true,
    send,
    navigate,
    ...overrides
  });
  return { template, send, navigate };
}

const submenu = (item: Item | undefined): Item[] => (item?.submenu as Item[] | undefined) ?? [];
const flatten = (items: Item[]): Item[] =>
  items.flatMap((item) => [item, ...flatten(submenu(item))]);
const named = (template: Item[], label: string) => template.find((item) => item.label === label);
const click = (item: Item | undefined, event: { triggeredByAccelerator?: boolean } = {}) =>
  (item?.click as ((...args: unknown[]) => void) | undefined)?.(item, undefined, event);

describe("application menu", () => {
  it("has the macOS-style top-level menus in order", () => {
    const { template } = build();
    expect(template.map((item) => item.label ?? item.role)).toEqual([
      "Memora Eterna",
      "File",
      "Edit",
      "View",
      "Go",
      "Window",
      "Help"
    ]);
    // Other platforms have no application menu; Settings and Quit move into File.
    const other = build({ platform: "linux" }).template;
    expect(other.map((item) => item.label ?? item.role)).toEqual([
      "File",
      "Edit",
      "View",
      "Go",
      "Window",
      "Help"
    ]);
    const file = flatten(submenu(named(other, "File")));
    expect(file.some((item) => item.accelerator === "CmdOrCtrl+,")).toBe(true);
    expect(file.some((item) => item.role === "quit")).toBe(true);
  });

  it("is written in every interface language, with no English left in the others", () => {
    for (const language of supportedLanguageCodes) {
      const { template } = build({ language });
      const t = createTranslator(language);
      expect(template.map((item) => item.label)).toEqual([
        t("app.title"),
        t("app.menu.file"),
        t("app.menu.edit"),
        t("app.menu.view"),
        t("app.menu.go"),
        t("app.menu.window"),
        t("app.menu.help")
      ]);
      const labels = flatten(template).flatMap((item) => (item.label ? [item.label] : []));
      expect(labels).toContain(t("app.menu.closePanel"));
      expect(labels).toContain(t("app.menu.about", { values: { app: t("app.title") } }));
      // Every role item carries a label, so the OS language never replaces the app language.
      for (const item of flatten(template))
        if (item.role && item.role !== "help") expect(item.label, item.role).toBeTruthy();
    }
    const portuguese = flatten(build({ language: "pt-BR" }).template).map((item) => item.label);
    expect(portuguese).not.toContain("Close Panel");
    expect(portuguese).toContain("Fechar Painel");
    // An unsupported language falls back to English.
    expect(named(build({ language: "de" }).template, "File")).toBeDefined();
  });

  it("has every menu string in all five locales", () => {
    const keys = Object.keys(messages.en.app.menu).sort();
    expect(keys.length).toBeGreaterThan(20);
    for (const language of supportedLanguageCodes) {
      expect(Object.keys(messages[language].app.menu).sort()).toEqual(keys);
      for (const value of Object.values(messages[language].app.menu)) expect(value).not.toBe("");
    }
  });

  it("closes a panel with Cmd-W and has no way to close the window or quit with it", () => {
    const { template, send } = build();
    const all = flatten(template);
    const withW = all.filter((item) => /\+W$/iu.test(item.accelerator ?? ""));
    expect(withW).toHaveLength(1);
    expect(withW[0]).toMatchObject({ label: "Close Panel", accelerator: "CmdOrCtrl+W" });
    expect(withW[0]!.role).toBeUndefined();
    click(withW[0]);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: "close-panel" });
    // No role that would close the window (or the app) on its own, and no Window menu role.
    expect(all.some((item) => item.role === "close" || item.role === "windowMenu")).toBe(false);
    expect(all.filter((item) => item.role === "quit")).toHaveLength(1);
    expect(all.find((item) => item.role === "quit")!.accelerator).toBeUndefined();
  });

  it("sends Back and Forward only when they are clicked, never twice for a key press", () => {
    const { template, navigate } = build();
    const go = submenu(named(template, "Go"));
    const back = go.find((item) => item.accelerator === "CmdOrCtrl+[");
    const forward = go.find((item) => item.accelerator === "CmdOrCtrl+]");
    expect([back?.label, forward?.label]).toEqual(["Back", "Forward"]);
    // The key press is already handled by the window; the menu would repeat it.
    click(back, { triggeredByAccelerator: true });
    click(forward, { triggeredByAccelerator: true });
    expect(navigate).not.toHaveBeenCalled();
    click(back);
    click(forward, { triggeredByAccelerator: false });
    expect(navigate.mock.calls).toEqual([["back"], ["forward"]]);
  });

  it("keeps clear of text editing and platform shortcuts", () => {
    const accelerators = flatten(build().template).flatMap((item) =>
      item.accelerator ? [String(item.accelerator)] : []
    );
    expect(accelerators.length).toBeGreaterThan(10);
    expect(new Set(accelerators).size).toBe(accelerators.length);
    for (const accelerator of accelerators) {
      // Always with the platform modifier: a single-key shortcut would fire while typing. Only
      // letters, digits and a few punctuation keys, which Electron accepts as key codes.
      expect(accelerator, accelerator).toMatch(/^CmdOrCtrl\+(?:[A-Z0-9]|[,[\]\\])$/u);
      expect(accelerator, accelerator).not.toMatch(/\+(?:E|I)$/u);
    }
    // The edit actions use the standard roles, so their shortcuts are the platform ones.
    const roles = submenu(named(build().template, "Edit")).map((item) => item.role);
    expect(roles).toEqual(["undo", "redo", undefined, "cut", "copy", "paste", "selectAll"]);
  });

  it("opens every view from the menu, each exactly once", () => {
    const { template, send } = build();
    const opened = new Map<string, number>();
    for (const item of flatten(template)) {
      send.mockClear();
      if (!item.click || item.accelerator === "CmdOrCtrl+W") continue;
      if (typeof item.accelerator === "string" && /\[|\]/u.test(item.accelerator)) continue;
      click(item);
      const command = send.mock.calls[0]?.[0];
      if (command?.type === "go-to") opened.set(command.view, (opened.get(command.view) ?? 0) + 1);
    }
    for (const view of appViewIds) {
      const entries = opened.get(view) ?? 0;
      // Add content is also in File; every other view has one entry.
      expect(entries, view).toBeGreaterThanOrEqual(1);
      if (view !== "import") expect(entries, view).toBe(1);
    }
    expect(viewsOutsideGoMenu).toEqual(["settings", "debug"]);
    const go = submenu(named(template, "Go"));
    goDestinations.forEach(({ view }, index) => {
      const item = go.find((entry) => entry.accelerator === `CmdOrCtrl+${index + 1}`);
      send.mockClear();
      click(item);
      expect(send).toHaveBeenCalledWith({ type: "go-to", view });
    });
    expect(goDestinations.map((entry) => entry.view)).toEqual(
      appViewIds.filter((view) => !viewsOutsideGoMenu.includes(view))
    );
  });

  it("toggles the navigation and the theme from View", () => {
    const { template, send } = build();
    const view = submenu(named(template, "View"));
    click(view.find((item) => item.accelerator === "CmdOrCtrl+\\"));
    click(view.find((item) => item.label === "Toggle theme"));
    expect(send.mock.calls.map(([command]) => command)).toEqual([
      { type: "toggle-navigation" },
      { type: "toggle-theme" }
    ]);
  });

  it("offers reload and developer tools in development builds only", () => {
    const roles = (isPackaged: boolean) =>
      flatten(build({ isPackaged }).template).flatMap((item) => (item.role ? [item.role] : []));
    expect(roles(true)).not.toContain("toggleDevTools");
    expect(roles(true)).not.toContain("reload");
    expect(roles(false)).toEqual(expect.arrayContaining(["toggleDevTools", "reload"]));
  });
});

describe("application menu controller", () => {
  const options = (initialLanguage: string) => {
    const apply = vi.fn<(template: Item[]) => void>();
    return {
      apply,
      controller: createApplicationMenuController({
        initialLanguage,
        platform: "darwin",
        isPackaged: true,
        send: vi.fn(),
        navigate: vi.fn(),
        apply
      })
    };
  };

  it("installs the menu in the system language and rebuilds it only when the language changes", () => {
    const { apply, controller } = options("pt-PT");
    expect(controller.language).toBe("pt-BR");
    expect(apply).toHaveBeenCalledTimes(1);
    expect(named(apply.mock.calls[0]![0], "Arquivo")).toBeDefined();
    controller.setLanguage("pt-BR");
    controller.setLanguage("pt");
    expect(apply).toHaveBeenCalledTimes(1);
    controller.setLanguage("fr");
    expect(apply).toHaveBeenCalledTimes(2);
    expect(controller.language).toBe("fr");
    expect(named(apply.mock.calls[1]![0], "Fichier")).toBeDefined();
    controller.setLanguage("xx");
    expect(controller.language).toBe("en");
    expect(named(apply.mock.calls[2]![0], "File")).toBeDefined();
  });

  it("keeps the language it has when the menu cannot be rebuilt", () => {
    const { apply, controller } = options("en");
    apply.mockImplementationOnce(() => {
      throw new Error("menu failed");
    });
    expect(() => controller.setLanguage("es")).toThrow("menu failed");
    expect(controller.language).toBe("en");
    controller.setLanguage("es");
    expect(controller.language).toBe("es");
  });

  it("takes the language only from a validated request", async () => {
    const { controller } = options("en");
    const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>();
    registerApplicationMenuIpc(
      {
        handle: (channel: string, handler: never) => handlers.set(channel, handler)
      } as never as IpcMain,
      controller
    );
    const handler = handlers.get(ipcChannels.menuSetLanguage)!;
    await handler({}, "it");
    expect(controller.language).toBe("it");
    expect(() => handler({}, "de")).toThrow();
    expect(() => handler({}, { language: "it" })).toThrow();
    expect(controller.language).toBe("it");
  });
});
