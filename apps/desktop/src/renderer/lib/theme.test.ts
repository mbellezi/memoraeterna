import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  applyTheme,
  readSystemPrefersDark,
  resolveTheme,
  subscribeSystemTheme,
  useResolvedTheme,
  type MatchMedia,
  type SchemeQuery,
  type ThemePreference,
  type ThemeRoot
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
