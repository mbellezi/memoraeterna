// Controls that took two stored values onto one screen control (F4 D33): the Obsidian sync switch
// and its pause, and the online book lookup and its provider. The stored values do not change.
import type { AppSettings, AppSettingsUpdate, StorageSettings } from "../../../shared/ipc";

/** Obsidian sync: off, on, or paused (still configured, not synchronizing). */
export const obsidianSyncModes = ["off", "on", "paused"] as const;
export type ObsidianSyncMode = (typeof obsidianSyncModes)[number];

/**
 * Every reader tests `enabled && !paused` (`isSyncActive`), so a stored `enabled=false, paused=true`
 * is Off: nothing distinguishes it from a plain Off.
 */
export function obsidianSyncModeOf(
  settings: Pick<StorageSettings, "obsidianSyncEnabled" | "obsidianSyncPaused">
): ObsidianSyncMode {
  if (!settings.obsidianSyncEnabled) return "off";
  return settings.obsidianSyncPaused ? "paused" : "on";
}

/** The two stored values a mode means; Off clears the pause so turning it on again starts clean. */
export function obsidianSyncModePatch(
  mode: ObsidianSyncMode
): Pick<StorageSettings, "obsidianSyncEnabled" | "obsidianSyncPaused"> {
  return { obsidianSyncEnabled: mode !== "off", obsidianSyncPaused: mode === "paused" };
}

/** The online book lookup: off, or the provider that is asked. */
export const bookLookupModes = ["off", "auto", "open-library", "google-books"] as const;
export type BookLookupMode = (typeof bookLookupModes)[number];

export function bookLookupModeOf(
  settings: Pick<AppSettings, "metadataEnrichmentEnabled" | "bookMetadataProvider">
): BookLookupMode {
  return settings.metadataEnrichmentEnabled ? settings.bookMetadataProvider : "off";
}

/** Off keeps the provider chosen before, so turning the lookup on again asks the same one. */
export function bookLookupPatch(mode: BookLookupMode): AppSettingsUpdate {
  return mode === "off"
    ? { metadataEnrichmentEnabled: false }
    : { metadataEnrichmentEnabled: true, bookMetadataProvider: mode };
}
