import { describe, expect, it, vi } from "vitest";

import {
  appDestinationIds,
  appMenuCommandSchema,
  type AppMenuCommand
} from "../../shared/app-menu";
import { initialState, reduce, type WorkspaceAction } from "../workspace/state";
import { keymap, type KeymapResult } from "../workspace/keymap";
import { applyMenuCommand, menuWorkspaceResult, type MenuCommandHandlers } from "./menu-commands";

const handlers = () =>
  ({
    closePanel: vi.fn(),
    goTo: vi.fn(),
    toggleNavigation: vi.fn(),
    toggleTheme: vi.fn(),
    workspace: vi.fn(),
    hoistTopic: vi.fn()
  }) satisfies MenuCommandHandlers;

describe("menu commands map to actions", () => {
  it("send a destination, Settings or an old view to goTo, exactly once", () => {
    for (const view of [
      "home",
      "explore",
      "library",
      "inbox",
      "map",
      "settings",
      "search"
    ] as const) {
      const h = handlers();
      applyMenuCommand({ type: "go-to", view }, h);
      expect(h.goTo).toHaveBeenCalledExactlyOnceWith(view);
      expect(h.workspace).not.toHaveBeenCalled();
    }
  });

  it("map every workspace command to the result its key gives", () => {
    const table: Array<[AppMenuCommand, KeymapResult, KeymapResult]> = [
      [
        { type: "open-palette" },
        { type: "openPalette" },
        keymap({
          key: "k",
          code: "KeyK",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false
        })!
      ],
      [
        { type: "new-import" },
        { type: "newImport" },
        keymap({
          key: "n",
          code: "KeyN",
          metaKey: true,
          ctrlKey: false,
          shiftKey: false,
          altKey: false
        })!
      ],
      [
        { type: "reopen-closed" },
        { type: "reopen" },
        keymap({
          key: "T",
          code: "KeyT",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false
        })!
      ],
      [
        { type: "toggle-context" },
        { type: "toggleContext" },
        keymap({
          key: "|",
          code: "Backslash",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false
        })!
      ],
      [
        { type: "toggle-focus-mode" },
        { type: "toggleFocusMode" },
        keymap({
          key: "F",
          code: "KeyF",
          metaKey: true,
          ctrlKey: false,
          shiftKey: true,
          altKey: false
        })!
      ],
      [
        { type: "focus-panel", direction: "next" },
        { type: "focusNext", delta: 1 },
        keymap({
          key: "Tab",
          code: "Tab",
          metaKey: false,
          ctrlKey: true,
          shiftKey: false,
          altKey: false
        })!
      ],
      [
        { type: "focus-panel", direction: "prev" },
        { type: "focusNext", delta: -1 },
        keymap({
          key: "Tab",
          code: "Tab",
          metaKey: false,
          ctrlKey: true,
          shiftKey: true,
          altKey: false
        })!
      ]
    ];
    for (const [command, expected, fromKey] of table) {
      expect(menuWorkspaceResult(command), command.type).toEqual(expected);
      expect(fromKey, command.type).toEqual(expected);
      const h = handlers();
      applyMenuCommand(command, h);
      expect(h.workspace).toHaveBeenCalledExactlyOnceWith(expected);
    }
  });

  it("turn Unhoist into the reducer's hoist reset, and leave hoisting to the focused topic", () => {
    const h = handlers();
    applyMenuCommand({ type: "unhoist" }, h);
    expect(h.workspace).toHaveBeenCalledExactlyOnceWith({ type: "hoist", topicId: null });
    const hoisting = handlers();
    applyMenuCommand({ type: "hoist-topic" }, hoisting);
    expect(hoisting.hoistTopic).toHaveBeenCalledTimes(1);
    expect(hoisting.workspace).not.toHaveBeenCalled();
  });

  it("keep close-panel, toggle-navigation and toggle-theme as their own handlers", () => {
    const h = handlers();
    applyMenuCommand({ type: "close-panel" }, h);
    applyMenuCommand({ type: "toggle-navigation" }, h);
    applyMenuCommand({ type: "toggle-theme" }, h);
    expect(h.closePanel).toHaveBeenCalledTimes(1);
    expect(h.toggleNavigation).toHaveBeenCalledTimes(1);
    expect(h.toggleTheme).toHaveBeenCalledTimes(1);
    expect(h.workspace).not.toHaveBeenCalled();
  });

  it("only ever give the reducer an action it accepts", () => {
    const state = initialState(new Date("2026-11-11T12:00:00Z"), null);
    const commands: AppMenuCommand[] = [
      { type: "reopen-closed" },
      { type: "toggle-context" },
      { type: "focus-panel", direction: "next" },
      { type: "unhoist" }
    ];
    for (const command of commands) {
      const result = menuWorkspaceResult(command)!;
      // A workspace action (not a UI command) runs through the reducer without throwing.
      expect(() => reduce(state, result as WorkspaceAction), command.type).not.toThrow();
    }
  });

  it("go to each of the five destinations, in rail order, with Cmd-1..5", () => {
    expect([...appDestinationIds]).toEqual(["home", "explore", "library", "inbox", "map"]);
    appDestinationIds.forEach((view, index) => {
      expect(appMenuCommandSchema.parse({ type: "go-to", view })).toEqual({ type: "go-to", view });
      const result = keymap({
        key: String(index + 1),
        code: `Digit${index + 1}`,
        metaKey: true,
        ctrlKey: false,
        shiftKey: false,
        altKey: false
      });
      expect(result).toEqual({ type: "go", destination: view });
    });
  });
});
