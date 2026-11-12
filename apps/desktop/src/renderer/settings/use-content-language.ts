import { useEffect, useState } from "react";
import type { LanguageCode } from "@app/i18n";

import { readOnEvents, settingsTouch } from "../lib/status-followers";
import { useSettings } from "./settings-context";

/**
 * The language the notes are written in: relation descriptions are written in it. Read once when
 * Settings is shown and again after each change of the app settings; a hidden Settings reads nothing.
 */
export function useContentLanguage(): LanguageCode | null {
  const [language, setLanguage] = useState<LanguageCode | null>(null);
  const { active } = useSettings();
  useEffect(() => {
    if (!active) return undefined;
    const read = () => window.app.settings.getApp().then((app) => app.contentLanguage);
    const follower = readOnEvents({
      api: () => window.app,
      sources: [{ type: "settings.changed", when: settingsTouch("app") }],
      read,
      onValue: setLanguage
    });
    return () => follower.stop();
  }, [active]);
  return language;
}
