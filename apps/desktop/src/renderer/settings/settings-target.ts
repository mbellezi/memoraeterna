import { useSyncExternalStore } from "react";

import { parseViewAddress } from "../workspace/route";
import type { WorkspaceAction } from "../workspace/state";
import type { SettingsSectionId } from "./settings-model";

/**
 * Where Settings is asked to go: `memora://settings/<section>#<setting>` (docs/f5-decisions.md D10).
 * The workspace state keeps only that the place is Settings (the Settings surface reads its section
 * itself), so an address that names a section or a setting is announced here, and the surface
 * scrolls to the row, focuses it and highlights it. The request waits until the surface is shown, and
 * each request is answered once (`token`).
 */
export interface SettingsTarget {
  section?: SettingsSectionId;
  /** A registry id, or its flat name (an address cannot hold every id). */
  setting?: string;
  /** Grows with each request, so the surface answers each once. */
  token: number;
}

let current: SettingsTarget | null = null;
let counter = 0;
const listeners = new Set<() => void>();

/** Asks Settings to open a section or a setting; without either there is nothing to ask. */
export function requestSettingsTarget(target: {
  section?: SettingsSectionId | undefined;
  setting?: string | undefined;
}): void {
  if (target.section === undefined && target.setting === undefined) return;
  counter += 1;
  current = {
    ...(target.section !== undefined ? { section: target.section } : {}),
    ...(target.setting !== undefined ? { setting: target.setting } : {}),
    token: counter
  };
  for (const listener of [...listeners]) listener();
}

/**
 * Announces what a workspace action asks of Settings: an `open` of a Settings address that names a
 * section (or a setting). Every other action is none of its business.
 */
export function announceSettingsAddress(action: WorkspaceAction): void {
  if (action.type !== "open") return;
  const view = parseViewAddress(action.address);
  if (view?.view === "settings") requestSettingsTarget(view);
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const getSnapshot = (): SettingsTarget | null => current;

/** The latest request, without subscribing; null before any. */
export const currentSettingsTarget = getSnapshot;

/** The latest request; null before any. */
export function useSettingsTarget(): SettingsTarget | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** For tests: forgets every request. */
export function resetSettingsTargetForTests(): void {
  current = null;
  counter = 0;
  listeners.clear();
}
