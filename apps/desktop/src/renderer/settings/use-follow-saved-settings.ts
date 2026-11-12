import type { AppEventOf } from "../../shared/app-events";
import type { AppSettings, StorageSettings } from "../../shared/ipc";
import { useAppEvent } from "../lib/app-events";

/**
 * What the app keeps of the saved settings (the interface language and theme above all) follows the
 * main process (F5 T162): a section of Settings v2 saves through `window.app.settings`, main
 * announces `settings.changed` after the write, and the app reads the store again. Without this a
 * change made in Settings (the language, the theme) would reach the screen only after a restart.
 * One read per event, never a timer. A store the app is itself about to save (a change waiting in its
 * own debounce) is not read over, and a value read back that is the one the app already has (the
 * echo of its own save) is not applied.
 */

export interface SavedSettingsFollowing {
  /** After the first load of the settings; before it there is nothing to follow. */
  enabled: boolean;
  /** The app holds a change of its own that is not saved yet. */
  appBusy: () => boolean;
  storageBusy: () => boolean;
  /** The settings the app holds now; a read that carries the same `updatedAt` is dropped. */
  currentApp: () => Pick<AppSettings, "updatedAt"> | null;
  currentStorage: () => Pick<StorageSettings, "updatedAt"> | null;
  onApp: (saved: AppSettings) => void;
  onStorage: (saved: StorageSettings) => void;
}

/** What a `settings.changed` asks the app to read again. */
export function storesToRead(event: AppEventOf<"settings.changed">): {
  app: boolean;
  storage: boolean;
} {
  return { app: event.stores.includes("app"), storage: event.stores.includes("storage") };
}

export function useFollowSavedSettings(options: SavedSettingsFollowing): void {
  useAppEvent(
    "settings.changed",
    (event) => {
      const { app, storage } = storesToRead(event);
      if (app && !options.appBusy()) {
        void window.app.settings
          .getApp()
          .then((saved) => {
            if (options.appBusy() || options.currentApp()?.updatedAt === saved.updatedAt) return;
            options.onApp(saved);
          })
          .catch(() => undefined);
      }
      if (storage && !options.storageBusy()) {
        void window.app.settings
          .get()
          .then((saved) => {
            if (options.storageBusy() || options.currentStorage()?.updatedAt === saved.updatedAt)
              return;
            options.onStorage(saved);
          })
          .catch(() => undefined);
      }
    },
    options.enabled
  );
}
