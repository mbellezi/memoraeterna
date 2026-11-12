import { useEffect, useState } from "react";
import type { LanguageCode } from "@app/i18n";

import { readOnEvents, settingsTouch } from "../lib/status-followers";

/** The language the notes are written in: relation descriptions are written in it. */
export function useContentLanguage(): LanguageCode | null {
  const [language, setLanguage] = useState<LanguageCode | null>(null);
  useEffect(() => {
    const read = () => window.app.settings.getApp().then((app) => app.contentLanguage);
    const follower = readOnEvents({
      api: () => window.app,
      sources: [{ type: "settings.changed", when: settingsTouch("app") }],
      read,
      onValue: setLanguage
    });
    return () => follower.stop();
  }, []);
  return language;
}
