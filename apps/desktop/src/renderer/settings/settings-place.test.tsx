// The DOM globals must exist before React loads: keep this import first.
import { createTestDom, type TestDom } from "../workspace/test-dom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { useWorkspace, type Workspace } from "../workspace/use-workspace";

import { newSettingsShown, useClassicSettings } from "./settings-place";
import {
  announceSettingsAddress,
  currentSettingsTarget,
  requestSettingsTarget,
  resetSettingsTargetForTests
} from "./settings-target";

describe("which Settings is on screen", () => {
  it("is the new one at Settings, unless an old screen covers it or the person chose the old one", () => {
    const at = (destination: string, legacyView: string | null = null, classic = false) =>
      newSettingsShown({ destination, legacyView, classic });
    expect(at("settings")).toBe(true);
    expect(at("home")).toBe(false);
    expect(at("settings", "library")).toBe(false);
    expect(at("settings", null, true)).toBe(false);
  });
});

describe("the choice of the old Settings", () => {
  let dom: TestDom;
  let classic = false;
  let choose: (value: boolean) => void = () => undefined;

  const Probe = () => {
    const [value, set] = useClassicSettings();
    classic = value;
    choose = set;
    return null;
  };

  beforeEach(async () => {
    resetSettingsTargetForTests();
    dom = createTestDom();
    await dom.render(<Probe />);
  });
  afterEach(() => dom.dispose());

  it("lasts until a link names a Settings section or setting, which is a request for the new one", async () => {
    await dom.act(() => choose(true));
    expect(classic).toBe(true);
    // Going elsewhere and opening something that is not Settings leaves it as it was.
    await dom.act(() =>
      announceSettingsAddress({
        type: "open",
        address: "memora://library",
        from: -1,
        mode: "push"
      })
    );
    expect(classic).toBe(true);
    // A source panel's "choose model" opens memora://settings/ai.
    await dom.act(() =>
      announceSettingsAddress({
        type: "open",
        address: "memora://settings/ai",
        from: 0,
        mode: "push"
      })
    );
    expect(classic).toBe(false);
    // The person can choose the old one again afterwards; that is not undone by the request before.
    await dom.act(() => choose(true));
    expect(classic).toBe(true);
    await dom.act(() => requestSettingsTarget({ setting: "themeMode" }));
    expect(classic).toBe(false);
  });
});

describe("the workspace's dispatch", () => {
  let dom: TestDom;
  let workspace: Workspace | null = null;
  const Probe = () => {
    workspace = useWorkspace({ commands: false });
    return null;
  };
  beforeEach(async () => {
    resetSettingsTargetForTests();
    dom = createTestDom();
    await dom.render(<Probe />);
  });
  afterEach(() => dom.dispose());

  it("tells Settings what a Settings address asks, and moves the place to Settings", async () => {
    await dom.act(() =>
      workspace!.dispatch({
        type: "open",
        address: "memora://settings/privacy",
        from: -1,
        mode: "push"
      })
    );
    expect(workspace!.workspace.destination).toBe("settings");
    expect(currentSettingsTarget()).toMatchObject({ section: "privacy" });
  });
});
