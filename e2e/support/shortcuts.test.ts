import { describe, expect, it } from "vitest";

import { acceleratorOf, isMenuShortcut, menuAccelerators } from "./shortcuts.js";

describe("acceleratorOf", () => {
  it("spells Playwright's combinations the way Electron's menu does", () => {
    expect(acceleratorOf("Meta+K")).toBe("CmdOrCtrl+K");
    expect(acceleratorOf("Meta+k")).toBe("CmdOrCtrl+K");
    expect(acceleratorOf("Meta+,")).toBe("CmdOrCtrl+,");
    expect(acceleratorOf("Meta+2")).toBe("CmdOrCtrl+2");
    expect(acceleratorOf("Meta+Shift+T")).toBe("CmdOrCtrl+Shift+T");
    expect(acceleratorOf("Meta+Shift+\\")).toBe("CmdOrCtrl+Shift+\\");
    expect(acceleratorOf("Meta++")).toBe("CmdOrCtrl++");
  });
});

describe("isMenuShortcut", () => {
  it("is true for the workspace accelerators of the application menu", () => {
    for (const combo of ["Meta+1", "Meta+5", "Meta+,", "Meta+K", "Meta+N", "Meta+W", "Meta+\\"])
      expect(isMenuShortcut(combo), combo).toBe(true);
    expect(menuAccelerators).toHaveLength(13);
  });

  it("is false for the keys main reads before the menu and for plain keys", () => {
    for (const combo of ["Meta+[", "Meta+]", "Meta+Y", "Escape", "ArrowDown", "Space", "Meta+6"])
      expect(isMenuShortcut(combo), combo).toBe(false);
  });
});
