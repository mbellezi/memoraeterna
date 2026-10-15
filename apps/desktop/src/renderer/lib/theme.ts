import { useEffect, useSyncExternalStore } from "react";

/** "system" follows the OS; "light" and "dark" are explicit choices that always win. */
export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const darkSchemeQuery = "(prefers-color-scheme: dark)";

/** The part of MediaQueryList the theme code uses, so tests need no DOM. */
export interface SchemeQuery {
  readonly matches: boolean;
  addEventListener(type: "change", listener: () => void): void;
  removeEventListener(type: "change", listener: () => void): void;
}
export type MatchMedia = (query: string) => SchemeQuery;

/** The part of the root element the theme code writes: classes and the native color scheme. */
export interface ThemeRoot {
  readonly classList: { toggle(token: string, force: boolean): unknown };
  readonly style: { colorScheme: string };
}

function browserMatchMedia(): MatchMedia | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  return (query) => window.matchMedia(query);
}

export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Whether the OS asks for a dark interface; false where there is no matchMedia. */
export function readSystemPrefersDark(
  matchMedia: MatchMedia | null = browserMatchMedia()
): boolean {
  return matchMedia ? matchMedia(darkSchemeQuery).matches : false;
}

/** Calls `onChange` whenever the OS colour scheme changes; returns the unsubscribe function. */
export function subscribeSystemTheme(
  onChange: () => void,
  matchMedia: MatchMedia | null = browserMatchMedia()
): () => void {
  if (!matchMedia) return () => undefined;
  const query = matchMedia(darkSchemeQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/**
 * Marks the root with exactly one theme class. tokens.css and the Tailwind `dark:` variant both
 * key off it; the inline colour scheme keeps native controls and scrollbars in step.
 */
export function applyTheme(root: ThemeRoot, theme: ResolvedTheme): void {
  root.classList.toggle("dark", theme === "dark");
  root.classList.toggle("light", theme === "light");
  root.style.colorScheme = theme;
}

const subscribeToSystemTheme = (notify: () => void) => subscribeSystemTheme(notify);
const readSystemOnClient = () => readSystemPrefersDark();
const readSystemOnServer = () => false;

/**
 * Resolves the preference against the OS scheme (live while it is "system") and applies the result
 * to the document root. Returns the theme the interface is drawn in.
 */
export function useResolvedTheme(preference: ThemePreference): ResolvedTheme {
  const systemPrefersDark = useSyncExternalStore(
    subscribeToSystemTheme,
    readSystemOnClient,
    readSystemOnServer
  );
  const theme = resolveTheme(preference, systemPrefersDark);
  useEffect(() => {
    applyTheme(document.documentElement, theme);
  }, [theme]);
  return theme;
}
