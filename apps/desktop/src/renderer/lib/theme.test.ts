import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applyRememberedTheme,
  applyTheme,
  defaultThemePreference,
  parseThemePreference,
  readRememberedTheme,
  readSystemPrefersDark,
  rememberedThemeKey,
  rememberTheme,
  resolveTheme,
  subscribeSystemTheme,
  useResolvedTheme,
  type MatchMedia,
  type SchemeQuery,
  type ThemePreference,
  type ThemeRoot,
  type ThemeStorage
} from "./theme";

function fakeScheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const queries: string[] = [];
  const query: SchemeQuery = {
    get matches() {
      return dark;
    },
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener)
  };
  const matchMedia: MatchMedia = (text) => {
    queries.push(text);
    return query;
  };
  return {
    matchMedia,
    queries,
    listeners,
    setDark(value: boolean) {
      dark = value;
      for (const listener of [...listeners]) listener();
    }
  };
}

function fakeRoot() {
  const classes = new Set<string>();
  const root: ThemeRoot = {
    classList: {
      toggle(token, force) {
        if (force) classes.add(token);
        else classes.delete(token);
        return force;
      }
    },
    style: { colorScheme: "" }
  };
  return { root, classes };
}

describe("resolveTheme", () => {
  it("follows the OS only while the preference is system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
  });

  it("lets an explicit theme override the OS in both directions", () => {
    expect(resolveTheme("dark", false)).toBe("dark");
    expect(resolveTheme("light", true)).toBe("light");
  });
});

describe("readSystemPrefersDark", () => {
  it("asks for the dark colour scheme", () => {
    const scheme = fakeScheme(true);
    expect(readSystemPrefersDark(scheme.matchMedia)).toBe(true);
    expect(scheme.queries).toEqual(["(prefers-color-scheme: dark)"]);
    expect(readSystemPrefersDark(fakeScheme(false).matchMedia)).toBe(false);
  });

  it("falls back to light where matchMedia does not exist", () => {
    expect(readSystemPrefersDark(null)).toBe(false);
  });
});

describe("subscribeSystemTheme", () => {
  it("notifies on every OS change until unsubscribed", () => {
    const scheme = fakeScheme(false);
    let calls = 0;
    const unsubscribe = subscribeSystemTheme(() => (calls += 1), scheme.matchMedia);
    scheme.setDark(true);
    scheme.setDark(false);
    expect(calls).toBe(2);
    unsubscribe();
    scheme.setDark(true);
    expect(calls).toBe(2);
    expect(scheme.listeners.size).toBe(0);
  });

  it("is a harmless no-op without matchMedia", () => {
    expect(() => subscribeSystemTheme(() => undefined, null)()).not.toThrow();
  });
});

describe("applyTheme", () => {
  it("marks the root with exactly one theme class and the native colour scheme", () => {
    const { root, classes } = fakeRoot();
    applyTheme(root, "dark");
    expect([...classes]).toEqual(["dark"]);
    expect(root.style.colorScheme).toBe("dark");
    applyTheme(root, "light");
    expect([...classes]).toEqual(["light"]);
    expect(root.style.colorScheme).toBe("light");
  });

  it("is idempotent", () => {
    const { root, classes } = fakeRoot();
    applyTheme(root, "dark");
    applyTheme(root, "dark");
    expect([...classes]).toEqual(["dark"]);
  });
});

describe("the System theme", () => {
  /** What the hook does: resolve the preference against the OS, apply it, and again on a change. */
  function follow(preference: ThemePreference, scheme: ReturnType<typeof fakeScheme>) {
    const { root, classes } = fakeRoot();
    const apply = () =>
      applyTheme(root, resolveTheme(preference, readSystemPrefersDark(scheme.matchMedia)));
    apply();
    const stop = subscribeSystemTheme(apply, scheme.matchMedia);
    return { classes, stop };
  }

  it("follows the OS appearance live while it is chosen", () => {
    const scheme = fakeScheme(false);
    const { classes, stop } = follow("system", scheme);
    expect([...classes]).toEqual(["light"]);
    scheme.setDark(true);
    expect([...classes]).toEqual(["dark"]);
    scheme.setDark(false);
    expect([...classes]).toEqual(["light"]);
    stop();
    scheme.setDark(true);
    expect([...classes]).toEqual(["light"]);
  });

  it("is overridden by an explicit Light or Dark choice, whatever the OS does", () => {
    const light = fakeScheme(true);
    const explicitLight = follow("light", light);
    expect([...explicitLight.classes]).toEqual(["light"]);
    light.setDark(false);
    light.setDark(true);
    expect([...explicitLight.classes]).toEqual(["light"]);
    const dark = fakeScheme(false);
    const explicitDark = follow("dark", dark);
    dark.setDark(false);
    expect([...explicitDark.classes]).toEqual(["dark"]);
  });
});

