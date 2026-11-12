import { useCallback, useEffect, useRef, useState } from "react";

import type { AppSettings, AppSettingsUpdate } from "../../../../shared/ipc";
import { readOnEvents, settingsTouch } from "../../../lib/status-followers";

/**
 * The app settings the Advanced section edits as one document (the matching values and their
 * presets): read once when the section is shown and again on each `settings.changed` of the app
 * store, never on a timer. Saves go one after the other, each built from the latest saved document,
 * so two quick edits of one group never write over each other.
 */

export type AppChange = AppSettingsUpdate | ((current: AppSettings) => AppSettingsUpdate | null);

export interface AppSettingsState {
  status: "loading" | "error" | "ready";
  settings: AppSettings | null;
  /** The last save failed and nothing was changed; the next save or a read clears it. */
  saveFailed: boolean;
  /** Saves a change; false when it failed (or the change had nothing to write). */
  save: (change: AppChange) => Promise<boolean>;
  retry: () => void;
}

export function useAppSettings(): AppSettingsState {
  const [status, setStatus] = useState<AppSettingsState["status"]>("loading");
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const latest = useRef<AppSettings | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const follower = useRef<ReturnType<typeof readOnEvents> | null>(null);

  const accept = useCallback((next: AppSettings) => {
    latest.current = next;
    setSettings(next);
    setStatus("ready");
  }, []);

  useEffect(() => {
    const reading = readOnEvents<AppSettings>({
      api: () => window.app,
      sources: [{ type: "settings.changed", when: settingsTouch("app") }],
      read: () => Promise.resolve().then(() => window.app.settings.getApp()),
      onValue: accept,
      // Values that were shown stay shown; only the first read can fail.
      onError: () => setStatus((current) => (current === "ready" ? current : "error"))
    });
    follower.current = reading;
    return () => {
      reading.stop();
      follower.current = null;
    };
  }, [accept]);

  const save = useCallback(
    (change: AppChange): Promise<boolean> => {
      const run = async (): Promise<boolean> => {
        const update =
          typeof change === "function" ? latest.current && change(latest.current) : change;
        if (!update) return false;
        try {
          accept(await window.app.settings.updateApp(update));
          setSaveFailed(false);
          return true;
        } catch {
          setSaveFailed(true);
          return false;
        }
      };
      const next = queue.current.then(run, run);
      queue.current = next;
      return next;
    },
    [accept]
  );

  const retry = useCallback(() => {
    setStatus("loading");
    follower.current?.refresh();
  }, []);

  return { status, settings, saveFailed, save, retry };
}
