import { beforeEach, describe, expect, it } from "vitest";

import {
  announceSettingsAddress,
  currentSettingsTarget,
  requestSettingsTarget,
  resetSettingsTargetForTests
} from "./settings-target";

const open = (address: string) =>
  announceSettingsAddress({ type: "open", address, from: -1, mode: "push" });

describe("the Settings requests", () => {
  beforeEach(() => resetSettingsTargetForTests());

  it("are made by an open of a Settings address that names a section or a setting, and by nothing else", () => {
    open("memora://settings");
    announceSettingsAddress({ type: "go", destination: "settings" });
    open("memora://library");
    requestSettingsTarget({});
    expect(currentSettingsTarget()).toBeNull();

    open("memora://settings/ai#ai.route.embed");
    expect(currentSettingsTarget()).toEqual({
      section: "ai",
      setting: "ai.route.embed",
      token: 1
    });
    open("memora://settings/privacy");
    expect(currentSettingsTarget()).toEqual({ section: "privacy", token: 2 });
  });

  it("give each request its own token, so the surface answers each once", () => {
    requestSettingsTarget({ setting: "themeMode" });
    requestSettingsTarget({ setting: "themeMode" });
    expect(currentSettingsTarget()?.token).toBe(2);
  });
});