describe("useResolvedTheme", () => {
  function themeOf(preference: ThemePreference) {
    function Probe() {
      return createElement("span", null, useResolvedTheme(preference));
    }
    return renderToString(createElement(Probe));
  }

  it("renders explicit themes as chosen and system as light where the OS is unknown", () => {
    expect(themeOf("dark")).toContain(">dark<");
    expect(themeOf("light")).toContain(">light<");
    // Server rendering has no matchMedia: system resolves to light until the client subscribes.
    expect(themeOf("system")).toContain(">light<");
  });
});

describe("the remembered theme", () => {
  function fakeStorage(initial: Record<string, string> = {}) {
    const values = new Map(Object.entries(initial));
    const storage: ThemeStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => void values.set(key, value)
    };
    return { storage, values };
  }
  const throwing: ThemeStorage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("full");
    }
  };

  it("reads only a valid preference", () => {
    for (const preference of ["system", "light", "dark"] as const)
      expect(readRememberedTheme(fakeStorage({ [rememberedThemeKey]: preference }).storage)).toBe(
        preference
      );
    for (const value of ["", "blue", "DARK", "null"])
      expect(readRememberedTheme(fakeStorage({ [rememberedThemeKey]: value }).storage)).toBe(
        undefined
      );
    expect(readRememberedTheme(fakeStorage().storage)).toBeUndefined();
    expect(parseThemePreference(undefined)).toBeUndefined();
    expect(parseThemePreference(1)).toBeUndefined();
  });

  it("falls back quietly where storage is missing, blocked or full", () => {
    expect(readRememberedTheme(null)).toBeUndefined();
    expect(readRememberedTheme(throwing)).toBeUndefined();
    expect(() => rememberTheme("dark", null)).not.toThrow();
    expect(() => rememberTheme("dark", throwing)).not.toThrow();
  });

  it("remembers the preference, not the theme it resolved to", () => {
    const { storage, values } = fakeStorage();
    rememberTheme("system", storage);
    expect(values.get(rememberedThemeKey)).toBe("system");
    rememberTheme("dark", storage);
    expect(readRememberedTheme(storage)).toBe("dark");
  });

  it("draws the stored explicit theme from the first frame, whatever the OS is", () => {
    // An existing install stored Dark; the OS is light and the database is not ready yet.
    const dark = fakeRoot();
    applyRememberedTheme(
      dark.root,
      fakeStorage({ [rememberedThemeKey]: "dark" }).storage,
      fakeScheme(false).matchMedia
    );
    expect([...dark.classes]).toEqual(["dark"]);
    expect(dark.root.style.colorScheme).toBe("dark");
    // The mirror image: Light chosen on a dark OS.
    const light = fakeRoot();
    applyRememberedTheme(
      light.root,
      fakeStorage({ [rememberedThemeKey]: "light" }).storage,
      fakeScheme(true).matchMedia
    );
    expect([...light.classes]).toEqual(["light"]);
    // System still follows the OS.
    const system = fakeRoot();
    applyRememberedTheme(
      system.root,
      fakeStorage({ [rememberedThemeKey]: "system" }).storage,
      fakeScheme(true).matchMedia
    );
    expect([...system.classes]).toEqual(["dark"]);
  });

  it("draws the default dark theme from the first frame when nothing is remembered", () => {
    // A first launch on a light macOS, and a blocked or empty store, all open dark: never light
    // first and dark after the settings load.
    for (const storage of [fakeStorage().storage, throwing, null]) {
      for (const osDark of [false, true]) {
        const { root, classes } = fakeRoot();
        applyRememberedTheme(root, storage, fakeScheme(osDark).matchMedia);
        expect([...classes]).toEqual(["dark"]);
        expect(root.style.colorScheme).toBe("dark");
      }
    }
    expect(defaultThemePreference).toBe("dark");
    const unusable = fakeRoot();
    applyRememberedTheme(
      unusable.root,
      fakeStorage({ [rememberedThemeKey]: "sepia" }).storage,
      fakeScheme(false).matchMedia
    );
    expect([...unusable.classes]).toEqual(["dark"]);
  });
});
